export type TaskTerminalStatus = 'completed' | 'failed' | 'cancelled'

const REPORT_PATH_RE = /^\s*REPORT_PATH\s*:\s*(.+?)\s*$/im
const TASK_STATUS_RE = /^\s*TASK_STATUS\s*:\s*(completed|failed|cancelled)\s*$/im
const TASK_ERROR_RE = /^\s*TASK_ERROR\s*:\s*(.+?)\s*$/im

function normalizeOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stripWrappers(text: string): string {
  let value = text.trim()
  if (!value) return value
  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  return value
}

export function extractReportPathFromTaskText(text: string): string | null {
  if (!text) return null
  const match = text.match(REPORT_PATH_RE)
  if (!match?.[1]) return null
  const path = stripWrappers(match[1])
  return path || null
}

export function extractTaskStatusFromTaskText(text: string): TaskTerminalStatus | null {
  if (!text) return null
  const match = text.match(TASK_STATUS_RE)
  if (!match?.[1]) return null
  const value = match[1].trim().toLowerCase()
  if (value === 'completed' || value === 'failed' || value === 'cancelled') {
    return value
  }
  return null
}

export function extractTaskErrorFromTaskText(text: string): string | null {
  if (!text) return null
  const explicit = text.match(TASK_ERROR_RE)
  if (explicit?.[1]) {
    const normalized = normalizeOneLine(explicit[1])
    return normalized || null
  }

  const firstNonEmptyLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
  if (!firstNonEmptyLine) return null

  const normalized = normalizeOneLine(firstNonEmptyLine)
  if (
    /(^failed\b|^error\b|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/i.test(
      normalized,
    )
  ) {
    return normalized
  }
  return null
}

export function isLikelyGeminiNetworkFailureMessage(message: string): boolean {
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(
    message,
  )
}

export function formatTaskTerminalFailureText(
  status: 'failed' | 'cancelled',
  message: string,
): string {
  const normalizedMessage = normalizeOneLine(message || '') || `Task ${status}`
  const lines = [`TASK_STATUS: ${status}`, `TASK_ERROR: ${normalizedMessage}`]

  if (
    isLikelyGeminiNetworkFailureMessage(normalizedMessage) &&
    !/Gemini\/网络请求失败/i.test(normalizedMessage)
  ) {
    lines.push(
      'TASK_HINT: Gemini/网络请求失败（fetch failed）。请检查网络、代理与 Gemini API 配置后重试。',
    )
  }

  return lines.join('\n')
}

export function summarizeTaskResultText(text: string): {
  status: TaskTerminalStatus | null
  reportPath: string | null
  errorSummary: string | null
  preview: string
} {
  const status = extractTaskStatusFromTaskText(text)
  const reportPath = extractReportPathFromTaskText(text)
  const errorSummary = extractTaskErrorFromTaskText(text)
  const preview = normalizeOneLine(text).slice(0, 200)
  return {
    status,
    reportPath,
    errorSummary,
    preview,
  }
}
