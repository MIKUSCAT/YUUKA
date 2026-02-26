import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { getAgentInboxPath, getAgentOutboxPath } from './teamPaths'
import { withFileLockSync } from '@utils/fileLock'

export type MailboxKind = 'inbox' | 'outbox'

export type TeamMailboxMessageType =
  | 'message'
  | 'progress'
  | 'result'
  | 'status'
  | 'broadcast'
  | 'shutdown_request'
  | 'shutdown_response'
  | 'plan_approval_response'

export interface TeamMailboxMessage {
  id: string
  teamName: string
  from: string
  to: string
  type: TeamMailboxMessageType
  content: string
  taskId?: string
  summary?: string
  requestId?: string
  approve?: boolean
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface MailboxReadCursorResult {
  messages: TeamMailboxMessage[]
  nextLine: number
  scannedLines: number
}

function ensureMailboxFile(path: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, '', 'utf-8')
  }
}

function getMailboxPath(
  kind: MailboxKind,
  teamName: string,
  agentName: string,
): string {
  return kind === 'inbox'
    ? getAgentInboxPath(teamName, agentName)
    : getAgentOutboxPath(teamName, agentName)
}

export function appendMailboxMessage(
  kind: MailboxKind,
  teamName: string,
  agentName: string,
  message: TeamMailboxMessage,
): void {
  const path = getMailboxPath(kind, teamName, agentName)
  withFileLockSync(path, () => {
    ensureMailboxFile(path)
    appendFileSync(path, `${JSON.stringify(message)}\n`, 'utf-8')
  })
}

export function readMailboxMessagesWithCursor(
  kind: MailboxKind,
  teamName: string,
  agentName: string,
  fromLine = 0,
): MailboxReadCursorResult {
  const path = getMailboxPath(kind, teamName, agentName)
  return withFileLockSync(path, () => {
    ensureMailboxFile(path)
    const content = readFileSync(path, 'utf-8')
    if (!content) {
      const nextLine = Math.max(0, fromLine)
      return { messages: [], nextLine, scannedLines: 0 }
    }

    const startLine = Math.max(0, fromLine)
    const rawLines = content.split('\n')
    const hasTrailingNewline = content.endsWith('\n')

    // 只消费“完整行”。若最后一行未写完（并发写/崩溃中断），本次不前进游标，
    // 等下次出现换行后再解析，避免丢消息。
    const completeLines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines.slice(0, -1)
    if (completeLines.length === 0 || startLine >= completeLines.length) {
      return { messages: [], nextLine: startLine, scannedLines: 0 }
    }

    const sliced = completeLines.slice(startLine)
    const messages: TeamMailboxMessage[] = []
    for (const line of sliced) {
      if (!line) {
        // 保持游标前进，避免空行导致死循环；仅跳过消息解析。
        continue
      }
      try {
        const parsed = JSON.parse(line)
        messages.push(parsed as TeamMailboxMessage)
      } catch {
        // 对完整但损坏的行保持跳过并前进游标，避免卡死读取循环
      }
    }
    return {
      messages,
      scannedLines: sliced.length,
      nextLine: startLine + sliced.length,
    }
  })
}

export function readMailboxMessages(
  kind: MailboxKind,
  teamName: string,
  agentName: string,
  fromLine = 0,
): TeamMailboxMessage[] {
  return readMailboxMessagesWithCursor(kind, teamName, agentName, fromLine).messages
}
