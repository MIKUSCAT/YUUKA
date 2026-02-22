import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import { cloneDeep, memoize, pick } from 'lodash-es'
import { homedir } from 'os'
import { getCwd } from './state'
import { randomBytes } from 'crypto'
import { safeParseJSON } from './json'
import { ConfigParseError } from './errors'
import type { ThemeNames } from './theme'
import { debug as debugLogger } from './debugLogger'
import { getSessionState, setSessionState } from './sessionState'
import {
  ensureGlobalGeminiSettings,
  getProjectGeminiSettingsPath,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
  type GeminiSettings,
} from './geminiSettings'

export type McpStdioServerConfig = {
  type?: 'stdio' // Optional for backwards compatibility
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

export type McpSSEServerConfig = {
  type: 'sse'
  url: string
}

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig

export type ProjectConfig = {
  allowedTools: string[]
  context: Record<string, string>
  contextFiles?: string[]
  dontCrawlDirectory?: boolean
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  approvedMcprcServers?: string[]
  rejectedMcprcServers?: string[]
  lastAPIDuration?: number
  lastCost?: number
  lastDuration?: number
  lastSessionId?: string
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  context: {},
  dontCrawlDirectory: false,
  mcpContextUris: [],
  mcpServers: {},
  approvedMcprcServers: [],
  rejectedMcprcServers: [],
  hasTrustDialogAccepted: false,
}

const GLOBAL_PROJECT_SCOPE_KEY = '__global__'

function defaultConfigForProject(projectPath: string): ProjectConfig {
  const config = { ...DEFAULT_PROJECT_CONFIG }
  if (projectPath === homedir()) {
    config.dontCrawlDirectory = true
  }
  return config
}

export type AutoUpdaterStatus =
  | 'disabled'
  | 'enabled'
  | 'no_permissions'
  | 'not_configured'

export function isAutoUpdaterStatus(value: string): value is AutoUpdaterStatus {
  return ['disabled', 'enabled', 'no_permissions', 'not_configured'].includes(
    value as AutoUpdaterStatus,
  )
}

export type NotificationChannel =
  | 'iterm2'
  | 'terminal_bell'
  | 'iterm2_with_bell'
  | 'notifications_disabled'

export type ProviderType = 'gemini'

export const DEFAULT_DANGEROUS_COMMANDS = [
  'rm',
  'rmdir',
  'dd',
  'mkfs',
  'fdisk',
  'sfdisk',
  'cfdisk',
  'parted',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'init',
  'diskpart',
  'format',
  'del',
  'rd',
] as const
const COMMAND_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'nohup',
  'time',
  'nice',
  'ionice',
  'chrt',
  'setsid',
])

function normalizeDangerousCommandName(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (!raw) {
    return ''
  }
  const baseName = raw.split(/[\\/]/).pop() ?? raw
  const tokens = baseName
    .split(/\s+/)
    .map(token => token.toLowerCase().replace(/\.exe$/i, ''))
    .filter(Boolean)
  for (const token of tokens) {
    if (token.startsWith('-')) {
      continue
    }
    if (COMMAND_WRAPPERS.has(token)) {
      continue
    }
    return token
  }
  return ''
}

export function normalizeDangerousCommands(value: unknown): string[] {
  if (typeof value === 'string') {
    return normalizeDangerousCommands(value.split(/[\n,;]+/))
  }
  if (!Array.isArray(value)) {
    return []
  }
  const unique = new Set<string>()
  for (const item of value) {
    const normalized = normalizeDangerousCommandName(item)
    if (normalized) {
      unique.add(normalized)
    }
  }
  return [...unique]
}

export function parseDangerousCommandsInput(raw: string): string[] {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) {
    return []
  }
  const parsedAsJson = safeParseJSON(trimmed)
  if (Array.isArray(parsedAsJson)) {
    return normalizeDangerousCommands(parsedAsJson)
  }
  return normalizeDangerousCommands(trimmed.split(/[\n,;]+/))
}

// New model system types
export type ModelProfile = {
  name: string // User-friendly name
  provider: ProviderType // Provider type
  modelName: string // Primary key - actual model identifier
  baseURL?: string // Custom endpoint
  apiKey: string
  maxTokens: number // Output token limit
  contextLength: number // Context window size
  reasoningEffort?: 'low' | 'medium' | 'high' | 'minimal'
  isActive: boolean // Whether profile is enabled
  createdAt: number // Creation timestamp
  lastUsed?: number // Last usage timestamp
}

