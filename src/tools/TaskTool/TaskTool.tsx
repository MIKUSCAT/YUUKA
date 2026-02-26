import { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import {
  createAssistantMessage,
  INTERRUPT_MESSAGE,
} from '@utils/messages'
import { getModelManager } from '@utils/model'
import { getTheme } from '@utils/theme'
import { getOriginalCwd } from '@utils/state'
import { getPrompt } from './prompt'
import { TOOL_NAME } from './constants'
import { getAvailableAgentTypes } from '@utils/agentLoader'
import { TASK_DASH } from '@constants/figures'
import { encodeTaskProgress } from '@components/messages/TaskProgressMessage'
import {
  readMailboxMessagesWithCursor,
  type TeamMailboxMessage,
} from '@services/mailbox'
import {
  createTeamTask,
  readTeamTask,
  spawnTeammateProcess,
  updateTeamTask,
} from '@services/teamManager'
import { normalizeAgentName, normalizeTeamName } from '@services/teamPaths'
import { TaskExecutionProgress } from './runAgentTaskExecution'
import type { PermissionMode } from '@yuuka-types/PermissionMode'

const inputSchema = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  model_name: z
    .string()
    .optional()
    .describe(
      'Optional: Specific model name to use for this task. If not provided, uses the default task model pointer.',
    ),
  subagent_type: z
    .string()
    .optional()
    .describe(
      'The type of specialized agent to use for this task',
    ),
  team_name: z
    .string()
    .optional()
    .describe('Optional team workspace name (TEAM mode)'),
  name: z
    .string()
    .optional()
    .describe('Optional teammate instance name (TEAM mode)'),
  wait_for_completion: z
    .boolean()
    .optional()
    .describe(
      'Whether to wait for the teammate to finish. Set false to launch in true parallel and continue orchestration.',
    ),
})

