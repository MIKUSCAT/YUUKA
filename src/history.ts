import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { logError } from '@utils/log'

const MAX_HISTORY_ITEMS = 100
const HISTORY_FILE_PATH = join(homedir(), '.yuuka', 'data', 'history.json')

function getHistoryFilePath(): string {
  return HISTORY_FILE_PATH
}

function readHistoryFile(filePath: string): string[] {
  if (!existsSync(filePath)) return []
  try {
    const text = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch (error) {
    logError(error)
    return []
  }
}

function writeHistoryFile(filePath: string, history: string[]): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8')
  } catch (error) {
    logError(error)
  }
}

export function getHistory(): string[] {
  return readHistoryFile(getHistoryFilePath())
}

export function addToHistory(command: string): void {
  const trimmed = command.trim()
  if (!trimmed) return

  const filePath = getHistoryFilePath()
  const history = readHistoryFile(filePath)

  if (history[0] === trimmed) {
    return
  }

  history.unshift(trimmed)
  writeHistoryFile(filePath, history.slice(0, MAX_HISTORY_ITEMS))
}
