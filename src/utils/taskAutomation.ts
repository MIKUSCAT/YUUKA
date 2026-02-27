import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getGlobalConfig } from './config'

type TaskAutomationEvent = {
  kind: 'summary' | 'diagnostic'
  source: 'Task' | 'TaskBatch'
  createdAt: string
  payload: Record<string, unknown>
}

const AUTOMATION_DIR = join(homedir(), '.yuuka', 'automation')
const AUTOMATION_LOG_PATH = join(AUTOMATION_DIR, 'task-events.jsonl')

function ensureAutomationDir(): void {
  if (!existsSync(AUTOMATION_DIR)) {
    mkdirSync(AUTOMATION_DIR, { recursive: true })
  }
}

function shouldWriteEvent(kind: TaskAutomationEvent['kind']): boolean {
  const config = getGlobalConfig() as any
  const summaryEnabled = config.autoTaskSummaryEnabled !== false
  const diagnosticsEnabled = config.autoTaskDiagnosticsEnabled !== false
  if (kind === 'summary') return summaryEnabled
  return diagnosticsEnabled
}

function appendEvent(event: TaskAutomationEvent): void {
  if (!shouldWriteEvent(event.kind)) return
  ensureAutomationDir()
  appendFileSync(AUTOMATION_LOG_PATH, `${JSON.stringify(event)}\n`, 'utf-8')
}

export function emitTaskSummaryEvent(
  source: 'Task' | 'TaskBatch',
  payload: Record<string, unknown>,
): void {
  appendEvent({
    kind: 'summary',
    source,
    createdAt: new Date().toISOString(),
    payload,
  })
}

export function emitTaskDiagnosticEvent(
  source: 'Task' | 'TaskBatch',
  payload: Record<string, unknown>,
): void {
  appendEvent({
    kind: 'diagnostic',
    source,
    createdAt: new Date().toISOString(),
    payload,
  })
}