export type ModelPointerType = 'main' | 'task' | 'reasoning' | 'quick'

export type ModelPointers = {
  main: string // Main dialog model ID
  task: string // Task tool model ID
  reasoning: string // Reasoning model ID
  quick: string // Quick model ID
}

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
}

export type GlobalConfig = {
  projects?: Record<string, ProjectConfig>
  numStartups: number
  autoUpdaterStatus?: AutoUpdaterStatus
  userID?: string
  theme: ThemeNames
  hasCompletedOnboarding?: boolean
  // Tracks the last version that reset onboarding, used with MIN_VERSION_REQUIRING_ONBOARDING_RESET
  lastOnboardingVersion?: string
  // Tracks the last version for which release notes were seen, used for managing release notes
  lastReleaseNotesSeen?: string
  mcpServers?: Record<string, McpServerConfig>
  preferredNotifChannel: NotificationChannel
  verbose: boolean
  agentExecutionMode?: 'inline' | 'process'
  maxToolUseConcurrency?: number
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryProvider?: ProviderType
  maxTokens?: number
  hasAcknowledgedCostThreshold?: boolean
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // Legacy - keeping for backward compatibility
  shiftEnterKeyBindingInstalled?: boolean
  proxy?: string
  proxyEnabled?: boolean
  proxyPort?: number
  stream?: boolean
  thinkingGemini3Level?: 'low' | 'high'
  thinkingNonGemini3Budget?: number
  memoryReadEnabled?: boolean
  memoryWriteEnabled?: boolean
  dangerousCommands?: string[]

  // New model system
  modelProfiles?: ModelProfile[] // Model configuration list
  modelPointers?: ModelPointers // Model pointer system
  defaultModelName?: string // Default model
  // Update notifications
  lastDismissedUpdateVersion?: string
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  numStartups: 0,
  autoUpdaterStatus: 'not_configured',
  theme: 'dark' as ThemeNames,
  preferredNotifChannel: 'iterm2',
  verbose: false,
  agentExecutionMode: 'process',
  maxToolUseConcurrency: 4,
  proxyEnabled: true,
  proxyPort: 7890,
  primaryProvider: 'gemini' as ProviderType,
  customApiKeyResponses: {
    approved: [],
    rejected: [],
  },
  stream: true,
  thinkingGemini3Level: 'high',
  thinkingNonGemini3Budget: 8192,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  dangerousCommands: [],

  // New model system defaults
  modelProfiles: [],
  modelPointers: {
    main: '',
    task: '',
    reasoning: '',
    quick: '',
  },
  lastDismissedUpdateVersion: undefined,
}

