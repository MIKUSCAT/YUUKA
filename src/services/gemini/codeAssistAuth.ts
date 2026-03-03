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
import { getModelManager } from '@utils/model'
import { getClientMetadata } from './clientMetadata'
import { getYuukaUserAgent } from './userAgent'
import { appendGeminiOAuthDiagnostic } from './diagnostics'
import type { AuthClient, Credentials } from 'google-auth-library'
import { OAuth2Client } from 'google-auth-library'
import { getGeminiCliCustomHeaders } from './customHeaderUtils'

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

// Defaults copied from gemini-cli (installed application OAuth).
// These values are public in Gemini CLI's source tree.
const GEMINI_CLI_OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
const GEMINI_CLI_OAUTH_CLIENT_SECRET = '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'

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'

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

export { getYuukaUserAgent } from './userAgent'

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
  const overrideClientId = settings.security?.auth?.geminiCliOAuth?.clientId?.trim() || ''
  const overrideClientSecret =
    settings.security?.auth?.geminiCliOAuth?.clientSecret?.trim() || ''

  // If user provides an override, require both fields.
  if (overrideClientId || overrideClientSecret) {
    return { clientId: overrideClientId, clientSecret: overrideClientSecret }
  }

  return {
    clientId: GEMINI_CLI_OAUTH_CLIENT_ID,
    clientSecret: GEMINI_CLI_OAUTH_CLIENT_SECRET,
  }
}

function ensureOauthClientConfigured(): OAuthClientConfig {
  const config = getOAuthClientConfig()
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'OAuth 配置缺失：geminiCliOAuth 需要同时提供 clientId 与 clientSecret（或删掉 override 让它回退到 Gemini CLI 默认值）。',
    )
  }

  return config
}

function getProxyFromSettings(): string | undefined {
  try {
    const { settingsPath } = ensureGlobalGeminiSettings()
    const settings = readGeminiSettingsFile(settingsPath)
    const proxy = typeof settings.proxy === 'string' ? settings.proxy.trim() : ''
    return proxy || undefined
  } catch {
    return undefined
  }
}

function createOAuth2ClientFromConfig(): OAuth2Client {
  const oauthConfig = ensureOauthClientConfigured()
  const proxy = getProxyFromSettings()
  return new OAuth2Client({
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    transporterOptions: proxy ? { proxy } : undefined,
  })
}

let cachedOauthClient: OAuth2Client | null = null
let cachedOauthClientKey = ''

function getOauthClientCacheKey(): string {
  const oauthConfig = ensureOauthClientConfigured()
  const proxy = getProxyFromSettings() ?? ''
  return `${oauthConfig.clientId}::${oauthConfig.clientSecret}::${proxy}`
}

function mergeTokenFields(existing: GeminiCliOAuthCreds, tokens: Credentials): GeminiCliOAuthCreds {
  const next: GeminiCliOAuthCreds = { ...existing }
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : ''
  if (accessToken) next.access_token = accessToken

  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token.trim() : ''
  if (refreshToken) next.refresh_token = refreshToken

  if (typeof tokens.scope === 'string') next.scope = tokens.scope
  if (typeof tokens.token_type === 'string') next.token_type = tokens.token_type
  if (typeof tokens.expiry_date === 'number') next.expiry_date = tokens.expiry_date

  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token.trim() : ''
  if (idToken) next.id_token = idToken

  return next
}

async function getCachedGeminiCliOAuthClient(): Promise<OAuth2Client> {
  const key = getOauthClientCacheKey()
  if (cachedOauthClient && cachedOauthClientKey === key) {
    return cachedOauthClient
  }

  const client = createOAuth2ClientFromConfig()

  // Load cached credentials if present (ignore extra fields like project_id/user_email).
  const creds = await readGeminiCliOAuthCreds()
  if (creds) {
    client.setCredentials(creds as any)
  }

  // Persist refreshed tokens automatically (Gemini CLI style).
  client.on('tokens', (tokens: Credentials) => {
    void (async () => {
      const existing = (await readGeminiCliOAuthCreds()) ?? {}
      const next = mergeTokenFields(existing, tokens)
      await writeGeminiCliOAuthCreds(next)
    })().catch(() => {})
  })

  cachedOauthClient = client
  cachedOauthClientKey = key
  return client
}

