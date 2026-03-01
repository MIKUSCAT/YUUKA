import { randomUUID } from 'node:crypto'
import {
  ensureGlobalGeminiSettings,
  getGlobalGeminiSettingsPath,
  normalizeGeminiApiRoot,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
  type GeminiSettings,
} from '@utils/geminiSettings'
import type { AssistantMessage, UserMessage } from '@query'
import type { Tool } from '@tool'
import { getModelManager } from '@utils/model'
import {
  getGeminiCliAuthContext,
  CODE_ASSIST_ENDPOINT,
  recordGeminiCliConversationOfferedBestEffort,
} from './codeAssistAuth'
import { CodeAssistTransport } from './codeAssistTransport'
import { GeminiTransport } from './transport'
import { kodeMessagesToGeminiContents, geminiResponseToAssistantMessage, toolsToFunctionDeclarations } from './adapter'
import { resolveGeminiModelConfig } from './modelConfig'
import type { GeminiContent, GeminiGenerateContentResponse, GeminiPart } from './types'
import { setSessionState, getSessionState } from '@utils/sessionState'
import { GeminiHttpError } from './transport'
import { applyGroundingCitations, extractGeminiGrounding, type GroundingSource } from './grounding'
import { acquireApiSlot, releaseApiSlot } from '@utils/apiSemaphore'

const NO_CONTENT_TEXTS = new Set([
  '(no content)',
  '(No content)',
  '（模型没有输出可见内容，请重试）',
])
const RETRY_MAX_ATTEMPTS = 3
const RETRY_INITIAL_DELAY_MS = 5000
const RETRY_MAX_DELAY_MS = 30000

type ThoughtSummary = {
  subject: string
  description: string
}

const THOUGHT_START_DELIMITER = '**'
const THOUGHT_END_DELIMITER = '**'

function parseThought(rawText: string): ThoughtSummary {
  const text = String(rawText ?? '').trim()
  const startIndex = text.indexOf(THOUGHT_START_DELIMITER)
  if (startIndex === -1) {
    return { subject: '', description: text }
  }

  const endIndex = text.indexOf(
    THOUGHT_END_DELIMITER,
    startIndex + THOUGHT_START_DELIMITER.length,
  )
  if (endIndex === -1) {
    return { subject: '', description: text }
  }

  const subject = text
    .substring(startIndex + THOUGHT_START_DELIMITER.length, endIndex)
    .trim()

  const description = (
    text.substring(0, startIndex) +
    text.substring(endIndex + THOUGHT_END_DELIMITER.length)
  ).trim()

  return { subject, description }
}

function resolveResponseTraceId(response: GeminiGenerateContentResponse): string | undefined {
  const traceId = (response as any)?.traceId
  if (typeof traceId === 'string' && traceId.trim()) {
    return traceId.trim()
  }
  return undefined
}

function hasResponseFunctionCalls(response: GeminiGenerateContentResponse): boolean {
  if (Array.isArray(response.functionCalls) && response.functionCalls.length > 0) {
    return true
  }
  const parts = response.candidates?.[0]?.content?.parts ?? []
  return parts.some(part => !!(part as any)?.functionCall)
}

function responseIncludesCodeFence(response: GeminiGenerateContentResponse): boolean {
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts ?? []
    for (const part of parts as any[]) {
      if (typeof part?.text === 'string' && part.text.includes('```')) {
        return true
      }
    }
  }
  return false
}

function maybeReportCodeAssistConversationOffered(options: {
  oauthContext: { accessToken: string; projectId: string } | null
  response: GeminiGenerateContentResponse
  signal: AbortSignal
}): void {
  if (!options.oauthContext) return
  const traceId = resolveResponseTraceId(options.response)
  const hasFunctionCalls = hasResponseFunctionCalls(options.response)
  if (!traceId || !hasFunctionCalls) return
  const status = options.signal.aborted ? 'cancelled' : 'no_error'
  const includedCode = responseIncludesCodeFence(options.response)
  void recordGeminiCliConversationOfferedBestEffort({
    accessToken: options.oauthContext.accessToken,
    projectId: options.oauthContext.projectId,
    traceId,
    hasFunctionCalls,
    includedCode,
    status,
  })
}