export const GLOBAL_CONFIG_KEYS = [
  'autoUpdaterStatus',
  'theme',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'lastReleaseNotesSeen',
  'verbose',
  'agentExecutionMode',
  'maxToolUseConcurrency',
  'proxyEnabled',
  'proxyPort',
  'proxy',
  'customApiKeyResponses',
  'primaryProvider',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'maxTokens',
  'thinkingGemini3Level',
  'thinkingNonGemini3Budget',
  'memoryReadEnabled',
  'memoryWriteEnabled',
  'dangerousCommands',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'dontCrawlDirectory',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

function getGlobalSettings(throwOnInvalid?: boolean): GeminiSettings {
  const { settingsPath } = ensureGlobalGeminiSettings()
  return readGeminiSettingsFile(settingsPath, throwOnInvalid)
}

function saveGlobalSettings(settings: GeminiSettings): void {
  const { settingsPath } = ensureGlobalGeminiSettings()
  writeGeminiSettingsFile(settingsPath, settings)
}

function getProjectSettingsPath(projectRoot: string): string {
  return getProjectGeminiSettingsPath(projectRoot)
}

function getProjectSettings(projectRoot: string): GeminiSettings {
  const settingsPath = getProjectSettingsPath(projectRoot)
  return readGeminiSettingsFile(settingsPath)
}

function saveProjectSettings(projectRoot: string, settings: GeminiSettings): void {
  const settingsPath = getProjectSettingsPath(projectRoot)
  writeGeminiSettingsFile(settingsPath, settings)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function extractGlobalConfigFromSettings(settings: GeminiSettings): GlobalConfig {
  const yuuka = isPlainObject((settings as any).yuuka)
    ? ((settings as any).yuuka as GlobalConfig)
    : {}

  const mergedConfig: GlobalConfig = {
    ...cloneDeep(DEFAULT_GLOBAL_CONFIG),
    ...(yuuka as any),
  }

  const rawProxyEnabled = (mergedConfig as any).proxyEnabled
  mergedConfig.proxyEnabled =
    typeof rawProxyEnabled === 'boolean' ? rawProxyEnabled : true

  const rawProxyPort = Number((mergedConfig as any).proxyPort)
  mergedConfig.proxyPort =
    Number.isFinite(rawProxyPort) &&
    rawProxyPort >= 1 &&
    rawProxyPort <= 65535
      ? Math.floor(rawProxyPort)
      : 7890
  const rawToolUseConcurrency = Number((mergedConfig as any).maxToolUseConcurrency)
  mergedConfig.maxToolUseConcurrency =
    Number.isFinite(rawToolUseConcurrency) && rawToolUseConcurrency > 0
      ? Math.min(20, Math.max(1, Math.floor(rawToolUseConcurrency)))
      : 4

  // 兼容 Gemini CLI 的字段：ui/theme、mcpServers 放在顶层
  if (settings.ui?.theme) {
    mergedConfig.theme = settings.ui.theme as ThemeNames
  }
  if (typeof settings.proxy === 'string' && settings.proxy.trim() && !mergedConfig.proxy) {
    mergedConfig.proxy = settings.proxy.trim()
  }
  if (settings.mcpServers && typeof settings.mcpServers === 'object') {
    mergedConfig.mcpServers = settings.mcpServers as any
  }
  mergedConfig.dangerousCommands = normalizeDangerousCommands(
    (mergedConfig as any).dangerousCommands,
  )

  return migrateModelProfilesRemoveId(mergedConfig)
}

export function getConfiguredDangerousCommands(): string[] {
  return normalizeDangerousCommands(getGlobalConfig().dangerousCommands)
}

function applyGlobalConfigToSettings(
  settings: GeminiSettings,
  config: GlobalConfig,
): GeminiSettings {
  const next: GeminiSettings = structuredClone(settings)

  ;(next as any).yuuka = config

  next.ui = next.ui ?? {}
  next.ui.theme = config.theme

  const proxyEnabled = config.proxyEnabled ?? true
  const rawProxyPort = Number(config.proxyPort)
  const proxyPort =
    Number.isFinite(rawProxyPort) &&
    rawProxyPort >= 1 &&
    rawProxyPort <= 65535
      ? Math.floor(rawProxyPort)
      : 7890
  const autoLocalProxy = `http://127.0.0.1:${proxyPort}`

  if (proxyEnabled) {
    next.proxy = autoLocalProxy
  } else if (config.proxy) {
    next.proxy = config.proxy
  } else {
    delete (next as any).proxy
  }

  // 顶层 mcpServers 优先作为“对外兼容字段”，yuuka 内也可保留（但运行时读顶层）
  if (config.mcpServers) {
    next.mcpServers = config.mcpServers
  }

  return next
}

export function checkHasTrustDialogAccepted(): boolean {
  let currentPath = getCwd()
  const globalConfig = getGlobalConfig()
  const globalScopedConfig = globalConfig.projects?.[GLOBAL_PROJECT_SCOPE_KEY]
  if (globalScopedConfig?.hasTrustDialogAccepted) {
    return true
  }

  while (true) {
    // 先看项目 settings（.yuuka/settings.json）
    const projectSettingsPath = getProjectGeminiSettingsPath(currentPath)
    if (existsSync(projectSettingsPath)) {
      const projectSettings = readGeminiSettingsFile(projectSettingsPath)
      const projectConfigFromFile = ((projectSettings as any).yuuka as any)?.project
      if (projectConfigFromFile?.hasTrustDialogAccepted) {
        return true
      }
    }

    // 再兜底看旧的全局 projects map（迁移期兼容）
    const projectConfig = globalConfig.projects?.[currentPath]
    if (projectConfig?.hasTrustDialogAccepted) {
      return true
    }
    const parentPath = resolve(currentPath, '..')
    // Stop if we've reached the root (when parent is same as current)
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

// We have to put this test code here because Jest doesn't support mocking ES modules :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdaterStatus: 'disabled',
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

export function saveGlobalConfig(config: GlobalConfig): void {
  if (process.env.NODE_ENV === 'test') {
    for (const key in config) {
      TEST_GLOBAL_CONFIG_FOR_TESTING[key] = config[key]
    }
    return
  }

  const existingSettings = getGlobalSettings()
  const existingConfig = extractGlobalConfigFromSettings(existingSettings)

  // 保留 projects（迁移期兼容），避免 saveGlobalConfig 意外清空
  const mergedConfig: GlobalConfig = {
    ...config,
    projects: config.projects ?? existingConfig.projects,
  }

  saveGlobalSettings(applyGlobalConfigToSettings(existingSettings, mergedConfig))
}

// 临时移除缓存，确保总是获取最新配置
export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }
  const settings = getGlobalSettings()
  return extractGlobalConfigFromSettings(settings)
}

export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey?.slice(-20) ?? ''
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // Filter out any values that match the defaults
  const filteredConfig = Object.fromEntries(
    Object.entries(config).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(defaultConfig[key as keyof A]),
    ),
  )
  try {
    writeFileSync(file, JSON.stringify(filteredConfig, null, 2), 'utf-8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EROFS') {
      debugLogger.state('CONFIG_SAVE_SKIPPED', {
        file,
        reason: String(err.code),
      })
      return
    }
    throw error
  }
}