export async function getGeminiCliOAuthClient(): Promise<OAuth2Client> {
  return await getCachedGeminiCliOAuthClient()
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
  cachedOauthClient = null
  cachedOauthClientKey = ''
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

export async function getValidGeminiCliAccessToken(): Promise<{
  accessToken: string
  creds: GeminiCliOAuthCreds
}> {
  const existing = await readGeminiCliOAuthCreds()
  if (!existing) throw new Error(`未登录：找不到 ${getGlobalGeminiOauthCredsPath()}`)

  const client = await getCachedGeminiCliOAuthClient()
  // Ensure we carry refresh_token (and any other cached fields) into the client.
  client.setCredentials(existing as any)

  let token = ''
  try {
    const res = await client.getAccessToken()
    token = (typeof res === 'string' ? res : res?.token || '').trim()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (!existing.refresh_token?.trim()) {
      throw new Error(`OAuth 不可用（没有 refresh_token）：请重新用 /auth 登录一次。原始错误：${msg}`)
    }
    throw new Error(`OAuth 获取 access token 失败：${msg}`)
  }

  if (!token) {
    throw new Error('OAuth 返回空 access_token：请重新用 /auth 登录一次')
  }

  const next = mergeTokenFields(existing, client.credentials as any)
  await writeGeminiCliOAuthCreds(next)
  return { accessToken: token, creds: next }
}

async function fetchUserEmail(client: AuthClient): Promise<string | undefined> {
  try {
    const res = await client.request({
      url: GOOGLE_USERINFO_URL,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...getGeminiCliCustomHeaders(),
      },
      responseType: 'json',
    })
    const data = (res as any).data as any
    const email = typeof data?.email === 'string' ? data.email.trim() : ''
    return email || undefined
  } catch {
    return undefined
  }
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
  client: AuthClient
  path: string
  method: 'GET' | 'POST'
  body?: unknown
}): Promise<any> {
  const methodPath = normalizeCodeAssistMethodPath(options.path)
  const uaModel = getModelManager().getModelName('main') || undefined
  const url = `${(process.env['CODE_ASSIST_ENDPOINT'] ?? CODE_ASSIST_ENDPOINT)
    .trim()
    .replace(/\/+$/, '')}${methodPath}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getGeminiCliCustomHeaders(),
    'User-Agent': getYuukaUserAgent(uaModel),
  }

  try {
    const res = await options.client.request({
      url,
      method: options.method,
      headers,
      responseType: 'json',
      ...(options.method === 'POST'
        ? { body: JSON.stringify(options.body ?? {}) }
        : {}),
    })
    return (res as any).data
  } catch (error) {
    const status =
      typeof (error as any)?.response?.status === 'number'
        ? (error as any).response.status
        : 0
    const data = (error as any)?.response?.data
    const snippet =
      typeof data === 'string'
        ? data
        : data
          ? JSON.stringify(data).slice(0, 800)
          : error instanceof Error
            ? error.message
            : String(error)

    await appendGeminiOAuthDiagnostic({
      stage: 'code_assist_request',
      url,
      method: options.method,
      status,
      ok: false,
      responseSnippet: snippet,
      extra: {
        path: methodPath,
      },
    })
    throw new Error(`Code Assist 请求失败 (HTTP ${status || 'unknown'}): ${snippet.slice(0, 400)}`)
  }
}

async function postCodeAssist(client: AuthClient, path: string, body: unknown): Promise<any> {
  return await requestCodeAssist({
    client,
    path,
    method: 'POST',
    body,
  })
}

async function getCodeAssist(client: AuthClient, path: string): Promise<any> {
  return await requestCodeAssist({
    client,
    path,
    method: 'GET',
  })
}

function createOAuth2ClientForAccessToken(accessToken: string): OAuth2Client {
  const client = createOAuth2ClientFromConfig()
  client.setCredentials({ access_token: accessToken })
  return client
}

function getCodeAssistApiVersion(): string {
  const version = String(process.env['CODE_ASSIST_API_VERSION'] || 'v1internal')
    .trim()
    .replace(/^\/+/, '')
  return version || 'v1internal'
}

function caMethodPath(method: string): string {
  const v = getCodeAssistApiVersion()
  const name = String(method ?? '').trim().replace(/^:+/, '')
  return `/${v}:${name}`
}

function caOperationPath(operationName: string): string {
  const v = getCodeAssistApiVersion()
  const name = String(operationName ?? '').trim().replace(/^\/+/, '')
  return `/${v}/${name}`
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

async function tryLoadCodeAssist(client: AuthClient): Promise<string | undefined> {
  const envProjectId =
    process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'] || undefined
  const clientMetadata = await getClientMetadata()
  const data = await postCodeAssist(client, caMethodPath('loadCodeAssist'), {
    cloudaicompanionProject: envProjectId,
    metadata: {
      ...clientMetadata,
      ...(envProjectId ? { duetProject: envProjectId } : {}),
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

async function tryOnboardUser(client: AuthClient): Promise<string | undefined> {
  const envProjectId =
    process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'] || undefined
  const clientMetadata = await getClientMetadata()
  const loadRes = await postCodeAssist(client, caMethodPath('loadCodeAssist'), {
    cloudaicompanionProject: envProjectId,
    metadata: {
      ...clientMetadata,
      ...(envProjectId ? { duetProject: envProjectId } : {}),
    },
  })
  ensureLoadCodeAssistUsable(loadRes)
  const tierId = getDefaultTierId(loadRes)

  const isFreeTier = tierId === FREE_TIER_ID
  const metadata: any = isFreeTier
    ? clientMetadata
    : {
        ...clientMetadata,
        ...(envProjectId ? { duetProject: envProjectId } : {}),
      }

  const reqBody: any = {
    tierId,
    metadata,
  }
  if (!isFreeTier) {
    reqBody.cloudaicompanionProject = envProjectId
  }

  let op = await postCodeAssist(client, caMethodPath('onboardUser'), reqBody)
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
    op = await getCodeAssist(client, caOperationPath(operationName))
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

    const client = createOAuth2ClientForAccessToken(resolvedAccessToken)
    const data = await postCodeAssist(client, caMethodPath('retrieveUserQuota'), {
      project: resolvedProjectId,
      userAgent: getYuukaUserAgent(),
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

const QUOTA_MODEL_CACHE_TTL_MS = 30_000
let cachedQuotaModels: { projectId: string; ts: number; modelIds: string[] } | null = null

// Gemini CLI 会在初始化时拉 quota，用它判断是否有 preview 模型权限。
// 这里做个 30s 的轻量缓存，避免每次对话都打一次 retrieveUserQuota。
export async function fetchGeminiCliQuotaModelIdsCached(options?: {
  accessToken?: string
  projectId?: string
}): Promise<string[]> {
  const projectId = String(options?.projectId ?? '').trim()
  if (projectId && cachedQuotaModels) {
    const age = Date.now() - cachedQuotaModels.ts
    if (cachedQuotaModels.projectId === projectId && age >= 0 && age < QUOTA_MODEL_CACHE_TTL_MS) {
      return cachedQuotaModels.modelIds
    }
  }

  const ids = await fetchGeminiCliQuotaModelIds(options)
  if (projectId) {
    cachedQuotaModels = { projectId, ts: Date.now(), modelIds: ids }
  }
  return ids
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
    metadata: await getClientMetadata(),
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
    const client = createOAuth2ClientForAccessToken(options.accessToken)
    await postCodeAssist(client, caMethodPath('recordCodeAssistMetrics'), request)
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
    metadata: await getClientMetadata(),
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
    const client = createOAuth2ClientForAccessToken(options.accessToken)
    await postCodeAssist(client, caMethodPath('recordCodeAssistMetrics'), request)
  } catch {
    // best-effort
  }
}

export async function fetchGeminiCliProjectId(accessToken: string): Promise<string> {
  const client = createOAuth2ClientForAccessToken(accessToken)
  try {
    const pid = await tryLoadCodeAssist(client)
    if (pid) return pid
  } catch (error) {
    if (error instanceof ValidationRequiredGeminiCliError) {
      throw error
    }
    // fallback
  }

  const onboarded = await tryOnboardUser(client)
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

  // Mirror Gemini CLI's OAuth flow: use google-auth-library OAuth2Client.
  const client = createOAuth2ClientFromConfig()
  const port = await getAvailablePort()
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
  const state = crypto.randomBytes(32).toString('hex')

  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    state,
  })

  options?.onAuthUrl?.(authUrl)
  void openBrowser(authUrl)

  const HTTP_REDIRECT = 301
  const SIGN_IN_SUCCESS_URL =
    'https://developers.google.com/gemini-code-assist/auth_success_gemini'
  const SIGN_IN_FAILURE_URL =
    'https://developers.google.com/gemini-code-assist/auth_failure_gemini'

  const loginCompletePromise = new Promise<void>((resolve, reject) => {
    const host = normalizeCallbackHost(process.env['OAUTH_CALLBACK_HOST'])
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url || req.url.indexOf('/oauth2callback') === -1) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL })
          res.end()
          reject(new Error('OAuth callback not received. Unexpected request: ' + (req.url || '')))
          return
        }

        const qs = new URL(req.url, 'http://127.0.0.1:3000').searchParams
        const error = qs.get('error')
        const gotState = qs.get('state')
        const code = qs.get('code')

        if (error) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL })
          res.end()
          reject(new Error(`Google OAuth error: ${error}`))
          return
        }

        if (gotState !== state) {
          res.end('State mismatch. Possible CSRF attack or browser session issue.')
          reject(new Error('OAuth state mismatch'))
          return
        }

        if (!code) {
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL })
          res.end()
          reject(new Error('No authorization code received from Google OAuth'))
          return
        }

        try {
          const { tokens } = await client.getToken({
            code,
            redirect_uri: redirectUri,
          })
          client.setCredentials(tokens)

          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_SUCCESS_URL })
          res.end()
          resolve()
        } catch (e) {
          const status =
            typeof (e as any)?.response?.status === 'number' ? (e as any).response.status : 0
          const data = (e as any)?.response?.data
          const snippet =
            typeof data === 'string'
              ? data
              : data
                ? JSON.stringify(data).slice(0, 800)
                : e instanceof Error
                  ? e.message
                  : String(e)
          await appendGeminiOAuthDiagnostic({
            stage: 'oauth_token_exchange',
            url: 'google-auth-library:getToken',
            method: 'POST',
            status,
            ok: false,
            responseSnippet: snippet,
          })
          res.writeHead(HTTP_REDIRECT, { Location: SIGN_IN_FAILURE_URL })
          res.end()
          reject(new Error(`Failed to exchange authorization code for tokens: ${snippet}`))
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        server.close()
      }
    })

    server.listen(port, host)
    server.on('error', reject)
  })

  const authTimeoutMs = 5 * 60 * 1000
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          'OAuth 登录超时（5 分钟）。浏览器可能卡住了；请重试，或换个网络/浏览器。',
        ),
      )
    }, authTimeoutMs)
  })

  await Promise.race([loginCompletePromise, timeoutPromise])

  const tokens = client.credentials as Credentials
  const email = await fetchUserEmail(client)

  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : ''
  const projectId = await (async () => {
    if (!accessToken) return undefined
    try {
      return await fetchGeminiCliProjectId(accessToken)
    } catch {
      return undefined
    }
  })()

  const next: GeminiCliOAuthCreds = mergeTokenFields({}, tokens)
  if (email) next.user_email = email
  if (projectId) next.project_id = projectId

  await writeGeminiCliOAuthCreds(next)

  // Clear in-memory cache so subsequent requests use the latest stored creds.
  cachedOauthClient = null
  cachedOauthClientKey = ''

  return { email, projectId }
}
