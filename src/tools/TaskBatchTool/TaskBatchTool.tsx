import { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { createAssistantMessage, INTERRUPT_MESSAGE } from '@utils/messages'
import { getTheme } from '@utils/theme'
import { getGlobalConfig } from '@utils/config'
import { all } from '@utils/generators'
import { TaskTool } from '@tools/TaskTool/TaskTool'
import { normalizeTeamName } from '@services/teamPaths'
import {
  encodeTaskProgress,
  parseTaskProgressText,
} from '@components/messages/TaskProgressMessage'
import {
  formatTaskTerminalFailureText,
  summarizeTaskResultText,
} from '@utils/taskResultSummary'
import { tryCreateAutoSnapshotFromContext } from '@utils/snapshotStore'
import {
  emitTaskDiagnosticEvent,
  emitTaskSummaryEvent,
} from '@utils/taskAutomation'

const DEFAULT_BATCH_CONCURRENCY = 4
const MAX_BATCH_CONCURRENCY = 20
const MIN_BATCH_PARALLELISM = 2

const taskItemSchema = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  model_name: z
    .string()
    .optional()
    .describe('Optional model name for this task'),
  subagent_type: z
    .string()
    .optional()
    .describe('The type of specialized agent to use'),
  team_name: z
    .string()
    .optional()
    .describe('Optional team workspace name (TEAM mode)'),
  name: z
    .string()
    .optional()
    .describe('Optional teammate instance name (TEAM mode)'),
})

const inputSchema = z.object({
  tasks: z
    .array(taskItemSchema)
    .min(1)
    .max(32)
    .describe('Task list to execute in parallel'),
  max_concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_BATCH_CONCURRENCY)
    .optional()
    .describe('Optional concurrency cap for this batch'),
})

type TaskBatchInput = z.infer<typeof inputSchema>
type TaskCallResult = { type: 'result'; data: TextBlock[]; resultForAssistant?: string }

type TaskBatchItemResult = {
  index: number
  description: string
  agentType: string
  status: 'completed' | 'failed'
  output: string
  reportPath?: string
  errorSummary?: string
}

type TaskBatchOut = {
  total: number
  maxConcurrency: number
  succeeded: number
  failed: number
  results: TaskBatchItemResult[]
}

type TaskBatchProgressEvent = {
  index: number
  progress: {
    type: 'progress'
    content: any
  }
}

type TaskBatchDoneEvent = {
  index: number
  result: TaskCallResult
  hadRuntimeError: boolean
  runtimeTaskId?: string
  runtimeAgentName?: string
  runtimeTeamName?: string
  lastToolCount?: number
  lastElapsedMs?: number
}

type TaskBatchWorkerEvent = TaskBatchProgressEvent | TaskBatchDoneEvent

function textBlocksToString(data: TextBlock[]): string {
  return data.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BATCH_CONCURRENCY
  return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, Math.floor(value)))
}

