import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { openBrowser } from '@utils/browser'
import {
  ensureGlobalGeminiSettings,
  readGeminiSettingsFile,
} from '@utils/geminiSettings'
import { fetch } from 'undici'

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

// 新版 OAuth 授权端点（旧的 /o/oauth2/auth 逐步不再被接受）
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const DEFAULT_GEMINI_CLI_VERSION = '1.1.0'
const USER_AGENT_MODEL_FALLBACK = 'unknown'

const CODE_ASSIST_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const

const EXPIRY_SKEW_MS = 60_000
const DEFAULT_OAUTH_CALLBACK_HOST = '127.0.0.1'
const FREE_TIER_ID = 'free-tier'
const LEGACY_TIER_ID = 'legacy-tier'
const ACTION_STATUS_NO_ERROR = 1
const ACTION_STATUS_ERROR_UNKNOWN = 2
const ACTION_STATUS_CANCELLED = 3
const ACTION_STATUS_EMPTY = 4
const INITIATION_METHOD_COMMAND = 2
const CONVERSATION_INTERACTION_UNKNOWN = 0

function normalizeUserAgentModel(model?: string): string {
  const trimmed = String(model ?? '').trim()
  if (!trimmed) return USER_AGENT_MODEL_FALLBACK
  if (trimmed.startsWith('models/')) return trimmed.slice('models/'.length)
  return trimmed
}

export function getGeminiCliUserAgent(model?: string): string {
  const version =
    String(
      process.env['YUUKA_VERSION'] ?? process.env['npm_package_version'] ?? DEFAULT_GEMINI_CLI_VERSION,
    ).trim() || DEFAULT_GEMINI_CLI_VERSION
  const normalizedModel = normalizeUserAgentModel(model)
  return `GeminiCLI/${version}/${normalizedModel} (${process.platform}; ${process.arch})`
}

export type GeminiCliOAuthCreds = {
  access_token?: string
  refresh_token?: string
  scope?: string
  token_type?: string
  expiry_date?: number
  id_token?: string

  // 额外缓存：不影响 gemini-cli 读取
  project_id?: string
  user_email?: string
}

class ValidationRequiredGeminiCliError extends Error {
  readonly validationUrl?: string

  constructor(message: string, validationUrl?: string) {
    super(message)
    this.name = 'ValidationRequiredGeminiCliError'
    this.validationUrl = validationUrl
  }
}

export function getGlobalGeminiOauthCredsPath(): string {
  return join(homedir(), '.yuuka', 'oauth_creds.json')
}

type OAuthClientConfig = {
  clientId: string
  clientSecret: string
}

function getOAuthClientConfig(): OAuthClientConfig {
  const { settingsPath } = ensureGlobalGeminiSettings()
  const settings = readGeminiSettingsFile(settingsPath)
  const clientId = settings.security?.auth?.geminiCliOAuth?.clientId?.trim() || ''
  const clientSecret =
    settings.security?.auth?.geminiCliOAuth?.clientSecret?.trim() || ''

  return { clientId, clientSecret }
}

function ensureOauthClientConfigured(): OAuthClientConfig {
  const config = getOAuthClientConfig()
  if (!config.clientId) {
    throw new Error(
      'OAuth 配置缺失：client_id 为空。请在 /auth 的 Google OAuth 页面填写 client_id。',
    )
  }
  if (!config.clientSecret) {
    throw new Error(
      'OAuth 配置缺失：client_secret 为空。请在 /auth 的 Google OAuth 页面填写 client_secret。',
    )
  }

  return config
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  try {
    await fs.chmod(filePath, 0o600)
  } catch {
    // Windows 上可能不生效，忽略
  }
}

export async function readGeminiCliOAuthCreds(): Promise<GeminiCliOAuthCreds | null> {
  return await readJsonFile<GeminiCliOAuthCreds>(getGlobalGeminiOauthCredsPath())
}

