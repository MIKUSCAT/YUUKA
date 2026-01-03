import type {
  GeminiFunctionCall,
  GeminiGenerateContentParameters,
  GeminiGenerateContentResponse,
  GeminiPart,
} from './types'

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

export class GeminiHttpError extends Error {
  readonly name = 'GeminiHttpError'

  constructor(
    message: string,
    readonly status: number,
    readonly responseBody?: string,
  ) {
    super(message)
  }
}

function normalizeApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('baseUrl 不能为空（来自 ./.gemini/settings.json）')
  }
  if (trimmed.endsWith('/v1') || trimmed.endsWith('/v1beta')) {
    return trimmed
  }
  return `${trimmed}/v1beta`
}

function normalizeModelName(model: string): string {
  if (!model || typeof model !== 'string') {
    throw new Error('model 必须是非空字符串')
  }
  if (model.includes('..') || model.includes('?') || model.includes('&')) {
    throw new Error('model 参数不合法')
  }
  if (model.startsWith('models/') || model.startsWith('tunedModels/')) {
    return model
  }
  return `models/${model}`
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

function applyAuth(headers: Headers, apiKey: string) {
  headers.set('Authorization', `Bearer ${apiKey}`)
}

async function readErrorBody(resp: Response): Promise<string> {
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
  if (cfg.tools !== undefined) {
    body.tools = cfg.tools
  }
  if (cfg.toolConfig !== undefined) {
    body.toolConfig = cfg.toolConfig
  }
  if (cfg.generationConfig !== undefined) {
    body.generationConfig = cfg.generationConfig
  }

  return body
}

function buildUrl(
  apiRoot: string,
  model: string,
  method: 'generateContent' | 'streamGenerateContent',
): URL {
  const normalizedModel = normalizeModelName(model)
  const root = apiRoot.replace(/\/+$/, '')
  let path = `${root}/${normalizedModel}:${method}`
  if (method === 'streamGenerateContent') {
    path += '?alt=sse'
  }
  return new URL(path)
}

export class GeminiTransport {
  private readonly apiRoot: string

  constructor(
    private readonly options: {
      baseUrl: string
      apiKey: string
      headers?: Record<string, string>
    },
  ) {
    this.apiRoot = normalizeApiRoot(options.baseUrl)
  }

  private buildHeaders(): Headers {
    const headers = new Headers(this.options.headers ?? {})
    headers.set('Content-Type', 'application/json')
    applyAuth(headers, this.options.apiKey)
    return headers
  }

  async generateContent(
    request: GeminiGenerateContentParameters,
  ): Promise<GeminiGenerateContentResponse> {
    const url = buildUrl(this.apiRoot, request.model, 'generateContent')
    const headers = this.buildHeaders()
    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequestBody(request)),
        signal: request.config?.abortSignal,
      })
    } catch (error) {
      if (request.config?.abortSignal?.aborted || isAbortError(error)) {
        return withConvenienceFields({
          candidates: [{ content: { role: 'model', parts: [] } }],
        } as GeminiGenerateContentResponse)
      }
      throw error
    }
    if (!resp.ok) {
      const text = await readErrorBody(resp)
      throw new GeminiHttpError(`Gemini 请求失败 (HTTP ${resp.status})`, resp.status, text)
    }
    try {
      return withConvenienceFields((await resp.json()) as GeminiGenerateContentResponse)
    } catch (error) {
      if (request.config?.abortSignal?.aborted || isAbortError(error)) {
        return withConvenienceFields({
          candidates: [{ content: { role: 'model', parts: [] } }],
        } as GeminiGenerateContentResponse)
      }
      throw error
    }
  }

  async generateContentStream(
    request: GeminiGenerateContentParameters,
  ): Promise<AsyncGenerator<GeminiGenerateContentResponse>> {
    const url = buildUrl(this.apiRoot, request.model, 'streamGenerateContent')
    const headers = this.buildHeaders()

    async function* emptyIterator(): AsyncGenerator<GeminiGenerateContentResponse> {
      return
    }

    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequestBody(request)),
        signal: request.config?.abortSignal,
      })
    } catch (error) {
      if (request.config?.abortSignal?.aborted || isAbortError(error)) {
        return emptyIterator()
      }
      throw error
    }
    if (!resp.ok) {
      const text = await readErrorBody(resp)
      throw new GeminiHttpError(
        `Gemini 流式请求失败 (HTTP ${resp.status})`,
        resp.status,
        text,
      )
    }

    const contentType = resp.headers.get('content-type') || ''
    const stream = resp.body
    if (!stream) {
      throw new Error('Gemini 流式响应没有 body')
    }

    // SSE 解析（Gemini 官方是 alt=sse）
    if (contentType.includes('text/event-stream')) {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      async function* iterator(): AsyncGenerator<GeminiGenerateContentResponse> {
        while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>
          try {
            readResult = await reader.read()
          } catch (error) {
            if (request.config?.abortSignal?.aborted || isAbortError(error)) {
              try {
                await reader.cancel()
              } catch {}
              return
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
              const json = JSON.parse(data) as GeminiGenerateContentResponse
              yield withConvenienceFields(json)
            } catch (error) {
              if (request.config?.abortSignal?.aborted) return
              throw error
            }
          }
        }

        // 兜底：处理末尾残留
        const tail = buffer.trim()
        if (tail.startsWith('data:')) {
          const data = tail.slice('data:'.length).trimStart().trim()
          if (data && data !== '[DONE]') {
            try {
              const json = JSON.parse(data) as GeminiGenerateContentResponse
              yield withConvenienceFields(json)
            } catch (error) {
              if (request.config?.abortSignal?.aborted) return
              throw error
            }
          }
        }
      }

      return iterator()
    }

    // 非 SSE：兜底当作一次性 JSON 或 JSON 数组
    let text: string
    try {
      text = await resp.text()
    } catch (error) {
      if (request.config?.abortSignal?.aborted || isAbortError(error)) {
        return emptyIterator()
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      if (request.config?.abortSignal?.aborted) {
        return emptyIterator()
      }
      throw new Error(
        `Gemini 流式响应不是 SSE 也不是 JSON，无法解析：${String(e)}`,
      )
    }

    async function* fallbackIterator(): AsyncGenerator<GeminiGenerateContentResponse> {
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          yield withConvenienceFields(item as GeminiGenerateContentResponse)
        }
        return
      }
      yield withConvenienceFields(parsed as GeminiGenerateContentResponse)
    }

    return fallbackIterator()
  }
}
