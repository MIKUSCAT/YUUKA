#!/usr/bin/env -S node --no-warnings=ExperimentalWarning --enable-source-maps

import 'dotenv/config'

// Global handler for AbortError - this prevents unhandled rejection crashes
// when user presses ESC to cancel streaming requests
process.on('unhandledRejection', (reason: any, promise) => {
  // Silently ignore AbortError - this is expected behavior when cancelling requests
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return
  }
  if (reason?.name === 'AbortError' || reason?.message?.includes('aborted')) {
    return
  }
  // For other unhandled rejections, log them
  console.error('Unhandled Rejection:', reason)
})

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { PRODUCT_COMMAND, PRODUCT_NAME } from '@constants/product'

// Ensure YOGA_WASM_PATH is set for Ink across run modes (wrapper/dev)
// Resolve yoga.wasm relative to this file when missing using ESM-friendly APIs
try {
  if (!process.env.YOGA_WASM_PATH) {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const devCandidate = join(__dirname, '../../yoga.wasm')
    const distCandidate = join(__dirname, './yoga.wasm')
    const resolved = existsSync(distCandidate)
      ? distCandidate
      : existsSync(devCandidate)
        ? devCandidate
        : undefined
    if (resolved) {
      process.env.YOGA_WASM_PATH = resolved
    }
  }
} catch {}

import React from 'react'
import { ReadStream } from 'tty'
// ink and REPL are imported lazily to avoid top-level awaits during module init
import type { RenderOptions } from 'ink'
import { addToHistory } from '@history'
import { getContext, setContext, removeContext } from '@context'
import { Command } from '@commander-js/extra-typings'
import { ask } from '@utils/ask'
import { hasPermissionsToUseTool } from '@permissions'
import { getTools, getCoreTools } from '@tools'
import {
  getGlobalConfig,
  getCurrentProjectConfig,
  saveGlobalConfig,
  saveCurrentProjectConfig,
  setConfigForCLI,
  deleteConfigForCLI,
  getConfigForCLI,
  listConfigForCLI,
  enableConfigs,
} from '@utils/config'
import { cwd } from 'process'
import { dateToFilename, logError, parseLogFilename } from '@utils/log'
import { initDebugLogger } from '@utils/debugLogger'
import { Onboarding } from '@components/Onboarding'
import { Doctor } from '@screens/Doctor'
import { TrustDialog } from '@components/TrustDialog'
import { checkHasTrustDialogAccepted, McpServerConfig } from '@utils/config'
import { LogList } from '@screens/LogList'
import { ResumeConversation } from '@screens/ResumeConversation'
import { startMCPServer } from './mcp'
import { getCwd, setCwd, setOriginalCwd } from '@utils/state'
import { omit } from 'lodash-es'
import { getCommands } from '@commands'
import { getNextAvailableLogForkNumber, loadLogList } from '@utils/log'
import { loadMessagesFromLog } from '@utils/conversationRecovery'
import { cleanupOldMessageFilesInBackground } from '@utils/cleanup'
import {
  handleListApprovedTools,
  handleRemoveApprovedTool,
} from '@commands/approvedTools'
import {
  addMcpServer,
  getMcpServer,
  listMCPServers,
  parseEnvVars,
  removeMcpServer,
  ensureConfigScope,
} from '@services/mcpClient'
import { handleMcprcServerApprovals } from '@services/mcpServerApproval'
 
import { cursorShow } from 'ansi-escapes'
import { getLatestVersion, assertMinVersion } from '@utils/autoUpdater'
import { gt } from 'semver'
import { CACHE_PATHS } from '@utils/log'
import { PersistentShell } from '@utils/PersistentShell'
import { clearTerminal } from '@utils/terminal'
import { showInvalidConfigDialog } from '@components/InvalidConfigDialog'
import { ConfigParseError } from '@utils/errors'
import { grantReadPermissionForOriginalDir } from '@utils/permissions/filesystem'
import { MACRO } from '@constants/macros'
import { runProjectMigrations } from '@utils/migrations'
import {
  ensureGlobalGeminiSettings,
  getGlobalGeminiSettingsPath,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
} from '@utils/geminiSettings'
import matter from 'gray-matter'
import { clearSkillCache } from '@utils/skillLoader'

type SkillImportScope = 'project' | 'user'

function normalizeSkillName(input: string): string {
  let name = input.trim().toLowerCase()
  name = name.replace(/[\s_]+/g, '-')
  name = name.replace(/[^a-z0-9-]/g, '-')
  name = name.replace(/-+/g, '-')
  name = name.replace(/^-+/, '').replace(/-+$/, '')
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/-+$/, '')
  }
  return name
}

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

function parseSkillImportScope(rawScope: string): SkillImportScope {
  const normalized = String(rawScope ?? 'user').trim().toLowerCase()
  if (normalized === 'project' || normalized === 'local') {
    return 'project'
  }
  if (
    normalized === 'user' ||
    normalized === 'personal' ||
    normalized === 'global'
  ) {
    return 'user'
  }
  throw new Error('scope 只支持: user（project/local 仅作兼容并会映射到 user）')
}

function getSkillImportBaseDir(scope: SkillImportScope): string {
  return join(homedir(), '.yuuka', 'skills')
}

