import { MACRO } from '@constants/macros'
import { PRODUCT_NAME } from '@constants/product'

const USER_AGENT_MODEL_FALLBACK = 'unknown'

function normalizeUserAgentModel(model?: string): string {
  const trimmed = String(model ?? '').trim()
  if (!trimmed) return USER_AGENT_MODEL_FALLBACK
  if (trimmed.startsWith('models/')) return trimmed.slice('models/'.length)
  return trimmed
}

export function getYuukaUserAgent(model?: string): string {
  const version =
    String(
      process.env['YUUKA_VERSION'] ??
        process.env['npm_package_version'] ??
        MACRO.VERSION ??
        '',
    ).trim() || '0.0.0'
  const normalizedModel = normalizeUserAgentModel(model)
  return `${PRODUCT_NAME}/${version}/${normalizedModel} (${process.platform}; ${process.arch})`
}

