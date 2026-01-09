import {
  getCurrentProjectConfig,
  McpServerConfig,
  saveCurrentProjectConfig,
  getGlobalConfig,
  saveGlobalConfig,
  getMcprcConfig,
  addMcprcServerForTesting,
  removeMcprcServerForTesting,
} from '@utils/config'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from '@utils/state'
import { safeParseJSON } from '@utils/json'
import { spawnSync } from 'child_process'
import {
  ImageBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  CallToolResultSchema,
  ClientRequest,
  ListToolsResult,
  ListToolsResultSchema,
  Result,
  ResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { memoize, pickBy } from 'lodash-es'
import type { Tool } from '@tool'
import { MCPTool } from '@tools/MCPTool/MCPTool'
import { logMCPError } from '@utils/log'
import { PRODUCT_COMMAND } from '@constants/product'

type McpName = string

const BASE64_MIN_LENGTH = 1000

export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

const VALID_SCOPES = ['project', 'global', 'mcprc'] as const
type ConfigScope = (typeof VALID_SCOPES)[number]
const EXTERNAL_SCOPES = ['project', 'global'] as ConfigScope[]

export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'project'

  const scopesToCheck =
    process.env.USER_TYPE === 'external' ? EXTERNAL_SCOPES : VALID_SCOPES

  if (!scopesToCheck.includes(scope as ConfigScope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${scopesToCheck.join(', ')}`,
    )
  }

  return scope as ConfigScope
}

export function addMcpServer(
  name: McpName,
  server: McpServerConfig,
  scope: ConfigScope = 'project',
): void {
  if (scope === 'mcprc') {
    if (process.env.NODE_ENV === 'test') {
      addMcprcServerForTesting(name, server)
    } else {
      const mcprcPath = join(getCwd(), '.mcprc')
      let mcprcConfig: Record<string, McpServerConfig> = {}

      // Read existing config if present
      if (existsSync(mcprcPath)) {
        try {
          const mcprcContent = readFileSync(mcprcPath, 'utf-8')
          const existingConfig = safeParseJSON(mcprcContent)
          if (existingConfig && typeof existingConfig === 'object') {
            mcprcConfig = existingConfig as Record<string, McpServerConfig>
          }
        } catch {
          // If we can't read/parse, start with empty config
        }
      }

      // Add the server
      mcprcConfig[name] = server

      // Write back to .mcprc
      try {
        writeFileSync(mcprcPath, JSON.stringify(mcprcConfig, null, 2), 'utf-8')
      } catch (error) {
        throw new Error(`Failed to write to .mcprc: ${error}`)
      }
    }
  } else if (scope === 'global') {
    const config = getGlobalConfig()
    if (!config.mcpServers) {
      config.mcpServers = {}
    }
    config.mcpServers[name] = server
    saveGlobalConfig(config)
  } else {
    const config = getCurrentProjectConfig()
    if (!config.mcpServers) {
      config.mcpServers = {}
    }
    config.mcpServers[name] = server
    saveCurrentProjectConfig(config)
  }
}

export function removeMcpServer(
  name: McpName,
  scope: ConfigScope = 'project',
): void {
  if (scope === 'mcprc') {
    if (process.env.NODE_ENV === 'test') {
      removeMcprcServerForTesting(name)
    } else {
      const mcprcPath = join(getCwd(), '.mcprc')
      if (!existsSync(mcprcPath)) {
        throw new Error('No .mcprc file found in this directory')
      }

      try {
        const mcprcContent = readFileSync(mcprcPath, 'utf-8')
        const mcprcConfig = safeParseJSON(mcprcContent) as Record<
          string,
          McpServerConfig
        > | null

        if (
          !mcprcConfig ||
          typeof mcprcConfig !== 'object' ||
          !mcprcConfig[name]
        ) {
          throw new Error(`No MCP server found with name: ${name} in .mcprc`)
        }

        delete mcprcConfig[name]
        writeFileSync(mcprcPath, JSON.stringify(mcprcConfig, null, 2), 'utf-8')
      } catch (error) {
        if (error instanceof Error) {
          throw error
        }
        throw new Error(`Failed to remove from .mcprc: ${error}`)
      }
    }
  } else if (scope === 'global') {
    const config = getGlobalConfig()
    if (!config.mcpServers?.[name]) {
      throw new Error(`No global MCP server found with name: ${name}`)
    }
    delete config.mcpServers[name]
    saveGlobalConfig(config)
  } else {
    const config = getCurrentProjectConfig()
    if (!config.mcpServers?.[name]) {
      throw new Error(`No local MCP server found with name: ${name}`)
    }
    delete config.mcpServers[name]
    saveCurrentProjectConfig(config)
  }
}

export function listMCPServers(): Record<string, McpServerConfig> {
  const globalConfig = getGlobalConfig()
  const mcprcConfig = getMcprcConfig()
  const projectConfig = getCurrentProjectConfig()
  return {
    ...(globalConfig.mcpServers ?? {}),
    ...(mcprcConfig ?? {}), // mcprc configs override global ones
    ...(projectConfig.mcpServers ?? {}), // Project configs override mcprc ones
  }
}

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
}

export function getMcpServer(name: McpName): ScopedMcpServerConfig | undefined {
  const projectConfig = getCurrentProjectConfig()
  const mcprcConfig = getMcprcConfig()
  const globalConfig = getGlobalConfig()

  // Check each scope in order of precedence
  if (projectConfig.mcpServers?.[name]) {
    return { ...projectConfig.mcpServers[name], scope: 'project' }
  }

  if (mcprcConfig?.[name]) {
    return { ...mcprcConfig[name], scope: 'mcprc' }
  }

  if (globalConfig.mcpServers?.[name]) {
    return { ...globalConfig.mcpServers[name], scope: 'global' }
  }

  return undefined
}

async function connectToServer(
  name: string,
  serverRef: McpServerConfig,
): Promise<Client> {
  const transport =
    serverRef.type === 'sse'
      ? new SSEClientTransport(new URL(serverRef.url))
      : new StdioClientTransport({
          command: serverRef.command,
          args: serverRef.args,
          env: {
            ...process.env,
            ...serverRef.env,
          } as Record<string, string>,
          stderr: 'pipe', // prevents error output from the MCP server from printing to the UI
        })

  const client = new Client(
    {
      name: PRODUCT_COMMAND,
      version: '0.1.0',
    },
    {
      capabilities: {},
    },
  )

  const refWithTimeouts = serverRef as McpServerConfig & {
    connectTimeoutMs?: number
    connectTimeout?: number
    connectionTimeoutMs?: number
  }

  // Add a timeout to connection attempts to prevent tests from hanging indefinitely
  const DEFAULT_CONNECTION_TIMEOUT_MS =
    process.env.NODE_ENV === 'test' || process.env.CI ? 5000 : 15_000
  const CONNECTION_TIMEOUT_MS =
    typeof refWithTimeouts.connectTimeoutMs === 'number'
      ? refWithTimeouts.connectTimeoutMs
      : typeof refWithTimeouts.connectionTimeoutMs === 'number'
        ? refWithTimeouts.connectionTimeoutMs
        : typeof refWithTimeouts.connectTimeout === 'number'
          ? refWithTimeouts.connectTimeout
          : name === 'windows_mcp'
            ? 30_000
            : DEFAULT_CONNECTION_TIMEOUT_MS

  const connectPromise = client.connect(transport)
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Connection to MCP server "${name}" timed out after ${CONNECTION_TIMEOUT_MS}ms`,
        ),
      )
    }, CONNECTION_TIMEOUT_MS)

    // Clean up timeout if connect resolves or rejects
    connectPromise.then(
      () => clearTimeout(timeoutId),
      () => clearTimeout(timeoutId),
    )
  })

  await Promise.race([connectPromise, timeoutPromise])

  if (serverRef.type === 'stdio') {
    ;(transport as StdioClientTransport).stderr?.on('data', (data: Buffer) => {
      const errorText = data.toString().trim()
      if (errorText) {
        logMCPError(name, `Server stderr: ${errorText}`)
      }
    })
  }
  return client
}