function isNoContentAssistantMessage(message: AssistantMessage): boolean {
  const raw = (message as any)?.message?.content

  if (!raw) return true

  if (typeof raw === 'string') {
    const text = raw.trim()
    return text.length === 0 || NO_CONTENT_TEXTS.has(text)
  }

  if (Array.isArray(raw)) {
    for (const block of raw as any[]) {
      if (!block || typeof block !== 'object') continue
      const type = String((block as any).type ?? '')
      if (type === 'tool_use' || type === 'image') return false
      if (type === 'text') {
        const text = String((block as any).text ?? '').trim()
        if (text && !NO_CONTENT_TEXTS.has(text)) {
          return false
        }
      }
    }
    return true
  }

  return false
}

function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'object') {
    const name = (error as any).name
    if (name === 'AbortError') return true
    const code = (error as any).code
    if (code === 'ABORT_ERR') return true
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    if (typeof error.message === 'string' && /aborted/i.test(error.message)) {
      return true
    }
  }
  return false
}

function isRetryableGeminiError(error: unknown): { retryable: boolean; reason: string } {
  if (!error) return { retryable: false, reason: 'unknown' }
  if (isAbortError(error)) return { retryable: false, reason: 'aborted' }

  if (error instanceof GeminiHttpError) {
    const status = error.status
    if (status === 408 || status === 429) {
      return { retryable: true, reason: `HTTP ${status}` }
    }
    if (status >= 500 && status <= 599) {
      return { retryable: true, reason: `HTTP ${status}` }
    }
    return { retryable: false, reason: `HTTP ${status}` }
  }

  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)

  // fetch/网络类错误：best-effort
  if (
    /fetch failed/i.test(msg) ||
    /network/i.test(msg) ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(msg)
  ) {
    return { retryable: true, reason: 'network' }
  }

  return { retryable: false, reason: 'non-retryable' }
}

function computeBackoffMs(attempt: number): number {
  const currentDelay = Math.min(
    RETRY_MAX_DELAY_MS,
    Math.floor(RETRY_INITIAL_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))),
  )
  const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1)
  return Math.max(0, Math.floor(currentDelay + jitter))
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

function wrapGeminiRequestError(
  error: unknown,
  meta: {
    stage: 'llm' | 'tools-only'
    model: string
    modelKey: string
    attempt: number
    maxAttempts: number
  },
): Error {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  const message = `Gemini ${meta.stage} request failed (modelKey=${meta.modelKey}, model=${meta.model}, attempt=${meta.attempt}/${meta.maxAttempts}): ${raw}`
  const wrapped = new Error(message)
  ;(wrapped as any).cause = error
  return wrapped
}

function getProjectSettings(): { settings: GeminiSettings; path: string } {
  const ensured = ensureGlobalGeminiSettings()
  const settingsPath = ensured.settingsPath || getGlobalGeminiSettingsPath()
  const settings = readGeminiSettingsFile(settingsPath)
  return {
    settings,
    path: settingsPath,
  }
}

function getGeminiApiKeyAuth(
  settings: GeminiSettings,
  path: string,
): { baseUrl: string; apiKey: string; apiKeyAuthMode: 'x-goog-api-key' | 'query' | 'bearer' } {
  const baseUrl =
    settings.security?.auth?.geminiApi?.baseUrl ??
    'https://generativelanguage.googleapis.com'
  const apiKey = settings.security?.auth?.geminiApi?.apiKey ?? ''
  const rawMode = settings.security?.auth?.geminiApi?.apiKeyAuthMode
  const apiKeyAuthMode: 'x-goog-api-key' | 'query' | 'bearer' =
    rawMode === 'bearer' || rawMode === 'query' || rawMode === 'x-goog-api-key'
      ? rawMode
      : 'x-goog-api-key'

  if (!apiKey.trim()) {
    throw new Error(
      `Gemini API Key 未配置：请在以下文件填写 security.auth.geminiApi.apiKey\n- ${path}`,
    )
  }

  return {
    baseUrl: normalizeGeminiApiRoot(baseUrl),
    apiKey: apiKey.trim(),
    apiKeyAuthMode,
  }
}

