import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { CONFIG_BASE_DIR } from '@constants/product'

function ensureDirectory(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
  return path
}

function normalizeSegment(input: string | undefined, fallback: string): string {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return fallback
  const normalized = raw
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  return normalized || fallback
}

export function normalizeTeamName(teamName?: string): string {
  return normalizeSegment(teamName, 'default-team')
}

export function normalizeAgentName(agentName?: string): string {
  return normalizeSegment(agentName, 'agent')
}

export function getYuukaDataDir(): string {
  return ensureDirectory(join(homedir(), CONFIG_BASE_DIR))
}

export function getTeamsDir(): string {
  return ensureDirectory(join(getYuukaDataDir(), 'teams'))
}

export function getTasksDir(): string {
  return ensureDirectory(join(getYuukaDataDir(), 'tasks'))
}

export function getMailboxDir(): string {
  return ensureDirectory(join(getYuukaDataDir(), 'mailbox'))
}

export function getTeamMetaPath(teamName: string): string {
  return join(getTeamsDir(), `${normalizeTeamName(teamName)}.json`)
}

export function getTeamTaskDir(teamName: string): string {
  return ensureDirectory(join(getTasksDir(), normalizeTeamName(teamName)))
}

export function getTeamTaskPath(teamName: string, taskId: string): string {
  return join(getTeamTaskDir(teamName), `${taskId}.json`)
}

export function getAgentMailboxDir(teamName: string, agentName: string): string {
  return ensureDirectory(
    join(
      getMailboxDir(),
      normalizeTeamName(teamName),
      normalizeAgentName(agentName),
    ),
  )
}

export function getAgentInboxPath(teamName: string, agentName: string): string {
  return join(getAgentMailboxDir(teamName, agentName), 'inbox.jsonl')
}

export function getAgentOutboxPath(teamName: string, agentName: string): string {
  return join(getAgentMailboxDir(teamName, agentName), 'outbox.jsonl')
}
