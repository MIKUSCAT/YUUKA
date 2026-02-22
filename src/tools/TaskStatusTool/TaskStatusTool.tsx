import * as React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import type { Tool, ToolUseContext, ValidationResult } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { createAssistantMessage } from '@utils/messages'
import { getTheme } from '@utils/theme'
import { TASK_DASH } from '@constants/figures'
import { readTeamTask, type TeamTaskRecord } from '@services/teamManager'
import { getTeamTaskPath, normalizeTeamName } from '@services/teamPaths'

const inputSchema = z.strictObject({
  team_name: z.string().describe('Team name'),
  task_id: z.string().describe('Task ID returned by Task'),
  block: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to wait for completion'),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .optional()
    .default(30000)
    .describe('Max wait time in ms when block=true'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  team_name: string
  task_id: string
  agent_name: string
  description: string
  status: TeamTaskRecord['status']
  is_final: boolean
  started_at?: number
  ended_at?: number
  duration_ms?: number
  tool_use_count?: number
  token_count?: number
  error?: string
  result_text?: string
  progress_count: number
  last_progress?: {
    status?: string
    last_action?: string
    elapsed_ms?: number
    token_count?: number
    tool_count?: number
    created_at?: number
  }
  retrieval_status: 'success' | 'timeout'
}

function isFinalStatus(status: TeamTaskRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function normalizeInput(input: Record<string, unknown>): Input {
  const parsed = inputSchema.parse(input)
  return parsed
}

function buildOutput(task: TeamTaskRecord, retrievalStatus: Output['retrieval_status']): Output {
  const lastProgress = task.progress?.[task.progress.length - 1]
  return {
    team_name: task.teamName,
    task_id: task.id,
    agent_name: task.agentName,
    description: task.description,
    status: task.status,
    is_final: isFinalStatus(task.status),
    started_at: task.startedAt,
    ended_at: task.endedAt,
    duration_ms: task.durationMs,
    tool_use_count: task.toolUseCount,
    token_count: task.tokenCount,
    error: task.error,
    result_text: task.resultText,
    progress_count: task.progress?.length ?? 0,
    last_progress: lastProgress
      ? {
          status: lastProgress.status,
          last_action: lastProgress.lastAction,
          elapsed_ms: lastProgress.elapsedMs,
          token_count: lastProgress.tokenCount,
          tool_count: lastProgress.toolCount,
          created_at: lastProgress.createdAt,
        }
      : undefined,
    retrieval_status: retrievalStatus,
  }
}

function readTaskOrThrow(teamName: string, taskId: string): TeamTaskRecord {
  const path = getTeamTaskPath(teamName, taskId)
  const task = readTeamTask(path)
  if (!task) {
    throw new Error(`Task "${taskId}" not found in team "${teamName}"`)
  }
  return task
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true
  return await new Promise(resolve => {
    const t = setTimeout(() => {
      cleanup()
      resolve(false)
    }, ms)
    const onAbort = () => {
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const TaskStatusTool = {
  name: 'TaskStatus',
  async description() {
    return 'Get teammate task status or wait for a teammate task to finish'
  },
  async prompt() {
    return `Use TaskStatus after Task(wait_for_completion=false) to check progress or wait for completion.

Patterns:
- Start true parallel teammates with Task(wait_for_completion=false)
- Coordinate via SendMessage / shared task tools while they run
- Use TaskStatus(block=false) for quick snapshots
- Use TaskStatus(block=true) when you are ready to wait for one task to finish`
  },
  userFacingName() {
    return 'TaskStatus'
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return false
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    const normalized = normalizeInput(input as any)
    const teamName = normalizeTeamName(normalized.team_name)
    try {
      readTaskOrThrow(teamName, normalized.task_id)
      return { result: true }
    } catch (error) {
      return {
        result: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  },
  renderToolUseMessage(input: Input) {
    const normalized = normalizeInput(input as any)
    return normalized.block ? `wait ${normalized.task_id}` : `peek ${normalized.task_id}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output) {
    const theme = getTheme()
    const color =
      output.status === 'completed'
        ? theme.success
        : output.status === 'failed' || output.status === 'cancelled'
          ? theme.warning
          : theme.secondaryText
    return (
      <Box flexDirection="row">
        <Text color={theme.yuuka}> {TASK_DASH} </Text>
        <Text color={color}>
          {output.agent_name} · {output.status} · task_id={output.task_id}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    return JSON.stringify(output, null, 2)
  },
  async *call(input: Input, context: ToolUseContext) {
    const normalized = normalizeInput(input as any)
    const teamName = normalizeTeamName(normalized.team_name)

    if (!normalized.block) {
      const task = readTaskOrThrow(teamName, normalized.task_id)
      const out = buildOutput(task, 'success')
      yield {
        type: 'result',
        data: out,
        resultForAssistant: this.renderResultForAssistant(out),
      }
      return
    }

    yield {
      type: 'progress',
      content: createAssistantMessage(
        `TaskStatus 等待任务结束…（team=${teamName}，task_id=${normalized.task_id}）`,
      ),
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < normalized.timeout) {
      if (context.abortController.signal.aborted) {
        const task = readTaskOrThrow(teamName, normalized.task_id)
        const out = buildOutput(task, 'timeout')
        yield {
          type: 'result',
          data: out,
          resultForAssistant: this.renderResultForAssistant(out),
        }
        return
      }

      const task = readTaskOrThrow(teamName, normalized.task_id)
      if (isFinalStatus(task.status)) {
        const out = buildOutput(task, 'success')
        yield {
          type: 'result',
          data: out,
          resultForAssistant: this.renderResultForAssistant(out),
        }
        return
      }

      const aborted = await sleepWithAbort(250, context.abortController.signal)
      if (aborted) {
        const latest = readTaskOrThrow(teamName, normalized.task_id)
        const out = buildOutput(latest, 'timeout')
        yield {
          type: 'result',
          data: out,
          resultForAssistant: this.renderResultForAssistant(out),
        }
        return
      }
    }

    const latest = readTaskOrThrow(teamName, normalized.task_id)
    const out = buildOutput(latest, 'timeout')
    yield {
      type: 'result',
      data: out,
      resultForAssistant: this.renderResultForAssistant(out),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