type GeminiAuthMode = 'gemini-api-key' | 'gemini-cli-oauth'

function resolveGeminiAuthMode(settings: GeminiSettings): GeminiAuthMode {
  const raw = String(settings.security?.auth?.selectedType ?? '')
    .trim()
    .toLowerCase()

  if (
    raw === 'gemini-cli-oauth' ||
    raw === 'gemini_cli_oauth' ||
    raw === 'oauth' ||
    raw === 'google-oauth' ||
    raw === 'google_oauth'
  ) {
    return 'gemini-cli-oauth'
  }
  return 'gemini-api-key'
}

async function createGeminiTransport(
  settings: GeminiSettings,
  path: string,
): Promise<{
  authMode: GeminiAuthMode
  transport: GeminiTransport | CodeAssistTransport
  oauthContext: { accessToken: string; projectId: string } | null
}> {
  const authMode = resolveGeminiAuthMode(settings)
  if (authMode === 'gemini-cli-oauth') {
    try {
      const { accessToken, projectId } = await getGeminiCliAuthContext()
      return {
        authMode,
        oauthContext: { accessToken, projectId },
        transport: new CodeAssistTransport({
          endpoint: CODE_ASSIST_ENDPOINT,
          accessToken,
          projectId,
        }),
      }
    } catch (error) {
      const raw =
        error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
      throw new Error(
        `Gemini OAuth 不可用：${raw}\n请先运行 /auth 完成 Google OAuth 登录，或切换到 gemini-api-key。`,
      )
    }
  }

  const auth = getGeminiApiKeyAuth(settings, path)
  return {
    authMode,
    oauthContext: null,
    transport: new GeminiTransport({
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
      apiKeyAuthMode: auth.apiKeyAuthMode,
    }),
  }
}

function getModelName(settings: GeminiSettings): string {
  const name = settings.model?.name ?? ''
  return normalizeGeminiModelName(name)
}

function resolveModelKey(model: string | 'main' | 'task' | 'reasoning' | 'quick'): string {
  if (model === 'main' || model === 'task' || model === 'reasoning' || model === 'quick') {
    return model
  }
  return 'main'
}

function resolveRequestedModelName(
  model: string | 'main' | 'task' | 'reasoning' | 'quick',
  settings: GeminiSettings,
): string {
  if (model === 'main' || model === 'task' || model === 'reasoning' || model === 'quick') {
    const pointerModel = getModelManager().getModelName(model)
    if (pointerModel && pointerModel.trim()) {
      return pointerModel.trim()
    }
    return getModelName(settings)
  }
  return String(model ?? '').trim() || getModelName(settings)
}

