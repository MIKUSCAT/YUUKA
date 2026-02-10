import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { getOriginalCwd } from '@utils/state'
import { logError } from '@utils/log'

const MAX_HISTORY_ITEMS = 100
const GLOBAL_HISTORY_FILE_PATH = join(homedir(), '.yuuka', 'data', 'history.json')

function readJsonFile(filePath: string): any | null {
  if (!existsSync(filePath)) return null
  try {
    const text = readFileSync(filePath, 'utf-8')
    return JSON.parse(text)
  } catch (error) {
    logError(error)
    return null
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function coerceHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    out.push(trimmed)
  }
  return out
}

function mergeHistory(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing
  const seen = new Set<string>()
  const merged: string[] = []
  for (const item of [...existing, ...incoming]) {
    if (seen.has(item)) continue
    seen.add(item)
    merged.push(item)
    if (merged.length >= MAX_HISTORY_ITEMS) break
  }
  return merged
}

function migrateHistoryFromSettings(settings: any): boolean {
  const historyFilePath = GLOBAL_HISTORY_FILE_PATH
  const existingHistory = coerceHistory(readJsonFile(historyFilePath))

  const yuukaLegacy = coerceHistory(settings?.yuuka?.project?.history)
  const legacyHistory = yuukaLegacy

  let changed = false

  if (legacyHistory.length > 0) {
    const nextHistory = mergeHistory(existingHistory, legacyHistory)
    try {
      writeJsonFile(historyFilePath, nextHistory)
      changed = true
    } catch (error) {
      logError(error)
    }
  }

  if (settings?.yuuka?.project && 'history' in settings.yuuka.project) {
    delete settings.yuuka.project.history
    changed = true
  }

  return changed
}

function migrateToolNamesInAllowedTools(settings: any): boolean {
  const mapping: Record<string, string> = {
    View: 'Read',
    Replace: 'Write',
    GlobTool: 'Glob',
    GrepTool: 'Grep',
  }

  const migrate = (tools: unknown): string[] | null => {
    if (!Array.isArray(tools)) return null
    let changed = false
    const next: string[] = []
    for (const item of tools) {
      if (typeof item !== 'string') continue
      const mapped = mapping[item] ?? item
      if (mapped !== item) changed = true
      if (!next.includes(mapped)) next.push(mapped)
    }
    return changed ? next : null
  }

  let changed = false
  const yuukaNext = migrate(settings?.yuuka?.project?.allowedTools)
  if (yuukaNext) {
    settings.yuuka = settings.yuuka ?? {}
    settings.yuuka.project = settings.yuuka.project ?? {}
    settings.yuuka.project.allowedTools = yuukaNext
    changed = true
  }

  return changed
}

export function runProjectMigrations(): void {
  if (process.env.NODE_ENV === 'test') return

  const projectRoot = resolve(getOriginalCwd())
  const settingsPath = resolve(projectRoot, '.yuuka', 'settings.json')
  if (!existsSync(settingsPath)) return

  try {
    const settings = readJsonFile(settingsPath)
    if (!settings || typeof settings !== 'object') return

    const changed =
      migrateHistoryFromSettings(settings) ||
      migrateToolNamesInAllowedTools(settings)

    if (!changed) return
    writeJsonFile(settingsPath, settings)
  } catch (error) {
    logError(error)
  }
}
