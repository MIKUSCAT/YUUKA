import 'dotenv/config'

import { resolve } from 'node:path'
import { cwd as processCwd } from 'process'
import { setCwd, setOriginalCwd } from '@utils/state'
import { grantReadPermissionForOriginalDir } from '@utils/permissions/filesystem'
import { getGlobalConfig } from '@utils/config'
import { logError } from '@utils/log'

type TeammateCliArgs = {
  cwd: string
  safe: boolean
  teammateTaskFile?: string
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

async function applyGlobalProxyFromConfigForTeammate(): Promise<void> {
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

    if (!process.env['HTTP_PROXY']) process.env['HTTP_PROXY'] = proxy
    if (!process.env['HTTPS_PROXY']) process.env['HTTPS_PROXY'] = proxy

    const existingNoProxy =
      String(process.env['NO_PROXY'] || process.env['no_proxy'] || '').trim()
    const noProxy = mergeNoProxy(existingNoProxy, ['127.0.0.1', 'localhost', '::1'])
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
    logError(error)
  }
}

function hasArgName(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`)
}

function getArgValue(argv: string[], index: number): string | undefined {
  const current = argv[index]
  if (!current) return undefined
  const eqIndex = current.indexOf('=')
  if (eqIndex >= 0) {
    return current.slice(eqIndex + 1)
  }
  return argv[index + 1]
}

function parseArgs(argv: string[]): TeammateCliArgs {
  let parsedCwd = processCwd()
  let safe = false
  let teammateTaskFile: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--safe') {
      safe = true
      continue
    }
    if (arg === '--teammate') {
      continue
    }
    if (hasArgName(arg, '--cwd')) {
      const value = getArgValue(argv, i)
      if (typeof value === 'string' && value.length > 0) {
        parsedCwd = value
      }
      if (arg === '--cwd') i++
      continue
    }
    if (hasArgName(arg, '--teammate-task-file')) {
      const value = getArgValue(argv, i)
      if (typeof value === 'string' && value.length > 0) {
        teammateTaskFile = value
      }
      if (arg === '--teammate-task-file') i++
      continue
    }
  }

  return {
    cwd: parsedCwd,
    safe,
    teammateTaskFile,
  }
}

async function setupTeammateRuntime(cwd: string, safeMode: boolean): Promise<void> {
  if (cwd !== process.cwd()) {
    setOriginalCwd(cwd)
  }
  await setCwd(cwd)
  grantReadPermissionForOriginalDir()
  await applyGlobalProxyFromConfigForTeammate()

  if (safeMode) {
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0
    ) {
      throw new Error('--safe mode cannot be used with root/sudo privileges')
    }
  }
}

async function main() {
  process.on('unhandledRejection', reason => {
    if (reason instanceof DOMException && reason.name === 'AbortError') return
    if ((reason as any)?.name === 'AbortError') return
    if ((reason as any)?.message?.includes?.('aborted')) return
    console.error('Unhandled Rejection:', reason)
  })

  const args = parseArgs(process.argv.slice(2))
  if (!args.teammateTaskFile) {
    console.error('Missing required --teammate-task-file for teammate mode')
    process.exit(1)
  }

  await setupTeammateRuntime(args.cwd, args.safe)
  const { runTeammateTask } = await import('./teammate')
  const exitCode = await runTeammateTask(resolve(args.teammateTaskFile))
  process.exit(exitCode)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