function aggregateStreamParts(chunks: GeminiGenerateContentResponse[]): GeminiPart[] {
  const parts: any[] = []

  // Gemini 的 streamGenerateContent 在 functionCall 时可能会“多次更新同一个调用”（同 id，或无 id 但同名连续片段）。
  // 这里做一次聚合/去重，避免上层把同一个 tool_call 当成多次调用，从而出现 Bash 重复执行/对话循环。
  const functionCallIndexById = new Map<string, number>()
  let lastAnonFunctionCallIndex: number | null = null
  let accumulatedVisibleText = ''

  const isThoughtPart = (part: any): boolean => {
    const thoughtFlag = part?.thought
    return thoughtFlag === true || typeof thoughtFlag === 'string'
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)

  const deepMergeArgs = (prev: unknown, next: unknown): unknown => {
    if (!isPlainObject(prev) || !isPlainObject(next)) {
      return next ?? prev
    }
    const merged: Record<string, unknown> = { ...prev }
    for (const [k, v] of Object.entries(next)) {
      if (k in merged) {
        merged[k] = deepMergeArgs(merged[k], v)
      } else {
        merged[k] = v
      }
    }
    return merged
  }

  for (const chunk of chunks) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts ?? []
    for (const rawPart of chunkParts as any[]) {
      const part = rawPart as any

      if (part?.functionCall) {
        const call = part.functionCall as any
        const callId =
          typeof call?.id === 'string' && call.id.trim() ? call.id.trim() : null
        const callName = typeof call?.name === 'string' ? call.name : ''
        const nextArgs = isPlainObject(call?.args) ? call.args : undefined

        if (callId) {
          const existingIndex = functionCallIndexById.get(callId)
          if (existingIndex !== undefined) {
            const prevPart = parts[existingIndex] as any
            const prevCall = prevPart?.functionCall ?? {}
            const mergedArgs = deepMergeArgs(prevCall?.args, nextArgs) as any

            parts[existingIndex] = {
              ...prevPart,
              ...part,
              functionCall: {
                ...prevCall,
                ...call,
                id: callId,
                name: callName || prevCall?.name,
                args: mergedArgs ?? (nextArgs ?? prevCall?.args ?? {}),
              },
              ...(prevPart?.thoughtSignature && !part?.thoughtSignature
                ? { thoughtSignature: prevPart.thoughtSignature }
                : {}),
            }
          } else {
            parts.push({
              ...part,
              functionCall: {
                ...call,
                id: callId,
                name: callName,
                args: nextArgs ?? call.args ?? {},
              },
            })
            functionCallIndexById.set(callId, parts.length - 1)
          }

          lastAnonFunctionCallIndex = null
          continue
        }

        // 无 id：尽量把同名的连续 functionCall 合并成一次调用
        if (
          lastAnonFunctionCallIndex !== null &&
          (parts[lastAnonFunctionCallIndex] as any)?.functionCall &&
          !String((parts[lastAnonFunctionCallIndex] as any).functionCall?.id ?? '').trim() &&
          String((parts[lastAnonFunctionCallIndex] as any).functionCall?.name ?? '') === callName
        ) {
          const prevPart = parts[lastAnonFunctionCallIndex] as any
          const prevCall = prevPart?.functionCall ?? {}
          const mergedArgs = deepMergeArgs(prevCall?.args, nextArgs) as any

          parts[lastAnonFunctionCallIndex] = {
            ...prevPart,
            ...part,
            functionCall: {
              ...prevCall,
              ...call,
              name: callName || prevCall?.name,
              args: mergedArgs ?? (nextArgs ?? prevCall?.args ?? {}),
            },
            ...(prevPart?.thoughtSignature && !part?.thoughtSignature
              ? { thoughtSignature: prevPart.thoughtSignature }
              : {}),
          }
          continue
        }

        parts.push(part)
        lastAnonFunctionCallIndex = parts.length - 1
        continue
      }

      // 文本：兼容“快照式”流（每次都发到目前为止的全文），避免重复拼接
      if (typeof part?.text === 'string' && !isThoughtPart(part)) {
        const nextText = String(part.text ?? '')
        if (nextText) {
          if (
            accumulatedVisibleText &&
            nextText.startsWith(accumulatedVisibleText)
          ) {
            const suffix = nextText.slice(accumulatedVisibleText.length)
            if (suffix) {
              parts.push({ ...part, text: suffix })
              accumulatedVisibleText += suffix
            }
          } else {
            parts.push(part)
            accumulatedVisibleText += nextText
          }
          lastAnonFunctionCallIndex = null
          continue
        }
      }

      parts.push(part)
      lastAnonFunctionCallIndex = null
    }
  }

  return parts as GeminiPart[]
}

const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