export async function writeGeminiCliOAuthCreds(creds: GeminiCliOAuthCreds): Promise<void> {
  await writeJsonFile(getGlobalGeminiOauthCredsPath(), creds)
}

export async function clearGeminiCliOAuthCreds(): Promise<void> {
  try {
    await fs.rm(getGlobalGeminiOauthCredsPath(), { force: true })
  } catch {
    // ignore
  }
}

export async function getAvailablePort(): Promise<number> {
  const portStr = process.env['OAUTH_CALLBACK_PORT']
  if (portStr) {
    const parsed = parseInt(portStr, 10)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`OAUTH_CALLBACK_PORT 不合法：${portStr}`)
    }
    return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('无法获取可用端口'))
        return
      }
      const { port } = addr
      server.close(err => {
        if (err) reject(err)
        else resolve(port)
      })
      server.unref()
    })
    server.on('error', reject)
  })
}

function normalizeCallbackHost(rawHost: string | undefined): string {
  if (!rawHost) return DEFAULT_OAUTH_CALLBACK_HOST

  let host = rawHost.trim()
  if (
    (host.startsWith('"') && host.endsWith('"')) ||
    (host.startsWith("'") && host.endsWith("'"))
  ) {
    host = host.slice(1, -1).trim()
  }

  if (!host) return DEFAULT_OAUTH_CALLBACK_HOST

  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.trim()
    } catch {
      return DEFAULT_OAUTH_CALLBACK_HOST
    }
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1).trim()
  }

  if (!host || /\s/.test(host) || host.includes('/')) {
    return DEFAULT_OAUTH_CALLBACK_HOST
  }

  // 若误写了 host:port，这里自动去掉端口（IPv6 除外）
  if (host.includes(':') && net.isIP(host) !== 6) {
    const index = host.lastIndexOf(':')
    const maybeHost = host.slice(0, index).trim()
    const maybePort = host.slice(index + 1).trim()
    if (maybeHost && /^\d+$/.test(maybePort)) {
      host = maybeHost
    }
  }

  if (!host) return DEFAULT_OAUTH_CALLBACK_HOST

  const isIp = net.isIP(host) !== 0
  const isLocalhost = host.toLowerCase() === 'localhost'
  const looksLikeHostname = /^[a-zA-Z0-9.-]+$/.test(host)
  if (isIp || isLocalhost || looksLikeHostname) {
    return host
  }

  return DEFAULT_OAUTH_CALLBACK_HOST
}

function buildAuthUrl(options: { redirectUri: string; state: string }): string {
  const oauthConfig = ensureOauthClientConfigured()
  const params = new URLSearchParams({
    client_id: oauthConfig.clientId,
    redirect_uri: options.redirectUri,
    scope: OAUTH_SCOPES.join(' '),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: options.state,
  })
  return `${OAUTH_AUTH_URL}?${params.toString()}`
}

async function readResponseText(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return await resp.text()
  } catch {
    return ''
  }
}

async function exchangeCodeForTokens(options: {
  code: string
  redirectUri: string
}): Promise<GeminiCliOAuthCreds> {
  const oauthConfig = ensureOauthClientConfigured()
  const form = new URLSearchParams({
    client_id: oauthConfig.clientId,
    client_secret: oauthConfig.clientSecret,
    redirect_uri: options.redirectUri,
    code: options.code,
    grant_type: 'authorization_code',
  })

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })

  if (!resp.ok) {
    const body = await readResponseText(resp)
    throw new Error(`OAuth 换 token 失败 (HTTP ${resp.status}): ${body.slice(0, 400)}`)
  }

  const data = (await resp.json()) as any
  const accessToken = typeof data?.access_token === 'string' ? data.access_token : ''
  if (!accessToken) {
    throw new Error('OAuth 返回缺少 access_token')
  }

  const expiresIn = typeof data?.expires_in === 'number' ? data.expires_in : undefined
  const expiryDate = expiresIn ? Date.now() + expiresIn * 1000 : undefined

  return {
    access_token: accessToken,
    refresh_token: typeof data?.refresh_token === 'string' ? data.refresh_token : undefined,
    scope: typeof data?.scope === 'string' ? data.scope : undefined,
    token_type: typeof data?.token_type === 'string' ? data.token_type : undefined,
    id_token: typeof data?.id_token === 'string' ? data.id_token : undefined,
    expiry_date: expiryDate,
  }
}