export function enableConfigs(): void {
  // Any reads to configuration before this flag is set show an console warning
  // to prevent us from adding config reading during module initialization
  // 校验项目 .yuuka/settings.json 是否可解析
  getGlobalSettings(true /* throwOnInvalid */)
}

function getConfig<A>(
  file: string,
  defaultConfig: A,
  throwOnInvalid?: boolean,
): A {
  // 简化配置访问逻辑，移除复杂的时序检查

  debugLogger.state('CONFIG_LOAD_START', {
    file,
    fileExists: String(existsSync(file)),
    throwOnInvalid: String(!!throwOnInvalid),
  })

  if (!existsSync(file)) {
    debugLogger.state('CONFIG_LOAD_DEFAULT', {
      file,
      reason: 'file_not_exists',
      defaultConfigKeys: Object.keys(defaultConfig as object).join(', '),
    })
    return cloneDeep(defaultConfig)
  }

  try {
    const fileContent = readFileSync(file, 'utf-8')
    debugLogger.state('CONFIG_FILE_READ', {
      file,
      contentLength: String(fileContent.length),
      contentPreview:
        fileContent.substring(0, 100) + (fileContent.length > 100 ? '...' : ''),
    })

    try {
      const parsedConfig = JSON.parse(fileContent)
      debugLogger.state('CONFIG_JSON_PARSED', {
        file,
        parsedKeys: Object.keys(parsedConfig).join(', '),
      })

      // Handle backward compatibility - remove logic for deleted fields
      const finalConfig = {
        ...cloneDeep(defaultConfig),
        ...parsedConfig,
      }

      debugLogger.state('CONFIG_LOAD_SUCCESS', {
        file,
        finalConfigKeys: Object.keys(finalConfig as object).join(', '),
      })

      return finalConfig
    } catch (error) {
      // Throw a ConfigParseError with the file path and default config
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      debugLogger.error('CONFIG_JSON_PARSE_ERROR', {
        file,
        errorMessage,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        contentLength: String(fileContent.length),
      })

      throw new ConfigParseError(errorMessage, file, defaultConfig)
    }
  } catch (error: unknown) {
    // Re-throw ConfigParseError if throwOnInvalid is true
    if (error instanceof ConfigParseError && throwOnInvalid) {
      debugLogger.error('CONFIG_PARSE_ERROR_RETHROWN', {
        file,
        throwOnInvalid: String(throwOnInvalid),
        errorMessage: error.message,
      })
      throw error
    }

    debugLogger.warn('CONFIG_FALLBACK_TO_DEFAULT', {
      file,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      action: 'using_default_config',
    })

    return cloneDeep(defaultConfig)
  }
}

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const projectRoot = resolve(getCwd())

  const normalizeProjectConfig = (projectConfig: ProjectConfig): ProjectConfig => {
    // Not sure how this became a string
    // TODO: Fix upstream
    if (typeof (projectConfig as any).allowedTools === 'string') {
      projectConfig.allowedTools =
        (safeParseJSON((projectConfig as any).allowedTools) as string[]) ?? []
    }
    return projectConfig
  }

  // 1) 优先读取统一全局项目槽位（跨目录共享）
  const globalConfig = getGlobalConfig()
  const fromGlobalScoped = globalConfig.projects?.[GLOBAL_PROJECT_SCOPE_KEY]
  if (fromGlobalScoped) {
    return normalizeProjectConfig(fromGlobalScoped)
  }

  // 2) 兼容历史：按 cwd 存储的项目配置，迁移到统一全局槽位
  const fromGlobal = globalConfig.projects?.[projectRoot]
  if (fromGlobal) {
    const nextGlobalConfig: GlobalConfig = {
      ...globalConfig,
      projects: {
        ...(globalConfig.projects ?? {}),
        [GLOBAL_PROJECT_SCOPE_KEY]: fromGlobal,
      },
    }
    saveGlobalConfig(nextGlobalConfig)
    return normalizeProjectConfig(fromGlobal)
  }

  // 3) 兼容更旧版：项目 .yuuka/settings.json 里存了 yuuka.project
  const projectSettingsPath = getProjectSettingsPath(projectRoot)
  if (existsSync(projectSettingsPath)) {
    try {
      const projectSettings = getProjectSettings(projectRoot)
      const fromProjectSettings =
        ((projectSettings as any).yuuka as any)?.project as ProjectConfig | undefined
      if (fromProjectSettings) {
        const nextGlobalConfig: GlobalConfig = {
          ...globalConfig,
          projects: {
            ...(globalConfig.projects ?? {}),
            [GLOBAL_PROJECT_SCOPE_KEY]: fromProjectSettings,
          },
        }
        saveGlobalConfig(nextGlobalConfig)
        return normalizeProjectConfig(fromProjectSettings)
      }
    } catch {
      // ignore migration errors
    }
  }

  const projectConfig = defaultConfigForProject(projectRoot)

  return normalizeProjectConfig(projectConfig)
}