function ensureActiveLoopHasThoughtSignatures(contents: GeminiContent[]): GeminiContent[] {
  // 找到“活跃回合”的起点：最后一个带用户文本的 user turn（而不是 tool_result/functionResponse）
  let activeLoopStartIndex = -1
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i]
    if (content?.role !== 'user') continue
    const hasUserText =
      Array.isArray(content.parts) &&
      content.parts.some(p => typeof (p as any)?.text === 'string' && String((p as any).text).trim())
    if (hasUserText) {
      activeLoopStartIndex = i
      break
    }
  }

  if (activeLoopStartIndex === -1) return contents

  // 确保 active loop 内每个 model turn 的“第一个 functionCall”都有 thoughtSignature
  const newContents = contents.slice()
  for (let i = activeLoopStartIndex; i < newContents.length; i++) {
    const content = newContents[i]
    if (content?.role !== 'model' || !Array.isArray(content.parts)) continue

    const newParts = content.parts.slice()
    for (let j = 0; j < newParts.length; j++) {
      const part = newParts[j] as any
      if (!part?.functionCall) continue

      const sig = part.thoughtSignature
      if (typeof sig !== 'string' || !sig.trim()) {
        newParts[j] = { ...part, thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE }
        newContents[i] = { ...content, parts: newParts }
      }
      break
    }
  }

  return newContents
}

