import type { Command } from '@commands'
import Table from 'cli-table3'
import modelsCatalog from '@constants/models'
import { getTotalCost } from '@costTracker'
import { getMessagesGetter } from '@messages'
import type { Message } from '@query'
import { getGlobalConfig } from '@utils/config'
import {
  ensureGlobalGeminiSettings,
  getGlobalGeminiSettingsPath,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
} from '@utils/geminiSettings'
import {
  getEffectiveThinkingSetting,
  getThinkingGemini3Level,
  getThinkingNonGemini3Budget,
} from '@utils/thinkingConfig'
import { countCachedTokens, countTokens } from '@utils/tokens'

type UsageTotals = {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.0000'
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

function renderSectionTable(rows: Array<[string, string]>): string {
  const table = new Table({
    head: ['项', '值'],
    style: { head: ['bold'] },
    wordWrap: true,
  })
  for (const row of rows) {
    table.push(row)
  }
  return table.toString()
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

function collectUsageTotals(messages: Message[]): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
  }

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const usage = (message.message as any)?.usage
    if (!usage || typeof usage !== 'object') continue

    const input = Number(usage.input_tokens ?? 0)
    const output = Number(usage.output_tokens ?? 0)
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0)
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0)

    totals.input += Number.isFinite(input) ? input : 0
    totals.output += Number.isFinite(output) ? output : 0
    totals.cacheCreate += Number.isFinite(cacheCreate) ? cacheCreate : 0
    totals.cacheRead += Number.isFinite(cacheRead) ? cacheRead : 0
  }

  totals.total = totals.input + totals.output + totals.cacheCreate + totals.cacheRead
  return totals
}

const status = {
  type: 'local',
  name: 'status',
  description: '显示当前会话状态（tokens/窗口/thinking/memory）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'status'
  },
  async call() {
    const messages = getMessagesGetter()()
    const globalConfig = getGlobalConfig()
    const modelName = getCurrentModelName()
    const modelLabel = modelName ? modelName.replace(/^models\//, '') : '(未设置)'

    const userMessages = messages.filter(_ => _.type === 'user').length
    const assistantMessages = messages.filter(_ => _.type === 'assistant').length
    const tokenUsage = countTokens(messages)
    const cachedTokens = countCachedTokens(messages)
    const usageTotals = collectUsageTotals(messages)
    const cost = getTotalCost()

    const contextWindow = getContextWindowFromCatalog(modelName)
    const rawRemaining =
      contextWindow != null ? Math.max(contextWindow - tokenUsage, 0) : null
    const reservedWindow =
      contextWindow != null ? Math.floor(contextWindow * 0.8) : null
    const reservedRemaining =
      reservedWindow != null ? Math.max(reservedWindow - tokenUsage, 0) : null
    const usagePct =
      contextWindow != null && contextWindow > 0
        ? (tokenUsage / contextWindow) * 100
        : null

    const thinkingGemini3Level = getThinkingGemini3Level(globalConfig)
    const thinkingNonGemini3Budget = getThinkingNonGemini3Budget(globalConfig)
    const effectiveThinking = getEffectiveThinkingSetting(modelName, globalConfig)

    const sections: string[] = []

    sections.push('会话状态')
    sections.push(
      renderSectionTable([
        ['模型', modelLabel],
        [
          '消息',
          `用户 ${formatNumber(userMessages)} / 助手 ${formatNumber(assistantMessages)} / 总计 ${formatNumber(messages.length)}`,
        ],
      ]),
    )

    sections.push('')
    sections.push('Tokens')
    sections.push(
      renderSectionTable([
        ['上下文已用(估算)', formatNumber(tokenUsage)],
        ['缓存 tokens(最近一次)', formatNumber(cachedTokens)],
        [
          '累计 usage (in/out/cache)',
          `${formatNumber(usageTotals.input)} / ${formatNumber(usageTotals.output)} / ${formatNumber(usageTotals.cacheCreate + usageTotals.cacheRead)}`,
        ],
        ['累计 usage 总计', formatNumber(usageTotals.total)],
      ]),
    )

    sections.push('')
    sections.push('窗口')
    sections.push(
      renderSectionTable(
        contextWindow == null
          ? [['上下文窗口', '未知（当前模型不在内置模型表）']]
          : [
              [
                '上下文窗口',
                `${formatNumber(contextWindow)} (${(usagePct ?? 0).toFixed(1)}% 已用)`,
              ],
              ['窗口剩余(原始)', formatNumber(rawRemaining ?? 0)],
              ['窗口剩余(建议80%)', formatNumber(reservedRemaining ?? 0)],
            ],
      ),
    )

    sections.push('')
    sections.push('Thinking')
    sections.push(
      renderSectionTable([
        ['Gemini-3 档位配置', thinkingGemini3Level],
        ['非 Gemini-3 thinking budget', formatNumber(thinkingNonGemini3Budget)],
        [
          '当前模型生效',
          effectiveThinking.mode === 'level'
            ? `thinkingLevel=${effectiveThinking.level}`
            : `thinkingBudget=${formatNumber(effectiveThinking.budget)}`,
        ],
      ]),
    )

    sections.push('')
    sections.push('Memory')
    sections.push(
      renderSectionTable([
        ['MemoryRead', (globalConfig.memoryReadEnabled ?? true) ? '开' : '关'],
        ['MemoryWrite', (globalConfig.memoryWriteEnabled ?? true) ? '开' : '关'],
      ]),
    )

    sections.push('')
    sections.push('费用')
    sections.push(
      renderSectionTable([['当前会话累计', formatCost(cost)]]),
    )

    return sections.join('\n')
  },
} satisfies Command

export default status