export function saveCurrentProjectConfig(projectConfig: ProjectConfig): void {
  if (process.env.NODE_ENV === 'test') {
    for (const key in projectConfig) {
      TEST_PROJECT_CONFIG_FOR_TESTING[key] = projectConfig[key]
    }
    return
  }

  const globalConfig = getGlobalConfig()
  const next: GlobalConfig = {
    ...globalConfig,
    projects: {
      ...(globalConfig.projects ?? {}),
      [GLOBAL_PROJECT_SCOPE_KEY]: projectConfig,
    },
  }
  saveGlobalConfig(next)
}

export async function isAutoUpdaterDisabled(): Promise<boolean> {
  return getGlobalConfig().autoUpdaterStatus === 'disabled'
}

export const TEST_MCPRC_CONFIG_FOR_TESTING: Record<string, McpServerConfig> = {}

export function clearMcprcConfigForTesting(): void {
  if (process.env.NODE_ENV === 'test') {
    Object.keys(TEST_MCPRC_CONFIG_FOR_TESTING).forEach(key => {
      delete TEST_MCPRC_CONFIG_FOR_TESTING[key]
    })
  }
}

export function addMcprcServerForTesting(
  name: string,
  server: McpServerConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    TEST_MCPRC_CONFIG_FOR_TESTING[name] = server
  }
}

export function removeMcprcServerForTesting(name: string): void {
  if (process.env.NODE_ENV === 'test') {
    if (!TEST_MCPRC_CONFIG_FOR_TESTING[name]) {
      throw new Error(`No MCP server found with name: ${name} in .mcprc`)
    }
    delete TEST_MCPRC_CONFIG_FOR_TESTING[name]
  }
}

