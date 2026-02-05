import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { CACHE_PATHS, logError } from './log'

const MAX_TASK_OUTPUT_READ_BYTES = 512 * 1024

export function getTaskOutputsDir(): string {
  return CACHE_PATHS.taskOutputs()
}

export function getTaskOutputFilePath(taskId: string): string {
  return join(getTaskOutputsDir(), `${taskId}.output`)
}

export function getTaskStatusFilePath(taskId: string): string {
  return join(getTaskOutputsDir(), `${taskId}.status`)
}

export function ensureTaskOutputsDirExists(): void {
  const dir = getTaskOutputsDir()
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
}

export function touchTaskOutputFiles(taskId: string): {
  outputFile: string
  statusFile: string
} {
  ensureTaskOutputsDirExists()

  const outputFile = getTaskOutputFilePath(taskId)
  const statusFile = getTaskStatusFilePath(taskId)

  try {
    writeFileSync(outputFile, '')
    writeFileSync(statusFile, '')
  } catch (error) {
    logError(error)
  }

  return { outputFile, statusFile }
}

export function readTaskOutput(taskId: string): string {
  const filePath = getTaskOutputFilePath(taskId)
  if (!existsSync(filePath)) return ''
  try {
    const stat = statSync(filePath)
    if (stat.size <= MAX_TASK_OUTPUT_READ_BYTES) {
      return readFileSync(filePath, 'utf8')
    }

    const start = Math.max(0, stat.size - MAX_TASK_OUTPUT_READ_BYTES)
    const length = stat.size - start
    const fd = openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    logError(error)
    return ''
  }
}

export function readTaskExitCode(taskId: string): number | null {
  const filePath = getTaskStatusFilePath(taskId)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8').trim()
    if (!raw) return null
    const code = Number(raw)
    return Number.isFinite(code) ? code : null
  } catch (error) {
    logError(error)
    return null
  }
}

export function hasTaskOutput(taskId: string): boolean {
  return (
    existsSync(getTaskOutputFilePath(taskId)) ||
    existsSync(getTaskStatusFilePath(taskId))
  )
}