type ConnectedClient = {
  client: Client
  name: string
  type: 'connected'
}
type FailedClient = {
  name: string
  type: 'failed'
}
export type WrappedClient = ConnectedClient | FailedClient

export function getMcprcServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const config = getCurrentProjectConfig()
  if (config.approvedMcprcServers?.includes(serverName)) {
    return 'approved'
  }
  if (config.rejectedMcprcServers?.includes(serverName)) {
    return 'rejected'
  }
  return 'pending'
}

export const getClients = memoize(async (): Promise<WrappedClient[]> => {
  // TODO: This is a temporary fix for a hang during npm run verify in CI.
  // We need to investigate why MCP client connections hang in CI verify but not in CI tests.
  if (process.env.CI && process.env.NODE_ENV !== 'test') {
    return []
  }

  const globalServers = getGlobalConfig().mcpServers ?? {}
  const mcprcServers = getMcprcConfig()
  const projectServers = getCurrentProjectConfig().mcpServers ?? {}

  // Filter mcprc servers to only include approved ones
  const approvedMcprcServers = pickBy(
    mcprcServers,
    (_, name) => getMcprcServerStatus(name) === 'approved',
  )

  const allServers = {
    ...globalServers,
    ...approvedMcprcServers, // Approved .mcprc servers override global ones
    ...projectServers, // Project servers take highest precedence
  }

  return await Promise.all(
    Object.entries(allServers).map(async ([name, serverRef]) => {
      try {
        const client = await connectToServer(name, serverRef as McpServerConfig)
        return { name, client, type: 'connected' as const }
      } catch (error) {
        logMCPError(
          name,
          `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return { name, type: 'failed' as const }
      }
    }),
  )
})

async function requestAll<
  ResultT extends Result,
  ResultSchemaT extends typeof ResultSchema,
>(
  req: ClientRequest,
  resultSchema: ResultSchemaT,
  requiredCapability: string,
): Promise<{ client: ConnectedClient; result: ResultT }[]> {
  const clients = await getClients()
  const results = await Promise.allSettled(
    clients.map(async client => {
      if (client.type === 'failed') return null

      try {
        const capabilities = await client.client.getServerCapabilities()
        if (!capabilities?.[requiredCapability]) {
          return null
        }
        return {
          client,
          result: (await client.client.request(req, resultSchema)) as ResultT,
        }
      } catch (error) {
        if (client.type === 'connected') {
          logMCPError(
            client.name,
            `Failed to request '${req.method}': ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return null
      }
    }),
  )
  return results
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        client: ConnectedClient
        result: ResultT
      } | null> => result.status === 'fulfilled',
    )
    .map(result => result.value)
    .filter(
      (result): result is { client: ConnectedClient; result: ResultT } =>
        result !== null,
    )
}

