import type { AssistantMessage, BinaryFeedbackResult, Message } from '@query'
import { query } from '@query'
import type { CanUseToolFn } from '@hooks/useCanUseTool'
import type { Tool, ToolUseContext } from '@tool'
import {
  emitRuntimeAgentEvent,
  ensureBuiltinRuntimeHooksRegistered,
  runAfterToolHooks,
  runBeforePromptHooks,
  runBeforeToolHooks,
} from './runtimeHooks'

type QueryToolUseContext = ToolUseContext & {
  options?: ToolUseContext['options'] & {
    tools?: Tool[]
    messageLogName?: string
  }
  setToolJSX: (jsx: any) => void
}

type GetBinaryFeedbackResponse = (
  m1: AssistantMessage,
  m2: AssistantMessage,
) => Promise<BinaryFeedbackResult>

export interface RunAgentRuntimeInput {
  messages: Message[]
  systemPrompt: string[]
  context: Record<string, string>
  canUseTool: CanUseToolFn
  toolUseContext: QueryToolUseContext
  getBinaryFeedbackResponse?: GetBinaryFeedbackResponse
}

function getSessionId(context: QueryToolUseContext): string | undefined {
  return context.options?.messageLogName
}

function getAgentId(context: QueryToolUseContext): string | undefined {
  return context.agentId
}

function extractAssistantText(message: AssistantMessage): {
  text: string
  toolUses: string[]
} {
  const toolUses: string[] = []
  const textParts: string[] = []

  for (const block of message.message.content ?? []) {
    if (!block || typeof block !== 'object') continue
    if ((block as any).type === 'text' && typeof (block as any).text === 'string') {
      textParts.push((block as any).text)
      continue
    }
    if ((block as any).type === 'tool_use' && typeof (block as any).name === 'string') {
      toolUses.push((block as any).name)
    }
  }

  return {
    text: textParts.join('\n').trim(),
    toolUses,
  }
}

function patchToolCalls(
  tools: Tool[],
  meta: { agentId?: string; sessionId?: string },
): () => void {
  const originals = new Map<Tool, Tool['call']>()
  const uniqueTools = Array.from(new Set(tools))

  for (const tool of uniqueTools) {
    const originalCall = tool.call
    originals.set(tool, originalCall)

    tool.call = (async function* wrappedToolCall(input: any, context: ToolUseContext) {
      await emitRuntimeAgentEvent({
        type: 'tool_start',
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        toolName: tool.name,
        input,
      })
      await runBeforeToolHooks({
        tool,
        input,
        context,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
      })

      let finalResultData: unknown = undefined
      try {
        const generator = originalCall.call(tool, input, context)
        for await (const chunk of generator) {
          if (chunk?.type === 'progress') {
            await emitRuntimeAgentEvent({
              type: 'tool_progress',
              agentId: meta.agentId,
              sessionId: meta.sessionId,
              toolName: tool.name,
            })
          } else if (chunk?.type === 'result') {
            finalResultData = chunk.data
          }
          yield chunk as any
        }

        await runAfterToolHooks({
          tool,
          input,
          context,
          status: 'success',
          result: finalResultData,
          agentId: meta.agentId,
          sessionId: meta.sessionId,
        })
        await emitRuntimeAgentEvent({
          type: 'tool_end',
          agentId: meta.agentId,
          sessionId: meta.sessionId,
          toolName: tool.name,
          status: 'success',
        })
      } catch (error) {
        await runAfterToolHooks({
          tool,
          input,
          context,
          status: 'error',
          error,
          agentId: meta.agentId,
          sessionId: meta.sessionId,
        })
        await emitRuntimeAgentEvent({
          type: 'tool_end',
          agentId: meta.agentId,
          sessionId: meta.sessionId,
          toolName: tool.name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }) as Tool['call']
  }

  return () => {
    for (const [tool, original] of originals) {
      tool.call = original
    }
  }
}

function wrapCanUseTool(
  canUseTool: CanUseToolFn,
  meta: { agentId?: string; sessionId?: string },
): CanUseToolFn {
  return async (tool, input, toolUseContext, assistantMessage) => {
    await emitRuntimeAgentEvent({
      type: 'permission_request',
      agentId: meta.agentId,
      sessionId: meta.sessionId,
      toolName: tool.name,
      input,
    })
    const result = await canUseTool(tool, input, toolUseContext, assistantMessage)
    const denyReason = result.result === false ? result.message : undefined
    await emitRuntimeAgentEvent({
      type: 'permission_result',
      agentId: meta.agentId,
      sessionId: meta.sessionId,
      toolName: tool.name,
      allowed: result.result,
      reason: denyReason,
    })
    return result
  }
}

export async function* runAgentRuntime(
  input: RunAgentRuntimeInput,
): AsyncGenerator<Message, void> {
  ensureBuiltinRuntimeHooksRegistered()

  const agentId = getAgentId(input.toolUseContext)
  const sessionId = getSessionId(input.toolUseContext)
  const tools = input.toolUseContext.options?.tools ?? []

  const patchedPrompt = await runBeforePromptHooks({
    systemPrompt: [...input.systemPrompt],
    context: { ...input.context },
    agentId,
    sessionId,
  })

  const restoreTools = patchToolCalls(tools, { agentId, sessionId })
  const wrappedCanUseTool = wrapCanUseTool(input.canUseTool, { agentId, sessionId })

  await emitRuntimeAgentEvent({
    type: 'runtime_start',
    agentId,
    sessionId,
    messageCount: input.messages.length,
  })

  let runtimeError: unknown = null
  try {
    for await (const message of query(
      input.messages,
      patchedPrompt.systemPrompt,
      patchedPrompt.context,
      wrappedCanUseTool,
      input.toolUseContext as any,
      input.getBinaryFeedbackResponse,
    )) {
      await emitRuntimeAgentEvent({
        type: 'message',
        agentId,
        sessionId,
        messageType: message.type,
      })

      if (message.type === 'assistant') {
        const summary = extractAssistantText(message)
        await emitRuntimeAgentEvent({
          type: 'assistant_message',
          agentId,
          sessionId,
          text: summary.text,
          toolUses: summary.toolUses,
        })
      }

      yield message
    }
  } catch (error) {
    runtimeError = error
    throw error
  } finally {
    restoreTools()
    await emitRuntimeAgentEvent({
      type: 'runtime_end',
      agentId,
      sessionId,
      success: runtimeError === null,
      error:
        runtimeError == null
          ? undefined
          : runtimeError instanceof Error
            ? runtimeError.message
            : String(runtimeError),
    })
  }
}
