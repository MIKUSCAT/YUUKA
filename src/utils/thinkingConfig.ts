import type { GlobalConfig } from './config'
import { getGlobalConfig } from './config'
import { normalizeGeminiModelName } from './geminiSettings'

export type ThinkingGemini3Level = 'low' | 'high'

export const DEFAULT_GEMINI3_THINKING_LEVEL: ThinkingGemini3Level = 'high'
export const DEFAULT_NON_GEMINI3_THINKING_BUDGET = 8192

type ThinkingConfigSource = Pick<
  GlobalConfig,
  'thinkingGemini3Level' | 'thinkingNonGemini3Budget'
>

function normalizeGemini3Level(value: unknown): ThinkingGemini3Level {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'low' || normalized === 'high') {
    return normalized
  }
  return DEFAULT_GEMINI3_THINKING_LEVEL
}

function normalizeNonGemini3Budget(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_NON_GEMINI3_THINKING_BUDGET
  }
  return Math.floor(parsed)
}

function readConfig(
  config?: Partial<ThinkingConfigSource>,
): ThinkingConfigSource {
  const source = config ?? getGlobalConfig()
  return {
    thinkingGemini3Level: normalizeGemini3Level(source.thinkingGemini3Level),
    thinkingNonGemini3Budget: normalizeNonGemini3Budget(
      source.thinkingNonGemini3Budget,
    ),
  }
}

export function getThinkingGemini3Level(
  config?: Partial<ThinkingConfigSource>,
): ThinkingGemini3Level {
  return readConfig(config).thinkingGemini3Level
}

export function getThinkingNonGemini3Budget(
  config?: Partial<ThinkingConfigSource>,
): number {
  return readConfig(config).thinkingNonGemini3Budget
}

function isGemini3Model(modelName: string): boolean {
  const normalized = normalizeGeminiModelName(modelName)
    .replace(/^models\//, '')
    .toLowerCase()
  return normalized.startsWith('gemini-3')
}

export type EffectiveThinkingSetting =
  | { mode: 'level'; level: 'LOW' | 'HIGH' }
  | { mode: 'budget'; budget: number }

export function getEffectiveThinkingSetting(
  modelName: string,
  config?: Partial<ThinkingConfigSource>,
): EffectiveThinkingSetting {
  const merged = readConfig(config)
  if (isGemini3Model(modelName)) {
    return {
      mode: 'level',
      level: merged.thinkingGemini3Level === 'low' ? 'LOW' : 'HIGH',
    }
  }
  return {
    mode: 'budget',
    budget: merged.thinkingNonGemini3Budget,
  }
}
