/**
 * 解析 Google API 的结构化错误（google/rpc/error_details.proto 风格）。
 *
 * 这套逻辑参考 gemini-cli 的实现，但做了最小化移植：
 * - 支持从 gaxios/axios-like error.response.data 提取
 * - 支持从字符串化 JSON（嵌在 error.message 内）继续下钻
 * - 兼容 YUUKA 自己的 GeminiHttpError.responseBody
 */

export interface ErrorInfo {
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo'
  reason: string
  domain: string
  metadata?: Record<string, string>
}

export interface RetryInfo {
  '@type': 'type.googleapis.com/google.rpc.RetryInfo'
  retryDelay: string // e.g. "34.074824224s", "900ms"
}

export interface QuotaFailure {
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure'
  violations: Array<{
    quotaId?: string
    quotaMetric?: string
    quotaDimensions?: Record<string, string>
    quotaValue?: string | number
    description?: string
    subject?: string
    apiService?: string
  }>
}

export interface Help {
  '@type': 'type.googleapis.com/google.rpc.Help'
  links: Array<{
    description: string
    url: string
  }>
}

export type GoogleApiErrorDetail = ErrorInfo | RetryInfo | QuotaFailure | Help | Record<string, unknown>

export interface GoogleApiError {
  code: number
  message: string
  details: GoogleApiErrorDetail[]
}

type ErrorShape = {
  message?: unknown
  details?: unknown
  code?: unknown
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeTypeKey(detailObj: Record<string, unknown>): void {
  const typeKey = Object.keys(detailObj).find(key => key.trim() === '@type')
  if (!typeKey) return
  if (typeKey !== '@type') {
    detailObj['@type'] = detailObj[typeKey]
    delete detailObj[typeKey]
  }
}

function fromGaxiosError(errorObj: Record<string, unknown>): ErrorShape | undefined {
  const response = errorObj.response as Record<string, unknown> | undefined
  let data: unknown = response?.data

  if (typeof data === 'string') {
    const parsed = tryParseJson(data)
    if (parsed !== null) data = parsed
  }

  if (Array.isArray(data) && data.length > 0) {
    data = data[0]
  }

  if (data && typeof data === 'object' && 'error' in (data as any)) {
    const outer = (data as any).error as unknown
    if (outer && typeof outer === 'object') return outer as ErrorShape
  }

  const topLevelError = (errorObj as any).error as unknown
  if (topLevelError && typeof topLevelError === 'object') {
    return topLevelError as ErrorShape
  }

  return undefined
}

function fromApiError(errorObj: Record<string, unknown>): ErrorShape | undefined {
  let data: unknown = errorObj.message
  if (!data) return undefined

  if (typeof data === 'string') {
    let parsed: unknown | null = null
    parsed = tryParseJson(data)

    // Fallback: 取出 message 中第一段 JSON（有些库会把 JSON 拼到错误字符串里）
    if (parsed === null) {
      const firstBrace = data.indexOf('{')
      const lastBrace = data.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        parsed = tryParseJson(data.substring(firstBrace, lastBrace + 1))
      }
    }

    if (parsed !== null) {
      data = parsed
    }
  }

  if (Array.isArray(data) && data.length > 0) {
    data = data[0]
  }

  if (data && typeof data === 'object' && 'error' in (data as any)) {
    const outer = (data as any).error as unknown
    if (outer && typeof outer === 'object') return outer as ErrorShape
  }

  return undefined
}

function parseGoogleApiErrorInternal(error: unknown): GoogleApiError | null {
  if (!error) return null

  let errorObj: unknown = error

  // allow string input
  if (typeof errorObj === 'string') {
    const parsed = tryParseJson(errorObj)
    if (parsed === null) return null
    errorObj = parsed
  }

  if (Array.isArray(errorObj) && errorObj.length > 0) {
    errorObj = errorObj[0]
  }

  if (!errorObj || typeof errorObj !== 'object') return null

  const record = errorObj as Record<string, unknown>
  let current: ErrorShape | undefined = fromGaxiosError(record) ?? fromApiError(record)
  if (!current) return null

  // 有些错误会把完整结构化错误 JSON stringified 到 message 里（再包一层 Error）
  let depth = 0
  const maxDepth = 10
  while (depth < maxDepth && typeof current.message === 'string') {
    const raw = current.message
      .replace(/\u00A0/g, '') // NBSP
      .replace(/\n/g, ' ')
    const parsed = tryParseJson(raw)
    if (parsed && typeof parsed === 'object' && 'error' in (parsed as any)) {
      const next = (parsed as any).error as unknown
      if (next && typeof next === 'object') {
        current = next as ErrorShape
        depth++
        continue
      }
    }
    break
  }

  const code = typeof current.code === 'number' ? current.code : undefined
  const message = typeof current.message === 'string' ? current.message : undefined
  if (!code || !message) return null

  const details: GoogleApiErrorDetail[] = []
  if (Array.isArray(current.details)) {
    for (const detail of current.details) {
      if (!detail || typeof detail !== 'object') continue
      const obj = detail as Record<string, unknown>
      normalizeTypeKey(obj)
      details.push(obj as GoogleApiErrorDetail)
    }
  }

  return {
    code,
    message,
    details,
  }
}

function extractResponseBodyCandidate(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const body = (error as any).responseBody
  if (typeof body === 'string' && body.trim()) return body
  return null
}

export function parseGoogleApiError(error: unknown): GoogleApiError | null {
  // 优先尝试解析 transport 层保存的 responseBody（通常更完整）
  const responseBody = extractResponseBodyCandidate(error)
  if (responseBody) {
    const parsed = parseGoogleApiErrorInternal(responseBody)
    if (parsed) return parsed
  }

  return parseGoogleApiErrorInternal(error)
}

