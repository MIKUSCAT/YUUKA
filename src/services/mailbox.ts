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
  ensureMailboxFile(path)
  const content = readFileSync(path, 'utf-8')
  if (!content) {
    const nextLine = Math.max(0, fromLine)
    return { messages: [], nextLine, scannedLines: 0 }
  }
  const lines = content.split('\n')
  const nonEmptyLines = lines.filter(Boolean)
  if (nonEmptyLines.length === 0) {
    const nextLine = Math.max(0, fromLine)
    return { messages: [], nextLine, scannedLines: 0 }
  }

  const startLine = Math.max(0, fromLine)
  const sliced = nonEmptyLines.slice(startLine)
  const messages: TeamMailboxMessage[] = []
  for (const line of sliced) {
    try {
      const parsed = JSON.parse(line)
      messages.push(parsed as TeamMailboxMessage)
    } catch {
      // 忽略损坏行，避免整个读取失败
    }
  }
  return {
    messages,
    scannedLines: sliced.length,
    nextLine: startLine + sliced.length,
  }
}

export function readMailboxMessages(
  kind: MailboxKind,
  teamName: string,
  agentName: string,
  fromLine = 0,
): TeamMailboxMessage[] {
  return readMailboxMessagesWithCursor(kind, teamName, agentName, fromLine).messages
}
