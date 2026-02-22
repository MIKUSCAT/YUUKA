import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import {
  getAgentMailboxDir,
  getMailboxDir,
  getTeamMetaPath,
  getTeamTaskPath,
  getTasksDir,
  getTeamsDir,
  normalizeAgentName,
  normalizeTeamName,
} from './teamPaths'
import { withFileLockSync } from '@utils/fileLock'

export type TeamTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TeamMetadata {
  name: string
  createdAt: number
  updatedAt: number
  agents: string[]
}

export interface TeamTaskProgress {
  status: string
  model?: string
  toolCount?: number
  tokenCount?: number
  elapsedMs?: number
  lastAction?: string
  createdAt: number
}

export interface TeamTaskRecord {
  id: string
  teamName: string
  agentName: string
  status: TeamTaskStatus
  description: string
  prompt: string
  subagent_type?: string
  model_name?: string
  safeMode: boolean
  verbose: boolean
  forkNumber: number
  messageLogName: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  resultText?: string
  error?: string
  tokenCount?: number
  toolUseCount?: number
  durationMs?: number
  progress: TeamTaskProgress[]
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  const dir = dirname(path)
  const tempPath = resolve(dir, `.${randomUUID()}.tmp`)
  writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tempPath, path)
}

export function ensureTeam(teamName: string, seedAgents: string[] = []): TeamMetadata {
  const normalizedTeamName = normalizeTeamName(teamName)
  const path = getTeamMetaPath(normalizedTeamName)
  const now = Date.now()
  return withFileLockSync(path, () => {
    const existing = readJsonFile<TeamMetadata>(path)
    if (existing) {
      const mergedAgents = Array.from(
        new Set([
          ...(existing.agents ?? []),
          ...seedAgents.map(agent => normalizeAgentName(agent)),
        ]),
      ).filter(Boolean)
      const next: TeamMetadata = {
        ...existing,
        name: normalizedTeamName,
        updatedAt: now,
        agents: mergedAgents,
      }
      writeJsonAtomic(path, next)
      return next
    }

    const created: TeamMetadata = {
      name: normalizedTeamName,
      createdAt: now,
      updatedAt: now,
      agents: Array.from(
        new Set(seedAgents.map(agent => normalizeAgentName(agent)).filter(Boolean)),
      ),
    }
    writeJsonAtomic(path, created)
    return created
  })
}

export function readTeam(teamName: string): TeamMetadata | null {
  return readJsonFile<TeamMetadata>(getTeamMetaPath(teamName))
}

export function deleteTeam(teamName: string, force = false): void {
  const normalizedTeamName = normalizeTeamName(teamName)
  const taskDir = resolve(getTasksDir(), normalizedTeamName)
  const metaPath = getTeamMetaPath(normalizedTeamName)
  const mailboxDir = resolve(getMailboxDir(), normalizedTeamName)

  if (!force && existsSync(taskDir)) {
    try {
      // 通过 stat 过滤目录里仍在进行中的任务
      const dirEntries = readdirSync(taskDir)
      for (const file of dirEntries) {
        const fullPath = resolve(taskDir, file)
        if (!statSync(fullPath).isFile()) continue
        const task = readJsonFile<TeamTaskRecord>(fullPath)
        if (!task) continue
        if (task.status === 'pending' || task.status === 'running') {
          throw new Error(
            `Team "${normalizedTeamName}" still has active task: ${task.id}`,
          )
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error
      }
    }
  }

  if (existsSync(taskDir)) {
    rmSync(taskDir, { recursive: true, force: true })
  }
  if (existsSync(mailboxDir)) {
    rmSync(mailboxDir, { recursive: true, force: true })
  }
  if (existsSync(metaPath)) {
    rmSync(metaPath, { force: true })
  }
}

export function createTeamTask(params: {
  teamName: string
  agentName: string
  description: string
  prompt: string
  subagent_type?: string
  model_name?: string
  safeMode: boolean
  verbose: boolean
  forkNumber: number
  messageLogName: string
}): { task: TeamTaskRecord; taskPath: string } {
  const teamName = normalizeTeamName(params.teamName)
  const agentName = normalizeAgentName(params.agentName)
  const taskId = `task-${randomUUID()}`
  const now = Date.now()

  ensureTeam(teamName, [agentName])
  getAgentMailboxDir(teamName, agentName)

  const task: TeamTaskRecord = {
    id: taskId,
    teamName,
    agentName,
    status: 'pending',
    description: params.description,
    prompt: params.prompt,
    subagent_type: params.subagent_type,
    model_name: params.model_name,
    safeMode: params.safeMode,
    verbose: params.verbose,
    forkNumber: params.forkNumber,
    messageLogName: params.messageLogName,
    createdAt: now,
    updatedAt: now,
    progress: [],
  }
  const taskPath = getTeamTaskPath(teamName, taskId)
  writeJsonAtomic(taskPath, task)
  return { task, taskPath }
}

export function readTeamTask(taskPath: string): TeamTaskRecord | null {
  return readJsonFile<TeamTaskRecord>(taskPath)
}

export function updateTeamTask(
  taskPath: string,
  updater: (current: TeamTaskRecord) => TeamTaskRecord,
): TeamTaskRecord {
  return withFileLockSync(taskPath, () => {
    const current = readTeamTask(taskPath)
    if (!current) {
      throw new Error(`Task file not found or invalid: ${taskPath}`)
    }
    const next = updater(current)
    next.updatedAt = Date.now()
    writeJsonAtomic(taskPath, next)
    return next
  })
}

function resolveTeammateEntrypoint(): string {
  const currentArgvPath = process.argv[1]
  if (currentArgvPath) {
    const resolvedCurrent = resolve(currentArgvPath)
    const currentDir = dirname(resolvedCurrent)
    const candidates = [
      join(currentDir, 'teammateCli.ts'),
      join(currentDir, 'teammateCli.js'),
      join(currentDir, 'entrypoints', 'teammateCli.ts'),
      join(currentDir, 'entrypoints', 'teammateCli.js'),
      // Dist wrapper (`dist/index.js`) should prefer the real teammate entrypoint.
      join(dirname(currentDir), 'dist', 'entrypoints', 'teammateCli.js'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
    return resolvedCurrent
  }
  return resolve(process.cwd(), 'dist/entrypoints/teammateCli.js')
}

export function spawnTeammateProcess(params: {
  taskPath: string
  cwd: string
  safeMode: boolean
}): ChildProcess {
  const teammateEntrypoint = resolveTeammateEntrypoint()
  const args = [
    ...process.execArgv,
    teammateEntrypoint,
    '--teammate-task-file',
    params.taskPath,
    '--cwd',
    params.cwd,
  ]
  if (params.safeMode) {
    args.push('--safe')
  }

  return spawn(process.execPath, args, {
    stdio: 'ignore',
    env: {
      ...process.env,
      YUUKA_TEAMMATE_MODE: '1',
    },
  })
}