export async function queryGeminiLLM(options: {
  messages: (UserMessage | AssistantMessage)[]
  systemPrompt: string[]
  tools: Tool[]
  signal: AbortSignal
  model: string | 'main' | 'task' | 'reasoning' | 'quick'
  stream: boolean
}): Promise<AssistantMessage> {
  const start = Date.now()
  setSessionState('currentThought', null)
  setSessionState('currentError', null)

  try {
    const { settings, path } = getProjectSettings()

    // modelKey 用于 quick/web-search/web-fetch 等配置差异
    const modelKey = resolveModelKey(options.model)
    const requestedModelName = resolveRequestedModelName(options.model, settings)

    // 给 main 对话声明函数工具
    const functionDeclarations =
      options.tools.length > 0 ? toolsToFunctionDeclarations(options.tools) : []

    const resolved = resolveGeminiModelConfig(
      modelKey,
      { model: { name: requestedModelName } },
      { functionDeclarations },
    )

    const { transport, oauthContext } = await createGeminiTransport(settings, path)

    const systemInstruction =
      options.systemPrompt.length > 0
        ? {
            role: 'user' as const,
            parts: [{ text: options.systemPrompt.join('\n') }],
          }
        : undefined

    const baseContents = ensureActiveLoopHasThoughtSignatures(
      kodeMessagesToGeminiContents(options.messages),
    )

    const MAX_NO_CONTENT_RETRIES = 2
    let noContentRetries = 0
    const noContentHint: GeminiContent = {
      role: 'user',
      parts: [
        {
          text: '（系统提醒：你刚才没有输出任何可见回答。请这次务必输出最终可见内容（文字/下一步动作），不要只输出 thought，也不要返回空内容。）',
        },
      ],
    }

    const userPromptId = randomUUID()
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      if (options.signal.aborted) {
        // 不再发新请求，直接返回空内容（上层会显示“Interrupted by user”）
        return geminiResponseToAssistantMessage(
          { candidates: [{ content: { role: 'model', parts: [] } }] } as any,
          { model: resolved.model, durationMs: Date.now() - start },
        )
      }

      try {
        setSessionState('currentError', null)
        const requestContents =
          noContentRetries > 0
            ? [...baseContents, noContentHint]
            : baseContents

        if (!options.stream) {
          await acquireApiSlot(options.signal)
          let resp: GeminiGenerateContentResponse
          try {
            resp = await transport.generateContent({
              model: resolved.model,
              contents: requestContents,
              userPromptId,
              config: {
                ...resolved.config,
                abortSignal: options.signal,
                ...(systemInstruction ? { systemInstruction } : {}),
              },
            })
          } finally {
            releaseApiSlot()
          }

          const assistantMessage = geminiResponseToAssistantMessage(resp, {
            model: resolved.model,
            durationMs: Date.now() - start,
          })
          if (
            isNoContentAssistantMessage(assistantMessage) &&
            noContentRetries < MAX_NO_CONTENT_RETRIES &&
            !options.signal.aborted
          ) {
            noContentRetries++
            setSessionState(
              'currentError',
              `模型返回空内容，自动重试 ${noContentRetries}/${MAX_NO_CONTENT_RETRIES}`,
            )
            const aborted = await sleepWithAbort(200, options.signal)
            if (aborted) {
              return geminiResponseToAssistantMessage(
                { candidates: [{ content: { role: 'model', parts: [] } }] } as any,
                { model: resolved.model, durationMs: Date.now() - start },
              )
            }
            continue
          }

          maybeReportCodeAssistConversationOffered({
            oauthContext,
            response: resp,
            signal: options.signal,
          })
          return assistantMessage
        }

        await acquireApiSlot(options.signal)
        let stream: AsyncIterable<GeminiGenerateContentResponse>
        try {
          stream = await transport.generateContentStream({
            model: resolved.model,
            contents: requestContents,
            userPromptId,
            config: {
              ...resolved.config,
              abortSignal: options.signal,
              ...(systemInstruction ? { systemInstruction } : {}),
            },
          })
        } catch (e) {
          releaseApiSlot()
          throw e
        }

        const chunks: GeminiGenerateContentResponse[] = []
        let lastUsage: GeminiGenerateContentResponse['usageMetadata'] | undefined
        for await (const chunk of stream) {
          chunks.push(chunk)
          if (chunk.usageMetadata) lastUsage = chunk.usageMetadata

          // Gemini “thinking” 兼容：如果 stream 里带 thought，就用状态条显示（不进正文）
          const parts = chunk.candidates?.[0]?.content?.parts ?? []
          for (const part of parts as any[]) {
            const thoughtFlag = (part as any)?.thought
            const thoughtText =
              typeof thoughtFlag === 'string'
                ? thoughtFlag
                : typeof (part as any)?.text === 'string'
                  ? String((part as any).text)
                  : ''
            if ((thoughtFlag === true || typeof thoughtFlag === 'string') && thoughtText.trim()) {
              const parsed = parseThought(thoughtText)
              const subject = parsed.subject.trim() || parsed.description.trim() || thoughtText.trim()
              if (getSessionState('suppressThoughtDepth') === 0) {
                setSessionState('currentThought', {
                  subject,
                  description: parsed.description.trim(),
                })
              }
            }
          }
        }
        releaseApiSlot()

        const aggregatedParts = aggregateStreamParts(chunks)
        const streamTraceId = chunks
          .map(chunk => resolveResponseTraceId(chunk))
          .find((value): value is string => typeof value === 'string' && value.length > 0)
        const synthetic: GeminiGenerateContentResponse = {
          ...(streamTraceId ? { traceId: streamTraceId } : {}),
          candidates: [
            {
              content: { role: 'model', parts: aggregatedParts },
            },
          ],
          usageMetadata: lastUsage,
        }

        const assistantMessage = geminiResponseToAssistantMessage(synthetic, {
          model: resolved.model,
          durationMs: Date.now() - start,
        })
        if (
          isNoContentAssistantMessage(assistantMessage) &&
          noContentRetries < MAX_NO_CONTENT_RETRIES &&
          !options.signal.aborted
        ) {
          noContentRetries++
          setSessionState(
            'currentError',
            `模型返回空内容，自动重试 ${noContentRetries}/${MAX_NO_CONTENT_RETRIES}`,
          )
          const aborted = await sleepWithAbort(200, options.signal)
          if (aborted) {
            return geminiResponseToAssistantMessage(
              { candidates: [{ content: { role: 'model', parts: [] } }] } as any,
              { model: resolved.model, durationMs: Date.now() - start },
            )
          }
            continue
          }

        maybeReportCodeAssistConversationOffered({
          oauthContext,
          response: synthetic,
          signal: options.signal,
        })
        return assistantMessage
      } catch (error) {
        releaseApiSlot() // 确保出错时释放信号量
        const meta = isRetryableGeminiError(error)
        if (
          attempt >= RETRY_MAX_ATTEMPTS ||
          !meta.retryable ||
          options.signal.aborted ||
          isAbortError(error)
        ) {
          throw wrapGeminiRequestError(error, {
            stage: 'llm',
            model: resolved.model,
            modelKey,
            attempt,
            maxAttempts: RETRY_MAX_ATTEMPTS,
          })
        }

        const backoff = computeBackoffMs(attempt)
        setSessionState('currentThought', null)
        setSessionState(
          'currentError',
          `网络波动，重试 ${attempt}/${RETRY_MAX_ATTEMPTS}（${meta.reason}，等待 ${backoff}ms）`,
        )
        const aborted = await sleepWithAbort(backoff, options.signal)
        if (aborted) {
          return geminiResponseToAssistantMessage(
            { candidates: [{ content: { role: 'model', parts: [] } }] } as any,
            { model: resolved.model, durationMs: Date.now() - start },
          )
        }
      }
    }

    // 理论上不会到这
    return geminiResponseToAssistantMessage(
      { candidates: [{ content: { role: 'model', parts: [] } }] } as any,
      { model: resolved.model, durationMs: Date.now() - start },
    )
  } finally {
    setSessionState('currentThought', null)
    setSessionState('currentError', null)
  }
}