function textBlocksToString(data: TextBlock[]): string {
  return data.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

export type TaskLaunchHandle = {
  mode: 'launched'
  launched: true
  wait_for_completion: false
  task_id: string
  team_name: string
  agent_name: string
  status: 'pending' | 'running'
  task_file_path: string
  child_pid: number | null
}

type TaskToolOutput = TextBlock[] | TaskLaunchHandle

function isTaskLaunchHandle(data: unknown): data is TaskLaunchHandle {
  if (!data || typeof data !== 'object') return false
  const value = data as Record<string, unknown>
  return value.mode === 'launched' && value.launched === true
}

export const TaskTool = {
  async prompt({ safeMode }) {
    // Keep prompts aligned with current `.yuuka/agents` definitions
    return await getPrompt(safeMode)
  },
  name: TOOL_NAME,
  async description() {
    // Keep metadata aligned with current `.yuuka/agents` definitions
    return "Launch a new task"
  },
  inputSchema,
  
  async *call(
    {
      description,
      prompt,
      model_name,
      subagent_type,
      team_name,
      name,
      wait_for_completion,
    },
    toolUseContext,
  ): AsyncGenerator<
    | { type: 'result'; data: TaskToolOutput; resultForAssistant?: string }
    | { type: 'progress'; content: any; normalizedMessages?: any[]; tools?: any[] },
    void,
    unknown
  > {
    const {
      abortController,
      options: {
        safeMode = false,
        permissionMode = 'default',
        forkNumber = 0,
        messageLogName = 'task',
        verbose = false,
      },
      readFileTimestamps,
    } = toolUseContext as any

    const agentType = subagent_type || 'general-purpose'
    const timelineItems: string[] = []
    const pushTimeline = (value?: string) => {
      if (!value || typeof value !== 'string') return
      const normalized = value.replace(/\s+/g, ' ').trim()
      if (!normalized) return
      if (timelineItems[timelineItems.length - 1] === normalized) return
      timelineItems.push(normalized)
      if (timelineItems.length > 24) {
        timelineItems.shift()
      }
    }
    const getTimelineSnapshot = () => timelineItems.slice(-4)

    const createProgressOutput = (progress: TaskExecutionProgress) => {
      pushTimeline(progress.lastAction)
      return {
        type: 'progress' as const,
        content: createAssistantMessage(
          encodeTaskProgress({
            agentType: progress.agentType,
            status: progress.status,
            description: progress.description,
            model: progress.model,
            toolCount: progress.toolCount,
            tokenCount: progress.tokenCount,
            elapsedMs: progress.elapsedMs,
            lastAction: progress.lastAction,
            timeline: getTimelineSnapshot(),
            teamName: progress.teamName,
            agentName: progress.agentName,
            taskId: progress.taskId,
            taskState: progress.taskState,
            eventType: progress.eventType,
            eventContent: progress.eventContent,
          }),
        ),
      }
    }

    const createResultOutput = (text: string) => {
      const data: TextBlock[] = [{ type: 'text', text }] as TextBlock[]
      return {
        type: 'result' as const,
        data,
        resultForAssistant: textBlocksToString(data),
      }
    }

    const createLaunchResultOutput = (
      launched: TaskLaunchHandle,
    ): {
      type: 'result'
      data: TaskLaunchHandle
      resultForAssistant: string
    } => ({
      type: 'result',
      data: launched,
      resultForAssistant: JSON.stringify(launched, null, 2),
    })

    // Team process mode is now the only execution path.
    try {
      const resolvedTeamName = normalizeTeamName(team_name || messageLogName)
      const teammateName = normalizeAgentName(
        name || `${agentType}-${Date.now().toString(36).slice(-5)}`,
      )

      const { taskPath, task } = createTeamTask({
        teamName: resolvedTeamName,
        agentName: teammateName,
        description,
        prompt,
        subagent_type,
        model_name,
        safeMode,
        permissionMode: permissionMode as PermissionMode,
        verbose,
        forkNumber,
        messageLogName,
      })

      const child = spawnTeammateProcess({
        taskPath,
        cwd: getOriginalCwd(),
        safeMode,
      })
      let childExitedAt: number | null = null
      child.on('exit', () => {
        if (childExitedAt === null) {
          childExitedAt = Date.now()
        }
      })

      const toBoardState = (
        raw: string | undefined,
      ): 'open' | 'in_progress' | 'completed' => {
        if (!raw) return 'open'
        if (
          raw === 'completed' ||
          raw === 'failed' ||
          raw === 'cancelled' ||
          raw === '已完成'
        ) {
          return 'completed'
        }
        if (
          raw === 'pending' ||
          raw === 'running' ||
          raw === 'in_progress' ||
          raw === '启动中' ||
          raw === '分析中' ||
          raw === '调用工具' ||
          raw === '排队中' ||
          raw === '收到消息'
        ) {
          return 'in_progress'
        }
        return 'open'
      }

      yield createProgressOutput({
        agentType,
        description,
        status: '启动中',
        model: model_name || 'task',
        toolCount: 0,
        elapsedMs: 0,
        lastAction: `worker started · team=${resolvedTeamName} · agent=${teammateName}`,
        teamName: resolvedTeamName,
        agentName: teammateName,
        taskId: task.id,
        taskState: 'in_progress',
        eventType: 'status',
        eventContent: 'worker spawned',
      })

      if (wait_for_completion === false) {
        yield createLaunchResultOutput({
          mode: 'launched',
          launched: true,
          wait_for_completion: false,
          task_id: task.id,
          team_name: resolvedTeamName,
          agent_name: teammateName,
          status: 'pending',
          task_file_path: taskPath,
          child_pid: child.pid ?? null,
        })
        return
      }

      let lastProgressIndex = 0
      let lastOutboxLine = 0
      const startTime = Date.now()
      const sleep = (ms: number) =>
        new Promise(resolve => setTimeout(resolve, ms))

      const emitMailboxEvent = (message: TeamMailboxMessage) => {
        const content = String(message.content ?? '').trim()
        if (!content) return null

        if (message.type === 'progress') {
          return null
        }

        const eventType: 'message' | 'status' | 'result' =
          message.type === 'result'
            ? 'result'
            : message.type === 'message' || message.type === 'broadcast'
              ? 'message'
              : 'status'

        const prettyContent =
          content.length > 180 ? `${content.slice(0, 180)}...` : content

        return createProgressOutput({
          agentType,
          description,
          status: eventType === 'message' ? '队友消息' : '状态更新',
          model: model_name || 'task',
          toolCount: 0,
          elapsedMs: Date.now() - startTime,
          lastAction:
            eventType === 'message'
              ? `${message.from} -> ${message.to}: ${prettyContent}`
              : `${message.type}: ${prettyContent}`,
          teamName: resolvedTeamName,
          agentName: teammateName,
          taskId: task.id,
          taskState: 'in_progress',
          eventType,
          eventContent: prettyContent,
        })
      }

      while (true) {
        if (abortController.signal.aborted) {
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill('SIGKILL')
            }
          }, 1000)
          updateTeamTask(taskPath, current => {
            if (
              current.status === 'completed' ||
              current.status === 'failed' ||
              current.status === 'cancelled'
            ) {
              return current
            }
            return {
              ...current,
              status: 'cancelled',
              endedAt: Date.now(),
              error: 'Cancelled by lead agent',
            }
          })
          const interruptedData: TextBlock[] = [
            { type: 'text', text: INTERRUPT_MESSAGE },
          ] as TextBlock[]
          yield {
            type: 'result',
            data: interruptedData,
            resultForAssistant: textBlocksToString(interruptedData),
          }
          return
        }

        const outboxRead = readMailboxMessagesWithCursor(
          'outbox',
          resolvedTeamName,
          teammateName,
          lastOutboxLine,
        )
        const outboxMessages = outboxRead.messages
        if (outboxRead.scannedLines > 0) {
          lastOutboxLine = outboxRead.nextLine
        }
        if (outboxMessages.length > 0) {
          for (const message of outboxMessages) {
            if (message.taskId && message.taskId !== task.id) {
              continue
            }
            const event = emitMailboxEvent(message)
            if (event) {
              yield event
            }
          }
        }

        const taskState = readTeamTask(taskPath)
        if (taskState) {
          const newProgress = taskState.progress.slice(lastProgressIndex)
          for (const progress of newProgress) {
            yield createProgressOutput({
              agentType,
              description,
              status: progress.status,
              model: progress.model || model_name || 'task',
              toolCount: progress.toolCount ?? 0,
              tokenCount: progress.tokenCount,
              elapsedMs: progress.elapsedMs ?? Date.now() - startTime,
              lastAction: progress.lastAction,
              teamName: resolvedTeamName,
              agentName: teammateName,
              taskId: taskState.id,
              taskState: toBoardState(taskState.status),
              eventType: 'progress',
            })
          }
          lastProgressIndex += newProgress.length

          if (
            taskState.status === 'completed' ||
            taskState.status === 'failed' ||
            taskState.status === 'cancelled'
          ) {
            const text =
              taskState.status === 'completed'
                ? taskState.resultText || ''
                : taskState.error || `Task ended with status: ${taskState.status}`
            yield createProgressOutput({
              agentType,
              description,
              status: taskState.status === 'completed' ? '已完成' : '已结束',
              model: model_name || 'task',
              toolCount: taskState.toolUseCount ?? 0,
              tokenCount: taskState.tokenCount,
              elapsedMs:
                taskState.durationMs ?? Date.now() - (taskState.startedAt || startTime),
              lastAction: taskState.status === 'completed' ? 'task completed' : taskState.status,
              teamName: resolvedTeamName,
              agentName: teammateName,
              taskId: taskState.id,
              taskState: toBoardState(taskState.status),
              eventType: taskState.status === 'completed' ? 'result' : 'status',
              eventContent: text,
            })
            yield createResultOutput(text)
            return
          }
        }

        if (child.exitCode !== null && !taskState) {
          yield createResultOutput(
            `Teammate process exited early (code ${child.exitCode}).`,
          )
          return
        }

        if (
          child.exitCode !== null &&
          taskState &&
          (taskState.status === 'pending' || taskState.status === 'running')
        ) {
          if (childExitedAt === null) {
            childExitedAt = Date.now()
          }
          if (Date.now() - childExitedAt > 1200) {
            const failedState = updateTeamTask(taskPath, current => {
              if (
                current.status === 'completed' ||
                current.status === 'failed' ||
                current.status === 'cancelled'
              ) {
                return current
              }
              return {
                ...current,
                status: 'failed',
                endedAt: Date.now(),
                error: `Teammate process exited unexpectedly (code ${child.exitCode}).`,
              }
            })
            yield createResultOutput(
              failedState.error ||
                `Teammate process exited unexpectedly (code ${child.exitCode}).`,
            )
            return
          }
        }

        await sleep(250)
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      yield createResultOutput(errorText)
      return
    }
  },

  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return true // Task tool supports concurrent execution in official implementation
  },
  async validateInput(input, context) {
    if (!input.description || typeof input.description !== 'string') {
      return {
        result: false,
        message: 'Description is required and must be a string',
      }
    }
    if (!input.prompt || typeof input.prompt !== 'string') {
      return {
        result: false,
        message: 'Prompt is required and must be a string',
      }
    }
    if (input.team_name && typeof input.team_name !== 'string') {
      return {
        result: false,
        message: 'team_name must be a string',
      }
    }
    if (input.name && typeof input.name !== 'string') {
      return {
        result: false,
        message: 'name must be a string',
      }
    }
    if (
      typeof (input as any).wait_for_completion !== 'undefined' &&
      typeof (input as any).wait_for_completion !== 'boolean'
    ) {
      return {
        result: false,
        message: 'wait_for_completion must be a boolean',
      }
    }

    // Model validation - similar to Edit tool error handling
    if (input.model_name) {
      const modelManager = getModelManager()
      const availableModels = modelManager.getAllAvailableModelNames()

      if (!availableModels.includes(input.model_name)) {
        return {
          result: false,
          message: `Model '${input.model_name}' does not exist. Available models: ${availableModels.join(', ')}`,
          meta: {
            model_name: input.model_name,
            availableModels,
          },
        }
      }
    }

    // Validate subagent_type if provided
    if (input.subagent_type) {
      const availableTypes = await getAvailableAgentTypes()
      if (!availableTypes.includes(input.subagent_type)) {
        return {
          result: false,
          message: `Agent type '${input.subagent_type}' does not exist. Available types: ${availableTypes.join(', ')}`,
          meta: {
            subagent_type: input.subagent_type,
            availableTypes,
          },
        }
      }
    }

    return { result: true }
  },
  async isEnabled() {
    return true
  },
  userFacingName() {
    return 'Task'
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(data: TaskToolOutput) {
    if (isTaskLaunchHandle(data)) {
      return JSON.stringify(data, null, 2)
    }
    return textBlocksToString(data)
  },
  renderToolUseMessage({ description, wait_for_completion }, { verbose }) {
    if (!description) return null
    if (wait_for_completion === false) {
      return `${description} (detach)`
    }
    return `${description}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(content) {
    const theme = getTheme()

    if (isTaskLaunchHandle(content)) {
      return (
        <Box flexDirection="row">
          <Text color={theme.yuuka}> {TASK_DASH} </Text>
          <Text color={theme.success}>
            Task launched: {content.agent_name} (task_id={content.task_id})
          </Text>
        </Box>
      )
    }

    if (Array.isArray(content)) {
      const textBlocks = content.filter(block => block.type === 'text')
      const totalLength = textBlocks.reduce(
        (sum, block) => sum + block.text.length,
        0,
      )
      // CRITICAL FIX: Use exact match for interrupt detection, not .includes()
      const isInterrupted = content.some(
        block =>
          block.type === 'text' && block.text === INTERRUPT_MESSAGE,
      )

      if (isInterrupted) {
        // CRITICAL FIX: Match original system interrupt rendering exactly
        return (
          <Box flexDirection="row">
            <Text color={theme.yuuka}> {TASK_DASH} </Text>
            <Text color={theme.error}>Interrupted by user</Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between" width="100%">
            <Box flexDirection="row">
              <Text color={theme.yuuka}> {TASK_DASH} </Text>
              <Text color={theme.success}>Task completed</Text>
              {textBlocks.length > 0 && (
                <Text color={theme.secondaryText}>
                  {' '}
                  ({totalLength} characters)
                </Text>
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Text color={theme.yuuka}> {TASK_DASH} </Text>
        <Text color={theme.secondaryText}>Task completed</Text>
      </Box>
    )
  },
} satisfies Tool<typeof inputSchema, TaskToolOutput>
