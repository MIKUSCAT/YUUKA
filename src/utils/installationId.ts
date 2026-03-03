import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

function getInstallationIdPath(): string {
  return join(homedir(), '.yuuka', 'installation_id')
}

function readInstallationIdFromFile(): string | null {
  const file = getInstallationIdPath()
  if (!existsSync(file)) return null
  try {
    const value = readFileSync(file, 'utf-8').trim()
    return value || null
  } catch {
    return null
  }
}

function writeInstallationIdToFile(installationId: string): void {
  const file = getInstallationIdPath()
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, installationId, 'utf-8')
}

/**
 * Stable installation id.
 * Used for aligning API metadata/headers with Gemini CLI conventions.
 */
export function getInstallationId(): string {
  try {
    let id = readInstallationIdFromFile()
    if (!id) {
      id = randomUUID()
      writeInstallationIdToFile(id)
    }
    return id
  } catch {
    // If filesystem is not writable, fall back to ephemeral id for this run.
    return randomUUID()
  }
}

