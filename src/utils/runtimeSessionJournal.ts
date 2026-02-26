import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { withFileLockSync } from './fileLock'
import type { RuntimeAgentEvent } from './runtimeHooks'

const JOURNAL_DIR = join(homedir(), '.yuuka', 'runtime-sessions')
const MAX_EVENT_TEXT_LEN = 2000
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024

function sanitizeSegment(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  return raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}

function getJournalPath(event: RuntimeAgentEvent): string {
  const session = sanitizeSegment((event as any).sessionId, 'session')
  const agent = sanitizeSegment((event as any).agentId, 'agent')
  return join(JOURNAL_DIR, `${session}.${agent}.events.jsonl`)
}

function trimEvent(event: RuntimeAgentEvent): RuntimeAgentEvent {
  if (event.type !== 'assistant_message') return event
  return {
    ...event,
    text:
      event.text.length > MAX_EVENT_TEXT_LEN
        ? `${event.text.slice(0, MAX_EVENT_TEXT_LEN)}...[truncated]`
        : event.text,
  }
}

function shouldPersistEvent(event: RuntimeAgentEvent): boolean {
  switch (event.type) {
    case 'runtime_start':
    case 'runtime_end':
    case 'assistant_message':
    case 'tool_start':
    case 'tool_end':
    case 'permission_request':
    case 'permission_result':
      return true
    default:
      return false
  }
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return
    const stat = statSync(path)
    if (stat.size <= MAX_JOURNAL_BYTES) return
    const rotatedPath = `${path}.${Date.now()}.bak`
    // 简单轮转：新会话继续写新文件，旧文件保留备份
    // 使用锁的调用方保证这里不会被并发写打断
    renameSync(path, rotatedPath)
  } catch {
    // 忽略轮转失败，不阻塞主流程
  }
}

export function appendRuntimeEventToJournal(event: RuntimeAgentEvent): void {
  if (!shouldPersistEvent(event)) return

  const path = getJournalPath(event)
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true })
    withFileLockSync(path, () => {
      rotateIfNeeded(path)
      const payload = JSON.stringify({
        ts: Date.now(),
        ...trimEvent(event),
      })
      appendFileSync(path, `${payload}\n`, 'utf-8')
    }, { timeoutMs: 500, retryDelayMs: 10, staleMs: 3000 })
  } catch {
    // 不让日志写入影响主流程
  }
}
