import type { Command } from '@commands'
import chalk from 'chalk'
import modelsCatalog from '@constants/models'
import { getTotalCost } from '@costTracker'
import { getMessagesGetter } from '@messages'
import { getGlobalConfig } from '@utils/config'
import {
  ensureGlobalGeminiSettings,
  getGlobalGeminiSettingsPath,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
} from '@utils/geminiSettings'
import { getEffectiveThinkingSetting } from '@utils/thinkingConfig'
import { countCachedTokens, countTokens } from '@utils/tokens'
import { getSystemPrompt } from '@constants/prompts'

const L = 10 // label width

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function cost(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0.00'
  if (v >= 1) return `$${v.toFixed(2)}`
  return `$${v.toFixed(4)}`
}

function label(s: string): string {
  return chalk.dim(s.padEnd(L))
}

function getCurrentModelName(): string {
  try {
    ensureGlobalGeminiSettings()
    const settings = readGeminiSettingsFile(getGlobalGeminiSettingsPath())
    return normalizeGeminiModelName(settings.model?.name ?? '')
  } catch {
    return ''
  }
}

function getContextWindowFromCatalog(modelName: string): number | null {
  if (!modelName) return null
  const normalized = normalizeGeminiModelName(modelName)
  const models = Array.isArray((modelsCatalog as any)?.gemini)
    ? (modelsCatalog as any).gemini
    : []
  const matched = models.find(
    (entry: any) =>
      normalizeGeminiModelName(String(entry?.model ?? '')) === normalized,
  )
  const limit = matched?.max_input_tokens
  return typeof limit === 'number' && limit > 0 ? limit : null
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length * 0.25) + 8
}

const status = {
  type: 'local',
  name: 'status',
  description: '显示当前会话状态（tokens/窗口/thinking）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'status'
  },
  async call() {
    const messages = getMessagesGetter()()
    const globalConfig = getGlobalConfig()
    const modelName = getCurrentModelName()
    const modelLabel = modelName ? modelName.replace(/^models\//, '') : '(unset)'

    const userMsgs = messages.filter(_ => _.type === 'user').length
    const asstMsgs = messages.filter(_ => _.type === 'assistant').length
    const tokenUsage = countTokens(messages)
    const cachedTokens = countCachedTokens(messages)
    const totalCost = getTotalCost()

    const contextWindow = getContextWindowFromCatalog(modelName)
    const usagePct =
      contextWindow != null && contextWindow > 0
        ? (tokenUsage / contextWindow) * 100
        : null
    const remain =
      contextWindow != null
        ? Math.max(Math.floor(contextWindow * 0.8) - tokenUsage, 0)
        : null

    const effectiveThinking = getEffectiveThinkingSetting(modelName, globalConfig)

    let sysTokens = 0
    try {
      const promptParts = await getSystemPrompt()
      const promptText = Array.isArray(promptParts) ? promptParts.join('\n') : String(promptParts)
      sysTokens = estimateTokenCount(promptText)
    } catch { /* ignore */ }
    const convTokens = Math.max(0, tokenUsage - sysTokens)

    const lines: string[] = []

    // model + msgs + cost
    lines.push(`${label('model')}${modelLabel}`)
    lines.push(`${label('msgs')}${fmt(userMsgs)}↑ ${fmt(asstMsgs)}↓ ${chalk.dim(`(${fmt(messages.length)} total)`)}`)
    lines.push(`${label('cost')}${cost(totalCost)}`)

    // tokens
    lines.push('')
    if (contextWindow != null) {
      lines.push(`${label('tokens')}${fmt(tokenUsage)} / ${fmt(contextWindow)} ${chalk.dim(`(${(usagePct ?? 0).toFixed(1)}%)`)}`)
      if (sysTokens > 0 || convTokens > 0) {
        lines.push(chalk.dim(`${''.padEnd(L)}  system ~${fmt(sysTokens)} · conversation ~${fmt(convTokens)}`))
      }
      lines.push(`${label('remain')}${fmt(remain ?? 0)} ${chalk.dim('(80% reserve)')}`)
    } else {
      lines.push(`${label('tokens')}${fmt(tokenUsage)}`)
      lines.push(chalk.dim(`${''.padEnd(L)}context window unknown`))
    }
    if (cachedTokens > 0) {
      lines.push(`${label('cached')}${fmt(cachedTokens)}`)
    }

    // thinking
    lines.push('')
    lines.push(
      `${label('think')}${
        effectiveThinking.mode === 'level'
          ? `thinkingLevel=${effectiveThinking.level}`
          : `thinkingBudget=${fmt(effectiveThinking.budget)}`
      }`,
    )

    return lines.join('\n')
  },
} satisfies Command

export default status
