import { Message } from '@query'
import { SYNTHETIC_ASSISTANT_MESSAGES } from './messages'

function estimateTokensFromText(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  // 粗估：1 token ≈ 4 chars（中英文混合也够用，宁可偏大一点）
  return Math.ceil(trimmed.length * 0.25)
}

function estimateTokensFromUnknown(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return estimateTokensFromText(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return estimateTokensFromText(String(value))
  }
  try {
    return estimateTokensFromText(JSON.stringify(value))
  } catch {
    return estimateTokensFromText(String(value))
  }
}

function estimateTokensFromContent(content: unknown): number {
  if (typeof content === 'string') return estimateTokensFromText(content)
  if (!Array.isArray(content)) return estimateTokensFromUnknown(content)

  let tokens = 0
  for (const block of content as any[]) {
    if (!block || typeof block !== 'object') {
      tokens += estimateTokensFromUnknown(block)
      continue
    }
    const type = String((block as any).type ?? '')
    if (type === 'text') {
      tokens += estimateTokensFromText(String((block as any).text ?? ''))
      continue
    }
    if (type === 'tool_use') {
      const name = String((block as any).name ?? '')
      tokens += estimateTokensFromText(name)
      tokens += estimateTokensFromUnknown((block as any).input)
      continue
    }
    if (type === 'tool_result') {
      tokens += estimateTokensFromContent((block as any).content)
      continue
    }
    if (type === 'image') {
      // 图片（base64）会显著占上下文/请求体大小，粗估把 data 算进去
      const data = (block as any)?.source?.data
      if (typeof data === 'string') {
        tokens += estimateTokensFromText(data)
      }
      continue
    }
    tokens += estimateTokensFromUnknown(block)
  }
  return tokens
}

function estimateTokensFromMessages(messages: Message[]): number {
  let tokens = 0
  for (const message of messages) {
    if (!message || message.type === 'progress') continue
    const raw = (message as any)?.message?.content
    tokens += estimateTokensFromContent(raw)
    // 给每条消息一点固定开销（role、包装、分隔符等）
    tokens += 8
  }
  return tokens
}

export function countTokens(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    if (
      message?.type === 'assistant' &&
      'usage' in message.message &&
      !(message as any)?.isApiErrorMessage &&
      message.message?.model !== '<synthetic>' &&
      !(
        message.message.content[0]?.type === 'text' &&
        SYNTHETIC_ASSISTANT_MESSAGES.has(message.message.content[0].text)
      )
    ) {
      const { usage } = message.message
      const total =
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        usage.output_tokens
      // usage 为 0 的 synthetic/error message 会把自动 compact 卡死：继续往前找
      if (total > 0) {
        const extra = estimateTokensFromMessages(messages.slice(i + 1))
        return total + extra
      }
    }
    i--
  }
  // 某些通道不返回 usage：退化成基于文本长度的粗估，避免永远不触发 auto-compact
  return estimateTokensFromMessages(messages)
}

export function countCachedTokens(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    if (
      message?.type === 'assistant' &&
      'usage' in message.message &&
      !(message as any)?.isApiErrorMessage &&
      message.message?.model !== '<synthetic>'
    ) {
      const { usage } = message.message
      const cached =
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      if (cached > 0) return cached
    }
    i--
  }
  return 0
}