export const getMcprcConfig = memoize(
  (): Record<string, McpServerConfig> => {
    if (process.env.NODE_ENV === 'test') {
      return TEST_MCPRC_CONFIG_FOR_TESTING
    }

    const mcprcPath = join(getCwd(), '.mcprc')
    if (!existsSync(mcprcPath)) {
      return {}
    }

    try {
      const mcprcContent = readFileSync(mcprcPath, 'utf-8')
      const config = safeParseJSON(mcprcContent)
      if (config && typeof config === 'object') {
        // Logging removed
        return config as Record<string, McpServerConfig>
      }
    } catch {
      // Ignore errors reading/parsing .mcprc (they're logged in safeParseJSON)
    }
    return {}
  },
  // This function returns the same value as long as the cwd and mcprc file content remain the same
  () => {
    const cwd = getCwd()
    const mcprcPath = join(cwd, '.mcprc')
    if (existsSync(mcprcPath)) {
      try {
        const stat = readFileSync(mcprcPath, 'utf-8')
        return `${cwd}:${stat}`
      } catch {
        return cwd
      }
    }
    return cwd
  },
)

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig({ ...config, userID })
  return userID
}

export function getConfigForCLI(key: string, global: boolean): unknown {
  
  if (global) {
    if (!isGlobalConfigKey(key)) {
      console.error(
        `Error: '${key}' is not a valid config key. Valid keys are: ${GLOBAL_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }
    return getGlobalConfig()[key]
  } else {
    if (!isProjectConfigKey(key)) {
      console.error(
        `Error: '${key}' is not a valid config key. Valid keys are: ${PROJECT_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }
    return getCurrentProjectConfig()[key]
  }
}

export function setConfigForCLI(
  key: string,
  rawValue: unknown,
  global: boolean,
): void {
  let value = rawValue
  
  if (global) {
    if (!isGlobalConfigKey(key)) {
      console.error(
        `Error: Cannot set '${key}'. Only these keys can be modified: ${GLOBAL_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }

    if (key === 'autoUpdaterStatus' && !isAutoUpdaterStatus(value as string)) {
      console.error(
        `Error: Invalid value for autoUpdaterStatus. Must be one of: disabled, enabled, no_permissions, not_configured`,
      )
      process.exit(1)
    }
    if (key === 'thinkingGemini3Level') {
      const normalized = String(value).trim().toLowerCase()
      if (normalized !== 'low' && normalized !== 'high') {
        console.error(`Error: thinkingGemini3Level must be one of: low, high`)
        process.exit(1)
      }
      value = normalized
    }
    if (key === 'thinkingNonGemini3Budget') {
      const parsed = Number.parseInt(String(value), 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`Error: thinkingNonGemini3Budget must be a positive integer`)
        process.exit(1)
      }
      value = Math.floor(parsed)
    }
    if (key === 'memoryReadEnabled' || key === 'memoryWriteEnabled') {
      const normalized = String(value).trim().toLowerCase()
      if (normalized !== 'true' && normalized !== 'false') {
        console.error(`Error: ${key} must be true or false`)
        process.exit(1)
      }
      value = normalized === 'true'
    }
    if (key === 'proxyEnabled') {
      const normalized = String(value).trim().toLowerCase()
      if (normalized !== 'true' && normalized !== 'false') {
        console.error(`Error: proxyEnabled must be true or false`)
        process.exit(1)
      }
      value = normalized === 'true'
    }
    if (key === 'proxyPort') {
      const parsed = Number.parseInt(String(value), 10)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`Error: proxyPort must be an integer between 1 and 65535`)
        process.exit(1)
      }
      value = Math.floor(parsed)
    }
    if (key === 'dangerousCommands') {
      value = parseDangerousCommandsInput(String(value ?? ''))
    }

    const currentConfig = getGlobalConfig()
    saveGlobalConfig({
      ...currentConfig,
      [key]: value,
    })
  } else {
    if (!isProjectConfigKey(key)) {
      console.error(
        `Error: Cannot set '${key}'. Only these keys can be modified: ${PROJECT_CONFIG_KEYS.join(', ')}. Did you mean --global?`,
      )
      process.exit(1)
    }
    const currentConfig = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...currentConfig,
      [key]: value,
    })
  }
  // Wait for the output to be flushed, to avoid clearing the screen.
  setTimeout(() => {
    // Without this we hang indefinitely.
    process.exit(0)
  }, 100)
}

export function deleteConfigForCLI(key: string, global: boolean): void {
  
  if (global) {
    if (!isGlobalConfigKey(key)) {
      console.error(
        `Error: Cannot delete '${key}'. Only these keys can be modified: ${GLOBAL_CONFIG_KEYS.join(', ')}`,
      )
      process.exit(1)
    }
    const currentConfig = getGlobalConfig()
    delete currentConfig[key]
    saveGlobalConfig(currentConfig)
  } else {
    if (!isProjectConfigKey(key)) {
      console.error(
        `Error: Cannot delete '${key}'. Only these keys can be modified: ${PROJECT_CONFIG_KEYS.join(', ')}. Did you mean --global?`,
      )
      process.exit(1)
    }
    const currentConfig = getCurrentProjectConfig()
    delete currentConfig[key]
    saveCurrentProjectConfig(currentConfig)
  }
}

export function listConfigForCLI(global: true): GlobalConfig
export function listConfigForCLI(global: false): ProjectConfig
export function listConfigForCLI(global: boolean): object {
  
  if (global) {
    const currentConfig = pick(getGlobalConfig(), GLOBAL_CONFIG_KEYS)
    return currentConfig
  } else {
    return pick(getCurrentProjectConfig(), PROJECT_CONFIG_KEYS)
  }
}

// Configuration migration utility functions
function migrateModelProfilesRemoveId(config: GlobalConfig): GlobalConfig {
  if (!config.modelProfiles) return config

  // 1. Remove id field from ModelProfile objects and build ID to modelName mapping
  const idToModelNameMap = new Map<string, string>()
  const migratedProfiles = config.modelProfiles.map(profile => {
    // Build mapping before removing id field
    if ((profile as any).id && profile.modelName) {
      idToModelNameMap.set((profile as any).id, profile.modelName)
    }

    // Remove id field, keep everything else
    const { id, ...profileWithoutId } = profile as any
    return profileWithoutId as ModelProfile
  })

  // 2. Migrate ModelPointers from IDs to modelNames
  const migratedPointers: ModelPointers = {
    main: '',
    task: '',
    reasoning: '',
    quick: '',
  }

  if (config.modelPointers) {
    Object.entries(config.modelPointers).forEach(([pointer, value]) => {
      if (value) {
        // If value looks like an old ID (model_xxx), map it to modelName
        const modelName = idToModelNameMap.get(value) || value
        migratedPointers[pointer as ModelPointerType] = modelName
      }
    })
  }

  // 3. Migrate legacy config fields
  let defaultModelName: string | undefined
  if ((config as any).defaultModelId) {
    defaultModelName =
      idToModelNameMap.get((config as any).defaultModelId) ||
      (config as any).defaultModelId
  } else if ((config as any).defaultModelName) {
    defaultModelName = (config as any).defaultModelName
  }

  // 4. Remove legacy fields and return migrated config
  const migratedConfig = { ...config }
  delete (migratedConfig as any).defaultModelId
  delete (migratedConfig as any).currentSelectedModelId
  delete (migratedConfig as any).mainAgentModelId
  delete (migratedConfig as any).taskToolModelId

  return {
    ...migratedConfig,
    modelProfiles: migratedProfiles,
    modelPointers: migratedPointers,
    defaultModelName,
  }
}

// New model system utility functions

export function setAllPointersToModel(modelName: string): void {
  const config = getGlobalConfig()
  const updatedConfig = {
    ...config,
    modelPointers: {
      main: modelName,
      task: modelName,
      reasoning: modelName,
      quick: modelName,
    },
    defaultModelName: modelName,
  }
  saveGlobalConfig(updatedConfig)
}

export function setModelPointer(
  pointer: ModelPointerType,
  modelName: string,
): void {
  const config = getGlobalConfig()
  const updatedConfig = {
    ...config,
    modelPointers: {
      ...config.modelPointers,
      [pointer]: modelName,
    },
  }
  saveGlobalConfig(updatedConfig)

  // Fix: Force ModelManager reload after config change
  // Import here to avoid circular dependency
  import('./model').then(({ reloadModelManager }) => {
    reloadModelManager()
  })
}