function importSkillFromPath(params: {
  source: string
  scope: string
  name?: string
}): { name: string; scope: SkillImportScope; targetDir: string } {
  const sourcePath = resolve(params.source)
  if (!existsSync(sourcePath)) {
    throw new Error(`源路径不存在: ${sourcePath}`)
  }

  const sourceStat = statSync(sourcePath)
  let sourceDir = sourcePath
  let sourceSkillFile = join(sourcePath, 'SKILL.md')

  if (sourceStat.isFile()) {
    if (basename(sourcePath).toLowerCase() !== 'skill.md') {
      throw new Error('source 若是文件，必须是 SKILL.md')
    }
    sourceDir = dirname(sourcePath)
    sourceSkillFile = sourcePath
  }

  if (!existsSync(sourceSkillFile)) {
    throw new Error(`未找到 SKILL.md: ${sourceSkillFile}`)
  }

  const sourceContent = readFileSync(sourceSkillFile, 'utf-8')
  const parsedSource = matter(sourceContent)
  const sourceFrontmatterName =
    typeof parsedSource.data?.name === 'string'
      ? String(parsedSource.data.name).trim()
      : ''
  const sourceDescription =
    typeof parsedSource.data?.description === 'string'
      ? String(parsedSource.data.description).trim()
      : ''
  if (!sourceDescription) {
    throw new Error('SKILL.md 缺少 description 字段，无法导入')
  }

  const inferredName =
    String(params.name ?? '').trim() ||
    sourceFrontmatterName ||
    basename(sourceDir)
  const normalizedName = normalizeSkillName(inferredName)
  if (!isValidSkillName(normalizedName)) {
    throw new Error(
      `技能名不合法: ${inferredName}（需要 kebab-case，1-64 字符）`,
    )
  }

  const scope = parseSkillImportScope(params.scope)
  const targetBaseDir = getSkillImportBaseDir(scope)
  const targetDir = join(targetBaseDir, normalizedName)
  if (existsSync(targetDir)) {
    throw new Error(`目标技能已存在: ${targetDir}`)
  }

  mkdirSync(targetBaseDir, { recursive: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })

  const targetSkillFile = join(targetDir, 'SKILL.md')
  if (!existsSync(targetSkillFile)) {
    throw new Error(`导入失败：目标目录缺少 SKILL.md (${targetSkillFile})`)
  }

  const targetContent = readFileSync(targetSkillFile, 'utf-8')
  const parsedTarget = matter(targetContent)
  parsedTarget.data = {
    ...(parsedTarget.data ?? {}),
    name: normalizedName,
  }
  writeFileSync(
    targetSkillFile,
    matter.stringify(parsedTarget.content, parsedTarget.data),
    'utf-8',
  )

  clearSkillCache()
  return { name: normalizedName, scope, targetDir }
}

export function completeOnboarding(): void {
  const config = getGlobalConfig()
  saveGlobalConfig({
    ...config,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
  })
}

async function showSetupScreens(
  safeMode?: boolean,
  print?: boolean,
): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  const config = getGlobalConfig()
  if (
    !config.theme ||
    !config.hasCompletedOnboarding // always show onboarding at least once
  ) {
    await clearTerminal()
    const { render } = await import('ink')
    await new Promise<void>(resolve => {
      render(
        <Onboarding
          onDone={async () => {
            completeOnboarding()
            await clearTerminal()
            resolve()
          }}
        />,
        {
          exitOnCtrlC: false,
        },
      )
    })
  }

  

  // In non-interactive mode, only show trust dialog in safe mode
  if (!print && safeMode) {
    if (!checkHasTrustDialogAccepted()) {
      await new Promise<void>(resolve => {
        const onDone = () => {
          // Grant read permission to the current working directory
          grantReadPermissionForOriginalDir()
          resolve()
        }
        ;(async () => {
          const { render } = await import('ink')
          render(<TrustDialog onDone={onDone} />, {
            exitOnCtrlC: false,
          })
        })()
      })
    }

    // After trust dialog, check for any mcprc servers that need approval
    if (process.env.USER_TYPE === 'ant') {
      await handleMcprcServerApprovals()
    }
  }
}

function migrateLegacyProjectGeminiSettingsToGlobal(projectRoot: string): void {
  // 只做“搬家”：把项目 settings 里的 Gemini key/baseUrl/model 迁移到全局 settings。
  try {
    ensureGlobalGeminiSettings()
    const globalPath = getGlobalGeminiSettingsPath()
    const globalSettings = readGeminiSettingsFile(globalPath)

    const globalAuth = globalSettings.security?.auth?.geminiApi
    const hasGlobalKey = !!globalAuth?.apiKey?.trim()

    const projectPath = join(projectRoot, '.yuuka', 'settings.json')
    if (!existsSync(projectPath)) return

    const projectSettings = readGeminiSettingsFile(projectPath)
    const projectAuth = projectSettings.security?.auth?.geminiApi

    const projectKey = projectAuth?.apiKey?.trim() ?? ''
    const projectBaseUrl = projectAuth?.baseUrl?.trim() ?? ''
    const projectModel = projectSettings.model?.name?.trim() ?? ''

    if (!projectKey && !projectBaseUrl && !projectModel) return

    const next = structuredClone(globalSettings) as any
    let changed = false

    // 只在全局还没配置 key 时才迁移（避免覆盖用户已有全局配置）
    if (!hasGlobalKey && projectKey) {
      next.security = next.security ?? {}
      next.security.auth = next.security.auth ?? {}
      next.security.auth.selectedType = 'gemini-api-key'
      next.security.auth.geminiApi = next.security.auth.geminiApi ?? {}
      next.security.auth.geminiApi.apiKeyAuthMode = 'x-goog-api-key'
      next.security.auth.geminiApi.apiKey = projectKey
      changed = true
    }

    // baseUrl：全局没填/用默认值时，允许迁移项目里的自定义 baseUrl
    const globalBaseUrl =
      String(globalAuth?.baseUrl ?? 'https://generativelanguage.googleapis.com').trim()
    if (
      projectBaseUrl &&
      (globalBaseUrl === 'https://generativelanguage.googleapis.com' ||
        globalBaseUrl === 'https://generativelanguage.googleapis.com/v1beta')
    ) {
      next.security = next.security ?? {}
      next.security.auth = next.security.auth ?? {}
      next.security.auth.selectedType = 'gemini-api-key'
      next.security.auth.geminiApi = next.security.auth.geminiApi ?? {}
      next.security.auth.geminiApi.apiKeyAuthMode = 'x-goog-api-key'
      next.security.auth.geminiApi.baseUrl = projectBaseUrl
      changed = true
    }

    // model：全局没配置时迁移
    const globalModel = String(globalSettings.model?.name ?? '').trim()
    if (!globalModel && projectModel) {
      next.model = next.model ?? {}
      next.model.name = projectModel
      changed = true
    }

    if (!changed) return
    writeGeminiSettingsFile(globalPath, next)
    console.log(`已迁移 Gemini 配置到全局 settings：${globalPath}`)
  } catch {
    // ignore
  }
}

