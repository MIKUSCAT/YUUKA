import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { openBrowser } from '@utils/browser'
import { fetch } from 'undici'

const OAUTH_CLIENT_ID = process.env.YUUKA_OAUTH_CLIENT_ID?.trim() || ''
const OAUTH_CLIENT_SECRET = process.env.YUUKA_OAUTH_CLIENT_SECRET?.trim() || ''
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
export const GEMINI_CLI_USER_AGENT = 'GeminiCLI/0.1.5 (Windows; AMD64)'

const CODE_ASSIST_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const

const EXPIRY_SKEW_MS = 60_000

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

export function getGlobalGeminiOauthCredsPath(): string {
  return join(homedir(), '.yuuka', 'oauth_creds.json')
}

function ensureOauthClientConfigured(): void {
  if (!OAUTH_CLIENT_ID) {
    throw new Error(
      'OAuth 配置缺失：client_id 为空。请设置 YUUKA_OAUTH_CLIENT_ID。',
    )
  }
  if (!OAUTH_CLIENT_SECRET) {
    throw new Error(
      'OAuth 配置缺失：client_secret 为空。请设置 YUUKA_OAUTH_CLIENT_SECRET。',
    )
  }
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

function buildAuthUrl(options: { redirectUri: string; state: string }): string {
  ensureOauthClientConfigured()
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
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
  ensureOauthClientConfigured()
  const form = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
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
  ensureOauthClientConfigured()
  const refreshToken = creds.refresh_token
  if (!refreshToken) {
    throw new Error('没有 refresh_token：请重新用 /auth 登录一次')
  }

  const form = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
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

async function postCodeAssist(accessToken: string, path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${CODE_ASSIST_ENDPOINT}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': GEMINI_CLI_USER_AGENT,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await readResponseText(resp)
    throw new Error(`Code Assist 请求失败 (HTTP ${resp.status}): ${text.slice(0, 400)}`)
  }

  return await resp.json()
}

function extractProjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    const v: any = value
    if (typeof v.id === 'string' && v.id.trim()) return v.id.trim()
  }
  return undefined
}

async function tryLoadCodeAssist(accessToken: string): Promise<string | undefined> {
  const data = await postCodeAssist(accessToken, '/v1internal:loadCodeAssist', {
    metadata: CODE_ASSIST_METADATA,
  })

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
  return 'LEGACY'
}

async function tryOnboardUser(accessToken: string): Promise<string | undefined> {
  const loadRes = await postCodeAssist(accessToken, '/v1internal:loadCodeAssist', {
    metadata: CODE_ASSIST_METADATA,
  })
  const tierId = getDefaultTierId(loadRes)

  const envProjectId =
    process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'] || undefined

  const isFreeTier = tierId === 'FREE'
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

  const maxAttempts = 12
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await postCodeAssist(accessToken, '/v1internal:onboardUser', reqBody)
    if (data?.done) {
      const projectId = extractProjectId(data?.response?.cloudaicompanionProject)
      return projectId
    }
    await new Promise(r => setTimeout(r, 5000))
  }

  return undefined
}

export async function fetchGeminiCliProjectId(accessToken: string): Promise<string> {
  try {
    const pid = await tryLoadCodeAssist(accessToken)
    if (pid) return pid
  } catch {
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
    const host = process.env['OAUTH_CALLBACK_HOST'] || '127.0.0.1'
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