export const getMCPTools = memoize(async (): Promise<Tool[]> => {
  const toolsList = await requestAll<
    ListToolsResult,
    typeof ListToolsResultSchema
  >(
    {
      method: 'tools/list',
    },
    ListToolsResultSchema,
    'tools',
  )

  // TODO: Add zod schema validation
  return toolsList.flatMap(({ client, result: { tools } }) =>
    tools.map(
      (tool): Tool => ({
        ...MCPTool,
        name: 'mcp__' + client.name + '__' + tool.name,
        async description() {
          const base = tool.description ?? ''
          if (client.name !== 'windows_mcp') return base
          const guard =
            '⚠️ 仅用于 Windows 桌面/窗口层操作；涉及浏览器页面内部交互（点网页、滚动、填表、抓取网页内容等）请用 `mcp__chrome-devtools__*`，不要和 Windows MCP 混用。'
          return base ? `${guard}\n\n${base}` : guard
        },
        async prompt() {
          const base = tool.description ?? ''
          if (client.name !== 'windows_mcp') return base
          const guard =
            '⚠️ 仅用于 Windows 桌面/窗口层操作；涉及浏览器页面内部交互（点网页、滚动、填表、抓取网页内容等）请用 `mcp__chrome-devtools__*`，不要和 Windows MCP 混用。'
          return base ? `${guard}\n\n${base}` : guard
        },
        inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
        async validateInput(input, context) {
          // MCP tools handle their own validation through their schemas
          return { result: true }
        },
        async *call(args: Record<string, unknown>, context) {
          const data = await callMCPTool({
            serverName: client.name,
            tool: tool.name,
            args,
            abortSignal: context.abortController.signal,
          })
          yield {
            type: 'result' as const,
            data,
            resultForAssistant: data,
          }
        },
        userFacingName() {
          return `${client.name}:${tool.name} (MCP)`
        },
      }),
    ),
  )
})

function isMcpTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Request timed out') || message.includes('timed out')
}