function migrateMcpServersToGlobalAndNpx(): void {
  try {
    const projectConfig = getCurrentProjectConfig()
    const projectServers = projectConfig.mcpServers ?? {}

    const globalConfig = getGlobalConfig()
    const globalServers = globalConfig.mcpServers ?? {}

    let changed = false
    const nextGlobalServers: typeof globalServers = { ...globalServers }

    // 1) 把项目 MCP servers 搬到全局（不覆盖全局同名项）
    for (const [name, server] of Object.entries(projectServers)) {
      if (nextGlobalServers[name]) continue
      nextGlobalServers[name] = server
      changed = true
    }

    // 2) 把老的本地 cwd + npm run start 形态迁移为 npx（减重、免本地 checkout）
    for (const [name, server] of Object.entries(nextGlobalServers)) {
      if (server.type === 'sse') continue
      const cwd = String(server.cwd ?? '')
      const cmd = String(server.command ?? '')
      const args = Array.isArray(server.args) ? server.args.map(String) : []

      const looksLikeLocalNpmRunStart =
        cmd === 'npm' && args.length >= 2 && args[0] === 'run' && args[1] === 'start'

      if (name === 'office-reader' && looksLikeLocalNpmRunStart && cwd.includes('mcp-servers/office-reader')) {
        nextGlobalServers[name] = {
          command: 'npx',
          args: ['-y', 'yuuka-mcp-office-reader'],
          env: server.env,
        }
        changed = true
        continue
      }

      if (name === 'chrome-devtools' && looksLikeLocalNpmRunStart && cwd.includes('mcp-servers/chrome-devtools-mcp')) {
        nextGlobalServers[name] = {
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp'],
          env: server.env,
        }
        changed = true
        continue
      }

      // windows_mcp：从本地目录脚本迁移为“直接跑本地 exe（需在 PATH 或写绝对路径）”
      if (
        name === 'windows_mcp' &&
        cmd.toLowerCase().includes('powershell') &&
        cwd.includes('mcp-servers/windows-mcp')
      ) {
        nextGlobalServers[name] = {
          command: 'Sbroenne.WindowsMcp.exe',
          args: [],
          env: server.env,
        }
        changed = true
      }
    }

    if (!changed) return

    saveGlobalConfig({
      ...globalConfig,
      mcpServers: nextGlobalServers,
    })

    // 清掉项目里的 mcpServers（以后只用全局）
    if (Object.keys(projectServers).length > 0) {
      saveCurrentProjectConfig({
        ...projectConfig,
        mcpServers: {},
      })
    }
  } catch {
    // ignore
  }
}

function mergeNoProxy(existing: string, additions: string[]): string {
  const items = [...existing.split(','), ...additions]
    .map(s => s.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result.join(',')
}

async function applyGlobalProxyFromConfig(): Promise<void> {
  try {
    const globalConfig = getGlobalConfig()
    const configuredProxy =
      typeof globalConfig.proxy === 'string' ? globalConfig.proxy.trim() : ''

    const proxyEnabled =
      typeof globalConfig.proxyEnabled === 'boolean'
        ? globalConfig.proxyEnabled
        : true
    const rawProxyPort = Number(globalConfig.proxyPort)
    const proxyPort =
      Number.isFinite(rawProxyPort) &&
      rawProxyPort >= 1 &&
      rawProxyPort <= 65535
        ? Math.floor(rawProxyPort)
        : 7890
    const autoLocalProxy = `http://127.0.0.1:${proxyPort}`

    const envProxy = String(
      process.env['YUUKA_PROXY'] ||
        process.env['HTTPS_PROXY'] ||
        process.env['HTTP_PROXY'] ||
        '',
    ).trim()

    const proxy = proxyEnabled ? autoLocalProxy : configuredProxy || envProxy
    if (!proxy) return

    // 给其他 HTTP 库兜底（node-fetch 等）
    if (!process.env['HTTP_PROXY']) process.env['HTTP_PROXY'] = proxy
    if (!process.env['HTTPS_PROXY']) process.env['HTTPS_PROXY'] = proxy

    // 默认不要代理本地回环地址，避免影响本机服务
    const existingNoProxy =
      String(process.env['NO_PROXY'] || process.env['no_proxy'] || '').trim()
    const noProxy = mergeNoProxy(existingNoProxy, [
      '127.0.0.1',
      'localhost',
      '::1',
    ])
    if (noProxy) process.env['NO_PROXY'] = noProxy

    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: proxy,
        httpsProxy: proxy,
        noProxy,
      }),
    )
  } catch (error) {
    // 不要打断启动，但把错误写入日志（方便 doctor/调试）
    logError(error)
  }
}

