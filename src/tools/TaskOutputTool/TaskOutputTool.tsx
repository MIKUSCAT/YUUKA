import { Box, Text } from 'ink'
import * as React from 'react'
import { z } from 'zod'
import type { Tool, ToolUseContext, ValidationResult } from '@tool'
import { createAssistantMessage } from '@utils/messages'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'
import { OutputLine } from '@tools/BashTool/OutputLine'
import { formatOutput } from '@tools/BashTool/utils'
import {
  hasTaskOutput,
  readTaskExitCode,
  readTaskOutput,
} from '@utils/taskOutputStore'
import { DESCRIPTION, PROMPT, TOOL_NAME_FOR_PROMPT } from './prompt'

const inputSchema = z.strictObject({
  task_id: z.string().describe('The task ID to get output from'),
  block: z.boolean().optional().default(false).describe('Whether to wait for completion'),
  timeout: z
    .number()
    .min(0)
    .max(600000)
    .optional()
    .default(30000)
    .describe('Max wait time in ms (only when block=true)'),
})

type Input = z.infer<typeof inputSchema>

type TaskStatus = 'running' | 'completed' | 'failed'
type RetrievalStatus = 'success' | 'timeout' | 'not_ready'

type Output = {
  retrieval_status: RetrievalStatus
  task_id: string
  status: TaskStatus
  exit_code: number | null
  output: string
  output_lines: number
}

function normalizeInput(input: Record<string, unknown>): Input {
  const task_id =
    (typeof input.task_id === 'string' && input.task_id) ||
    (typeof (input as any).taskId === 'string' && String((input as any).taskId)) ||
    ''

  const block = typeof input.block === 'boolean' ? input.block : false

  const timeout =
    typeof input.timeout === 'number'
      ? input.timeout
      : typeof (input as any).wait_up_to === 'number'
        ? Number((input as any).wait_up_to) * 1000
        : 30000

  return { task_id, block, timeout }
}

function buildOutput(taskId: string, retrieval: RetrievalStatus): Output {
  const exitCode = readTaskExitCode(taskId)
  const status: TaskStatus =
    exitCode === null ? 'running' : exitCode === 0 ? 'completed' : 'failed'

  const raw = readTaskOutput(taskId)
  const trimmed = raw.trimEnd()
  const { totalLines, truncatedContent } = formatOutput(trimmed)

  return {
    retrieval_status: retrieval,
    task_id: taskId,
    status,
    exit_code: exitCode,
    output: truncatedContent,
    output_lines: totalLines,
  }
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

export const TaskOutputTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Task Output'
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
  async prompt() {
    return PROMPT
  },
  renderToolUseMessage(input: any) {
    const normalized = normalizeInput(input as any)
    return normalized.block ? 'block=true' : 'block=false'
  },
  renderToolResultMessage(
    output: Output,
    options?: { verbose: boolean },
  ): React.ReactElement {
    const theme = getTheme()
    const verbose = Boolean(options?.verbose)

    const statusText =
      output.status === 'running'
        ? '任务还在运行…'
        : `已结束（exit_code=${output.exit_code ?? 'unknown'}）`

    const content = output.output?.trimEnd() ?? ''
    const lines = output.output_lines ?? 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.secondaryText}>
            {statusText}（task_id={output.task_id}）
          </Text>
        </Box>
        {content ? (
          <OutputLine content={content} lines={lines} verbose={verbose} />
        ) : (
          <Box flexDirection="row">
            <Text color={theme.secondaryText}>{TREE_END} </Text>
            <Text color={theme.secondaryText}>(No content)</Text>
          </Box>
        )}
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    const parts: string[] = []
    parts.push(`<retrieval_status>${output.retrieval_status}</retrieval_status>`)
    parts.push(`<task_id>${output.task_id}</task_id>`)
    parts.push(`<status>${output.status}</status>`)
    if (output.exit_code !== null) {
      parts.push(`<exit_code>${output.exit_code}</exit_code>`)
    }
    if (output.output?.trim()) {
      parts.push(`<output>\n${output.output.trimEnd()}\n</output>`)
    }
    return parts.join('\n\n')
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    const normalized = normalizeInput(input as any)
    if (!normalized.task_id) {
      return { result: false, message: 'Task ID is required', errorCode: 1 }
    }
    if (!hasTaskOutput(normalized.task_id)) {
      return {
        result: false,
        message: `No task output found for ID: ${normalized.task_id}`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async *call(input: Input, context: ToolUseContext) {
    const normalized = normalizeInput(input as any)
    const taskId = normalized.task_id
    const block = normalized.block
    const timeoutMs = normalized.timeout

    if (!hasTaskOutput(taskId)) {
      throw new Error(`No task output found for ID: ${taskId}`)
    }

    const initialExitCode = readTaskExitCode(taskId)
    const initialDone = initialExitCode !== null
    if (!block) {
      const out = buildOutput(taskId, initialDone ? 'success' : 'not_ready')
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
        `TaskOutput 等待任务结束…（task_id=${taskId}，esc 可取消）`,
      ),
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (context.abortController.signal.aborted) {
        const out = buildOutput(taskId, 'timeout')
        yield {
          type: 'result',
          data: out,
          resultForAssistant: this.renderResultForAssistant(out),
        }
        return
      }

      const exitCode = readTaskExitCode(taskId)
      if (exitCode !== null) {
        const out = buildOutput(taskId, 'success')
        yield {
          type: 'result',
          data: out,
          resultForAssistant: this.renderResultForAssistant(out),
        }
        return
      }

      const aborted = await sleepWithAbort(250, context.abortController.signal)
      if (aborted) {
        const out = buildOutput(taskId, 'timeout')
        yield {
          type: 'result',
          data: out,
          resultForAssistant: this.renderResultForAssistant(out),
        }
        return
      }
    }

    const out = buildOutput(taskId, 'timeout')
    yield {
      type: 'result',
      data: out,
      resultForAssistant: this.renderResultForAssistant(out),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
