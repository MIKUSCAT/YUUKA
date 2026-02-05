import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { ConfigParseError } from './errors'
import { getCwd } from './state'

const DEFAULT_GEMINI_MODEL = 'models/gemini-3-flash-preview'

export type GeminiApiAuthSettings = {
  baseUrl?: string
  apiKey?: string
  apiKeyAuthMode?: 'x-goog-api-key' | 'query' | 'bearer'
}

export type GeminiSettings = {
  security?: {
    auth?: {
      geminiApi?: GeminiApiAuthSettings
      selectedType?: 'gemini-api-key' | 'gemini-cli-oauth'
    }
  }
  model?: {
    name?: string
  }
  proxy?: string
  mcpServers?: unknown
  ui?: {
    theme?: string
  }
  yuuka?: unknown
}

export function getProjectGeminiDir(projectRoot: string): string {
  return join(projectRoot, '.gemini')
}

export function getProjectGeminiSettingsPath(projectRoot: string): string {
  return join(getProjectGeminiDir(projectRoot), 'settings.json')
}

export function getWorkspaceGeminiSettingsPath(projectRoot?: string): string {
  const resolvedRoot = resolve(projectRoot ?? getCwd())
  return getProjectGeminiSettingsPath(resolvedRoot)
}

export function normalizeGeminiApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('baseUrl 不能为空（来自 ~/.gemini/settings.json）')
  }
  if (trimmed.endsWith('/v1') || trimmed.endsWith('/v1beta')) {
    return trimmed
  }
  return `${trimmed}/v1beta`
}

export function normalizeGeminiModelName(model: string): string {
  const trimmed = model?.trim()
  if (!trimmed) {
    throw new Error('model.name 不能为空（来自 ~/.gemini/settings.json）')
  }
  if (trimmed.includes('..') || trimmed.includes('?') || trimmed.includes('&')) {
    throw new Error('model.name 参数不合法')
  }
  if (trimmed.startsWith('models/') || trimmed.startsWith('tunedModels/')) {
    return trimmed
  }
  return `models/${trimmed}`
}

function readJsonFile<T extends object>(
  filePath: string,
  defaultValue: T,
  throwOnInvalid?: boolean,
): T {
  if (!existsSync(filePath)) {
    return structuredClone(defaultValue)
  }
  try {
    const text = readFileSync(filePath, 'utf-8')
    try {
      const parsed = JSON.parse(text) as T
      return { ...structuredClone(defaultValue), ...parsed }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(message, filePath, defaultValue)
    }
  } catch (error) {
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }
    return structuredClone(defaultValue)
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function pickFirstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export type EnsureGeminiSettingsResult = {
  settingsPath: string
}

export function getGlobalGeminiSettingsPath(): string {
  return join(homedir(), '.gemini', 'settings.json')
}

export function ensureGeminiSettings({
  projectRoot,
}: {
  projectRoot?: string
} = {}): EnsureGeminiSettingsResult {
  return ensureGeminiSettingsAtPath(getWorkspaceGeminiSettingsPath(projectRoot))
}

export function ensureGlobalGeminiSettings(): EnsureGeminiSettingsResult {
  return ensureGeminiSettingsAtPath(getGlobalGeminiSettingsPath())
}

function ensureGeminiSettingsAtPath(settingsPath: string): EnsureGeminiSettingsResult {

  const ensureSettingsDefaults = () => {
    if (!existsSync(settingsPath)) return
    try {
      const existing = readJsonFile<any>(settingsPath, {}, true)
      const next: any = structuredClone(existing ?? {})

      next.security = next.security ?? {}
      next.security.auth = next.security.auth ?? {}
      // 不要强行覆盖用户选择的认证类型
      if (
        next.security.auth.selectedType !== 'gemini-api-key' &&
        next.security.auth.selectedType !== 'gemini-cli-oauth'
      ) {
        next.security.auth.selectedType = 'gemini-api-key'
      }
      next.security.auth.geminiApi = next.security.auth.geminiApi ?? {}
      const keyMode = String(next.security.auth.geminiApi.apiKeyAuthMode ?? '').trim()
      if (keyMode !== 'x-goog-api-key' && keyMode !== 'query' && keyMode !== 'bearer') {
        next.security.auth.geminiApi.apiKeyAuthMode = 'x-goog-api-key'
      }
      if (!pickFirstString(next.security.auth.geminiApi.baseUrl)) {
        next.security.auth.geminiApi.baseUrl =
          'https://generativelanguage.googleapis.com'
      }

      next.model = next.model ?? {}
      if (!pickFirstString(next.model.name)) {
        next.model.name = DEFAULT_GEMINI_MODEL
      }

      writeJsonFile(settingsPath, next)
    } catch {
      // 配置损坏时不自动改写
    }
  }

  if (!existsSync(settingsPath)) {
    const defaultSettings: GeminiSettings = {
      security: {
        auth: {
          geminiApi: {
            baseUrl: 'https://generativelanguage.googleapis.com',
            apiKey: '',
            apiKeyAuthMode: 'x-goog-api-key',
          },
          selectedType: 'gemini-api-key',
        },
      },
      model: { name: DEFAULT_GEMINI_MODEL },
      yuuka: {},
    }
    writeJsonFile(settingsPath, defaultSettings)
  } else {
    ensureSettingsDefaults()
  }

  return { settingsPath }
}

export function readGeminiSettingsFile(
  filePath: string,
  throwOnInvalid?: boolean,
): GeminiSettings {
  return readJsonFile<GeminiSettings>(filePath, {}, throwOnInvalid)
}

export function writeGeminiSettingsFile(
  filePath: string,
  settings: GeminiSettings,
): void {
  writeJsonFile(filePath, settings)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function mergeGeminiSettings(
  base: GeminiSettings,
  override: GeminiSettings,
): GeminiSettings {
  const result: GeminiSettings = structuredClone(base)

  const mergeRec = (target: any, source: any) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      const existing = target[key]
      if (isPlainObject(existing) && isPlainObject(value)) {
        mergeRec(existing, value)
        continue
      }
      target[key] = value
    }
  }

  mergeRec(result as any, override as any)
  return result
}
