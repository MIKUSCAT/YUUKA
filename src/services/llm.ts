import { randomUUID } from 'crypto'
import type { AssistantMessage, UserMessage } from '@query'
import type { Tool, ToolUseContext } from '@tool'
import { getGlobalConfig } from '@utils/config'
import { getCLISyspromptPrefix } from '@constants/prompts'
import { queryGeminiLLM } from './gemini/query'
import {
  debug as debugLogger,
  getCurrentRequest,
  logErrorWithDiagnosis,
  markPhase,
} from '@utils/debugLogger'
import {
  API_ERROR_MESSAGE_PREFIX,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  MAIN_QUERY_TEMPERATURE,
  NO_CONTENT_MESSAGE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './llm/constants'
import { verifyApiKey } from './llm/providerVerification'
import { formatSystemPromptWithContext } from './llm/systemPrompt'
import { generateYuukaContext, refreshYuukaContext } from './llm/yuukaContext'

export {
  API_ERROR_MESSAGE_PREFIX,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  MAIN_QUERY_TEMPERATURE,
  NO_CONTENT_MESSAGE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  formatSystemPromptWithContext,
  generateYuukaContext,
  refreshYuukaContext,
  verifyApiKey,
}

export async function queryLLM(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  maxThinkingTokens: number,
  tools: Tool[],
  signal: AbortSignal,
  options: {
    safeMode: boolean
    model: string | import('@utils/config').ModelPointerType
    prependCLISysprompt: boolean
    toolUseContext?: ToolUseContext
  },
): Promise<AssistantMessage> {
  const currentRequest = getCurrentRequest()
  debugLogger.api('LLM_REQUEST_START', {
    messageCount: messages.length,
    systemPromptLength: systemPrompt.join(' ').length,
    toolCount: tools.length,
    maxThinkingTokens,
    model: options.model,
    requestId: currentRequest?.id,
  })

  markPhase('LLM_CALL')

  try {
    const finalSystemPrompt = options.prependCLISysprompt
      ? [getCLISyspromptPrefix(), ...systemPrompt]
      : systemPrompt

    const config = getGlobalConfig()
    const result = await queryGeminiLLM({
      messages,
      systemPrompt: finalSystemPrompt,
      tools,
      signal,
      model: options.model as any,
      stream: config.stream ?? true,
    })

    debugLogger.api('LLM_REQUEST_SUCCESS', {
      costUSD: result.costUSD,
      durationMs: result.durationMs,
      responseLength: result.message.content?.length || 0,
      requestId: getCurrentRequest()?.id,
    })

    return result
  } catch (error) {
    logErrorWithDiagnosis(
      error,
      {
        messageCount: messages.length,
        systemPromptLength: systemPrompt.join(' ').length,
        maxThinkingTokens,
        model: options.model,
        toolCount: tools.length,
        phase: 'LLM_CALL',
      },
      currentRequest?.id,
    )
    throw error
  }
}

export async function queryModel(
  modelPointer: import('@utils/config').ModelPointerType,
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[] = [],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  return queryLLM(
    messages,
    systemPrompt,
    0,
    [],
    signal || new AbortController().signal,
    {
      safeMode: false,
      model: modelPointer,
      prependCLISysprompt: true,
    },
  )
}

export async function queryQuick({
  systemPrompt = [],
  userPrompt,
  signal,
}: {
  systemPrompt?: string[]
  userPrompt: string
  assistantPrompt?: string
  enablePromptCaching?: boolean
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  const messages = [
    {
      message: { role: 'user', content: userPrompt },
      type: 'user',
      uuid: randomUUID(),
    },
  ] as (UserMessage | AssistantMessage)[]

  return queryModel('quick', messages, systemPrompt, signal)
}