function redactLargeBase64(text: string): string {
  // data:...;base64,... (most common)
  const dataUrlRegex = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]{200,})/g
  let sanitized = text.replace(dataUrlRegex, (_m, mimeType: string, data: string) => {
    if (data.length < BASE64_MIN_LENGTH) return _m
    return `data:${mimeType};base64,[omitted ${data.length} chars]`
  })

  // raw base64 blobs inside JSON
  const base64Regex = /[A-Za-z0-9+/]{1000,}={0,2}/g
  sanitized = sanitized.replace(base64Regex, (m: string) => {
    if (m.length < BASE64_MIN_LENGTH) return m
    return `[base64 omitted ${m.length} chars]`
  })
  return sanitized
}

function normalizeImageMimeType(
  format: unknown,
): ImageBlockParam.Source['media_type'] {
  const fmt = typeof format === 'string' ? format.trim().toLowerCase() : ''
  if (!fmt) return 'image/png'
  if (fmt.startsWith('image/')) return fmt as ImageBlockParam.Source['media_type']
  if (fmt === 'jpg' || fmt === 'jpeg') return 'image/jpeg'
  if (fmt === 'png') return 'image/png'
  if (fmt === 'webp') return 'image/webp'
  return 'image/png'
}

function extractImagesFromStructuredContent(
  structuredContent: unknown,
): Array<{ data: string; mimeType: ImageBlockParam.Source['media_type'] }> {
  if (!structuredContent || typeof structuredContent !== 'object') return []
  if (Array.isArray(structuredContent)) return []
  const obj = structuredContent as Record<string, unknown>

  const images: Array<{ data: string; mimeType: ImageBlockParam.Source['media_type'] }> =
    []

  const img = typeof obj.img === 'string' ? obj.img : null
  if (img && img.length >= BASE64_MIN_LENGTH) {
    images.push({
      data: img,
      mimeType: normalizeImageMimeType(obj.fmt),
    })
  }

  const diff = typeof obj.diff_image_data === 'string' ? obj.diff_image_data : null
  if (diff && diff.length >= BASE64_MIN_LENGTH) {
    images.push({
      data: diff,
      mimeType: 'image/png',
    })
  }

  return images
}

function extractImagesFromTextOutput(
  text: string,
): Array<{ data: string; mimeType: ImageBlockParam.Source['media_type'] }> {
  if (!text || text.length < BASE64_MIN_LENGTH) return []

  const images: Array<{ data: string; mimeType: ImageBlockParam.Source['media_type'] }> =
    []

  const fmtMatch = /"fmt"\s*:\s*"([^"]+)"/i.exec(text)
  const fmt = fmtMatch?.[1]

  const imgMatch = /"img"\s*:\s*"([A-Za-z0-9+/=]{1000,})"/.exec(text)
  if (imgMatch?.[1]) {
    images.push({
      data: imgMatch[1],
      mimeType: normalizeImageMimeType(fmt),
    })
  }

  const diffMatch = /"diff_image_data"\s*:\s*"([A-Za-z0-9+/=]{1000,})"/.exec(
    text,
  )
  if (diffMatch?.[1]) {
    images.push({
      data: diffMatch[1],
      mimeType: 'image/png',
    })
  }

  return images
}

async function resetServerConnection(serverName: string): Promise<void> {
  try {
    const clients = await getClients().catch(() => [])
    const connected = clients.find(
      c => c.type === 'connected' && c.name === serverName,
    )
    if (connected?.type === 'connected') {
      const transport: any = connected.client.transport
      const pid: number | null =
        transport && typeof transport.pid === 'number' ? transport.pid : null

      try {
        await connected.client.close()
      } catch {
        // ignore
      }

      // On Windows, terminating the parent process doesn't always kill children (e.g., uv -> python).
      if (
        process.platform === 'win32' &&
        pid &&
        Number.isFinite(pid) &&
        pid > 0
      ) {
        try {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
          })
        } catch {
          // ignore
        }
      }
    }
  } finally {
    // Force a reconnect next time (also refreshes tool list if it is reloaded elsewhere).
    getClients.cache?.clear?.()
    getMCPTools.cache?.clear?.()
  }
}

