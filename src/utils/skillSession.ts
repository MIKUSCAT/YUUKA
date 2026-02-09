import { getSessionState, setSessionState } from './sessionState'

function normalizeSkillNames(names: string[]): string[] {
  return Array.from(
    new Set(
      names
        .map(name => String(name ?? '').trim())
        .filter(Boolean),
    ),
  )
}

export function getSessionEnabledSkillNames(): string[] | null {
  const value = getSessionState('enabledSkillNames')
  if (!Array.isArray(value)) {
    return null
  }
  return normalizeSkillNames(value)
}

export function setSessionEnabledSkillNames(names: string[] | null): void {
  if (names === null) {
    setSessionState('enabledSkillNames', null)
    return
  }
  setSessionState('enabledSkillNames', normalizeSkillNames(names))
}

export function resetSessionEnabledSkillNames(): void {
  setSessionState('enabledSkillNames', null)
}
