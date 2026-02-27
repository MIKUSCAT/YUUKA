import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Tool } from '@tool'
import { getMessagesPath } from './log'
import { deserializeMessages } from './conversationRecovery'

const SNAPSHOT_DIR = join(homedir(), '.yuuka', 'snapshots')
const SNAPSHOT_EXT = '.snapshot.json'
const DEFAULT_MAX_LIST = 50

export type ConversationSnapshot = {
  id: string
  createdAt: number
  createdAtIso: string
  reason: string
  label?: string
  messageLogName: string
  forkNumber: number
  sidechainNumber: number
  sourcePath: string
  messageCount: number
  messages: any[]
}

export type ConversationSnapshotMeta = Omit<ConversationSnapshot, 'messages'>

type SnapshotContextLike = {
  options?: {
    messageLogName?: string
    forkNumber?: number
  }
}

function ensureSnapshotDir(): void {
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true })
  }
}

function readJSONFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function sanitizeSegment(input: string, fallback = 'snapshot'): string {
  const normalized = String(input || '')
    .trim()
    .replace(/[^\w\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return normalized || fallback
}

function toFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function splitMeta(snapshot: ConversationSnapshot): ConversationSnapshotMeta {
  const { messages: _, ...meta } = snapshot
  return meta
}

function readSnapshot(filePath: string): ConversationSnapshot | null {
  const parsed = readJSONFile<ConversationSnapshot>(filePath)
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null
  }
  if (!parsed.id || !parsed.createdAt || !parsed.reason) {
    return null
  }
  return parsed
}

function getSnapshotFilePathById(id: string): string {
  return join(SNAPSHOT_DIR, `${id}${SNAPSHOT_EXT}`)
}

function getAllSnapshotMetas(): ConversationSnapshotMeta[] {
  ensureSnapshotDir()
  const files = readdirSync(SNAPSHOT_DIR).filter(file => file.endsWith(SNAPSHOT_EXT))
  const metas: ConversationSnapshotMeta[] = []

  for (const file of files) {
    const snapshot = readSnapshot(join(SNAPSHOT_DIR, file))
    if (!snapshot) continue
    metas.push(splitMeta(snapshot))
  }

  metas.sort((a, b) => b.createdAt - a.createdAt)
  return metas
}

export function createConversationSnapshot(input: {
  messageLogName: string
  forkNumber?: number
  sidechainNumber?: number
  reason: string
  label?: string
  sourcePath?: string
}): ConversationSnapshotMeta {
  ensureSnapshotDir()

  const forkNumber = Number.isFinite(Number(input.forkNumber))
    ? Math.max(0, Math.floor(Number(input.forkNumber)))
    : 0
  const sidechainNumber = Number.isFinite(Number(input.sidechainNumber))
    ? Math.max(0, Math.floor(Number(input.sidechainNumber)))
    : 0
  const sourcePath =
    input.sourcePath ||
    getMessagesPath(input.messageLogName, forkNumber, sidechainNumber)

  if (!existsSync(sourcePath)) {
    throw new Error(`Snapshot source log not found: ${sourcePath}`)
  }

  const messages = readJSONFile<any[]>(sourcePath)
  if (!Array.isArray(messages)) {
    throw new Error(`Snapshot source is not a valid message array: ${sourcePath}`)
  }

  const now = new Date()
  const baseId = `${toFileTimestamp(now)}-${sanitizeSegment(
    input.label || input.reason || 'snapshot',
  )}`
  let id = baseId
  let suffix = 1
  while (existsSync(getSnapshotFilePathById(id))) {
    suffix += 1
    id = `${baseId}-${suffix}`
  }

  const snapshot: ConversationSnapshot = {
    id,
    createdAt: now.getTime(),
    createdAtIso: now.toISOString(),
    reason: String(input.reason || 'manual'),
    ...(input.label ? { label: input.label } : {}),
    messageLogName: input.messageLogName,
    forkNumber,
    sidechainNumber,
    sourcePath,
    messageCount: messages.length,
    messages,
  }

  writeFileSync(
    getSnapshotFilePathById(id),
    JSON.stringify(snapshot, null, 2),
    'utf-8',
  )

  return splitMeta(snapshot)
}

export function tryCreateAutoSnapshotFromContext(
  context: SnapshotContextLike,
  reason: string,
  label?: string,
): ConversationSnapshotMeta | null {
  const messageLogName = String(context?.options?.messageLogName || '').trim()
  if (!messageLogName) return null
  const forkNumber = Number(context?.options?.forkNumber || 0)
  try {
    return createConversationSnapshot({
      messageLogName,
      forkNumber,
      reason,
      label,
    })
  } catch {
    return null
  }
}

export function listConversationSnapshots(
  limit = DEFAULT_MAX_LIST,
): ConversationSnapshotMeta[] {
  const maxItems = Number.isFinite(Number(limit))
    ? Math.max(1, Math.floor(Number(limit)))
    : DEFAULT_MAX_LIST
  return getAllSnapshotMetas().slice(0, maxItems)
}

export function resolveConversationSnapshot(
  target?: string,
): ConversationSnapshotMeta | null {
  const metas = getAllSnapshotMetas()
  if (metas.length === 0) return null

  const raw = String(target || '').trim()
  if (!raw) return metas[0]

  if (/^\d+$/.test(raw)) {
    const index = Math.max(1, Number(raw))
    return metas[index - 1] || null
  }

  const exact = metas.find(meta => meta.id === raw)
  if (exact) return exact

  const prefix = metas.find(meta => meta.id.startsWith(raw))
  if (prefix) return prefix

  const byLabel = metas.find(meta =>
    String(meta.label || '').toLowerCase().includes(raw.toLowerCase()),
  )
  if (byLabel) return byLabel

  return null
}

export function loadConversationSnapshotMessages(
  target: string | undefined,
  tools: Tool[],
): { snapshot: ConversationSnapshotMeta; messages: any[] } {
  const meta = resolveConversationSnapshot(target)
  if (!meta) {
    throw new Error('Snapshot not found')
  }
  const filePath = getSnapshotFilePathById(meta.id)
  const snapshot = readSnapshot(filePath)
  if (!snapshot) {
    throw new Error(`Snapshot file is invalid: ${filePath}`)
  }
  return {
    snapshot: splitMeta(snapshot),
    messages: deserializeMessages(snapshot.messages, tools),
  }
}