async function refreshAccessToken(creds: GeminiCliOAuthCreds): Promise<GeminiCliOAuthCreds> {
  const oauthConfig = ensureOauthClientConfigured()
  const refreshToken = creds.refresh_token
  if (!refreshToken) {
    throw new Error('没有 refresh_token：请重新用 /auth 登录一次')
  }

  const form = new URLSearchParams({
    client_id: oauthConfig.clientId,
    client_secret: oauthConfig.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })

  if (!resp.ok) {
    const body = await readResponseText(resp)
    throw new Error(`OAuth 刷新 token 失败 (HTTP ${resp.status}): ${body.slice(0, 400)}`)
  }

  const data = (await resp.json()) as any
  const accessToken = typeof data?.access_token === 'string' ? data.access_token : ''
  if (!accessToken) {
    throw new Error('OAuth 刷新返回缺少 access_token')
  }

  const expiresIn = typeof data?.expires_in === 'number' ? data.expires_in : undefined
  const expiryDate = expiresIn ? Date.now() + expiresIn * 1000 : undefined

  return {
    ...creds,
    access_token: accessToken,
    token_type: typeof data?.token_type === 'string' ? data.token_type : creds.token_type,
    scope: typeof data?.scope === 'string' ? data.scope : creds.scope,
    expiry_date: expiryDate ?? creds.expiry_date,
  }
}

export async function getValidGeminiCliAccessToken(): Promise<{
  accessToken: string
  creds: GeminiCliOAuthCreds
}> {
  const existing = await readGeminiCliOAuthCreds()
  if (!existing) {
    throw new Error(`未登录：找不到 ${getGlobalGeminiOauthCredsPath()}`)
  }

  const token = existing.access_token?.trim() ?? ''
  const expiry = typeof existing.expiry_date === 'number' ? existing.expiry_date : undefined
  const stillValid = token && expiry && expiry - Date.now() > EXPIRY_SKEW_MS

  if (stillValid) {
    return { accessToken: token, creds: existing }
  }

  const refreshed = await refreshAccessToken(existing)
  await writeGeminiCliOAuthCreds(refreshed)

  const nextToken = refreshed.access_token?.trim() ?? ''
  if (!nextToken) throw new Error('刷新后仍然没有 access_token')
  return { accessToken: nextToken, creds: refreshed }
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) return undefined
  const data = (await resp.json()) as any
  const email = typeof data?.email === 'string' ? data.email.trim() : ''
  return email || undefined
}

function normalizeCodeAssistMethodPath(path: string): string {
  const trimmed = String(path ?? '').trim()
  if (!trimmed) {
    throw new Error('Code Assist 路径不能为空')
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizeOperationName(name: string): string {
  return String(name ?? '').trim().replace(/^\/+/, '')
}

function normalizeCodeAssistModelId(modelId: string): string {
  const trimmed = String(modelId ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('models/') || trimmed.startsWith('tunedModels/')) {
    return trimmed
  }
  return `models/${trimmed}`
}

async function requestCodeAssist(options: {
  accessToken: string
  path: string
  method: 'GET' | 'POST'
  body?: unknown
}): Promise<any> {
  const methodPath = normalizeCodeAssistMethodPath(options.path)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    'User-Agent': getGeminiCliUserAgent(),
  }
  if (options.method === 'POST') {
    headers['Content-Type'] = 'application/json'
  }

  const resp = await fetch(`${CODE_ASSIST_ENDPOINT}${methodPath}`, {
    method: options.method,
    headers,
    ...(options.method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
  })

  if (!resp.ok) {
    const text = await readResponseText(resp)
    throw new Error(`Code Assist 请求失败 (HTTP ${resp.status}): ${text.slice(0, 400)}`)
  }

  return await resp.json()
}

async function postCodeAssist(accessToken: string, path: string, body: unknown): Promise<any> {
  return await requestCodeAssist({
    accessToken,
    path,
    method: 'POST',
    body,
  })
}

async function getCodeAssist(accessToken: string, path: string): Promise<any> {
  return await requestCodeAssist({
    accessToken,
    path,
    method: 'GET',
  })
}

function extractProjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    const v: any = value
    if (typeof v.id === 'string' && v.id.trim()) return v.id.trim()
  }
  return undefined
}

