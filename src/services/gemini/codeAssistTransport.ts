import { randomUUID } from 'node:crypto'
import type {
  GeminiFunctionCall,
  GeminiGenerateContentParameters,
  GeminiGenerateContentResponse,
} from './types'
import { getGeminiCliUserAgent } from './codeAssistAuth'
import { GeminiHttpError } from './transport'
import { fetch } from 'undici'

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

  constructor(
    private readonly options: {
      endpoint: string
      accessToken: string
      projectId: string
      headers?: Record<string, string>
    },
  ) {
    this.endpoint = options.endpoint.trim().replace(/\/+$/, '')
  }

  private buildHeaders(model: string): Headers {
    const headers = new Headers(this.options.headers ?? {})
    headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${this.options.accessToken}`)
    headers.set('User-Agent', getGeminiCliUserAgent(model))
    return headers
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
    const url = new URL(`${this.endpoint}/v1internal:generateContent`)
    const headers = this.buildHeaders(request.model)
    const managed = createManagedAbortController({
      upstream: request.config?.abortSignal,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildPayload(request)),
        signal: managed.controller.signal,
      })

      if (!resp.ok) {
        const text = await readErrorBody(resp)
        throw new GeminiHttpError(
          `Code Assist 请求失败 (HTTP ${resp.status})`,
          resp.status,
          text,
        )
      }

      const json = await resp.json()
      return withConvenienceFields(unwrapCodeAssistResponse(json))
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
      throw error
    } finally {
      managed.cleanup()
    }
  }

  async generateContentStream(
    request: GeminiGenerateContentParameters,
  ): Promise<AsyncGenerator<GeminiGenerateContentResponse>> {
    const url = new URL(`${this.endpoint}/v1internal:streamGenerateContent?alt=sse`)
    const headers = this.buildHeaders(request.model)

    async function* emptyIterator(): AsyncGenerator<GeminiGenerateContentResponse> {
      return
    }

    const managed = createManagedAbortController({
      upstream: request.config?.abortSignal,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })

    let resp: Awaited<ReturnType<typeof fetch>>
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildPayload(request)),
        signal: managed.controller.signal,
      })
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
      throw error
    }

    if (!resp.ok) {
      const text = await readErrorBody(resp)
      managed.cleanup()
      throw new GeminiHttpError(
        `Code Assist 流式请求失败 (HTTP ${resp.status})`,
        resp.status,
        text,
      )
    }

    const contentType = resp.headers.get('content-type') || ''
    const stream = resp.body
    if (!stream) {
      managed.cleanup()
      throw new Error('Code Assist 流式响应没有 body')
    }

    if (contentType.includes('text/event-stream')) {
      managed.clearRequestTimeout()
      const reader = (stream as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buffer = ''
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

      async function* iterator(): AsyncGenerator<GeminiGenerateContentResponse> {
        try {
          while (true) {
            let readResult: ReadableStreamReadResult<Uint8Array>
            try {
              readResult = await reader.read()
              resetIdleTimeout()
            } catch (error) {
              if (request.config?.abortSignal?.aborted) {
                try {
                  await reader.cancel()
                } catch {}
                return
              }
              if (managed.getTimeoutReason() === 'stream_idle_timeout') {
                try {
                  await reader.cancel()
                } catch {}
                throw new GeminiHttpError(
                  `Code Assist 流式响应空闲超时（${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s）`,
                  408,
                )
              }
              if (managed.getTimeoutReason() === 'request_timeout') {
                try {
                  await reader.cancel()
                } catch {}
                throw new GeminiHttpError(
                  `Code Assist 请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）`,
                  408,
                )
              }
              if (isAbortError(error)) {
                try {
                  await reader.cancel()
                } catch {}
              }
              throw error
            }

            const { value, done } = readResult
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replace(/\r\n/g, '\n')

            while (true) {
              const splitIndex = buffer.indexOf('\n\n')
              if (splitIndex < 0) break

              const eventBlock = buffer.slice(0, splitIndex)
              buffer = buffer.slice(splitIndex + 2)

              const dataLines = eventBlock
                .split('\n')
                .filter(l => l.startsWith('data:'))
                .map(l => l.slice('data:'.length).trimStart())
              if (dataLines.length === 0) continue

              const data = dataLines.join('\n').trim()
              if (!data || data === '[DONE]') continue

              try {
                const json = JSON.parse(data)
                yield withConvenienceFields(unwrapCodeAssistResponse(json))
              } catch (error) {
                if (request.config?.abortSignal?.aborted) return
                throw error
              }
            }
          }

          const tail = buffer.trim()
          if (tail.startsWith('data:')) {
            const data = tail.slice('data:'.length).trimStart().trim()
            if (data && data !== '[DONE]') {
              try {
                const json = JSON.parse(data)
                yield withConvenienceFields(unwrapCodeAssistResponse(json))
              } catch (error) {
                if (request.config?.abortSignal?.aborted) return
                throw error
              }
            }
          }
        } finally {
          clearIdleTimeout()
          managed.cleanup()
        }
      }

      return iterator()
    }

    // 非 SSE：兜底当作一次性 JSON
    let text: string
    try {
      text = await resp.text()
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
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      managed.cleanup()
      if (request.config?.abortSignal?.aborted) {
        return emptyIterator()
      }
      throw new Error(
        `Code Assist 流式响应不是 SSE 也不是 JSON，无法解析：${String(e)}`,
      )
    }

    async function* fallbackIterator(): AsyncGenerator<GeminiGenerateContentResponse> {
      try {
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            yield withConvenienceFields(unwrapCodeAssistResponse(item))
          }
          return
        }
        yield withConvenienceFields(unwrapCodeAssistResponse(parsed))
      } finally {
        managed.cleanup()
      }
    }

    return fallbackIterator()
  }
}
