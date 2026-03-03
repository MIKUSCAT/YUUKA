import { classifyGoogleError, RetryableQuotaError, TerminalQuotaError, ValidationRequiredError } from './googleQuotaErrors'
import { getErrorStatus, ModelNotFoundError } from './httpErrors'

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_INITIAL_DELAY_MS = 5000
export const DEFAULT_MAX_DELAY_MS = 30000

export type RetryEvent = {
  attempt: number
  maxAttempts: number
  delayMs: number
  error: unknown
  classifiedError: unknown
  status?: number
  kind: 'quota' | 'backoff'
}

export interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  retryFetchErrors?: boolean
  signal?: AbortSignal
  shouldRetryOnError?: (error: unknown, retryFetchErrors?: boolean) => boolean
  onRetry?: (event: RetryEvent) => void
}

const RETRYABLE_NETWORK_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  // SSL/TLS transient errors
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
  'EPROTO',
]

function createAbortError(): Error {
  const err = new Error('Aborted')
  ;(err as any).name = 'AbortError'
  return err
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

function getNetworkErrorCode(error: unknown): string | undefined {
  const getCode = (obj: unknown): string | undefined => {
    if (!obj || typeof obj !== 'object') return undefined
    const code = (obj as any).code
    return typeof code === 'string' && code.trim() ? code.trim() : undefined
  }

  const direct = getCode(error)
  if (direct) return direct

  let current: unknown = error
  const maxDepth = 5
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!current || typeof current !== 'object' || !('cause' in (current as any))) {
      break
    }
    current = (current as any).cause
    const code = getCode(current)
    if (code) return code
  }

  return undefined
}

const FETCH_FAILED_MESSAGE = 'fetch failed'

export function isRetryableError(
  error: Error | unknown,
  retryFetchErrors?: boolean,
): boolean {
  const errorCode = getNetworkErrorCode(error)
  if (errorCode && RETRYABLE_NETWORK_CODES.includes(errorCode)) {
    return true
  }

  if (retryFetchErrors && error instanceof Error) {
    if (error.message.toLowerCase().includes(FETCH_FAILED_MESSAGE)) {
      return true
    }
  }

  const status = getErrorStatus(error)
  if (status !== undefined) {
    if (status === 400) return false
    return status === 408 || status === 429 || (status >= 500 && status < 600)
  }

  return false
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError()
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, Math.floor(ms)))
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    const cleanup = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  if (options?.signal?.aborted) {
    throw createAbortError()
  }

  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive number.')
  }

  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const retryFetchErrors = options?.retryFetchErrors ?? false
  const shouldRetryOnError = options?.shouldRetryOnError ?? isRetryableError
  const onRetry = options?.onRetry
  const signal = options?.signal

  let attempt = 0
  let currentDelay = initialDelayMs

  while (attempt < maxAttempts) {
    if (signal?.aborted) {
      throw createAbortError()
    }

    attempt++
    try {
      return await fn()
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      const classified = classifyGoogleError(error)
      const status = getErrorStatus(error)

      if (classified instanceof TerminalQuotaError || classified instanceof ModelNotFoundError) {
        throw classified
      }

      if (classified instanceof ValidationRequiredError) {
        throw classified
      }

      const is500 = status !== undefined && status >= 500 && status < 600

      if (classified instanceof RetryableQuotaError || is500) {
        if (attempt >= maxAttempts) {
          throw classified instanceof RetryableQuotaError ? classified : error
        }

        if (classified instanceof RetryableQuotaError && classified.retryDelayMs !== undefined) {
          const delayMs = Math.max(0, Math.floor(classified.retryDelayMs))
          onRetry?.({
            attempt,
            maxAttempts,
            delayMs,
            error,
            classifiedError: classified,
            status,
            kind: 'quota',
          })
          await delay(delayMs, signal)
          continue
        }

        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1)
        const delayMs = Math.max(0, Math.floor(currentDelay + jitter))
        onRetry?.({
          attempt,
          maxAttempts,
          delayMs,
          error,
          classifiedError: classified,
          status,
          kind: 'backoff',
        })
        await delay(delayMs, signal)
        currentDelay = Math.min(maxDelayMs, currentDelay * 2)
        continue
      }

      if (attempt >= maxAttempts || !shouldRetryOnError(error as any, retryFetchErrors)) {
        throw error
      }

      const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1)
      const delayMs = Math.max(0, Math.floor(currentDelay + jitter))
      onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error,
        classifiedError: classified,
        status,
        kind: 'backoff',
      })
      await delay(delayMs, signal)
      currentDelay = Math.min(maxDelayMs, currentDelay * 2)
    }
  }

  throw new Error('Retry attempts exhausted')
}
