import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const CURRENT_SESSION_VERSION = 1

export type SessionHeader = {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

export type SessionEntryBase = {
  type: string
  id: string
  parentId: string | null
  timestamp: string
}

export type SessionMessageEntry = SessionEntryBase & {
  type: 'message'
  message: any
}

export type CompactionEntry<T = unknown> = SessionEntryBase & {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: T
  fromHook?: boolean
}

export type BranchSummaryEntry<T = unknown> = SessionEntryBase & {
  type: 'branch_summary'
  fromId: string
  summary: string
  details?: T
  fromHook?: boolean
}

export type CustomEntry = SessionEntryBase & {
  type: 'custom'
  customType: string
  data?: unknown
}

export type SessionInfoEntry = SessionEntryBase & {
  type: 'session_info'
  name: string
}

export type LabelEntry = SessionEntryBase & {
  type: 'label'
  targetId: string
  label?: string
}

export type SessionEntry =
  | SessionMessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | SessionInfoEntry
  | LabelEntry

export type FileEntry = SessionHeader | SessionEntry

export type SessionListItem = {
  id: string
  path: string
  cwd: string
  name?: string
  parentSessionPath?: string
  created: Date
  modified: Date
  messageCount: number
  firstPrompt: string
}

const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'

const BRANCH_SUMMARY_PREFIX =
  'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n'
const BRANCH_SUMMARY_SUFFIX = '\n</summary>'

export function getDefaultSessionsDir(): string {
  return join(homedir(), '.yuuka', 'sessions')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function parseJsonl(content: string): FileEntry[] {
  const entries: FileEntry[] = []
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as FileEntry)
    } catch {
      // skip
    }
  }
  return entries
}

function loadEntriesFromFile(path: string): FileEntry[] {
  try {
    if (!existsSync(path)) return []
    const content = readFileSync(path, 'utf-8')
    return parseJsonl(content)
  } catch {
    return []
  }
}

function generateId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8)
    if (!byId.has(id)) return id
  }
  return randomUUID()
}

function isMessageWithContent(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false
  if (msg.type === 'user') return true
  if (msg.type === 'assistant') return true
  return false
}

function extractFirstUserText(msg: any): string {
  try {
    if (!msg || msg.type !== 'user') return ''
    const content = (msg as any)?.message?.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const firstText = content.find((b: any) => b?.type === 'text' && typeof b.text === 'string')
      return typeof firstText?.text === 'string' ? String(firstText.text).trim() : ''
    }
    return ''
  } catch {
    return ''
  }
}

function getSessionModifiedDate(entries: FileEntry[], fallback: Date): Date {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any
    if (e && typeof e.timestamp === 'string') {
      const t = Date.parse(e.timestamp)
      if (Number.isFinite(t)) return new Date(t)
    }
  }
  return fallback
}

async function buildSessionListItem(filePath: string): Promise<SessionListItem | null> {
  try {
    const entries = loadEntriesFromFile(filePath)
    const header = entries.find(e => (e as any)?.type === 'session') as SessionHeader | undefined
    if (!header?.id) return null

    const stats = statSync(filePath)
    let messageCount = 0
    let firstPrompt = ''
    let name: string | undefined

    for (const entry of entries) {
      if ((entry as any)?.type === 'session_info') {
        const v = (entry as any)?.name
        if (typeof v === 'string' && v.trim()) {
          name = v.trim()
        }
      }
      if ((entry as any)?.type !== 'message') continue
      const msg = (entry as any)?.message
      if (!isMessageWithContent(msg)) continue
      messageCount++
      if (!firstPrompt) {
        const t = extractFirstUserText(msg)
        if (t) firstPrompt = t
      }
    }

    const created = new Date(header.timestamp)
    const modified = getSessionModifiedDate(entries, stats.mtime)
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    const parentSessionPath =
      typeof header.parentSession === 'string' ? header.parentSession : undefined

    return {
      id: header.id,
      path: filePath,
      cwd,
      name,
      parentSessionPath,
      created: Number.isFinite(created.getTime()) ? created : new Date(stats.ctimeMs),
      modified,
      messageCount,
      firstPrompt: firstPrompt || '(no user messages)',
    }
  } catch {
    return null
  }
}

export async function listSessions(options?: {
  dir?: string
}): Promise<SessionListItem[]> {
  const dir = options?.dir ?? getDefaultSessionsDir()
  if (!existsSync(dir)) return []
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const items = await Promise.all(
    files.map(async f => buildSessionListItem(join(dir, f))),
  )
  return items
    .filter((v): v is SessionListItem => !!v)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
}