async function setup(cwd: string, safeMode?: boolean): Promise<void> {
  // Set both current and original working directory if --cwd was provided
  if (cwd !== process.cwd()) {
    setOriginalCwd(cwd)
  }
  await setCwd(cwd)

  // Always grant read permissions for original working dir
  grantReadPermissionForOriginalDir()

  // 迁移：如果之前把 key/baseUrl 写在项目 settings 里，这里帮你搬到全局 ~/.yuuka/settings.json
  migrateLegacyProjectGeminiSettingsToGlobal(resolve(cwd))

  // Ensure project config exists (legacy config migrations may create settings.json)
  getCurrentProjectConfig()

  // One-time migrations (history/tool names) for the current project
  runProjectMigrations()

  // 迁移：把 MCP servers 从项目配置搬到全局，并把本地 npm run start 形态改成 npx
  migrateMcpServersToGlobalAndNpx()

  // 应用全局代理（用于 Gemini OAuth / Code Assist / fetch 等网络请求）
  await applyGlobalProxyFromConfig()

  // Non-blocking: Start agent watcher in background (don't await)
  ;(async () => {
    try {
      const agentLoader = await import('@utils/agentLoader')
      const { startAgentWatcher } = agentLoader
      await startAgentWatcher()
    } catch (e) {
      // Silently ignore agent watcher errors - not critical for startup
    }
  })()

  // Non-blocking: Start skill watcher in background (don't await)
  ;(async () => {
    try {
      const skillLoader = await import('@utils/skillLoader')
      const { startSkillWatcher } = skillLoader
      await startSkillWatcher()
    } catch {
      // Silently ignore skill watcher errors - not critical for startup
    }
  })()

  // If --safe mode is enabled, prevent root/sudo usage for security
  if (safeMode) {
    // Check if running as root/sudo on Unix-like systems
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0
    ) {
      console.error(
        `--safe mode cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  // Non-blocking: Run cleanup and context prefetch in background
  cleanupOldMessageFilesInBackground()
  // Note: getContext() is now called lazily in REPL when needed, not here

  // Non-blocking: Migrate config in background
  setImmediate(() => {
    const globalConfig = getGlobalConfig()
    if (
      globalConfig.iterm2KeyBindingInstalled === true &&
      globalConfig.shiftEnterKeyBindingInstalled !== true
    ) {
      const updatedConfig = {
        ...globalConfig,
        shiftEnterKeyBindingInstalled: true,
      }
      delete updatedConfig.iterm2KeyBindingInstalled
      saveGlobalConfig(updatedConfig)
    }
  })

  // Skip interactive auto-updater permission prompts during startup
  // Users can still run the doctor command manually if desired.
}

async function main() {
  // 初始化调试日志系统
  initDebugLogger()

  // Validate configs are valid and enable configuration system
  try {
    enableConfigs()
  } catch (error: unknown) {
    if (error instanceof ConfigParseError) {
      // Show the invalid config dialog with the error object
      await showInvalidConfigDialog({ error })
      return // Exit after handling the config error
    }
  }

  // Disabled background notifier to avoid mid-screen logs during REPL

  let inputPrompt = ''
  let renderContext: RenderOptions | undefined = {
    exitOnCtrlC: false,

    onFlicker() {},
  } as any

  if (
    !process.stdin.isTTY &&
    !process.env.CI &&
    // Input hijacking breaks MCP.
    !process.argv.includes('mcp')
  ) {
    inputPrompt = await stdin()
    if (process.platform !== 'win32') {
      try {
        const ttyFd = openSync('/dev/tty', 'r')
        renderContext = { ...renderContext, stdin: new ReadStream(ttyFd) }
      } catch (err) {
        logError(`Could not open /dev/tty: ${err}`)
      }
    }
  }
  await parseArgs(inputPrompt, renderContext)
}

async function parseArgs(
  stdinContent: string,
  renderContext: RenderOptions | undefined,
): Promise<Command> {
  const program = new Command()

  const renderContextWithExitOnCtrlC = {
    ...renderContext,
    exitOnCtrlC: true,
  }

  // Get the initial list of commands filtering based on user type
  const commands = await getCommands()

  // Format command list for help text (using same filter as in help.ts)
  const commandList = commands
    .filter(cmd => !cmd.isHidden)
    .map(cmd => `/${cmd.name} - ${cmd.description}`)
    .join('\n')

  program
    .name(PRODUCT_COMMAND)
    .description(
      `${PRODUCT_NAME} - starts an interactive session by default, use -p/--print for non-interactive output

Slash commands available during an interactive session:
${commandList}`,
    )
    .argument('[prompt]', 'Your prompt', String)
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-d, --debug', 'Enable debug mode', () => true)
    .option(
      '--debug-verbose',
      'Enable verbose debug terminal output',
      () => true,
    )
    .option(
      '--verbose',
      'Override verbose mode setting from config',
      () => true,
    )
    .option(
      '-p, --print',
      'Print response and exit (useful for pipes)',
      () => true,
    )
    .option(
      '--safe',
      'Enable strict permission checking mode (default is permissive in interactive mode)',
      () => true,
    )
    .option(
      '--teammate',
      'Internal: run as teammate worker process',
      () => true,
    )
    .option(
      '--teammate-task-file <path>',
      'Internal: teammate task file path',
      String,
    )
    .action(
      async (
        prompt,
        { cwd, debug, verbose, print, safe, teammate, teammateTaskFile },
      ) => {
        if (teammate) {
          await setup(cwd, safe)
          if (!teammateTaskFile) {
            console.error('Missing required --teammate-task-file for teammate mode')
            process.exit(1)
          }
          const { runTeammateTask } = await import('./teammate')
          const exitCode = await runTeammateTask(resolve(teammateTaskFile))
          process.exit(exitCode)
        }

        await showSetupScreens(safe, print)
        
        await setup(cwd, safe)

        assertMinVersion()
        const inputPrompt = [prompt, stdinContent].filter(Boolean).join('\n')
        if (print) {
          const tools = await getTools()
          if (!inputPrompt) {
            console.error(
              'Error: Input must be provided either through stdin or as a prompt argument when using --print',
            )
            process.exit(1)
          }

          addToHistory(inputPrompt)
          const { resultText: response } = await ask({
            commands,
            hasPermissionsToUseTool,
            messageLogName: dateToFilename(new Date()),
            prompt: inputPrompt,
            cwd,
            tools,
            safeMode: safe,
          })
          console.log(response)
          process.exit(0)
        } else {
          // Render REPL immediately, check for updates in background
          const { render } = await import('ink')
          const { REPL } = await import('@screens/REPL')
          const tools = await getCoreTools()
          render(
            <REPL
              commands={commands}
              debug={debug}
              initialPrompt={inputPrompt}
              messageLogName={dateToFilename(new Date())}
              shouldShowPromptInput={true}
              verbose={verbose}
              tools={tools}
              safeMode={safe}
              loadMcpToolsInBackground={true}
            />,
            renderContext,
          )

          // Non-blocking: Check for updates in background (after render)
          setImmediate(async () => {
            try {
              const latest = await getLatestVersion()
              if (latest && gt(latest, MACRO.VERSION)) {
                // Update info is available but we don't block render for it
                // Users can run `yuuka update` to see update commands
              }
            } catch {
              // Silently ignore update check errors
            }
          })
        }
      },
    )
    .version(MACRO.VERSION, '-v, --version')

  // claude config
  const config = program
    .command('config')
    .description(
      `Manage configuration (eg. ${PRODUCT_COMMAND} config set -g theme dark)`,
    )

  config
    .command('get <key>')
    .description('Get a config value')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config')
    .action(async (key, { cwd, global }) => {
      await setup(cwd, false)
      console.log(getConfigForCLI(key, global ?? false))
      process.exit(0)
    })

  config
    .command('set <key> <value>')
    .description('Set a config value')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config')
    .action(async (key, value, { cwd, global }) => {
      await setup(cwd, false)
      setConfigForCLI(key, value, global ?? false)
      console.log(`Set ${key} to ${value}`)
      process.exit(0)
    })

  config
    .command('remove <key>')
    .description('Remove a config value')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config')
    .action(async (key, { cwd, global }) => {
      await setup(cwd, false)
      deleteConfigForCLI(key, global ?? false)
      console.log(`Removed ${key}`)
      process.exit(0)
    })

  config
    .command('list')
    .description('List all config values')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config', false)
    .action(async ({ cwd, global }) => {
      await setup(cwd, false)
      console.log(
        JSON.stringify(global ? listConfigForCLI(true) : listConfigForCLI(false), null, 2),
      )
      process.exit(0)
    })

  const skills = program
    .command('skills')
    .description('Manage skills from command line')

  skills
    .command('import <source> [name]')
    .description(
      'Import a skill directory (or SKILL.md file) into ~/.yuuka/skills',
    )
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option(
      '-s, --scope <scope>',
      'Import scope: project or user',
      'user',
    )
    .action(async (source, name, { cwd, scope }) => {
      try {
        await setup(cwd, false)
        const result = importSkillFromPath({
          source,
          name,
          scope,
        })
        console.log(
          `Imported skill "${result.name}" to ${result.scope} scope:\n${result.targetDir}`,
        )
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  // claude approved-tools

  const allowedTools = program
    .command('approved-tools')
    .description('Manage approved tools')

  allowedTools
    .command('list')
    .description('List all approved tools')
    .action(async () => {
      const result = handleListApprovedTools(getCwd())
      console.log(result)
      process.exit(0)
    })

  allowedTools
    .command('remove <tool>')
    .description('Remove a tool from the list of approved tools')
    .action(async (tool: string) => {
      const result = handleRemoveApprovedTool(tool)
      console.log(result.message)
      process.exit(result.success ? 0 : 1)
    })

  // claude mcp

  const mcp = program
    .command('mcp')
    .description('Configure and manage MCP servers')

  mcp
    .command('serve')
    .description(`Start the ${PRODUCT_NAME} MCP server`)
    .action(async () => {
      const providedCwd = (program.opts() as { cwd?: string }).cwd ?? cwd()

      // Verify the directory exists
      if (!existsSync(providedCwd)) {
        console.error(`Error: Directory ${providedCwd} does not exist`)
        process.exit(1)
      }

      try {
        await setup(providedCwd, false)
        await startMCPServer(providedCwd)
      } catch (error) {
        console.error('Error: Failed to start MCP server:', error)
        process.exit(1)
      }
    })

  mcp
    .command('add-sse <name> <url>')
    .description('Add an SSE server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project or global)',
      'global',
    )
    .action(async (name, url, options) => {
      try {
        const scope = ensureConfigScope(options.scope)

        addMcpServer(name, { type: 'sse', url }, scope)
        console.log(
          `Added SSE MCP server ${name} with URL ${url} to ${scope} config`,
        )
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  mcp
    .command('add [name] [commandOrUrl] [args...]')
    .description('Add a server (run without arguments for interactive wizard)')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project or global)',
      'global',
    )
    .option(
      '-e, --env <env...>',
      'Set environment variables (e.g. -e KEY=value)',
    )
    .action(async (name, commandOrUrl, args, options) => {
      try {
        // If name is not provided, start interactive wizard
        if (!name) {
          console.log('Interactive wizard mode: Enter the server details')
          const { createInterface } = await import('readline')
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          })

          const question = (query: string) =>
            new Promise<string>(resolve => rl.question(query, resolve))

          // Get server name
          const serverName = await question('Server name: ')
          if (!serverName) {
            console.error('Error: Server name is required')
            rl.close()
            process.exit(1)
          }

          // Get server type
          const serverType = await question(
            'Server type (stdio or sse) [stdio]: ',
          )
          const type =
            serverType && ['stdio', 'sse'].includes(serverType)
              ? serverType
              : 'stdio'

          // Get command or URL
          const prompt = type === 'stdio' ? 'Command: ' : 'URL: '
          const commandOrUrlValue = await question(prompt)
          if (!commandOrUrlValue) {
            console.error(
              `Error: ${type === 'stdio' ? 'Command' : 'URL'} is required`,
            )
            rl.close()
            process.exit(1)
          }

          // Get args and env if stdio
          let serverArgs: string[] = []
          let serverEnv: Record<string, string> = {}

          if (type === 'stdio') {
            const argsStr = await question(
              'Command arguments (space-separated): ',
            )
            serverArgs = argsStr ? argsStr.split(' ').filter(Boolean) : []

            const envStr = await question(
              'Environment variables (format: KEY1=value1,KEY2=value2): ',
            )
            if (envStr) {
              const envPairs = envStr.split(',').map(pair => pair.trim())
              serverEnv = parseEnvVars(envPairs.map(pair => pair))
            }
          }

          // Get scope
          const scopeStr = await question(
            'Configuration scope (project or global) [global]: ',
          )
          const serverScope = ensureConfigScope(scopeStr || 'global')

          rl.close()

          // Add the server
          if (type === 'sse') {
            
            addMcpServer(
              serverName,
              { type: 'sse', url: commandOrUrlValue },
              serverScope,
            )
            console.log(
              `Added SSE MCP server ${serverName} with URL ${commandOrUrlValue} to ${serverScope} config`,
            )
          } else {
            
            addMcpServer(
              serverName,
              {
                type: 'stdio',
                command: commandOrUrlValue,
                args: serverArgs,
                env: serverEnv,
              },
              serverScope,
            )

            console.log(
              `Added stdio MCP server ${serverName} with command: ${commandOrUrlValue} ${serverArgs.join(' ')} to ${serverScope} config`,
            )
          }
        } else if (name && commandOrUrl) {
          // Regular non-interactive flow
          const scope = ensureConfigScope(options.scope)

          // Check if it's an SSE URL (starts with http:// or https://)
          if (commandOrUrl.match(/^https?:\/\//)) {
            
            addMcpServer(name, { type: 'sse', url: commandOrUrl }, scope)
            console.log(
              `Added SSE MCP server ${name} with URL ${commandOrUrl} to ${scope} config`,
            )
          } else {
            
            const env = parseEnvVars(options.env)
            addMcpServer(
              name,
              { type: 'stdio', command: commandOrUrl, args: args || [], env },
              scope,
            )

            console.log(
              `Added stdio MCP server ${name} with command: ${commandOrUrl} ${(args || []).join(' ')} to ${scope} config`,
            )
          }
        } else {
          console.error(
            'Error: Missing required arguments. Either provide no arguments for interactive mode or specify name and command/URL.',
          )
          process.exit(1)
        }

        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })
  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project, global, or mcprc)',
      'global',
    )
    .action(async (name: string, options: { scope?: string }) => {
      try {
        const scope = ensureConfigScope(options.scope)
        

        removeMcpServer(name, scope)
        console.log(`Removed MCP server ${name} from ${scope} config`)
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  mcp
    .command('list')
    .description('List configured MCP servers')
    .action(() => {
      const servers = listMCPServers()
      if (Object.keys(servers).length === 0) {
        console.log(
          `No MCP servers configured. Use \`${PRODUCT_COMMAND} mcp add\` to add a server.`,
        )
      } else {
        for (const [name, server] of Object.entries(servers)) {
          if (server.type === 'sse') {
            console.log(`${name}: ${server.url} (SSE)`)
          } else {
            console.log(`${name}: ${server.command} ${server.args.join(' ')}`)
          }
        }
      }
      process.exit(0)
    })

  mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server (stdio or SSE) with a JSON string')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project or global)',
      'global',
    )
    .action(async (name, jsonStr, options) => {
      try {
        const scope = ensureConfigScope(options.scope)

        // Parse JSON string
        let serverConfig
        try {
          serverConfig = JSON.parse(jsonStr)
        } catch (e) {
          console.error('Error: Invalid JSON string')
          process.exit(1)
        }

        // Validate the server config
        if (
          !serverConfig.type ||
          !['stdio', 'sse'].includes(serverConfig.type)
        ) {
          console.error('Error: Server type must be "stdio" or "sse"')
          process.exit(1)
        }

        if (serverConfig.type === 'sse' && !serverConfig.url) {
          console.error('Error: SSE server must have a URL')
          process.exit(1)
        }

        if (serverConfig.type === 'stdio' && !serverConfig.command) {
          console.error('Error: stdio server must have a command')
          process.exit(1)
        }

        // Add server with the provided config
        
        addMcpServer(name, serverConfig, scope)

        if (serverConfig.type === 'sse') {
          console.log(
            `Added SSE MCP server ${name} with URL ${serverConfig.url} to ${scope} config`,
          )
        } else {
          console.log(
            `Added stdio MCP server ${name} with command: ${serverConfig.command} ${(
              serverConfig.args || []
            ).join(' ')} to ${scope} config`,
          )
        }

        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  mcp
    .command('get <name>')
    .description('Get details about an MCP server')
    .action((name: string) => {
      
      const server = getMcpServer(name)
      if (!server) {
        console.error(`No MCP server found with name: ${name}`)
        process.exit(1)
      }
      console.log(`${name}:`)
      console.log(`  Scope: ${server.scope}`)
      if (server.type === 'sse') {
        console.log(`  Type: sse`)
        console.log(`  URL: ${server.url}`)
      } else {
        console.log(`  Type: stdio`)
        console.log(`  Command: ${server.command}`)
        console.log(`  Args: ${server.args.join(' ')}`)
        if (server.env) {
          console.log('  Environment:')
          for (const [key, value] of Object.entries(server.env)) {
            console.log(`    ${key}=${value}`)
          }
        }
      }
      process.exit(0)
    })

  // Import servers from Claude Desktop
  mcp
    .command('add-from-claude-desktop')
    .description(
      'Import MCP servers from Claude Desktop (Mac, Windows and WSL)',
    )
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project or global)',
      'global',
    )
    .action(async options => {
      try {
        const scope = ensureConfigScope(options.scope)
        const platform = process.platform

        // Import fs and path modules
        const { existsSync, readFileSync } = await import('fs')
        const { join } = await import('path')
        const { exec } = await import('child_process')

        // Determine if running in WSL
        const isWSL =
          platform === 'linux' &&
          existsSync('/proc/version') &&
          readFileSync('/proc/version', 'utf-8')
            .toLowerCase()
            .includes('microsoft')

        if (platform !== 'darwin' && platform !== 'win32' && !isWSL) {
          console.error(
            'Error: This command is only supported on macOS, Windows, and WSL',
          )
          process.exit(1)
        }

        // Get Claude Desktop config path
        let configPath
        if (platform === 'darwin') {
          configPath = join(
            process.env.HOME || '~',
            'Library/Application Support/Claude/claude_desktop_config.json',
          )
        } else if (platform === 'win32') {
          configPath = join(
            process.env.APPDATA || '',
            'Claude/claude_desktop_config.json',
          )
        } else if (isWSL) {
          // Get Windows username
          const whoamiCommand = await new Promise<string>((resolve, reject) => {
            exec(
              'powershell.exe -Command "whoami"',
              (err: Error, stdout: string) => {
                if (err) reject(err)
                else resolve(stdout.trim().split('\\').pop() || '')
              },
            )
          })

          configPath = `/mnt/c/Users/${whoamiCommand}/AppData/Roaming/Claude/claude_desktop_config.json`
        }

        // Check if config file exists
        if (!existsSync(configPath)) {
          console.error(
            `Error: Claude Desktop config file not found at ${configPath}`,
          )
          process.exit(1)
        }

        // Read config file
        let config
        try {
          const configContent = readFileSync(configPath, 'utf-8')
          config = JSON.parse(configContent)
        } catch (err) {
          console.error(`Error reading config file: ${err}`)
          process.exit(1)
        }

        // Extract MCP servers
        const mcpServers = config.mcpServers || {}
        const serverNames = Object.keys(mcpServers)
        const numServers = serverNames.length

        if (numServers === 0) {
          console.log('No MCP servers found in Claude Desktop config')
          process.exit(0)
        }

        // Create server information for display
        const serversInfo = serverNames.map(name => {
          const server = mcpServers[name]
          let description = ''

          if (server.type === 'sse') {
            description = `SSE: ${server.url}`
          } else {
            description = `stdio: ${server.command} ${(server.args || []).join(' ')}`
          }

          return { name, description, server }
        })

        // First import all required modules outside the component
        // Import modules separately to avoid any issues
        const ink = await import('ink')
        const reactModule = await import('react')
        const inkjsui = await import('@inkjs/ui')
        const utilsTheme = await import('@utils/theme')

        const { render } = ink
        const React = reactModule // React is already the default export when imported this way
        const { MultiSelect } = inkjsui
        const { Box, Text } = ink
        const { getTheme } = utilsTheme

        // Use Ink to render a nice UI for selection
        await new Promise<void>(resolve => {
          // Create a component for the server selection
          function ClaudeDesktopImport() {
            const { useState } = reactModule
            const [isFinished, setIsFinished] = useState(false)
            const [importResults, setImportResults] = useState([] as { name: string; success: boolean }[])
            const [isImporting, setIsImporting] = useState(false)
            const theme = getTheme()

            // Function to import selected servers
            const importServers = async (selectedServers: string[]) => {
              setIsImporting(true)
              const results = []

              for (const name of selectedServers) {
                try {
                  const server = mcpServers[name]

                  // Check if server already exists
                  const existingServer = getMcpServer(name)
                  if (existingServer) {
                    // Skip duplicates - we'll handle them in the confirmation step
                    continue
                  }

                  addMcpServer(name, server as McpServerConfig, scope)
                  results.push({ name, success: true })
                } catch (err) {
                  results.push({ name, success: false })
                }
              }

              setImportResults(results)
              setIsImporting(false)
              setIsFinished(true)

              // Give time to show results
              setTimeout(() => {
                resolve()
              }, 1000)
            }

            // Handle confirmation of selections
            const handleConfirm = async (selectedServers: string[]) => {
              // Check for existing servers and confirm overwrite
              const existingServers = selectedServers.filter(name =>
                getMcpServer(name),
              )

              if (existingServers.length > 0) {
                // We'll just handle it directly since we have a simple UI
                const results = []

                // Process non-existing servers first
                const newServers = selectedServers.filter(
                  name => !getMcpServer(name),
                )
                for (const name of newServers) {
                  try {
                    const server = mcpServers[name]
                    addMcpServer(name, server as McpServerConfig, scope)
                    results.push({ name, success: true })
                  } catch (err) {
                    results.push({ name, success: false })
                  }
                }

                // Now handle existing servers by prompting for each one
                for (const name of existingServers) {
                  try {
                    const server = mcpServers[name]
                    // Overwrite existing server - in a real interactive UI you'd prompt here
                    addMcpServer(name, server as McpServerConfig, scope)
                    results.push({ name, success: true })
                  } catch (err) {
                    results.push({ name, success: false })
                  }
                }

                setImportResults(results)
                setIsImporting(false)
                setIsFinished(true)

                // Give time to show results before resolving
                setTimeout(() => {
                  resolve()
                }, 1000)
              } else {
                // No existing servers, proceed with import
                await importServers(selectedServers)
              }
            }

            return (
              <Box flexDirection="column" padding={1}>
                <Box
                  flexDirection="column"
                  borderStyle="round"
                borderColor={theme.yuuka}
                  padding={1}
                  width={'100%'}
                >
                  <Text bold color={theme.yuuka}>
                    Import MCP Servers from Claude Desktop
                  </Text>

                  <Box marginY={1}>
                    <Text>
                      Found {numServers} MCP servers in Claude Desktop.
                    </Text>
                  </Box>

                  <Text>Please select the servers you want to import:</Text>

                  <Box marginTop={1}>
                    <MultiSelect
                      options={serverNames.map(name => ({
                        label: name,
                        value: name,
                      }))}
                      defaultValue={serverNames}
                      onSubmit={handleConfirm}
                    />
                  </Box>
                </Box>

                <Box marginTop={0} marginLeft={3}>
                  <Text dimColor>
                    Space to select · Enter to confirm · Esc to cancel
                  </Text>
                </Box>

                {isFinished && (
                  <Box marginTop={1}>
                    <Text color={theme.success}>
                      Successfully imported{' '}
                      {importResults.filter(r => r.success).length} MCP server
                      to local config.
                    </Text>
                  </Box>
                )}
              </Box>
            )
          }

          // Render the component
          const { unmount } = render(<ClaudeDesktopImport />)

          // Clean up when done
          setTimeout(() => {
            unmount()
            resolve()
          }, 30000) // Timeout after 30 seconds as a fallback
        })

        process.exit(0)
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  // Function to reset MCP server choices
  const resetMcpChoices = () => {
    const config = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...config,
      approvedMcprcServers: [],
      rejectedMcprcServers: [],
    })
    console.log('All .mcprc server approvals and rejections have been reset.')
    console.log(
      `You will be prompted for approval next time you start ${PRODUCT_NAME}.`,
    )
    process.exit(0)
  }

  mcp
    .command('reset-project-choices')
    .description(
      'Reset all approved and rejected project-scoped (.mcp.json) servers within this project',
    )
    .action(() => {
      
      resetMcpChoices()
    })

  // Keep old command for backward compatibility (visible only to ants)
  if (process.env.USER_TYPE === 'ant') {
    mcp
      .command('reset-mcprc-choices')
      .description(
        'Reset all approved and rejected .mcprc servers for this project',
      )
      .action(() => {
        
        resetMcpChoices()
      })
  }

  // Doctor command - simple installation health check (no auto-update)
  program
    .command('doctor')
    .description(`Check the health of your ${PRODUCT_NAME} installation`)
    .action(async () => {
      

      await new Promise<void>(resolve => {
        ;(async () => {
          const { render } = await import('ink')
          render(<Doctor onDone={() => resolve()} doctorMode={true} />)
        })()
      })
      process.exit(0)
    })

  // ant-only commands

  // claude update
  program
    .command('update')
    .description('Show manual upgrade commands (no auto-install)')
    .action(async () => {
      
      console.log(`Current version: ${MACRO.VERSION}`)
      console.log('Checking for updates...')

      const latestVersion = await getLatestVersion()

      if (!latestVersion) {
        console.error('Failed to check for updates')
        process.exit(1)
      }

      if (latestVersion === MACRO.VERSION) {
        console.log(`${PRODUCT_NAME} is up to date`)
        process.exit(0)
      }

      console.log(`New version available: ${latestVersion}`)
      const { getUpdateCommandSuggestions } = await import('@utils/autoUpdater')
      const cmds = await getUpdateCommandSuggestions()
      console.log('\nRun one of the following commands to update:')
      for (const c of cmds) console.log(`  ${c}`)
      if (process.platform !== 'win32') {
        console.log('\nNote: you may need to prefix with "sudo" on macOS/Linux.')
      }
      process.exit(0)
    })

  // claude log
  program
    .command('log')
    .description('Manage conversation logs.')
    .argument(
      '[number]',
      'A number (0, 1, 2, etc.) to display a specific log',
      parseInt,
    )
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .action(async (number, { cwd }) => {
      await setup(cwd, false)
      
      const context: { unmount?: () => void } = {}
      ;(async () => {
        const { render } = await import('ink')
        const { unmount } = render(
          <LogList context={context} type="messages" logNumber={number} />,
          renderContextWithExitOnCtrlC,
        )
        context.unmount = unmount
      })()
    })

  // claude resume
  program
    .command('resume')
    .description(
      'Resume a previous conversation. Optionally provide a number (0, 1, 2, etc.) or file path to resume a specific conversation.',
    )
    .argument(
      '[identifier]',
      'A number (0, 1, 2, etc.) or file path to resume a specific conversation',
    )
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .option('-v, --verbose', 'Do not truncate message output', () => true)
    .option(
      '--safe',
      'Enable strict permission checking mode (default is permissive in interactive mode)',
      () => true,
    )
    .action(async (identifier, { cwd, safe, verbose }) => {
      await setup(cwd, safe)
      assertMinVersion()

      const [tools, commands, logs] = await Promise.all([
        getTools(),
        getCommands(),
        loadLogList(CACHE_PATHS.messages()),
      ])

      // If a specific conversation is requested, load and resume it directly
      if (identifier !== undefined) {
        // Check if identifier is a number or a file path
        const number = Math.abs(parseInt(identifier))
        const isNumber = !isNaN(number)
        let messages, date, forkNumber
        try {
          if (isNumber) {
            
            const log = logs[number]
            if (!log) {
              console.error('No conversation found at index', number)
              process.exit(1)
            }
            messages = await loadMessagesFromLog(log.fullPath, tools)
            ;({ date, forkNumber } = log)
          } else {
            // Handle file path case
            
            if (!existsSync(identifier)) {
              console.error('File does not exist:', identifier)
              process.exit(1)
            }
            messages = await loadMessagesFromLog(identifier, tools)
            const pathSegments = identifier.split('/')
            const filename = pathSegments[pathSegments.length - 1] ?? 'unknown'
            ;({ date, forkNumber } = parseLogFilename(filename))
          }
          const fork = getNextAvailableLogForkNumber(date, forkNumber ?? 1, 0)
          {
            const { render } = await import('ink')
            const { REPL } = await import('@screens/REPL')
            render(
              <REPL
              initialPrompt=""
              messageLogName={date}
              initialForkNumber={fork}
              shouldShowPromptInput={true}
              verbose={verbose}
              commands={commands}
              tools={tools}
              safeMode={safe}
              initialMessages={messages}
            />,
            { exitOnCtrlC: false },
            )
          }
        } catch (error) {
          logError(`Failed to load conversation: ${error}`)
          process.exit(1)
        }
      } else {
        // Show the conversation selector UI
        const context: { unmount?: () => void } = {}
        ;(async () => {
          const { render } = await import('ink')
          const { unmount } = render(
            <ResumeConversation
              context={context}
              commands={commands}
              logs={logs}
              tools={tools}
              verbose={verbose}
            />,
            renderContextWithExitOnCtrlC,
          )
          context.unmount = unmount
        })()
      }
    })

  // claude error
  program
    .command('error')
    .description(
      'View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.',
    )
    .argument(
      '[number]',
      'A number (0, 1, 2, etc.) to display a specific log',
      parseInt,
    )
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .action(async (number, { cwd }) => {
      await setup(cwd, false)
      
      const context: { unmount?: () => void } = {}
      ;(async () => {
        const { render } = await import('ink')
        const { unmount } = render(
          <LogList context={context} type="errors" logNumber={number} />,
          renderContextWithExitOnCtrlC,
        )
        context.unmount = unmount
      })()
    })

  // legacy context (TODO: deprecate)
  const context = program
    .command('context')
    .description(
      `Set static context (eg. ${PRODUCT_COMMAND} context add-file ./src/*.py)`,
    )

  context
    .command('get <key>')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .description('Get a value from context')
    .action(async (key, { cwd }) => {
      await setup(cwd, false)
      
      const context = omit(
        await getContext(),
        'codeStyle',
        'directoryStructure',
      )
      console.log(context[key])
      process.exit(0)
    })

  context
    .command('set <key> <value>')
    .description('Set a value in context')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .action(async (key, value, { cwd }) => {
      await setup(cwd, false)
      
      setContext(key, value)
      console.log(`Set context.${key} to "${value}"`)
      process.exit(0)
    })

  context
    .command('list')
    .description('List all context values')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .action(async ({ cwd }) => {
      await setup(cwd, false)
      
      const context = omit(
        await getContext(),
        'codeStyle',
        'directoryStructure',
        'gitStatus',
      )
      console.log(JSON.stringify(context, null, 2))
      process.exit(0)
    })

  context
    .command('remove <key>')
    .description('Remove a value from context')
    .option('-c, --cwd <cwd>', 'The current working directory', String, cwd())
    .action(async (key, { cwd }) => {
      await setup(cwd, false)
      
      removeContext(key)
      console.log(`Removed context.${key}`)
      process.exit(0)
    })

  await program.parseAsync(process.argv)
  return program
}

// TODO: stream?
async function stdin() {
  if (process.stdin.isTTY) {
    return ''
  }

  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

process.on('exit', () => {
  resetCursor()
  PersistentShell.getInstance().close()
})

function gracefulExit(code = 0) {
  try { resetCursor() } catch {}
  try { PersistentShell.getInstance().close() } catch {}
  process.exit(code)
}

process.on('SIGINT', () => gracefulExit(0))
process.on('SIGTERM', () => gracefulExit(0))
// Windows CTRL+BREAK
process.on('SIGBREAK', () => gracefulExit(0))
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err)
  gracefulExit(1)
})

function resetCursor() {
  const terminal = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : undefined
  terminal?.write(`\u001B[?25h${cursorShow}`)
}

main()