function findValidationRequired(loadRes: any): { reasonMessage?: string; validationUrl?: string } | null {
  if (loadRes?.currentTier) return null
  const ineligibleTiers = Array.isArray(loadRes?.ineligibleTiers) ? loadRes.ineligibleTiers : []
  for (const tier of ineligibleTiers) {
    const reasonCode = String(tier?.reasonCode ?? '')
    const validationUrl = typeof tier?.validationUrl === 'string' ? tier.validationUrl.trim() : ''
    if (reasonCode === 'VALIDATION_REQUIRED' && validationUrl) {
      const reasonMessage =
        typeof tier?.reasonMessage === 'string' ? tier.reasonMessage.trim() : ''
      return {
        reasonMessage: reasonMessage || undefined,
        validationUrl,
      }
    }
  }
  return null
}

function ensureLoadCodeAssistUsable(loadRes: any): void {
  const validation = findValidationRequired(loadRes)
  if (!validation) return
  const message =
    validation.reasonMessage && validation.validationUrl
      ? `账号需要验证：${validation.reasonMessage}（请打开并完成验证：${validation.validationUrl}）`
      : validation.validationUrl
        ? `账号需要验证：请打开并完成验证 ${validation.validationUrl}`
        : '账号需要验证，请按官方流程完成验证后重试。'
  throw new ValidationRequiredGeminiCliError(message, validation.validationUrl)
}

async function tryLoadCodeAssist(accessToken: string): Promise<string | undefined> {
  const envProjectId =
    process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'] || undefined
  const data = await postCodeAssist(accessToken, '/v1internal:loadCodeAssist', {
    cloudaicompanionProject: envProjectId,
    metadata: {
      ...CODE_ASSIST_METADATA,
      duetProject: envProjectId,
    },
  })
  ensureLoadCodeAssistUsable(data)

  if (!data || !data.currentTier) return undefined
  return extractProjectId(data.cloudaicompanionProject)
}

function getDefaultTierId(loadRes: any): string {
  const tiers = Array.isArray(loadRes?.allowedTiers) ? loadRes.allowedTiers : []
  for (const tier of tiers) {
    if (tier && typeof tier === 'object' && tier.isDefault && typeof tier.id === 'string') {
      return tier.id
    }
  }
  return LEGACY_TIER_ID
}

async function tryOnboardUser(accessToken: string): Promise<string | undefined> {
  const envProjectId =
    process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'] || undefined
  const loadRes = await postCodeAssist(accessToken, '/v1internal:loadCodeAssist', {
    cloudaicompanionProject: envProjectId,
    metadata: {
      ...CODE_ASSIST_METADATA,
      duetProject: envProjectId,
    },
  })
  ensureLoadCodeAssistUsable(loadRes)
  const tierId = getDefaultTierId(loadRes)

  const isFreeTier = tierId === FREE_TIER_ID
  const metadata: any = isFreeTier
    ? CODE_ASSIST_METADATA
    : {
        ...CODE_ASSIST_METADATA,
        duetProject: envProjectId,
      }

  const reqBody: any = {
    tierId,
    metadata,
  }
  if (!isFreeTier) {
    reqBody.cloudaicompanionProject = envProjectId
  }

  let op = await postCodeAssist(accessToken, '/v1internal:onboardUser', reqBody)
  if (op?.done) {
    return extractProjectId(op?.response?.cloudaicompanionProject)
  }

  const operationName = normalizeOperationName(String(op?.name ?? ''))
  if (!operationName) {
    return undefined
  }

  const maxPollAttempts = 12
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    await new Promise(r => setTimeout(r, 5000))
    op = await getCodeAssist(accessToken, `/v1internal/${operationName}`)
    if (op?.done) {
      return extractProjectId(op?.response?.cloudaicompanionProject)
    }
  }

  return undefined
}

