import { randomUUID } from 'node:crypto'
import * as readline from 'node:readline'
import type {
  GeminiFunctionCall,
  GeminiGenerateContentParameters,
  GeminiGenerateContentResponse,
} from './types'
import { getYuukaUserAgent } from './codeAssistAuth'
import { GeminiHttpError } from './transport'
import type { AuthClient } from 'google-auth-library'
import { getGeminiCliCustomHeaders } from './customHeaderUtils'

const REQUEST_TIMEOUT_MS = 90_000
const STREAM_IDLE_TIMEOUT_MS = 90_000

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

function extractFunctionCalls(
  response: GeminiGenerateContentResponse,
): GeminiFunctionCall[] {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  const calls: GeminiFunctionCall[] = []
  for (const part of parts) {
    if (part && typeof part === 'object' && 'functionCall' in part) {
      const fn = (part as any).functionCall as GeminiFunctionCall | undefined
      if (fn) calls.push(fn)
    }
  }
  return calls
}

function withConvenienceFields(
  response: GeminiGenerateContentResponse,
): GeminiGenerateContentResponse {
  response.functionCalls = extractFunctionCalls(response)
  return response
}

async function readErrorBody(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return await resp.text()
  } catch {
    return ''
  }
}

function buildRequestBody(
  request: GeminiGenerateContentParameters,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: request.contents,
  }

  const cfg = request.config
  if (!cfg) return body

  if (cfg.systemInstruction !== undefined) {
    body.systemInstruction = cfg.systemInstruction
  }
  if (cfg.cachedContent !== undefined) {
    body.cachedContent = cfg.cachedContent
  }
  if (cfg.tools !== undefined) {
    body.tools = cfg.tools
  }
  if (cfg.toolConfig !== undefined) {
    body.toolConfig = cfg.toolConfig
  }
  if (cfg.labels !== undefined) {
    body.labels = cfg.labels
  }
  if (cfg.safetySettings !== undefined) {
    body.safetySettings = cfg.safetySettings
  }
  if (cfg.generationConfig !== undefined) {
    body.generationConfig = cfg.generationConfig
  }
  if (cfg.sessionId !== undefined) {
    body.session_id = cfg.sessionId
  }

  return body
}

function normalizeCodeAssistModel(model: string): string {
  const trimmed = model?.trim?.() ?? ''
  if (trimmed.startsWith('models/')) return trimmed.slice('models/'.length)
  return trimmed
}

function unwrapCodeAssistResponse(
  json: any,
): GeminiGenerateContentResponse {
  if (json && typeof json === 'object' && json.response && typeof json.response === 'object') {
    const resp = json.response as GeminiGenerateContentResponse
    const traceId = typeof (json as any).traceId === 'string' ? String((json as any).traceId).trim() : ''
    if (traceId) {
      return { ...resp, traceId }
    }
    return resp
  }
  return json as GeminiGenerateContentResponse
}

type TimeoutReason = 'request_timeout' | 'stream_idle_timeout' | null

function createManagedAbortController(options: {
  upstream?: AbortSignal
  requestTimeoutMs?: number
}): {
  controller: AbortController
  markTimeout: (reason: Exclude<TimeoutReason, null>) => void
  getTimeoutReason: () => TimeoutReason
  clearRequestTimeout: () => void
  cleanup: () => void
} {
  const controller = new AbortController()
  let timeoutReason: TimeoutReason = null
  let requestTimeoutId: ReturnType<typeof setTimeout> | null = null

  const markTimeout = (reason: Exclude<TimeoutReason, null>) => {
    if (timeoutReason) return
    timeoutReason = reason
  }

  const onUpstreamAbort = () => {
    controller.abort()
  }

  if (options.upstream) {
    if (options.upstream.aborted) {
      controller.abort()
    } else {
      options.upstream.addEventListener('abort', onUpstreamAbort, { once: true })
    }
  }

  const setRequestTimeout = () => {
    const ms = options.requestTimeoutMs ?? 0
    if (!Number.isFinite(ms) || ms <= 0) return
    requestTimeoutId = setTimeout(() => {
      markTimeout('request_timeout')
      controller.abort()
    }, ms)
  }
  setRequestTimeout()

  const clearRequestTimeout = () => {
    if (requestTimeoutId) {
      clearTimeout(requestTimeoutId)
      requestTimeoutId = null
    }
  }

  const cleanup = () => {
    clearRequestTimeout()
    if (options.upstream) {
      try {
        options.upstream.removeEventListener('abort', onUpstreamAbort)
      } catch {
        // ignore
      }
    }
  }

  return {
    controller,
    markTimeout,
    getTimeoutReason: () => timeoutReason,
    clearRequestTimeout,
    cleanup,
  }
}

export class CodeAssistTransport {
  private readonly endpoint: string
  private readonly version: string

  constructor(
    private readonly options: {
      client: AuthClient
      projectId: string
      headers?: Record<string, string>
    },
  ) {
    const endpoint = (process.env['CODE_ASSIST_ENDPOINT'] ?? 'https://cloudcode-pa.googleapis.com')
      .trim()
      .replace(/\/+$/, '')
    this.endpoint = endpoint
    this.version = String(process.env['CODE_ASSIST_API_VERSION'] || 'v1internal')
      .trim()
      .replace(/^\/+/, '')
  }

  private getMethodUrl(method: string): string {
    const base = `${this.endpoint}/${this.version}`
    const trimmed = String(method ?? '').trim().replace(/^:+/, '')
    return `${base}:${trimmed}`
  }

