import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Command } from '@commands'
import type { Tool } from '@tool'
import { logError } from '@utils/log'
import { registerRuntimeHooks, type RuntimeHookSet } from '@utils/runtimeHooks'

export type YuukaExtensionModule = {
  id?: string
  hooks?: RuntimeHookSet | RuntimeHookSet[]
  tools?: Tool[]
  commands?: Command[]
  register?: (api: YuukaExtensionAPI) => void | Promise<void>
}

export type YuukaExtensionAPI = {
  registerHooks: (hooks: RuntimeHookSet, options?: { id?: string }) => void
  registerTool: (tool: Tool) => void
  registerCommand: (command: Command) => void
}

function getExtensionsDir(): string {
  return join(homedir(), '.yuuka', 'extensions')
}

function isSupportedExtensionFile(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return ext === '.js' || ext === '.mjs' || ext === '.cjs'
}

type LoadedExtensions = {
  tools: Tool[]
  commands: Command[]
}

let cached: LoadedExtensions | null = null
let unregisterFns: Array<() => void> = []

function unregisterAllHooks(): void {
  for (const fn of unregisterFns) {
    try {
      fn()
    } catch {
      // ignore
    }
  }
  unregisterFns = []
}

function normalizeExtensionId(filePath: string, explicit?: string): string {
  const clean = String(explicit ?? '').trim()
  if (clean) return clean
  const base = basename(filePath)
  return base.replace(extname(base), '')
}

function coerceExtensionModule(mod: any): YuukaExtensionModule | null {
  const candidate = mod?.default ?? mod?.extension ?? mod
  if (!candidate) return null
  if (typeof candidate === 'function') {
    return { register: candidate }
  }
  if (typeof candidate === 'object') {
    return candidate as YuukaExtensionModule
  }
  return null
}

async function loadOneExtension(
  filePath: string,
  cacheBust: string,
): Promise<YuukaExtensionModule | null> {
  try {
    const url = `${pathToFileURL(resolve(filePath)).href}?v=${encodeURIComponent(cacheBust)}`
    const mod = await import(url)
    return coerceExtensionModule(mod)
  } catch (e) {
    logError(`Failed to load extension: ${filePath}: ${e}`)
    return null
  }
}

export async function reloadExtensions(): Promise<LoadedExtensions> {
  unregisterAllHooks()

  const tools: Tool[] = []
  const commands: Command[] = []

  const dir = getExtensionsDir()
  if (!existsSync(dir)) {
    cached = { tools, commands }
    return cached
  }

  const cacheBust = Date.now().toString(36)
  const files = readdirSync(dir)
    .filter(isSupportedExtensionFile)
    .map(name => join(dir, name))
    .sort((a, b) => a.localeCompare(b))

  for (const filePath of files) {
    const ext = await loadOneExtension(filePath, cacheBust)
    if (!ext) continue

    const extensionId = normalizeExtensionId(filePath, ext.id)
    const hookPrefix = `ext:${extensionId}`

    const api: YuukaExtensionAPI = {
      registerHooks: (hooks, options) => {
        const id = options?.id?.trim()
        const hookId = id ? `${hookPrefix}:${id}` : hookPrefix
        unregisterFns.push(registerRuntimeHooks({ id: hookId, ...hooks }))
      },
      registerTool: tool => {
        tools.push(tool)
      },
      registerCommand: command => {
        commands.push(command)
      },
    }

    try {
      if (typeof ext.register === 'function') {
        await ext.register(api)
      }
      if (ext.hooks) {
        const list = Array.isArray(ext.hooks) ? ext.hooks : [ext.hooks]
        list.forEach((hooks, i) => api.registerHooks(hooks, { id: `hooks-${i + 1}` }))
      }
      if (Array.isArray(ext.tools)) {
        ext.tools.forEach(t => api.registerTool(t))
      }
      if (Array.isArray(ext.commands)) {
        ext.commands.forEach(c => api.registerCommand(c))
      }
    } catch (e) {
      logError(`Extension crashed during init: ${filePath}: ${e}`)
      continue
    }
  }

  cached = { tools, commands }
  return cached
}

async function ensureLoaded(): Promise<LoadedExtensions> {
  if (cached) return cached
  return await reloadExtensions()
}

export async function getExtensionTools(): Promise<Tool[]> {
  const loaded = await ensureLoaded()
  return loaded.tools
}

export async function getExtensionCommands(): Promise<Command[]> {
  const loaded = await ensureLoaded()
  return loaded.commands
}
