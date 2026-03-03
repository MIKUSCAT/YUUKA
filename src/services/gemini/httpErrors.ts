export interface HttpError extends Error {
  status?: number
}

/**
 * 尽量从各种 error 形状里提取 HTTP status。
 * 兼容：
 * - { status: number }
 * - axios/gaxios: { response: { status: number } }
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined

  const maybeStatus = (error as any).status
  if (typeof maybeStatus === 'number' && Number.isFinite(maybeStatus)) {
    return maybeStatus
  }

  const resp = (error as any).response
  if (resp && typeof resp === 'object') {
    const status = (resp as any).status
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status
    }
  }

  return undefined
}

export class ModelNotFoundError extends Error {
  readonly name = 'ModelNotFoundError'
  readonly code: number

  constructor(message: string, code?: number) {
    super(message)
    this.code = typeof code === 'number' ? code : 404
  }
}