  private buildHeaders(model: string): Record<string, string> {
    // Mirror Gemini CLI: Content-Type is always present; no installation id header for OAuth.
    return {
      'Content-Type': 'application/json',
      ...getGeminiCliCustomHeaders(),
      ...(this.options.headers ?? {}),
      'User-Agent': getYuukaUserAgent(model),
    }
  }

  private buildPayload(request: GeminiGenerateContentParameters): Record<string, unknown> {
    return {
      model: normalizeCodeAssistModel(request.model),
      project: this.options.projectId,
      user_prompt_id: request.userPromptId || randomUUID(),
      request: buildRequestBody(request),
    }
  }

  async generateContent(
    request: GeminiGenerateContentParameters,
  ): Promise<GeminiGenerateContentResponse> {
    const managed = createManagedAbortController({
      upstream: request.config?.abortSignal,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })
    try {
      const res = await this.options.client.request({
        url: this.getMethodUrl('generateContent'),
        method: 'POST',
        headers: this.buildHeaders(request.model),
        responseType: 'json',
        body: JSON.stringify(this.buildPayload(request)),
        signal: managed.controller.signal,
      })
      return withConvenienceFields(unwrapCodeAssistResponse((res as any).data))
    } catch (error) {
      if (request.config?.abortSignal?.aborted) {
        return withConvenienceFields({
          candidates: [{ content: { role: 'model', parts: [] } }],
        } as GeminiGenerateContentResponse)
      }
      if (managed.getTimeoutReason() === 'request_timeout') {
        throw new GeminiHttpError(
          `Code Assist 请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）`,
          408,
        )
      }
      // Best-effort: surface HTTP status when present (gaxios error).
      const status = typeof (error as any)?.response?.status === 'number' ? (error as any).response.status : undefined
      const data = (error as any)?.response?.data
      let responseBody: string | undefined
      if (typeof data === 'string') {
        responseBody = data
      } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
        responseBody = data.toString('utf-8')
      } else if (data != null) {
        try {
          responseBody = JSON.stringify(data)
        } catch {
          responseBody = String(data)
        }
      }
      if (status) {
        throw new GeminiHttpError(`Code Assist 请求失败 (HTTP ${status})`, status, responseBody)
      }
      throw error
    } finally {
      managed.cleanup()
    }
  }

  async generateContentStream(
    request: GeminiGenerateContentParameters,
  ): Promise<AsyncGenerator<GeminiGenerateContentResponse>> {
    async function* emptyIterator(): AsyncGenerator<GeminiGenerateContentResponse> {
      return
    }

    const managed = createManagedAbortController({
      upstream: request.config?.abortSignal,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })

    let stream: NodeJS.ReadableStream
    try {
      const res = await this.options.client.request({
        url: this.getMethodUrl('streamGenerateContent'),
        method: 'POST',
        params: { alt: 'sse' },
        headers: this.buildHeaders(request.model),
        responseType: 'stream',
        body: JSON.stringify(this.buildPayload(request)),
        signal: managed.controller.signal,
      })
      stream = (res as any).data as NodeJS.ReadableStream
    } catch (error) {
      if (request.config?.abortSignal?.aborted) {
        managed.cleanup()
        return emptyIterator()
      }
      if (managed.getTimeoutReason() === 'request_timeout') {
        managed.cleanup()
        throw new GeminiHttpError(
          `Code Assist 请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）`,
          408,
        )
      }
      managed.cleanup()

      const status = typeof (error as any)?.response?.status === 'number' ? (error as any).response.status : undefined
      const data = (error as any)?.response?.data
      let responseBody: string | undefined
      if (typeof data === 'string') {
        responseBody = data
      } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
        responseBody = data.toString('utf-8')
      } else if (data != null) {
        try {
          responseBody = JSON.stringify(data)
        } catch {
          responseBody = String(data)
        }
      }
      if (status) {
        throw new GeminiHttpError(`Code Assist 流式请求失败 (HTTP ${status})`, status, responseBody)
      }
      throw error
    }

    if (!stream) {
      managed.cleanup()
      throw new Error('Code Assist 流式响应没有 body')
    }

    managed.clearRequestTimeout()

    let idleTimeoutId: ReturnType<typeof setTimeout> | null = null
    const clearIdleTimeout = () => {
      if (idleTimeoutId) {
        clearTimeout(idleTimeoutId)
        idleTimeoutId = null
      }
    }
    const resetIdleTimeout = () => {
      clearIdleTimeout()
      idleTimeoutId = setTimeout(() => {
        managed.markTimeout('stream_idle_timeout')
        managed.controller.abort()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetIdleTimeout()

    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    async function* iterator(): AsyncGenerator<GeminiGenerateContentResponse> {
      try {
        let buffered: string[] = []
        for await (const line of rl) {
          resetIdleTimeout()
          if (line.startsWith('data: ')) {
            buffered.push(line.slice(6).trim())
            continue
          }
          if (line === '') {
            if (buffered.length === 0) continue
            const json = JSON.parse(buffered.join('\n'))
            buffered = []
            yield withConvenienceFields(unwrapCodeAssistResponse(json))
          }
        }
      } catch (error) {
        if (request.config?.abortSignal?.aborted) return
        if (managed.getTimeoutReason() === 'stream_idle_timeout') {
          throw new GeminiHttpError(
            `Code Assist 流式响应空闲超时（${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s）`,
            408,
          )
        }
        if (managed.getTimeoutReason() === 'request_timeout') {
          throw new GeminiHttpError(
            `Code Assist 请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）`,
            408,
          )
        }
        if (isAbortError(error)) return
        throw error
      } finally {
        clearIdleTimeout()
        managed.cleanup()
        try {
          rl.close()
        } catch {}
      }
    }

    return iterator()
  }
}
