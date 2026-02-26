/**
 * 跨进程 API 请求信号量
 *
 * 基于文件锁实现：每个"槽位"是 ~/.yuuka/.api-semaphore/slot-N.lock，
 * 用 openSync(path, 'wx') 独占创建来竞争槽位，保证多个子进程不会同时
 * 请求 Gemini API 导致 429。
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { readGeminiSettingsFile, getGlobalGeminiSettingsPath } from './geminiSettings'

const SEMAPHORE_DIR = join(homedir(), '.yuuka', '.api-semaphore')
const DEFAULT_MAX_CONCURRENT = 2
const SLOT_STALE_MS = 120_000 // 120 秒未释放视为过期
const ACQUIRE_RETRY_MS = 200

let heldSlotPath: string | null = null
let heldSlotFd: number | null = null

function ensureSemaphoreDir(): void {
  if (!existsSync(SEMAPHORE_DIR)) {
    mkdirSync(SEMAPHORE_DIR, { recursive: true })
  }
}

/**
 * 从 settings.json 读取 performance.maxConcurrentApiRequests，
 * 默认返回 2。
 */
export function getMaxConcurrentApiRequests(): number {
  try {
    const settings = readGeminiSettingsFile(getGlobalGeminiSettingsPath())
    const configured = (settings as any)?.performance?.maxConcurrentApiRequests
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1) {
      return Math.floor(Math.min(configured, 20))
    }
  } catch {
    // ignore
  }
  return DEFAULT_MAX_CONCURRENT
}

/**
 * 清理过期槽位文件（超过 SLOT_STALE_MS 未更新的）
 */
function cleanupStaleSlots(): void {
  try {
    const files = readdirSync(SEMAPHORE_DIR)
    const now = Date.now()
    for (const file of files) {
      if (!file.startsWith('slot-') || !file.endsWith('.lock')) continue
      const filePath = join(SEMAPHORE_DIR, file)
      try {
        const stat = statSync(filePath)
        if (now - stat.mtimeMs > SLOT_STALE_MS) {
          unlinkSync(filePath)
        }
      } catch {
        // 文件可能已被其他进程删除
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 尝试获取一个 API 槽位。
 * 如果所有槽位已满，等待 ACQUIRE_RETRY_MS 后重试。
 * 支持 AbortSignal 中断等待。
 */
export async function acquireApiSlot(signal?: AbortSignal): Promise<void> {
  ensureSemaphoreDir()
  cleanupStaleSlots()

  const maxSlots = getMaxConcurrentApiRequests()

  while (true) {
    if (signal?.aborted) return

    for (let i = 0; i < maxSlots; i++) {
      const slotPath = join(SEMAPHORE_DIR, `slot-${i}.lock`)
      try {
        const fd = openSync(slotPath, 'wx')
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), 'utf-8')
        } catch {
          // 写入元数据失败不影响锁
        }
        heldSlotPath = slotPath
        heldSlotFd = fd
        return
      } catch (error: any) {
        if (error?.code === 'EEXIST') {
          // 槽位被占用，检查是否过期
          try {
            const stat = statSync(slotPath)
            if (Date.now() - stat.mtimeMs > SLOT_STALE_MS) {
              try {
                unlinkSync(slotPath)
              } catch {
                // 可能被其他进程抢先清理
              }
              // 不递归，让下一轮 for 循环重试
            }
          } catch {
            // stat 失败说明文件已被删除，下轮会重新尝试
          }
          continue
        }
        throw error
      }
    }

    // 所有槽位已满，等待后重试
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ACQUIRE_RETRY_MS)
      const onAbort = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/**
 * 释放当前持有的 API 槽位
 */
export function releaseApiSlot(): void {
  if (heldSlotFd !== null) {
    try {
      closeSync(heldSlotFd)
    } catch {
      // ignore
    }
    heldSlotFd = null
  }
  if (heldSlotPath !== null) {
    try {
      unlinkSync(heldSlotPath)
    } catch {
      // ignore
    }
    heldSlotPath = null
  }
}