export async function fetchGeminiCliQuotaModelIds(options?: {
  accessToken?: string
  projectId?: string
}): Promise<string[]> {
  try {
    const accessToken = options?.accessToken?.trim()
    const projectId = options?.projectId?.trim()
    const authContext =
      accessToken && projectId ? null : await getGeminiCliAuthContext()
    const resolvedAccessToken = accessToken || authContext?.accessToken || ''
    const resolvedProjectId = projectId || authContext?.projectId || ''
    if (!resolvedAccessToken || !resolvedProjectId) return []

    const data = await postCodeAssist(accessToken || resolvedAccessToken, '/v1internal:retrieveUserQuota', {
      project: resolvedProjectId,
      userAgent: getGeminiCliUserAgent(),
    })
    const buckets = Array.isArray(data?.buckets) ? data.buckets : []
    const ids = buckets
      .map((bucket: any) => normalizeCodeAssistModelId(String(bucket?.modelId ?? '')))
      .filter(Boolean)
    return Array.from(new Set(ids))
  } catch {
    return []
  }
}

export async function recordGeminiCliConversationOfferedBestEffort(options: {
  accessToken: string
  projectId: string
  traceId?: string
  hasFunctionCalls: boolean
  includedCode: boolean
  status?: 'no_error' | 'error' | 'cancelled' | 'empty'
}): Promise<void> {
  if (!options.hasFunctionCalls) return
  const traceId = String(options.traceId ?? '').trim()
  if (!traceId) return

  const statusCode =
    options.status === 'cancelled'
      ? ACTION_STATUS_CANCELLED
      : options.status === 'empty'
        ? ACTION_STATUS_EMPTY
        : options.status === 'error'
          ? ACTION_STATUS_ERROR_UNKNOWN
          : ACTION_STATUS_NO_ERROR

  const request = {
    project: options.projectId,
    metadata: CODE_ASSIST_METADATA,
    metrics: [
      {
        timestamp: new Date().toISOString(),
        conversationOffered: {
          citationCount: '0',
          includedCode: options.includedCode,
          status: statusCode,
          traceId,
          isAgentic: true,
          initiationMethod: INITIATION_METHOD_COMMAND,
        },
      },
    ],
  }

  try {
    await postCodeAssist(options.accessToken, '/v1internal:recordCodeAssistMetrics', request)
  } catch {
    // best-effort
  }
}

export async function recordGeminiCliConversationInteractionBestEffort(options: {
  accessToken: string
  projectId: string
  traceId?: string
  status?: 'no_error' | 'error' | 'cancelled' | 'empty'
  interaction?: 'unknown'
}): Promise<void> {
  const traceId = String(options.traceId ?? '').trim()
  if (!traceId) return

  const statusCode =
    options.status === 'cancelled'
      ? ACTION_STATUS_CANCELLED
      : options.status === 'empty'
        ? ACTION_STATUS_EMPTY
        : options.status === 'error'
          ? ACTION_STATUS_ERROR_UNKNOWN
          : ACTION_STATUS_NO_ERROR

  const interactionCode = CONVERSATION_INTERACTION_UNKNOWN

  const request = {
    project: options.projectId,
    metadata: CODE_ASSIST_METADATA,
    metrics: [
      {
        timestamp: new Date().toISOString(),
        conversationInteraction: {
          traceId,
          status: statusCode,
          interaction: interactionCode,
          isAgentic: true,
        },
      },
    ],
  }

  try {
    await postCodeAssist(options.accessToken, '/v1internal:recordCodeAssistMetrics', request)
  } catch {
    // best-effort
  }
}

