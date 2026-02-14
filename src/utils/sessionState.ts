 
type SessionState = {
  modelErrors: Record<string, unknown>
  currentError: string | null
  currentThought: { subject: string; description: string } | null
  enabledSkillNames: string[] | null
  suppressThoughtDepth: number // > 0 时抑制子 agent 的 thought 写入主界面
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
}

function getSessionState(): SessionState
function getSessionState<K extends keyof SessionState>(key: K): SessionState[K]
function getSessionState<K extends keyof SessionState>(key?: K) {
  return key === undefined ? sessionState : sessionState[key]
}

export type { SessionState }
export { setSessionState, getSessionState }
export default sessionState