async function callMCPTool({
  serverName,
  tool,
  args,
  abortSignal,
}: {
  serverName: string
  tool: string
  args: Record<string, unknown>
  abortSignal?: AbortSignal
}): Promise<ToolResultBlockParam['content']> {
  let clients = await getClients()
  let connected = clients.find(
    c => c.type === 'connected' && c.name === serverName,
  )
  if (!connected) {
    // Retry once in case the previous connection attempt was cached as failed.
    getClients.cache?.clear?.()
    clients = await getClients()
    connected = clients.find(c => c.type === 'connected' && c.name === serverName)
  }

  if (!connected || connected.type !== 'connected') {
    throw new Error(`MCP server "${serverName}" is not connected`)
  }

  const client = connected.client

  const serverConfig = getMcpServer(serverName) as unknown as
    | (McpServerConfig & { timeout?: number; timeoutMs?: number })
    | undefined
  const configuredTimeoutMs =
    typeof serverConfig?.timeoutMs === 'number'
      ? serverConfig.timeoutMs
      : typeof serverConfig?.timeout === 'number'
        ? serverConfig.timeout
        : undefined
  const timeoutMs =
    typeof configuredTimeoutMs === 'number' &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : serverName === 'windows_mcp'
        ? 120_000
        : undefined

  let abortListener: (() => void) | undefined
  const abortPromise =
    abortSignal
      ? new Promise<never>((_, reject) => {
          if (abortSignal.aborted) {
            void resetServerConnection(serverName)
            reject(new Error('Tool call aborted'))
            return
          }
          abortListener = () => {
            void resetServerConnection(serverName)
            reject(new Error('Tool call aborted'))
          }
          abortSignal.addEventListener('abort', abortListener, { once: true })
        })
      : null

  let result: any
  try {
    const requestPromise = client.callTool(
      {
        name: tool,
        arguments: args,
      },
      CallToolResultSchema,
      timeoutMs ? { timeout: timeoutMs } : undefined,
    )
    result = await (abortPromise
      ? Promise.race([requestPromise, abortPromise])
      : requestPromise)
  } catch (error) {
    if (isMcpTimeoutError(error)) {
      void resetServerConnection(serverName)
    }
    throw error
  } finally {
    if (abortSignal && abortListener) {
      abortSignal.removeEventListener('abort', abortListener)
    }
  }

  const isError =
    'isError' in result && (result.isError === true || result.isError === 'true')

  if (isError) {
    const contentText =
      'content' in result && Array.isArray(result.content)
        ? result.content
            .map(item => {
              if (item?.type === 'text') return String(item.text ?? '')
              return ''
            })
            .filter(Boolean)
            .join('\n')
        : ''
    const errorMessage = `Error calling tool ${tool}: ${contentText || 'Unknown error'}`
    logMCPError(serverName, errorMessage)
    throw Error(errorMessage)
  }

  // Handle toolResult-type response
  if ('toolResult' in result) {
    return String(result.toolResult)
  }

  const structuredContent =
    'structuredContent' in result ? (result as any).structuredContent : undefined
  let extractedImages = extractImagesFromStructuredContent(structuredContent)

  // Handle content array response
  if ('content' in result && Array.isArray(result.content)) {
    if (extractedImages.length === 0) {
      const firstText = result.content.find(
        (item: any) => item?.type === 'text' && typeof item.text === 'string',
      )
      if (firstText?.text) {
        extractedImages = extractImagesFromTextOutput(String(firstText.text))
      }
    }

    const mapped = result.content.map(item => {
      if (item?.type === 'image') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            data: String((item as any).data),
            media_type: (item as any).mimeType as ImageBlockParam.Source['media_type'],
          },
        }
      }
      if (item?.type === 'text' && typeof (item as any).text === 'string') {
        return {
          ...item,
          text: redactLargeBase64(String((item as any).text)),
        }
      }
      return item
    })

    const alreadyHasImage = mapped.some(b => (b as any)?.type === 'image')
    if (!alreadyHasImage && extractedImages.length > 0) {
      return [
        ...mapped,
        ...extractedImages.map(img => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            data: img.data,
            media_type: img.mimeType,
          },
        })),
      ]
    }

    return mapped
  }

  // Fallback: some servers may only return structuredContent
  if (structuredContent !== undefined) {
    const text = redactLargeBase64(
      (() => {
        try {
          return JSON.stringify(structuredContent)
        } catch {
          return String(structuredContent)
        }
      })(),
    )

    const blocks: any[] = [{ type: 'text', text }]
    if (extractedImages.length > 0) {
      blocks.push(
        ...extractedImages.map(img => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            data: img.data,
            media_type: img.mimeType,
          },
        })),
      )
    }
    return blocks
  }

  throw Error(`Unexpected response format from tool ${tool}`)
}

// MCP prompts are intentionally not exposed as slash commands in YUUKA.
