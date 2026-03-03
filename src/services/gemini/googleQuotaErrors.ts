import type { ErrorInfo, GoogleApiError, Help, QuotaFailure, RetryInfo } from './googleErrors'
import { parseGoogleApiError } from './googleErrors'
import { getErrorStatus, ModelNotFoundError } from './httpErrors'

export class TerminalQuotaError extends Error {
  readonly name = 'TerminalQuotaError'
  readonly retryDelayMs?: number
  readonly cause?: GoogleApiError

  constructor(message: string, cause?: GoogleApiError, retryDelaySeconds?: number) {
    super(message)
    this.cause = cause
    this.retryDelayMs =
      typeof retryDelaySeconds === 'number' && Number.isFinite(retryDelaySeconds)
        ? Math.max(0, Math.floor(retryDelaySeconds * 1000))
        : undefined
  }
}

export class RetryableQuotaError extends Error {
  readonly name = 'RetryableQuotaError'
  readonly retryDelayMs?: number
  readonly cause?: GoogleApiError

  constructor(message: string, cause?: GoogleApiError, retryDelaySeconds?: number) {
    super(message)
    this.cause = cause
    this.retryDelayMs =
      typeof retryDelaySeconds === 'number' && Number.isFinite(retryDelaySeconds)
        ? Math.max(0, Math.floor(retryDelaySeconds * 1000))
        : undefined
  }
}

export class ValidationRequiredError extends Error {
  readonly name = 'ValidationRequiredError'
  readonly validationLink?: string
  readonly validationDescription?: string
  readonly learnMoreUrl?: string
  readonly cause?: GoogleApiError
  userHandled = false

  constructor(options: {
    message: string
    cause?: GoogleApiError
    validationLink?: string
    validationDescription?: string
    learnMoreUrl?: string
  }) {
    super(options.message)
    this.cause = options.cause
    this.validationLink = options.validationLink
    this.validationDescription = options.validationDescription
    this.learnMoreUrl = options.learnMoreUrl
  }
}

function parseDurationInSeconds(duration: string): number | null {
  if (!duration) return null
  const raw = String(duration).trim()
  if (!raw) return null

  if (raw.endsWith('ms')) {
    const milliseconds = parseFloat(raw.slice(0, -2))
    return Number.isFinite(milliseconds) ? milliseconds / 1000 : null
  }
  if (raw.endsWith('s')) {
    const seconds = parseFloat(raw.slice(0, -1))
    return Number.isFinite(seconds) ? seconds : null
  }
  return null
}

const CLOUDCODE_DOMAINS = [
  'cloudcode-pa.googleapis.com',
  'staging-cloudcode-pa.googleapis.com',
  'autopush-cloudcode-pa.googleapis.com',
]

function classifyValidationRequiredError(googleApiError: GoogleApiError): ValidationRequiredError | null {
  const errorInfo = googleApiError.details.find(
    (d): d is ErrorInfo =>
      (d as any)?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo',
  )
  if (!errorInfo) return null

  if (!CLOUDCODE_DOMAINS.includes(errorInfo.domain) || errorInfo.reason !== 'VALIDATION_REQUIRED') {
    return null
  }

  const helpDetail = googleApiError.details.find(
    (d): d is Help => (d as any)?.['@type'] === 'type.googleapis.com/google.rpc.Help',
  )

  let validationLink: string | undefined
  let validationDescription: string | undefined
  let learnMoreUrl: string | undefined

  if (helpDetail?.links && helpDetail.links.length > 0) {
    const first = helpDetail.links[0]
    if (first?.url) validationLink = first.url
    if (first?.description) validationDescription = first.description

    const learnMore = helpDetail.links.find(link => {
      const desc = String(link?.description ?? '').toLowerCase().trim()
      if (desc === 'learn more') return true
      try {
        const parsed = new URL(link.url)
        return parsed.hostname === 'support.google.com'
      } catch {
        return false
      }
    })
    if (learnMore?.url) learnMoreUrl = learnMore.url
  }

  if (!validationLink) {
    const meta = errorInfo.metadata ?? {}
    const v = typeof meta['validation_link'] === 'string' ? meta['validation_link'].trim() : ''
    if (v) validationLink = v
  }

  const extraLines: string[] = []
  if (validationDescription) {
    extraLines.push(`验证说明：${validationDescription}`)
  }
  if (validationLink) {
    extraLines.push(`请在浏览器打开验证链接：${validationLink}`)
  }
  if (learnMoreUrl) {
    extraLines.push(`了解更多：${learnMoreUrl}`)
  }
  const message =
    extraLines.length > 0
      ? `${googleApiError.message}\n${extraLines.join('\n')}`
      : googleApiError.message

  return new ValidationRequiredError({
    message,
    cause: googleApiError,
    validationLink,
    validationDescription,
    learnMoreUrl,
  })
}