function resolveDefaultConcurrency(): number {
  const configured = Number(getGlobalConfig().maxToolUseConcurrency)
  return clampConcurrency(configured)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

function computeStartupSpreadDelay(index: number, maxConcurrency: number): number {
  if (index <= 0) return 0
  const safeConcurrency = Math.max(1, Math.floor(maxConcurrency))
  // Keep a small startup spread to reduce transient 429,
  // but avoid linear delay growth that hurts true parallelism.
  const slot = index % safeConcurrency
  const base = slot * 80
  const jitter = Math.floor(Math.random() * 35)
  return base + jitter
}

async function* runSingleTask(
  index: number,
  task: TaskBatchInput['tasks'][number],
  batchId: string,
  unifiedTeamName: string,
  maxConcurrency: number,
  context: any,
): AsyncGenerator<TaskBatchWorkerEvent, void, unknown> {
  const preparedTask = {
    ...task,
    team_name: unifiedTeamName,
    name: task.name || `batch-${batchId}-${index + 1}`,
  }
  let runtimeTaskId: string | undefined
  let runtimeAgentName: string | undefined
  let runtimeTeamName: string | undefined
  let lastToolCount: number | undefined
  let lastElapsedMs: number | undefined

  try {
    yield {
      index,
      progress: {
        type: 'progress' as const,
        content: createAssistantMessage(
          encodeTaskProgress({
            agentType: task.subagent_type || 'general-purpose',
            status: '启动中',
            description: task.description,
            model: task.model_name || 'task',
            toolCount: 0,
            elapsedMs: 0,
            lastAction: `batch admitted worker ${preparedTask.name}`,
            teamName: unifiedTeamName,
            agentName: preparedTask.name,
            taskId: `seed-${index + 1}`,
            taskState: 'in_progress',
            eventType: 'status',
            eventContent: 'worker admitted',
          }),
        ),
      },
    }

    // Small bounded spread (instead of index-based linear delay) keeps API safer
    // while preserving high parallel throughput.
    const staggerDelayMs = computeStartupSpreadDelay(index, maxConcurrency)
    if (staggerDelayMs > 0) {
      await new Promise(r => setTimeout(r, staggerDelayMs))
    }

    const validation = await TaskTool.validateInput?.(preparedTask as any, context)
    if (validation?.result === false) {
      throw new Error(validation.message || 'Task validation failed')
    }

    let finalResult: TaskCallResult | null = null
    for await (const event of TaskTool.call(preparedTask as any, context)) {
      if (event.type === 'progress') {
        const textBlock = (event as any)?.content?.message?.content?.[0]
        const text = textBlock?.type === 'text' ? textBlock.text : null
        if (typeof text === 'string') {
          const payload = parseTaskProgressText(text)
          if (payload) {
            runtimeTaskId = payload.taskId || runtimeTaskId
            runtimeAgentName = payload.agentName || runtimeAgentName
            runtimeTeamName = payload.teamName || runtimeTeamName
            if (typeof payload.toolCount === 'number') {
              lastToolCount = payload.toolCount
            }
            if (typeof payload.elapsedMs === 'number') {
              lastElapsedMs = payload.elapsedMs
            }
          }
        }
        yield {
          index,
          progress: event,
        }
        continue
      }
      if (event.type === 'result') {
        finalResult = event as TaskCallResult
      }
    }

    if (!finalResult) {
      throw new Error('Task execution ended unexpectedly without result.')
    }

    yield {
      index,
      result: finalResult,
      hadRuntimeError: false,
      runtimeTaskId,
      runtimeAgentName,
      runtimeTeamName,
      lastToolCount,
      lastElapsedMs,
    }
  } catch (error) {
    const errorText = formatTaskTerminalFailureText('failed', toErrorMessage(error))
    const data: TextBlock[] = [{ type: 'text', text: errorText }] as TextBlock[]
    yield {
      index,
      result: {
        type: 'result',
        data,
        resultForAssistant: errorText,
      },
      hadRuntimeError: true,
      runtimeTaskId,
      runtimeAgentName,
      runtimeTeamName,
      lastToolCount,
      lastElapsedMs,
    }
  }
}

export const TaskBatchTool = {
  name: 'TaskBatch',
  async description() {
    return 'Launch multiple Task tool invocations in one call with guaranteed parallel execution'
  },
  async prompt() {
    return `Use TaskBatch when you have 2+ independent subtasks and need deterministic parallel execution.

Input:
- tasks: array of Task payloads (description, prompt, optional model_name/subagent_type/team_name/name)
- max_concurrency: optional batch concurrency cap (default: max(global maxToolUseConcurrency, 2), fallback 4)

Behavior:
- Runs multiple Task invocations concurrently (up to max_concurrency)
- Collects each subtask final result and returns a summary
- If you need live TEAM coordination while tasks are running, prefer multiple Task(wait_for_completion=false) launches + TaskStatus instead of TaskBatch waiting to the end

Hard rule:
- One TaskBatch call must use exactly ONE team.
- If you need parallelism, create multiple AGENTs in that single team instead of multiple teams.`
  },
  inputSchema,
  userFacingName() {
    return 'TaskBatch'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions() {
    return false
  },
  async validateInput(input, context) {
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
      return { result: false, message: 'tasks must contain at least one task' }
    }

    const contextTeamName = String((context as any)?.options?.teamName || '').trim()
    const fallbackTeamBase = contextTeamName || String((context as any)?.options?.messageLogName || 'default-team')
    const normalizedTeams = new Set(
      input.tasks.map(task => normalizeTeamName(task.team_name || fallbackTeamBase)),
    )
    if (normalizedTeams.size > 1) {
      return {
        result: false,
        message:
          'TaskBatch 一次调用只允许一个 TEAM。请把所有 tasks 的 team_name 统一后再试。',
      }
    }

    for (let i = 0; i < input.tasks.length; i++) {
      const task = input.tasks[i]
      const validation = await TaskTool.validateInput?.(task as any, context)
      if (validation?.result === false) {
        return {
          result: false,
          message: `Task #${i + 1} invalid: ${validation.message || 'validation failed'}`,
        }
      }
    }
    return { result: true }
  },
  async *call(input: TaskBatchInput, context) {
    const snapshotLabel = `taskbatch:${input.tasks.length}`.slice(0, 96)
    const createAutoSnapshot = (reason: string) => {
      tryCreateAutoSnapshotFromContext(context as any, reason, snapshotLabel)
    }
    createAutoSnapshot('taskbatch_before')

    const batchId = Date.now().toString(36)
    const defaultBatchConcurrency = Math.max(
      MIN_BATCH_PARALLELISM,
      resolveDefaultConcurrency(),
    )
    const maxConcurrency = clampConcurrency(
      input.max_concurrency ?? defaultBatchConcurrency,
    )
    const total = input.tasks.length
    const results: Array<TaskBatchItemResult | null> = new Array(total).fill(null)
    const contextTeamName = String((context as any)?.options?.teamName || '').trim()
    const fallbackTeamBase =
      contextTeamName ||
      String((context as any)?.options?.messageLogName || 'default-team')
    const normalizedTeams = new Set(
      input.tasks.map(task => normalizeTeamName(task.team_name || fallbackTeamBase)),
    )
    if (normalizedTeams.size > 1) {
      emitTaskDiagnosticEvent('TaskBatch', {
        status: 'failed',
        reason: 'multiple-team-name-detected',
        total: input.tasks.length,
      })
      createAutoSnapshot('taskbatch_after_failed')
      throw new Error('TaskBatch detected multiple team_name values in one call')
    }
    const unifiedTeamName =
      [...normalizedTeams][0] || normalizeTeamName(fallbackTeamBase)

    yield {
      type: 'progress' as const,
      content: createAssistantMessage(
        `TaskBatch 启动 ${total} 个任务（TEAM=${unifiedTeamName}，并发上限 ${maxConcurrency}）`,
      ),
    }

    for (let i = 0; i < input.tasks.length; i++) {
      const task = input.tasks[i]
      const seedAgentName = task.name || `batch-${batchId}-${i + 1}`
      yield {
        type: 'progress' as const,
        content: createAssistantMessage(
          encodeTaskProgress({
            agentType: task.subagent_type || 'general-purpose',
            status: '排队中',
            description: task.description,
            model: task.model_name || 'task',
            toolCount: 0,
            elapsedMs: 0,
            lastAction: `batch queued worker ${seedAgentName}`,
            teamName: unifiedTeamName,
            agentName: seedAgentName,
            taskId: `seed-${i + 1}`,
            taskState: 'open',
            eventType: 'status',
            eventContent: 'queued by batch scheduler',
          }),
        ),
      }
    }

    let finished = 0
    const generators = input.tasks.map((task, index) =>
      runSingleTask(index, task, batchId, unifiedTeamName, maxConcurrency, context),
    )

    for await (const done of all(generators, maxConcurrency)) {
      if ('progress' in done) {
        yield done.progress
        continue
      }

      finished++
      const outputText =
        done.result.resultForAssistant || textBlocksToString(done.result.data)
      const parsedSummary = summarizeTaskResultText(outputText)
      const failed =
        done.hadRuntimeError ||
        parsedSummary.status === 'failed' ||
        parsedSummary.status === 'cancelled' ||
        outputText.trim() === INTERRUPT_MESSAGE
      const task = input.tasks[done.index]
      const finalAgentName =
        done.runtimeAgentName || task.name || `batch-${batchId}-${done.index + 1}`
      const finalTeamName = normalizeTeamName(done.runtimeTeamName || unifiedTeamName)
      const finalTaskId = done.runtimeTaskId || `seed-${done.index + 1}`
      const compactOutput = outputText.replace(/\s+/g, ' ').trim()
      const finalEventContent = parsedSummary.reportPath
        ? `REPORT_PATH: ${parsedSummary.reportPath}`
        : parsedSummary.errorSummary ||
          (compactOutput.length > 180 ? `${compactOutput.slice(0, 180)}...` : compactOutput)
      const entry: TaskBatchItemResult = {
        index: done.index + 1,
        description: task.description,
        agentType: task.subagent_type || 'general-purpose',
        status: failed ? 'failed' : 'completed',
        output: outputText,
        ...(parsedSummary.reportPath ? { reportPath: parsedSummary.reportPath } : {}),
        ...(parsedSummary.errorSummary ? { errorSummary: parsedSummary.errorSummary } : {}),
      }
      results[done.index] = entry

      yield {
        type: 'progress' as const,
        content: createAssistantMessage(
          encodeTaskProgress({
            agentType: task.subagent_type || 'general-purpose',
            status: failed ? '已结束' : '已完成',
            description: task.description,
            model: task.model_name || 'task',
            toolCount: done.lastToolCount ?? 0,
            elapsedMs: done.lastElapsedMs,
            lastAction: failed ? 'task failed' : 'task completed',
            teamName: finalTeamName,
            agentName: finalAgentName,
            taskId: finalTaskId,
            taskState: failed ? 'failed' : 'completed',
            eventType: failed ? 'status' : 'result',
            eventContent:
              finalEventContent ||
              (failed ? 'task failed without output' : 'task completed'),
          }),
        ),
      }

      yield {
        type: 'progress' as const,
        content: createAssistantMessage(
          `TaskBatch 进度 ${finished}/${total}: #${entry.index} ${entry.description}（${entry.status}）`,
        ),
      }
    }

    const normalizedResults = results.filter(Boolean) as TaskBatchItemResult[]
    const failedCount = normalizedResults.filter(item => item.status === 'failed').length
    const data: TaskBatchOut = {
      total,
      maxConcurrency,
      succeeded: normalizedResults.length - failedCount,
      failed: failedCount,
      results: normalizedResults,
    }

    if (failedCount > 0) {
      emitTaskDiagnosticEvent('TaskBatch', {
        status: 'failed',
        total,
        succeeded: data.succeeded,
        failed: failedCount,
        teamName: unifiedTeamName,
      })
      createAutoSnapshot('taskbatch_after_failed')
    } else {
      emitTaskSummaryEvent('TaskBatch', {
        status: 'completed',
        total,
        succeeded: data.succeeded,
        maxConcurrency,
        teamName: unifiedTeamName,
      })
      createAutoSnapshot('taskbatch_after_completed')
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderResultForAssistant(output: TaskBatchOut) {
    return JSON.stringify(output, null, 2)
  },
  renderToolUseMessage(input: TaskBatchInput) {
    const defaultBatchConcurrency = Math.max(
      MIN_BATCH_PARALLELISM,
      resolveDefaultConcurrency(),
    )
    const maxConcurrency = clampConcurrency(
      input.max_concurrency ?? defaultBatchConcurrency,
    )
    return `${input.tasks.length} tasks (max ${maxConcurrency})`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TaskBatchOut) {
    const theme = getTheme()
    const summaryColor = output.failed > 0 ? theme.warning : theme.success
    const reportResults = output.results.filter(item => item.reportPath)
    const failedResults = output.results.filter(item => item.status === 'failed')
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={summaryColor}>
            TaskBatch completed: {output.succeeded}/{output.total} succeeded
          </Text>
        </Box>
        {output.failed > 0 && (
          <Box flexDirection="row">
            <Text color={theme.warning}>Failed: {output.failed}</Text>
          </Box>
        )}
        {reportResults.length > 0 && (
          <Box flexDirection="column">
            <Text color={theme.success}>Reports: {reportResults.length}</Text>
            {reportResults.slice(0, 3).map(item => (
              <Box key={`report-${item.index}`} marginLeft={2}>
                <Text color={theme.secondaryText}>
                  #{item.index} {truncate(item.reportPath || '', 90)}
                </Text>
              </Box>
            ))}
            {reportResults.length > 3 && (
              <Box marginLeft={2}>
                <Text color={theme.secondaryText}>
                  ...and {reportResults.length - 3} more report paths
                </Text>
              </Box>
            )}
          </Box>
        )}
        {failedResults.length > 0 && (
          <Box flexDirection="column">
            {failedResults.slice(0, 3).map(item => (
              <Box key={`failed-${item.index}`} marginLeft={2}>
                <Text color={theme.warning}>
                  #{item.index} {item.description}: {truncate(item.errorSummary || item.output.replace(/\s+/g, ' ').trim(), 90)}
                </Text>
              </Box>
            ))}
            {failedResults.length > 3 && (
              <Box marginLeft={2}>
                <Text color={theme.secondaryText}>
                  ...and {failedResults.length - 3} more failed tasks
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  },
} satisfies Tool<typeof inputSchema, TaskBatchOut>