export async function queryGeminiToolsOnly(options: {
  modelKey: 'web-search' | 'web-fetch'
  prompt: string
  signal?: AbortSignal
}): Promise<string> {
  const result = await queryGeminiToolsOnlyDetailed(options)
  return result.text
}

export type GeminiToolsOnlyResult = {
  text: string
  textWithCitations: string
  sources: GroundingSource[]
  webSearchQueries: string[]
}

export async function queryGeminiToolsOnlyDetailed(options: {
  modelKey: 'web-search' | 'web-fetch'
  prompt: string
  signal?: AbortSignal
}): Promise<GeminiToolsOnlyResult> {
  const { settings, path } = getProjectSettings()

  const resolved = resolveGeminiModelConfig(options.modelKey, { model: { name: settings.model?.name } })
  const { transport } = await createGeminiTransport(settings, path)

  const userPromptId = randomUUID()
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await transport.generateContent({
        model: resolved.model,
        contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
        userPromptId,
        config: {
          ...resolved.config,
          abortSignal: options.signal,
        },
      })

      const parts = resp.candidates?.[0]?.content?.parts ?? []
      const rawText = parts
        .map(p => (p as any).text)
        .filter((t): t is string => typeof t === 'string')
        .join('')

      const { sources, webSearchQueries, supports } = extractGeminiGrounding(resp as any)
      const textWithCitations = applyGroundingCitations(rawText, supports)

      return {
        text: rawText.trim(),
        textWithCitations: textWithCitations.trim(),
        sources,
        webSearchQueries,
      }
    } catch (error) {
      const meta = isRetryableGeminiError(error)
      const aborted = !!options.signal?.aborted || isAbortError(error)
      if (attempt >= RETRY_MAX_ATTEMPTS || !meta.retryable || aborted) {
        throw wrapGeminiRequestError(error, {
          stage: 'tools-only',
          model: resolved.model,
          modelKey: options.modelKey,
          attempt,
          maxAttempts: RETRY_MAX_ATTEMPTS,
        })
      }

      const backoff = computeBackoffMs(attempt)
      if (options.signal) {
        const wasAborted = await sleepWithAbort(backoff, options.signal)
        if (wasAborted) {
          throw wrapGeminiRequestError(new Error('aborted'), {
            stage: 'tools-only',
            model: resolved.model,
            modelKey: options.modelKey,
            attempt,
            maxAttempts: RETRY_MAX_ATTEMPTS,
          })
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, backoff))
      }
    }
  }

  throw new Error(`Gemini tools-only request failed unexpectedly (${options.modelKey})`)
}
