import { closeSync, openSync, statSync, unlinkSync, writeFileSync } from 'fs'

const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return
  Atomics.wait(SLEEP_VIEW, 0, 0, Math.floor(ms))
}

function isLockStale(lockPath: string, staleMs: number): boolean {
  try {
    const stat = statSync(lockPath)
    return Date.now() - stat.mtimeMs > staleMs
  } catch {
    return false
  }
}

export function withFileLockSync<T>(
  targetPath: string,
  fn: () => T,
  options?: {
    timeoutMs?: number
    retryDelayMs?: number
    staleMs?: number
  },
): T {
  const timeoutMs = options?.timeoutMs ?? 5000
  const retryDelayMs = options?.retryDelayMs ?? 15
  const staleMs = options?.staleMs ?? 15000
  const lockPath = `${targetPath}.lock`
  const startedAt = Date.now()

  let lockFd: number | null = null

  while (lockFd === null) {
    try {
      lockFd = openSync(lockPath, 'wx')
      try {
        writeFileSync(
          lockFd,
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          'utf-8',
        )
      } catch {
        // Ignore metadata write failures; lock ownership already established.
      }
      break
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error
      }

      if (isLockStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath)
          continue
        } catch {
          // Another process may have released/replaced the lock.
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out acquiring file lock: ${targetPath}`)
      }

      sleepSync(retryDelayMs)
    }
  }

  try {
    return fn()
  } finally {
    if (lockFd !== null) {
      try {
        closeSync(lockFd)
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // ignore
    }
  }
}