export function loadSessionEntries(sessionFile: string): {
  header: SessionHeader | null
  entries: SessionEntry[]
} {
  const fileEntries = loadEntriesFromFile(sessionFile)
  const header = fileEntries.find(e => (e as any)?.type === 'session') as SessionHeader | undefined
  const entries = fileEntries.filter((e): e is SessionEntry => (e as any)?.type !== 'session')
  return { header: header ?? null, entries }
}

export function buildSessionContextFromEntries(options: {
  entries: SessionEntry[]
  leafId?: string | null
  byId?: Map<string, SessionEntry>
}): { messages: any[] } {
  const entries = options.entries
  let byId = options.byId
  if (!byId) {
    byId = new Map<string, SessionEntry>()
    for (const e of entries) byId.set(e.id, e)
  }

  if (options.leafId === null) {
    return { messages: [] }
  }

  let leaf: SessionEntry | undefined
  if (options.leafId) {
    leaf = byId.get(options.leafId)
  }
  if (!leaf) {
    leaf = entries[entries.length - 1]
  }
  if (!leaf) return { messages: [] }

  const path: SessionEntry[] = []
  let current: SessionEntry | undefined = leaf
  while (current) {
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }

  let compaction: CompactionEntry | null = null
  for (const entry of path) {
    if (entry.type === 'compaction') {
      compaction = entry as CompactionEntry
    }
  }

  const messages: any[] = []

  const appendMessageLike = (entry: SessionEntry) => {
    if (entry.type === 'message') {
      messages.push((entry as SessionMessageEntry).message)
      return
    }
    if (entry.type === 'branch_summary') {
      const bs = entry as BranchSummaryEntry
      messages.push({
        type: 'user',
        uuid: randomUUID(),
        message: {
          role: 'user',
          content: `${BRANCH_SUMMARY_PREFIX}${bs.summary}${BRANCH_SUMMARY_SUFFIX}`,
        },
        options: { _internal: 'branch_summary', fromId: bs.fromId },
      })
      return
    }
  }

  if (compaction) {
    messages.push({
      type: 'user',
      uuid: randomUUID(),
      message: {
        role: 'user',
        content: `${COMPACTION_SUMMARY_PREFIX}${compaction.summary}${COMPACTION_SUMMARY_SUFFIX}`,
      },
      options: { _internal: 'compaction_summary', tokensBefore: compaction.tokensBefore },
    })

    const compactionIdx = path.findIndex(e => e.type === 'compaction' && e.id === compaction.id)
    let foundFirstKept = false
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i]
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true
      }
      if (foundFirstKept) appendMessageLike(entry)
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      appendMessageLike(path[i])
    }
  } else {
    for (const entry of path) {
      appendMessageLike(entry)
    }
  }

  return { messages }
}

export class SessionManager {
  private sessionId = ''
  private sessionFile: string | undefined
  private sessionDir: string
  private cwd: string
  private fileEntries: FileEntry[] = []
  private byId: Map<string, SessionEntry> = new Map()
  private labelsById: Map<string, string> = new Map()
  private leafId: string | null = null
  private messageUuidToEntryId: Map<string, string> = new Map()

  private constructor(cwd: string, sessionDir: string, sessionFile?: string) {
    this.cwd = cwd
    this.sessionDir = sessionDir
    ensureDir(this.sessionDir)

    if (sessionFile) {
      this.setSessionFile(sessionFile)
    } else {
      this.newSession()
    }
  }

  static create(cwd: string, sessionDir?: string): SessionManager {
    return new SessionManager(cwd, sessionDir ?? getDefaultSessionsDir(), undefined)
  }

  static open(path: string, sessionDir?: string): SessionManager {
    const entries = loadEntriesFromFile(path)
    const header = entries.find(e => (e as any)?.type === 'session') as SessionHeader | undefined
    const cwd = header?.cwd ?? process.cwd()
    const dir = sessionDir ?? resolve(path, '..')
    return new SessionManager(cwd, dir, path)
  }

  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const dir = sessionDir ?? getDefaultSessionsDir()
    ensureDir(dir)
    let mostRecent: { path: string; mtimeMs: number } | null = null