export function classifyGoogleError(error: unknown): unknown {
  const googleApiError = parseGoogleApiError(error)
  const status = googleApiError?.code ?? getErrorStatus(error)

  if (status === 404) {
    const message =
      googleApiError?.message ||
      (error instanceof Error ? error.message : 'Model not found')
    return new ModelNotFoundError(message, status)
  }

  // 403: Cloud Code API 的 VALIDATION_REQUIRED（账号需要验证）
  if (status === 403 && googleApiError) {
    const validation = classifyValidationRequiredError(googleApiError)
    if (validation) return validation
  }

  // 非 429：先不做 quota 分类
  if (!googleApiError || googleApiError.code !== 429) {
    const msg =
      googleApiError?.message ||
      (error instanceof Error ? error.message : String(error))

    const match = msg.match(/Please retry in ([0-9.]+(?:ms|s))/)
    if (match?.[1]) {
      const retryDelaySeconds = parseDurationInSeconds(match[1])
      if (retryDelaySeconds !== null) {
        return new RetryableQuotaError(msg, googleApiError ?? undefined, retryDelaySeconds)
      }
    } else if (status === 429) {
      // 429 但没有结构化 details：默认当作可重试限流
      return new RetryableQuotaError(msg, googleApiError ?? undefined)
    }

    return error
  }

  // 429 with details
  const quotaFailure = googleApiError.details.find(
    (d): d is QuotaFailure =>
      (d as any)?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure',
  )
  const errorInfo = googleApiError.details.find(
    (d): d is ErrorInfo =>
      (d as any)?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo',
  )
  const retryInfo = googleApiError.details.find(
    (d): d is RetryInfo =>
      (d as any)?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo',
  )

  // 1) 长周期额度（按天）直接视为 terminal
  if (quotaFailure) {
    for (const violation of quotaFailure.violations ?? []) {
      const quotaId = String(violation?.quotaId ?? '')
      if (quotaId.includes('PerDay') || quotaId.includes('Daily')) {
        return new TerminalQuotaError('你已耗尽该模型的日配额（429）。', googleApiError)
      }
    }
  }

  let delaySeconds: number | undefined
  if (retryInfo?.retryDelay) {
    const parsed = parseDurationInSeconds(retryInfo.retryDelay)
    if (parsed !== null) delaySeconds = parsed
  }

  // 2) Cloud Code API 的新 quota 错误格式（ErrorInfo.reason）
  if (errorInfo?.domain && CLOUDCODE_DOMAINS.includes(errorInfo.domain)) {
    if (errorInfo.reason === 'RATE_LIMIT_EXCEEDED') {
      return new RetryableQuotaError(googleApiError.message, googleApiError, delaySeconds ?? 10)
    }
    if (errorInfo.reason === 'QUOTA_EXHAUSTED') {
      return new TerminalQuotaError(googleApiError.message, googleApiError, delaySeconds)
    }
  }

  // 3) RetryInfo 提供了明确的延迟
  if (retryInfo?.retryDelay && typeof delaySeconds === 'number') {
    return new RetryableQuotaError(
      `${googleApiError.message}\nSuggested retry after ${retryInfo.retryDelay}.`,
      googleApiError,
      delaySeconds,
    )
  }

  // 4) Per-minute quota：给一个保守的 60s
  if (quotaFailure) {
    for (const violation of quotaFailure.violations ?? []) {
      const quotaId = String(violation?.quotaId ?? '')
      if (quotaId.includes('PerMinute')) {
        return new RetryableQuotaError(
          `${googleApiError.message}\nSuggested retry after 60s.`,
          googleApiError,
          60,
        )
      }
    }
  }
  if (errorInfo) {
    const meta = errorInfo.metadata ?? {}
    const quotaLimit = String(meta['quota_limit'] ?? '')
    if (quotaLimit.includes('PerMinute')) {
      return new RetryableQuotaError(
        `${errorInfo.reason}\nSuggested retry after 60s.`,
        googleApiError,
        60,
      )
    }
  }

  // 兜底：429 都当作可重试
  return new RetryableQuotaError(googleApiError.message, googleApiError)
}
