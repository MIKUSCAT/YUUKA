import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { getAgentInboxPath, getAgentOutboxPath } from './teamPaths'

export type MailboxKind = 'inbox' | 'outbox'

export interface TeamMailboxMessage {
  id: string
  teamName: string
  from: string
  to: string
  type: 'message' | 'progress' | 'result' | 'status'
  content: string
  taskId?: string
  createdAt: number
  metadata?: Record<string, unknown>
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
  ensureMailboxFile(path)
  appendFileSync(path, `${JSON.stringify(message)}\n`, 'utf-8')
}

export function readMailboxMessages(
  kind: MailboxKind,
  teamName: string,
  agentName: string,
  fromLine = 0,
): TeamMailboxMessage[] {
  const path = getMailboxPath(kind, teamName, agentName)
  ensureMailboxFile(path)
  const content = readFileSync(path, 'utf-8')
  if (!content.trim()) return []
  const lines = content.split('\n').filter(Boolean)
  const sliced = lines.slice(Math.max(0, fromLine))
  const messages: TeamMailboxMessage[] = []
  for (const line of sliced) {
    try {
      const parsed = JSON.parse(line)
      messages.push(parsed as TeamMailboxMessage)
    } catch {
      // 忽略损坏行，避免整个读取失败
    }
  }
  return messages
}