    try {
      const names = existsSync(dir) ? readdirSync(dir) : []
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const p = join(dir, name)
        try {
          const s = statSync(p)
          if (!mostRecent || s.mtimeMs > mostRecent.mtimeMs) {
            mostRecent = { path: p, mtimeMs: s.mtimeMs }
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    if (mostRecent) {
      return new SessionManager(cwd, dir, mostRecent.path)
    }
    return new SessionManager(cwd, dir, undefined)
  }

  getSessionId(): string {
    return this.sessionId
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  getSessionDir(): string {
    return this.sessionDir
  }

  getCwd(): string {
    return this.cwd
  }

  getLeafId(): string | null {
    return this.leafId
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter(
      (e): e is SessionEntry => (e as any)?.type !== 'session',
    )
  }

  buildSessionContext(): { messages: any[] } {
    return buildSessionContextFromEntries({
      entries: this.getEntries(),
      leafId: this.leafId,
      byId: this.byId,
    })
  }

  setSessionFile(sessionFile: string): void {
    this.sessionFile = resolve(sessionFile)
    if (existsSync(this.sessionFile)) {
      this.fileEntries = loadEntriesFromFile(this.sessionFile)
      const header = this.fileEntries.find(
        e => (e as any)?.type === 'session',
      ) as SessionHeader | undefined
      if (!header?.id) {
        // corrupted/empty: re-init and rewrite to the same explicit path
        const explicit = this.sessionFile
        this.newSession()
        this.sessionFile = explicit
        this.rewriteFile()
        return
      }
      this.sessionId = header.id
      this.buildIndex()
      return
    }

    // file doesn't exist: create new session but keep explicit filename
    const explicit = this.sessionFile
    this.newSession()
    this.sessionFile = explicit
    this.rewriteFile()
  }

  newSession(options?: { parentSession?: string }): string | undefined {
    this.sessionId = randomUUID()
    const timestamp = new Date().toISOString()
    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession,
    }
    this.fileEntries = [header]
    this.byId.clear()
    this.labelsById.clear()
    this.leafId = null

    const fileTimestamp = timestamp.replace(/[:.]/g, '-')
    this.sessionFile = join(this.sessionDir, `${fileTimestamp}_${this.sessionId}.jsonl`)
    this.rewriteFile()
    return this.sessionFile
  }

  private buildIndex(): void {
    this.byId.clear()
    this.labelsById.clear()
    this.leafId = null
    this.messageUuidToEntryId.clear()
    for (const entry of this.fileEntries) {
      if ((entry as any)?.type === 'session') continue
      const e = entry as SessionEntry
      this.byId.set(e.id, e)
      this.leafId = e.id
      if (e.type === 'label') {
        if (e.label) {
          this.labelsById.set(e.targetId, e.label)
        } else {
          this.labelsById.delete(e.targetId)
        }
      }
      if (e.type === 'message') {
        const msg = (e as SessionMessageEntry).message as any
        const uuid = typeof msg?.uuid === 'string' ? msg.uuid : ''
        if (uuid) {
          this.messageUuidToEntryId.set(uuid, e.id)
        }
      }
    }
  }

  private rewriteFile(): void {
    if (!this.sessionFile) return
    ensureDir(this.sessionDir)
    const content = `${this.fileEntries.map(e => JSON.stringify(e)).join('\n')}\n`
    writeFileSync(this.sessionFile, content, 'utf-8')
  }

  private persist(entry: SessionEntry): void {
    if (!this.sessionFile) return
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, 'utf-8')
  }

  private appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry)
    this.byId.set(entry.id, entry)
    this.leafId = entry.id
    if (entry.type === 'message') {
      const msg = (entry as SessionMessageEntry).message as any
      const uuid = typeof msg?.uuid === 'string' ? msg.uuid : ''
      if (uuid) {
        this.messageUuidToEntryId.set(uuid, entry.id)
      }
    }
    this.persist(entry)
  }

  appendMessage(message: any): string {
    const entry: SessionMessageEntry = {
      type: 'message',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    }
    this.appendEntry(entry)
    return entry.id
  }

  findEntryIdByMessageUuid(uuid: string): string | undefined {
    const key = String(uuid ?? '').trim()
    if (!key) return undefined
    return this.messageUuidToEntryId.get(key)
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: 'session_info',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: String(name ?? '').trim(),
    }
    this.appendEntry(entry)
    return entry.id
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: 'custom',
      customType,
      data,
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    }
    this.appendEntry(entry)
    return entry.id
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
  ): string {
    if (!this.byId.has(firstKeptEntryId)) {
      throw new Error(`firstKeptEntryId not found: ${firstKeptEntryId}`)
    }
    const entry: CompactionEntry<T> = {
      type: 'compaction',
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    }
    this.appendEntry(entry)
    return entry.id
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`)
    }
    this.leafId = branchFromId
  }

  branchToRoot(): void {
    this.leafId = null
  }
}
