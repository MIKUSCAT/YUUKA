import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { resolveAgentId } from '@utils/agentStorage'
import { MEMORY_DIR } from '@utils/env'

export type MemoryLayer = 'core' | 'retrievable' | 'episodic'
export type MemoryStatus = 'active' | 'archived'

export interface MemoryIndexEntry {
  file_path: string
  title: string
  tags: string[]
  summary: string
  layer: MemoryLayer
  strength: number
  status: MemoryStatus
  updated_at: string
  last_used_at: string | null
  last_decayed_at: string | null
}

interface MemoryIndex {
  version: 1
  updated_at: string
  entries: MemoryIndexEntry[]
}

interface MemoryIndexMutation {
  title?: string
  tags?: string[]
  summary?: string
  layer?: MemoryLayer
  status?: MemoryStatus
  strength?: number
  strengthDelta?: number
  touchLastUsed?: boolean
}

const MEMORY_INDEX_FILE = 'index.json'
const CORE_MEMORY_FILE = 'YUUKA.md'
const DECAY_INTERVAL_DAYS = 7
const ARCHIVE_THRESHOLD = 0
const MIN_STRENGTH = 0
const MAX_STRENGTH = 20
const DAY_MS = 24 * 60 * 60 * 1000

function nowIso(date = new Date()): string {
  return date.toISOString()
}

function normalizeMemoryFilePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
}

function emptyIndex(): MemoryIndex {
  return {
    version: 1,
    updated_at: nowIso(),
    entries: [],
  }
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return MIN_STRENGTH
  return Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, Math.round(value)))
}

function inferLayer(filePath: string): MemoryLayer {
  const normalized = normalizeMemoryFilePath(filePath)
  if (normalized === CORE_MEMORY_FILE) return 'core'
  if (
    normalized.startsWith('episodic/') ||
    normalized.startsWith('temp/') ||
    normalized.startsWith('tmp/')
  ) {
    return 'episodic'
  }
  return 'retrievable'
}

