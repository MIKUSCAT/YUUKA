import { cwd } from 'process'
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { PersistentShell } from './PersistentShell'

// DO NOT ADD MORE STATE HERE OR BORIS WILL CURSE YOU
const STATE: {
  originalCwd: string
  currentCwd: string
} = {
  originalCwd: cwd(),
  currentCwd: cwd(),
}

export async function setCwd(cwd: string): Promise<void> {
  const resolved = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
  if (!existsSync(resolved)) {
    throw new Error(`Path "${resolved}" does not exist`)
  }

  // Keep process.cwd() in sync for code paths that read Node's cwd directly.
  process.chdir(resolved)
  STATE.currentCwd = resolved

  const shell = PersistentShell.getIfAlive()
  if (shell) {
    await shell.setCwd(resolved)
    STATE.currentCwd = shell.pwd()
  }
}

export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

export function getCwd(): string {
  const shell = PersistentShell.getIfAlive()
  if (shell) {
    STATE.currentCwd = shell.pwd()
  }
  return STATE.currentCwd
}
