import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { resolveAgentId } from '@utils/agentStorage'
import { MEMORY_DIR } from '@utils/env'

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
