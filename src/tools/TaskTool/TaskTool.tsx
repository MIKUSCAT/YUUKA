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
import { getGlobalConfig } from '@utils/config'
import { getOriginalCwd } from '@utils/state'
import { getPrompt } from './prompt'
import { TOOL_NAME } from './constants'
import { getAvailableAgentTypes } from '@utils/agentLoader'
import { TASK_DASH } from '@constants/figures'
import { encodeTaskProgress } from '@components/messages/TaskProgressMessage'
import {
  createTeamTask,
  readTeamTask,
  spawnTeammateProcess,
  updateTeamTask,
} from '@services/teamManager'
import { normalizeAgentName, normalizeTeamName } from '@services/teamPaths'
import {
  runAgentTaskExecutionStream,
  TaskExecutionProgress,
} from './runAgentTaskExecution'

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
    .describe('Optional team workspace name (process mode)'),
  name: z
    .string()
    .optional()
    .describe('Optional teammate instance name (process mode)'),
})

function textBlocksToString(data: TextBlock[]): string {
  return data.map(block => (block.type === 'text' ? block.text : '')).join('\n')
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
    { description, prompt, model_name, subagent_type, team_name, name },
    toolUseContext,
  ): AsyncGenerator<
    | { type: 'result'; data: TextBlock[]; resultForAssistant?: string }
    | { type: 'progress'; content: any; normalizedMessages?: any[]; tools?: any[] },
    void,
    unknown
  > {
    const {
      abortController,
      options: {
        safeMode = false,
        forkNumber = 0,
        messageLogName = 'task',
        verbose = false,
      },
      readFileTimestamps,
    } = toolUseContext as any

    const executionMode = getGlobalConfig().agentExecutionMode ?? 'inline'
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

    if (executionMode === 'process') {
      try {
        const resolvedTeamName = normalizeTeamName(team_name || messageLogName)
        const teammateName = normalizeAgentName(
          name || `${agentType}-${Date.now().toString(36).slice(-5)}`,
        )

        const { taskPath } = createTeamTask({
          teamName: resolvedTeamName,
          agentName: teammateName,
          description,
          prompt,
          subagent_type,
          model_name,
          safeMode,
          verbose,
          forkNumber,
          messageLogName,
        })

        yield createProgressOutput({
          agentType,
          description,
          status: '排队中',
          model: model_name || 'task',
          toolCount: 0,
          elapsedMs: 0,
          lastAction: `team=${resolvedTeamName} · worker=${teammateName}`,
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

        let lastProgressIndex = 0
        const startTime = Date.now()
        const sleep = (ms: number) =>
          new Promise(resolve => setTimeout(resolve, ms))

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
    }

    try {
      for await (const event of runAgentTaskExecutionStream({
        description,
        prompt,
        model_name,
        subagent_type,
        team_name,
        name,
        safeMode,
        forkNumber,
        messageLogName,
        verbose,
        abortController,
        readFileTimestamps,
        canUseTool: (toolUseContext as any)?.canUseTool,
      })) {
        if (event.type === 'progress') {
          yield createProgressOutput(event.progress)
          continue
        }
        yield {
          type: 'result',
          data: event.result.data,
          resultForAssistant: event.result.resultForAssistant,
        }
        return
      }
      yield createResultOutput('Task execution ended unexpectedly without result.')
      return
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      yield createResultOutput(errorText)
      return
    }
  },

  isReadOnly() {
    return true // for now...
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
  renderResultForAssistant(data: TextBlock[]) {
    return textBlocksToString(data)
  },
  renderToolUseMessage({ description }, { verbose }) {
    if (!description) return null
    return `${description}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(content) {
    const theme = getTheme()

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
} satisfies Tool<typeof inputSchema, TextBlock[]>
