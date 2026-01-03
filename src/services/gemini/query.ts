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
  const parts: GeminiPart[] = []
  for (const chunk of chunks) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts ?? []
    for (const part of chunkParts as any[]) {
      // 绝大多数情况下 streamGenerateContent 是增量片段，直接 append 即可
      parts.push(part)
    }
  }
  return parts
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

    const contents = ensureActiveLoopHasThoughtSignatures(
      kodeMessagesToGeminiContents(options.messages),
    )

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

        if (!options.stream) {
          const resp = await transport.generateContent({
            model: resolved.model,
            contents,
            config: {
              ...resolved.config,
              abortSignal: options.signal,
              ...(systemInstruction ? { systemInstruction } : {}),
            },
          })

          return geminiResponseToAssistantMessage(resp, {
            model: resolved.model,
            durationMs: Date.now() - start,
          })
        }

        const stream = await transport.generateContentStream({
          model: resolved.model,
          contents,
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

        return geminiResponseToAssistantMessage(synthetic, {
          model: resolved.model,
          durationMs: Date.now() - start,
        })
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
  const text = parts
    .map(p => (p as any).text)
    .filter((t): t is string => typeof t === 'string')
    .join('')

  return text.trim()
}
