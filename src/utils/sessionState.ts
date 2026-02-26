import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { withFileLockSync } from './fileLock'

type SessionState = {
  modelErrors: Record<string, unknown>
  currentError: string | null
  currentThought: { subject: string; description: string } | null
  enabledSkillNames: string[] | null
  suppressThoughtDepth: number // > 0 时抑制子 agent 的 thought 写入主界面
}

type PersistedSessionState = Partial<
  Pick<SessionState, 'enabledSkillNames'>
> & {
  todos?: unknown
  todoConfig?: unknown
  todoMetrics?: unknown
}

const isDebug =
  process.argv.includes('--debug') ||
  process.argv.includes('-d') ||
  process.env.DEBUG === 'true'

const sessionState: SessionState = {
  modelErrors: {},
  currentError: null,
  currentThought: null,
  enabledSkillNames: null,
  suppressThoughtDepth: 0,
} as const

const SESSION_STATE_PATH = join(homedir(), '.yuuka', 'session-state.json')
const PERSISTED_KEYS = ['enabledSkillNames', 'todos', 'todoConfig', 'todoMetrics'] as const
let persistTimer: NodeJS.Timeout | null = null
let lastPersistedPayload = ''

function readPersistedSessionState(): PersistedSessionState | null {
  const dir = dirname(SESSION_STATE_PATH)
  if (!existsSync(dir)) return null
  return withFileLockSync(
    SESSION_STATE_PATH,
    () => {
      if (!existsSync(SESSION_STATE_PATH)) return null
      try {
        const raw = readFileSync(SESSION_STATE_PATH, 'utf-8')
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        return parsed as PersistedSessionState
      } catch {
        return null
      }
    },
    { timeoutMs: 200, retryDelayMs: 10, staleMs: 3000 },
  )
}

function serializePersistedSessionState(): string {
  const raw = sessionState as Record<string, unknown>
  const persisted: PersistedSessionState = {}
  for (const key of PERSISTED_KEYS) {
    const value = raw[key]
    if (value !== undefined) {
      ;(persisted as Record<string, unknown>)[key] = value
    }
  }
  return JSON.stringify(persisted, null, 2)
}

function writePersistedSessionState(payload: string): void {
  const dir = dirname(SESSION_STATE_PATH)
  mkdirSync(dir, { recursive: true })
  withFileLockSync(SESSION_STATE_PATH, () => {
    const tempPath = join(dir, `.${randomUUID()}.tmp`)
    writeFileSync(tempPath, payload, 'utf-8')
    try {
      rmSync(SESSION_STATE_PATH, { force: true })
    } catch {
      // ignore
    }
    renameSync(tempPath, SESSION_STATE_PATH)
  })
}

function scheduleSessionStatePersist(): void {
  const nextPayload = serializePersistedSessionState()
  if (nextPayload === lastPersistedPayload) {
    return
  }
  if (persistTimer) {
    clearTimeout(persistTimer)
  }
  persistTimer = setTimeout(() => {
    persistTimer = null
    const latest = serializePersistedSessionState()
    if (latest === lastPersistedPayload) {
      return
    }
    try {
      writePersistedSessionState(latest)
      lastPersistedPayload = latest
    } catch {
      // 持久化失败不影响主流程
    }
  }, 120)
}

try {
  const persisted = readPersistedSessionState()
  if (persisted && typeof persisted === 'object') {
    Object.assign(sessionState as Record<string, unknown>, persisted)
  }
  lastPersistedPayload = serializePersistedSessionState()
} catch {
  // 初始化读取失败时继续使用默认内存状态
}

function setSessionState<K extends keyof SessionState>(
  key: K,
  value: SessionState[K],
): void
function setSessionState(partialState: Partial<SessionState>): void
function setSessionState(
  keyOrState: keyof SessionState | Partial<SessionState>,
  value?: any,
): void {
  if (typeof keyOrState === 'string') {
    ;(sessionState as Record<string, unknown>)[keyOrState] = value
  } else {
    Object.assign(sessionState, keyOrState)
  }
  scheduleSessionStatePersist()
}

function getSessionState(): SessionState
function getSessionState<K extends keyof SessionState>(key: K): SessionState[K]
function getSessionState<K extends keyof SessionState>(key?: K) {
  return key === undefined ? sessionState : sessionState[key]
}

export type { SessionState }
export { setSessionState, getSessionState }
export default sessionState