export async function fetchGeminiCliProjectId(accessToken: string): Promise<string> {
  try {
    const pid = await tryLoadCodeAssist(accessToken)
    if (pid) return pid
  } catch (error) {
    if (error instanceof ValidationRequiredGeminiCliError) {
      throw error
    }
    // fallback
  }

  const onboarded = await tryOnboardUser(accessToken)
  if (onboarded) return onboarded
  throw new Error('获取 project_id 失败（loadCodeAssist/onboardUser 都没拿到）')
}

export async function ensureGeminiCliProjectId(): Promise<string> {
  const { accessToken, creds } = await getValidGeminiCliAccessToken()
  if (creds.project_id?.trim()) return creds.project_id.trim()

  const projectId = await fetchGeminiCliProjectId(accessToken)
  await writeGeminiCliOAuthCreds({ ...creds, project_id: projectId })
  return projectId
}

export async function getGeminiCliAuthContext(): Promise<{
  accessToken: string
  projectId: string
  creds: GeminiCliOAuthCreds
}> {
  const { accessToken, creds } = await getValidGeminiCliAccessToken()
  const cached = creds.project_id?.trim()
  if (cached) {
    return { accessToken, projectId: cached, creds }
  }

  const projectId = await fetchGeminiCliProjectId(accessToken)
  const next = { ...creds, project_id: projectId }
  await writeGeminiCliOAuthCreds(next)
  return { accessToken, projectId, creds: next }
}

export async function loginWithGoogleForGeminiCli(options?: {
  onAuthUrl?: (url: string) => void
}): Promise<{ email?: string; projectId?: string }> {
  ensureOauthClientConfigured()
  const port = await getAvailablePort()
  // Google 对 Desktop / loopback 回调有严格限制，优先使用 IP 字面量。
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
  const state = crypto.randomBytes(32).toString('hex')
  const authUrl = buildAuthUrl({ redirectUri, state })

  options?.onAuthUrl?.(authUrl)
  void openBrowser(authUrl)

  const code = await new Promise<string>((resolve, reject) => {
    const host = normalizeCallbackHost(process.env['OAUTH_CALLBACK_HOST'])
    const server = http.createServer((req, res) => {
      try {
        if (!req.url || !req.url.includes('/oauth2callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Not Found')
          return
        }

        const qs = new URL(req.url, 'http://127.0.0.1:3000').searchParams
        const error = qs.get('error')
        const gotState = qs.get('state')
        const gotCode = qs.get('code')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`登录失败：${error}`)
          reject(new Error(`Google OAuth error: ${error}`))
          return
        }

        if (gotState !== state) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('State 不匹配（可能是浏览器会话问题），请重试')
          reject(new Error('OAuth state mismatch'))
          return
        }

        if (!gotCode) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('没有收到 code，请重试')
          reject(new Error('No authorization code received'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('登录成功，可以关掉这个页面回到终端了。')
        resolve(gotCode)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        server.close()
      }
    })

    server.listen(port, host)
    server.on('error', reject)
  })

  const tokens = await exchangeCodeForTokens({ code, redirectUri })
  const email = await fetchUserEmail(tokens.access_token ?? '')

  const projectId = await (async () => {
    try {
      return await fetchGeminiCliProjectId(tokens.access_token ?? '')
    } catch {
      return undefined
    }
  })()

  const next: GeminiCliOAuthCreds = {
    ...tokens,
    ...(email ? { user_email: email } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  }

  await writeGeminiCliOAuthCreds(next)
  return { email, projectId }
}
