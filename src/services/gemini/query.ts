import { getCwd, getOriginalCwd } from '@utils/state'
import {
  ensureGeminiSettings,
  getProjectGeminiSettingsPath,
  getWorkspaceGeminiSettingsPath,
  normalizeGeminiApiRoot,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
  type GeminiSettings,
} from '@utils/geminiSettings'
import type { AssistantMessage, UserMessage } from '@query'
import type { Tool } from '@tool'
import { existsSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { GeminiTransport } from './transport'
import { kodeMessagesToGeminiContents, geminiResponseToAssistantMessage, toolsToFunctionDeclarations } from './adapter'
import { resolveGeminiModelConfig } from './modelConfig'
import type { GeminiContent, GeminiGenerateContentResponse, GeminiPart } from './types'
import { setSessionState } from '@utils/sessionState'
import { parseThought } from '@utils/thought'
import { GeminiHttpError } from './transport'
import { applyGroundingCitations, extractGeminiGrounding, type GroundingSource } from './grounding'

const NO_CONTENT_TEXTS = new Set([
  '(no content)',
  '(No content)',
  '（模型没有输出可见内容，请重试）',
])

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
  const base = 300
  const cap = 5000
  const exp = Math.min(cap, Math.floor(base * Math.pow(2, Math.max(0, attempt - 1))))
  const jitter = Math.floor(Math.random() * 200)
  return Math.min(cap, exp + jitter)
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

function findNearestGeminiSettingsWithApiKey(options: {
  startDir: string
  stopDir?: string
}): { settings: GeminiSettings; path: string } | null {
  let currentDir = resolve(options.startDir)
  const stopDir = options.stopDir ? resolve(options.stopDir) : undefined

  while (true) {
    const settingsPath = getProjectGeminiSettingsPath(currentDir)
    if (existsSync(settingsPath)) {
      const settings = readGeminiSettingsFile(settingsPath)
      const apiKey = settings.security?.auth?.geminiApi?.apiKey ?? ''
      if (apiKey.trim()) {
        return { settings, path: settingsPath }
      }
    }

    if (stopDir && currentDir === stopDir) return null
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
}

function getProjectSettings(): { settings: GeminiSettings; path: string } {
  const originalCwd = getOriginalCwd()
  const ensured = ensureGeminiSettings({ projectRoot: originalCwd })
  const fallbackPath =
    ensured.settingsPath || getWorkspaceGeminiSettingsPath(originalCwd)
  const fallbackSettings = readGeminiSettingsFile(fallbackPath)

  const cwd = getCwd()
  const resolvedCwd = resolve(cwd)
  const resolvedOriginal = resolve(originalCwd)
  const relToOriginal = relative(resolvedOriginal, resolvedCwd)
  const isInOriginal =
    relToOriginal === '' ||
    (!relToOriginal.startsWith('..') && !isAbsolute(relToOriginal))

  const nearestWithKey = findNearestGeminiSettingsWithApiKey({
    startDir: cwd,
    stopDir: isInOriginal ? originalCwd : undefined,
  })

  return {
    settings: nearestWithKey?.settings ?? fallbackSettings,
    path: nearestWithKey?.path ?? fallbackPath,
  }
}

function getGeminiAuth(
  settings: GeminiSettings,
  path: string,
): { baseUrl: string; apiKey: string } {
  const baseUrl =
    settings.security?.auth?.geminiApi?.baseUrl ??
    'https://generativelanguage.googleapis.com'
  const apiKey = settings.security?.auth?.geminiApi?.apiKey ?? ''

  if (!apiKey.trim()) {
    throw new Error(
      `Gemini API Key 未配置：请在以下文件填写 security.auth.geminiApi.apiKey\n- ${path}`,
    )
  }

  return { baseUrl: normalizeGeminiApiRoot(baseUrl), apiKey: apiKey.trim() }
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
    const auth = getGeminiAuth(settings, path)

    // modelKey 用于 quick/web-search/web-fetch 等配置差异
    const modelKey = resolveModelKey(options.model)

    // 给 main 对话声明函数工具
    const functionDeclarations =
      options.tools.length > 0 ? toolsToFunctionDeclarations(options.tools) : []

    const resolved = resolveGeminiModelConfig(
      modelKey,
      { model: { name: settings.model?.name } },
      { functionDeclarations },
    )

    const transport = new GeminiTransport({
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
    })

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

    const MAX_ATTEMPTS = 10
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          const resp = await transport.generateContent({
            model: resolved.model,
            contents: requestContents,
            config: {
              ...resolved.config,
              abortSignal: options.signal,
              ...(systemInstruction ? { systemInstruction } : {}),
            },
          })

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

          return assistantMessage
        }

        const stream = await transport.generateContentStream({
          model: resolved.model,
          contents: requestContents,
          config: {
            ...resolved.config,
            abortSignal: options.signal,
            ...(systemInstruction ? { systemInstruction } : {}),
          },
        })

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
              setSessionState('currentThought', {
                subject,
                description: parsed.description.trim(),
              })
            }
          }
        }

        const aggregatedParts = aggregateStreamParts(chunks)
        const synthetic: GeminiGenerateContentResponse = {
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

        return assistantMessage
      } catch (error) {
        const meta = isRetryableGeminiError(error)
        if (attempt >= MAX_ATTEMPTS || !meta.retryable || options.signal.aborted || isAbortError(error)) {
          throw error
        }

        const backoff = computeBackoffMs(attempt)
        setSessionState('currentThought', null)
        setSessionState(
          'currentError',
          `网络波动，重试 ${attempt}/${MAX_ATTEMPTS}（${meta.reason}，等待 ${backoff}ms）`,
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
  const auth = getGeminiAuth(settings, path)

  const resolved = resolveGeminiModelConfig(options.modelKey, { model: { name: settings.model?.name } })
  const transport = new GeminiTransport({
    baseUrl: auth.baseUrl,
    apiKey: auth.apiKey,
  })

  const resp = await transport.generateContent({
    model: resolved.model,
    contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
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
}
