import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join, resolve } from 'path'
import { ensureTeam } from './teamManager'
import { getTeamTaskDir, normalizeAgentName, normalizeTeamName } from './teamPaths'

export type SharedTaskStatus = 'open' | 'in_progress' | 'completed' | 'blocked'

export interface SharedTask {
  id: number
  subject: string
  description: string
  status: SharedTaskStatus
  owner?: string
  blockedBy?: number[]
  createdAt: number
  updatedAt: number
  completedAt?: number
  result?: string
}

export interface ListSharedTaskInput {
  teamName: string
  status?: SharedTaskStatus
  owner?: string
}

export interface CreateSharedTaskInput {
  teamName: string
  subject: string
  description: string
  blockedBy?: number[]
}

export interface UpdateSharedTaskInput {
  teamName: string
  taskId: number
  status?: SharedTaskStatus
  owner?: string
  result?: string
  blockedBy?: number[]
}

function getSharedTaskPath(teamName: string): string {
  const normalizedTeam = normalizeTeamName(teamName)
  return join(getTeamTaskDir(normalizedTeam), 'shared-tasks.json')
}

function normalizeBlockedBy(blockedBy?: number[]): number[] | undefined {
  if (!Array.isArray(blockedBy)) return undefined
  const normalized = Array.from(
    new Set(blockedBy.filter(id => Number.isInteger(id) && id > 0)),
  ).sort((a, b) => a - b)
  return normalized.length > 0 ? normalized : undefined
}

function readSharedTasks(path: string): SharedTask[] {
  if (!existsSync(path)) {
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      task =>
        task &&
        typeof task.id === 'number' &&
        typeof task.subject === 'string' &&
        typeof task.description === 'string' &&
        typeof task.status === 'string',
    ) as SharedTask[]
  } catch {
    return []
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  const tempPath = resolve(dirname(path), `.${randomUUID()}.tmp`)
  writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tempPath, path)
}

export function createSharedTask(input: CreateSharedTaskInput): SharedTask {
  const teamName = normalizeTeamName(input.teamName)
  ensureTeam(teamName)
  const path = getSharedTaskPath(teamName)
  const tasks = readSharedTasks(path)
  const now = Date.now()
  const nextId = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1
  const blockedBy = normalizeBlockedBy(input.blockedBy)

  const task: SharedTask = {
    id: nextId,
    subject: input.subject.trim(),
    description: input.description.trim(),
    status: 'open',
    blockedBy,
    createdAt: now,
    updatedAt: now,
  }

  tasks.push(task)
  writeJsonAtomic(path, tasks)
  return task
}

export function listSharedTasks(input: ListSharedTaskInput): SharedTask[] {
  const teamName = normalizeTeamName(input.teamName)
  const path = getSharedTaskPath(teamName)
  const tasks = readSharedTasks(path).sort((a, b) => a.id - b.id)
  const normalizedOwner = input.owner ? normalizeAgentName(input.owner) : undefined

  return tasks.filter(task => {
    if (input.status && task.status !== input.status) {
      return false
    }
    if (normalizedOwner && task.owner !== normalizedOwner) {
      return false
    }
    return true
  })
}

export function updateSharedTask(input: UpdateSharedTaskInput): SharedTask {
  const teamName = normalizeTeamName(input.teamName)
  const path = getSharedTaskPath(teamName)
  const tasks = readSharedTasks(path)
  const index = tasks.findIndex(task => task.id === input.taskId)
  if (index < 0) {
    throw new Error(`Shared task ${input.taskId} not found in team "${teamName}"`)
  }

  const current = tasks[index]
  const next: SharedTask = {
    ...current,
    updatedAt: Date.now(),
  }

  if (typeof input.status !== 'undefined') {
    next.status = input.status
    if (input.status === 'completed') {
      next.completedAt = Date.now()
    } else {
      delete next.completedAt
    }
  }

  if (typeof input.owner !== 'undefined') {
    const normalizedOwner = input.owner.trim()
      ? normalizeAgentName(input.owner)
      : undefined
    next.owner = normalizedOwner
  }

  if (typeof input.result !== 'undefined') {
    next.result = input.result
  }

  if (typeof input.blockedBy !== 'undefined') {
    next.blockedBy = normalizeBlockedBy(input.blockedBy)
  }

  tasks[index] = next
  writeJsonAtomic(path, tasks)
  return next
}

export function claimSharedTask(params: {
  teamName: string
  taskId: number
  owner: string
}): SharedTask {
  return updateSharedTask({
    teamName: params.teamName,
    taskId: params.taskId,
    owner: params.owner,
    status: 'in_progress',
  })
}
