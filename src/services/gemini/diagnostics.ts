import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

function getDiagnosticsPath(filename: string): string {
  return join(homedir(), '.yuuka', 'diagnostics', filename)
}

function safeSnippet(value: unknown, max = 800): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export async function appendGeminiOAuthDiagnostic(event: {
  stage: 'oauth_token_exchange' | 'oauth_refresh' | 'code_assist_request'
  url: string
  method: 'GET' | 'POST'
  status?: number
  ok?: boolean
  error?: string
  responseSnippet?: string
  extra?: Record<string, unknown>
}): Promise<void> {
  try {
    const path = getDiagnosticsPath('oauth.jsonl')
    await fs.mkdir(dirname(path), { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
      ...(event.responseSnippet
        ? { responseSnippet: safeSnippet(event.responseSnippet) }
        : {}),
      ...(event.error ? { error: safeSnippet(event.error) } : {}),
    })
    await fs.appendFile(path, `${line}\n`, 'utf-8')
  } catch {
    // best-effort; never break auth flow
  }
}