function defaultStrength(layer: MemoryLayer): number {
  if (layer === 'core') return 10
  if (layer === 'episodic') return 1
  return 3
}

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/`/g, '')
    .trim()
}

function summarizeMemory(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map(line => stripMarkdownNoise(line))
    .find(Boolean)

  if (!firstLine) return '（暂无摘要）'
  if (firstLine.length <= 80) return firstLine
  return `${firstLine.slice(0, 80)}...`
}

function titleFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.[^.]+$/, '')
  return name || filePath
}

function relativeMemoryPath(filePath: string, agentId?: string): string {
  const { agentMemoryDir } = resolveMemoryFilePath('.', agentId)
  const relativePath = relative(agentMemoryDir, filePath)
  return normalizeMemoryFilePath(relativePath)
}

function readIndex(agentId?: string): MemoryIndex {
  const indexPath = resolveMemoryFilePath(MEMORY_INDEX_FILE, agentId).fullPath
  if (!existsSync(indexPath)) return emptyIndex()

  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf-8'))
    if (!raw || typeof raw !== 'object') return emptyIndex()
    const entries = Array.isArray(raw.entries) ? raw.entries : []
    const normalizedEntries: MemoryIndexEntry[] = entries
      .map((entry: any) => {
        if (!entry || typeof entry !== 'object') return null
        const filePath = normalizeMemoryFilePath(String(entry.file_path || ''))
        if (!filePath || filePath === MEMORY_INDEX_FILE) return null

        const layer: MemoryLayer =
          entry.layer === 'core' ||
          entry.layer === 'retrievable' ||
          entry.layer === 'episodic'
            ? entry.layer
            : inferLayer(filePath)

        const status: MemoryStatus =
          entry.status === 'active' || entry.status === 'archived'
            ? entry.status
            : 'active'

        const title = String(entry.title || titleFromPath(filePath))
        const tags = Array.isArray(entry.tags)
          ? entry.tags
              .map((tag: unknown) => String(tag || '').trim())
              .filter(Boolean)
          : []
        const summary = String(entry.summary || '（暂无摘要）')
        const strength = clampStrength(
          typeof entry.strength === 'number'
            ? entry.strength
            : defaultStrength(layer),
        )
        const updatedAt = String(entry.updated_at || nowIso())
        const lastUsedAt =
          typeof entry.last_used_at === 'string' ? entry.last_used_at : null
        const lastDecayedAt =
          typeof entry.last_decayed_at === 'string'
            ? entry.last_decayed_at
            : null

        return {
          file_path: filePath,
          title,
          tags,
          summary,
          layer,
          strength,
          status,
          updated_at: updatedAt,
          last_used_at: lastUsedAt,
          last_decayed_at: lastDecayedAt,
        } satisfies MemoryIndexEntry
      })
      .filter(Boolean) as MemoryIndexEntry[]

    return {
      version: 1,
      updated_at: String(raw.updated_at || nowIso()),
      entries: normalizedEntries,
    }
  } catch {
    return emptyIndex()
  }
}

function writeIndex(index: MemoryIndex, agentId?: string): void {
  const indexPath = resolveMemoryFilePath(MEMORY_INDEX_FILE, agentId).fullPath
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
}

function compareTimeDesc(a: string | null, b: string | null): number {
  const aTs = a ? Date.parse(a) : 0
  const bTs = b ? Date.parse(b) : 0
  return bTs - aTs
}

function sortEntries(entries: MemoryIndexEntry[]): MemoryIndexEntry[] {
  const layerPriority: Record<MemoryLayer, number> = {
    core: 0,
    retrievable: 1,
    episodic: 2,
  }

  return [...entries].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'active' ? -1 : 1
    }
    if (layerPriority[a.layer] !== layerPriority[b.layer]) {
      return layerPriority[a.layer] - layerPriority[b.layer]
    }
    if (a.strength !== b.strength) {
      return b.strength - a.strength
    }
    const byUsed = compareTimeDesc(a.last_used_at, b.last_used_at)
    if (byUsed !== 0) return byUsed
    return compareTimeDesc(a.updated_at, b.updated_at)
  })
}

function applyDecay(entry: MemoryIndexEntry, now: Date): MemoryIndexEntry {
  if (entry.layer === 'core') return entry

  const anchor =
    entry.last_decayed_at || entry.last_used_at || entry.updated_at || nowIso()
  const anchorTs = Date.parse(anchor)
  if (!Number.isFinite(anchorTs)) return entry

  const elapsedDays = Math.floor((now.getTime() - anchorTs) / DAY_MS)
  const steps = Math.floor(elapsedDays / DECAY_INTERVAL_DAYS)
  if (steps <= 0) return entry

  const nextStrength = clampStrength(entry.strength - steps)
  const nextStatus: MemoryStatus =
    nextStrength <= ARCHIVE_THRESHOLD ? 'archived' : 'active'

  return {
    ...entry,
    strength: nextStrength,
    status: nextStatus,
    last_decayed_at: nowIso(now),
  }
}

function ensureIndex(agentId?: string): MemoryIndex {
  const now = new Date()
  let changed = false
  let index = readIndex(agentId)

  const entriesAfterDecay = index.entries.map(entry => {
    const decayed = applyDecay(entry, now)
    if (
      decayed.strength !== entry.strength ||
      decayed.status !== entry.status ||
      decayed.last_decayed_at !== entry.last_decayed_at
    ) {
      changed = true
    }
    return decayed
  })

  const filePaths = new Set(
    listMemoryFiles(agentId)
      .map(filePath => relativeMemoryPath(filePath, agentId))
      .filter(filePath => filePath && filePath !== MEMORY_INDEX_FILE),
  )

  const existingByPath = new Map<string, MemoryIndexEntry>()
  for (const entry of entriesAfterDecay) {
    if (filePaths.has(entry.file_path)) {
      existingByPath.set(entry.file_path, entry)
    } else {
      changed = true
    }
  }

  for (const filePath of filePaths) {
    if (!existingByPath.has(filePath)) {
      const content = readMemoryFile(filePath, agentId) || ''
      const layer = inferLayer(filePath)
      existingByPath.set(filePath, {
        file_path: filePath,
        title: titleFromPath(filePath),
        tags: [],
        summary: summarizeMemory(content),
        layer,
        strength: defaultStrength(layer),
        status: layer === 'core' ? 'active' : 'active',
        updated_at: nowIso(now),
        last_used_at: null,
        last_decayed_at: null,
      })
      changed = true
    }
  }

  const syncedEntries = sortEntries(Array.from(existingByPath.values()))
  if (
    syncedEntries.length !== index.entries.length ||
    syncedEntries.some((entry, idx) => entry !== index.entries[idx])
  ) {
    changed = true
  }

  index = {
    version: 1,
    updated_at: nowIso(now),
    entries: syncedEntries,
  }

  if (changed) {
    writeIndex(index, agentId)
  }

  return index
}

export function getAgentMemoryDir(agentId?: string): string {
  const resolvedAgentId = resolveAgentId(agentId)
  return join(MEMORY_DIR, 'agents', resolvedAgentId)
}

export function ensureAgentMemoryDir(agentId?: string): string {
  const agentMemoryDir = getAgentMemoryDir(agentId)
  mkdirSync(agentMemoryDir, { recursive: true })
  return agentMemoryDir
}

export function resolveMemoryFilePath(
  filePath: string,
  agentId?: string,
): { agentMemoryDir: string; fullPath: string } {
  const agentMemoryDir = getAgentMemoryDir(agentId)
  const normalizedDir = resolve(agentMemoryDir)
  const normalizedFullPath = resolve(normalizedDir, filePath)

  if (
    normalizedFullPath !== normalizedDir &&
    !normalizedFullPath.startsWith(`${normalizedDir}${sep}`)
  ) {
    throw new Error('Invalid memory file path')
  }

  return {
    agentMemoryDir: normalizedDir,
    fullPath: normalizedFullPath,
  }
}

export function readMemoryFile(
  filePath: string,
  agentId?: string,
): string | null {
  const { fullPath } = resolveMemoryFilePath(filePath, agentId)
  if (!existsSync(fullPath)) return null
  return readFileSync(fullPath, 'utf-8')
}

export function writeMemoryFile(
  filePath: string,
  content: string,
  agentId?: string,
): string {
  const { fullPath } = resolveMemoryFilePath(filePath, agentId)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

export function deleteMemoryFile(filePath: string, agentId?: string): boolean {
  const { fullPath } = resolveMemoryFilePath(filePath, agentId)
  if (!existsSync(fullPath)) return false
  unlinkSync(fullPath)
  return true
}

export function listMemoryFiles(agentId?: string): string[] {
  const agentMemoryDir = ensureAgentMemoryDir(agentId)
  return readdirSync(agentMemoryDir, { recursive: true })
    .map(entry => join(agentMemoryDir, entry.toString()))
    .filter(filePath => !lstatSync(filePath).isDirectory())
}

export function upsertMemoryIndexEntry(
  filePath: string,
  mutation: MemoryIndexMutation = {},
  agentId?: string,
): MemoryIndexEntry | null {
  const normalizedPath = normalizeMemoryFilePath(filePath)
  if (!normalizedPath || normalizedPath === MEMORY_INDEX_FILE) return null

  const index = ensureIndex(agentId)
  const now = nowIso()
  const byPath = new Map(index.entries.map(entry => [entry.file_path, entry]))

  const existing = byPath.get(normalizedPath)
  const content = readMemoryFile(normalizedPath, agentId) || ''
  const layer =
    normalizedPath === CORE_MEMORY_FILE
      ? 'core'
      : mutation.layer || existing?.layer || inferLayer(normalizedPath)

  const baseStrength = existing?.strength ?? defaultStrength(layer)
  const mergedStrength = clampStrength(
    mutation.strength ??
      baseStrength + (Number.isFinite(mutation.strengthDelta) ? mutation.strengthDelta! : 0),
  )

  const nextStatus: MemoryStatus =
    layer === 'core'
      ? 'active'
      : mutation.status
        ? mutation.status
        : mergedStrength <= ARCHIVE_THRESHOLD
          ? 'archived'
          : 'active'

  const next: MemoryIndexEntry = {
    file_path: normalizedPath,
    title: mutation.title || existing?.title || titleFromPath(normalizedPath),
    tags:
      mutation.tags ??
      existing?.tags ??
      (layer === 'core' ? ['偏好', '核心'] : layer === 'episodic' ? ['临时'] : []),
    summary: mutation.summary || existing?.summary || summarizeMemory(content),
    layer,
    strength: mergedStrength,
    status: nextStatus,
    updated_at: now,
    last_used_at: mutation.touchLastUsed ? now : existing?.last_used_at || null,
    last_decayed_at: existing?.last_decayed_at || null,
  }

  byPath.set(normalizedPath, next)

  const nextIndex: MemoryIndex = {
    version: 1,
    updated_at: now,
    entries: sortEntries(Array.from(byPath.values())),
  }
  writeIndex(nextIndex, agentId)
  return next
}

export function removeMemoryIndexEntry(filePath: string, agentId?: string): boolean {
  const normalizedPath = normalizeMemoryFilePath(filePath)
  if (!normalizedPath || normalizedPath === MEMORY_INDEX_FILE) return false

  const index = ensureIndex(agentId)
  const originalLength = index.entries.length
  const entries = index.entries.filter(entry => entry.file_path !== normalizedPath)
  if (entries.length === originalLength) return false

  writeIndex(
    {
      version: 1,
      updated_at: nowIso(),
      entries: sortEntries(entries),
    },
    agentId,
  )
  return true
}

export function markMemoryUsed(
  filePath: string,
  agentId?: string,
  helpful = false,
): MemoryIndexEntry | null {
  const normalizedPath = normalizeMemoryFilePath(filePath)
  if (!normalizedPath || normalizedPath === MEMORY_INDEX_FILE) return null
  if (readMemoryFile(normalizedPath, agentId) === null) return null

  return upsertMemoryIndexEntry(
    normalizedPath,
    {
      touchLastUsed: true,
      strengthDelta: helpful ? 1 : 0,
      status: 'active',
    },
    agentId,
  )
}

export function listMemoryIndexEntries(
  agentId?: string,
  options?: { includeArchived?: boolean },
): MemoryIndexEntry[] {
  const index = ensureIndex(agentId)
  const includeArchived = options?.includeArchived ?? false
  const entries = includeArchived
    ? index.entries
    : index.entries.filter(entry => entry.status === 'active')
  return sortEntries(entries)
}

export function searchMemoryIndex(
  query: string,
  agentId?: string,
  options?: { limit?: number; includeArchived?: boolean },
): MemoryIndexEntry[] {
  const tokens = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const limit = Math.min(10, Math.max(1, options?.limit ?? 3))
  const entries = listMemoryIndexEntries(agentId, {
    includeArchived: options?.includeArchived ?? false,
  })

  if (tokens.length === 0) {
    return entries.slice(0, limit)
  }

  const scored = entries
    .map(entry => {
      const filePath = entry.file_path.toLowerCase()
      const title = entry.title.toLowerCase()
      const tags = entry.tags.map(tag => tag.toLowerCase())
      const summary = entry.summary.toLowerCase()
      let score = entry.strength * 3 + (entry.layer === 'core' ? 4 : 0)

      for (const token of tokens) {
        if (filePath.includes(token)) score += 8
        if (title.includes(token)) score += 6
        if (tags.some(tag => tag.includes(token))) score += 5
        if (summary.includes(token)) score += 3
      }

      if (entry.status === 'archived') score -= 10
      if (entry.last_used_at && Date.now() - Date.parse(entry.last_used_at) <= 14 * DAY_MS) {
        score += 2
      }

      return { entry, score }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return scored.map(item => item.entry)
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '未使用'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return '未知'
  const diff = Date.now() - ts
  if (diff < DAY_MS) return '今天'
  if (diff < 2 * DAY_MS) return '1天前'
  const days = Math.floor(diff / DAY_MS)
  return `${days}天前`
}

export function formatMemoryIndexSummary(
  agentId?: string,
  options?: { limit?: number; includeArchived?: boolean },
): string {
  const limit = Math.min(50, Math.max(1, options?.limit ?? 20))
  const entries = listMemoryIndexEntries(agentId, {
    includeArchived: options?.includeArchived ?? false,
  }).slice(0, limit)

  if (entries.length === 0) {
    return '- (暂无可检索记忆)'
  }

  return entries
    .map(entry => {
      const tags = entry.tags.length ? entry.tags.join(', ') : '无'
      return `- ${entry.file_path} | ${entry.layer} | ${entry.title} | 标签:${tags} | 摘要:${entry.summary} | 强度:${entry.strength} | 最近使用:${formatRelativeTime(entry.last_used_at)}`
    })
    .join('\n')
}

export function getMemoryBootstrapContext(agentId?: string): string {
  const yuukaMemoryPath = resolveMemoryFilePath(CORE_MEMORY_FILE, agentId).fullPath
  const yuukaMemory = readMemoryFile(CORE_MEMORY_FILE, agentId) || '(YUUKA.md 尚未创建)'
  const indexSummary = formatMemoryIndexSummary(agentId, { limit: 20 })
  const quotes = "'''"

  return [
    '以下是当前会话开局必须加载的记忆：',
    '',
    `核心记忆文件（${yuukaMemoryPath}）：`,
    quotes,
    yuukaMemory,
    quotes,
    '',
    '可检索记忆索引摘要（标题/标签/摘要/强度/最近使用）：',
    indexSummary,
    '',
    '如果信息不够，优先使用 MemorySearch(query) 找到 1-3 条，再用 MemoryRead(file_path) 读取细节。',
  ].join('\n')
}
