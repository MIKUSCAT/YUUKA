import { randomUUID } from 'crypto'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '@tool'
import { getToolDescription } from '@tool'
import type { AssistantMessage, UserMessage } from '@query'
import type { GeminiContent, GeminiFunctionDeclaration, GeminiPart } from './types'

function createCallId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function extractToolResultOutputAndInlineData(content: unknown): {
  output: string
  inlineDataParts: GeminiPart[]
} {
  if (typeof content === 'string') {
    return { output: content, inlineDataParts: [] }
  }

  if (!Array.isArray(content)) {
    return { output: String(content ?? ''), inlineDataParts: [] }
  }

  const textParts: string[] = []
  const inlineDataParts: GeminiPart[] = []

  for (const part of content) {
    if (!part || typeof part !== 'object') continue

    if ((part as any).type === 'text') {
      const text = String((part as any).text ?? '')
      if (text.trim()) textParts.push(text)
      continue
    }

    if ((part as any).type === 'image') {
      const source = (part as any).source
      const base64Data = source?.type === 'base64' ? String(source?.data ?? '') : ''
      const mimeTypeRaw = source?.media_type ?? source?.mediaType ?? source?.mimeType
      const mimeType = typeof mimeTypeRaw === 'string' ? mimeTypeRaw : ''

      if (base64Data && mimeType) {
        inlineDataParts.push({ inlineData: { mimeType, data: base64Data } })
      }
      continue
    }
  }

  let output = textParts.join('\n')
  if (!output.trim() && inlineDataParts.length > 0) {
    output = '（已附工具返回的图片）'
  }
  if (!output.trim()) {
    try {
      output = JSON.stringify(content)
    } catch {
      output = String(content)
    }
  }

  return { output, inlineDataParts }
}

function buildToolNameIndex(
  messages: (UserMessage | AssistantMessage)[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = (m as any).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id && block.name) {
        map.set(String(block.id), String(block.name))
      }
    }
  }
  return map
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  return value
}

function normalizeType(value: unknown): { type?: string; nullable?: boolean } {
  if (Array.isArray(value)) {
    const types = value.filter(v => typeof v === 'string') as string[]
    const nullable = types.includes('null')
    const first = types.find(t => t !== 'null')
    return { type: first, nullable }
  }
  if (typeof value === 'string') {
    return { type: value }
  }
  return {}
}

function sanitizeUnionSchema(
  base: Record<string, unknown>,
  union: unknown[],
): Record<string, unknown> {
  let nullable = false
  let candidate: unknown = undefined

  for (const item of union) {
    if (isRecord(item)) {
      const typeInfo = normalizeType(item.type)
      if (typeInfo.nullable) nullable = true
      if (typeInfo.type && typeInfo.type !== 'null' && candidate === undefined) {
        candidate = item
      }
    }
  }

  if (!candidate && union.length > 0) {
    candidate = union[0]
  }

  const sanitized = sanitizeSchemaNode(candidate)
  if (typeof base.description === 'string' && !('description' in sanitized)) {
    sanitized.description = base.description
  }
  if (nullable) {
    sanitized.nullable = true
  }
  return sanitized
}

function sanitizeSchemaNode(node: unknown): Record<string, unknown> {
  if (!isRecord(node)) {
    return { type: 'object', properties: {} }
  }

  if (node.$ref) {
    return { type: 'object', properties: {} }
  }

  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)) {
    const union = (node.anyOf || node.oneOf || node.allOf) as unknown[]
    return sanitizeUnionSchema(node, union)
  }

  const out: Record<string, unknown> = {}

  const typeInfo = normalizeType(node.type)
  if (typeInfo.type) out.type = typeInfo.type
  if (typeInfo.nullable) out.nullable = true

  if (typeof node.description === 'string') {
    out.description = node.description
  }
  if (typeof node.format === 'string') {
    out.format = node.format
  }

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    out.enum = node.enum.filter(
      v =>
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        v === null,
    )
  }

  if (Array.isArray(node.required) && node.required.length > 0) {
    out.required = node.required.filter(v => typeof v === 'string')
  }

  if (isRecord(node.properties)) {
    const props: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node.properties)) {
      props[key] = sanitizeSchemaNode(value)
    }
    out.properties = props
  }

  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      out.items = node.items.map(item => sanitizeSchemaNode(item))
    } else {
      out.items = sanitizeSchemaNode(node.items)
    }
  }

  const minimum = toNumber(node.minimum)
  const maximum = toNumber(node.maximum)
  const exclusiveMinimum = toNumber(node.exclusiveMinimum)
  const exclusiveMaximum = toNumber(node.exclusiveMaximum)

  if (minimum !== undefined) out.minimum = minimum
  else if (exclusiveMinimum !== undefined) out.minimum = exclusiveMinimum
  if (maximum !== undefined) out.maximum = maximum
  else if (exclusiveMaximum !== undefined) out.maximum = exclusiveMaximum

  const minItems = toNumber(node.minItems)
  const maxItems = toNumber(node.maxItems)
  if (minItems !== undefined) out.minItems = minItems
  if (maxItems !== undefined) out.maxItems = maxItems

  const minLength = toNumber(node.minLength)
  const maxLength = toNumber(node.maxLength)
  if (minLength !== undefined) out.minLength = minLength
  if (maxLength !== undefined) out.maxLength = maxLength

  if (typeof node.pattern === 'string') {
    out.pattern = node.pattern
  }

  return out
}

function sanitizeJsonSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSchemaNode(schema)
}

export function toolsToFunctionDeclarations(tools: Tool[]): GeminiFunctionDeclaration[] {
  return tools.map(tool => {
    const rawSchema =
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : (zodToJsonSchema(tool.inputSchema as any, {
            $refStrategy: 'none',
          } as any) as Record<string, unknown>)

    return {
      name: tool.name,
      description: getToolDescription(tool),
      parameters: sanitizeJsonSchemaForGemini(rawSchema),
    }
  })
}

export function kodeMessagesToGeminiContents(
  messages: (UserMessage | AssistantMessage)[],
): GeminiContent[] {
  const toolNameById = buildToolNameIndex(messages)

  const contents: GeminiContent[] = []

  for (const msg of messages) {
    const role = msg.type === 'assistant' ? 'model' : 'user'
    const rawContent = (msg as any).message?.content

    const parts: GeminiPart[] = []
    const extraContents: GeminiContent[] = []

    if (typeof rawContent === 'string') {
      if (rawContent.trim()) parts.push({ text: rawContent })
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (!block || typeof block !== 'object') continue

        if (block.type === 'text') {
          const text = String((block as any).text ?? '')
          if (text.trim()) parts.push({ text })
          continue
        }

        if (block.type === 'image') {
          const source = (block as any).source
          if (source?.type === 'base64' && source?.data && source?.media_type) {
            parts.push({
              inlineData: { mimeType: String(source.media_type), data: String(source.data) },
            })
          }
          continue
        }

        if (block.type === 'tool_use' && role === 'model') {
          const id = (block as any).id ? String((block as any).id) : undefined
          const name = String((block as any).name ?? 'undefined_tool_name')
          const args = (block as any).input ?? {}

          const rawThoughtSignature =
            typeof (block as any).thoughtSignature === 'string'
              ? (block as any).thoughtSignature
              : typeof (block as any).thought_signature === 'string'
                ? (block as any).thought_signature
                : undefined
          const thoughtSignature =
            typeof rawThoughtSignature === 'string' && rawThoughtSignature.trim()
              ? rawThoughtSignature.trim()
              : undefined

          parts.push({
            functionCall: {
              id,
              name,
              args: (args && typeof args === 'object') ? args : {},
            },
            ...(thoughtSignature ? { thoughtSignature } : {}),
          })
          continue
        }

        if (block.type === 'tool_result' && role === 'user') {
          const toolUseId = String((block as any).tool_use_id ?? '')
          const toolName = toolNameById.get(toolUseId) ?? 'unknown_tool'
          const { output, inlineDataParts } = extractToolResultOutputAndInlineData(
            (block as any).content,
          )

          parts.push({
            functionResponse: {
              id: toolUseId,
              name: toolName,
              response: { output },
            },
          })
          if (inlineDataParts.length > 0) {
            extraContents.push({
              role: 'user',
              parts: [{ text: '（工具返回了图片，供你参考）' }, ...inlineDataParts],
            })
          }
          continue
        }
      }
    }

    // Gemini 不接受空 parts
    if (parts.length === 0) {
      parts.push({ text: '' })
    }

    contents.push({ role, parts })
    if (extraContents.length > 0) {
      contents.push(...extraContents)
    }
  }

  return contents
}

export function geminiResponseToAssistantMessage(
  response: {
    candidates?: Array<{ content?: { parts?: any[] } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  },
  options: { model: string; durationMs: number },
): AssistantMessage {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  const contentBlocks: any[] = []
  let textBuffer = ''

  const flushText = () => {
    if (!textBuffer.trim()) {
      textBuffer = ''
      return
    }
    contentBlocks.push({ type: 'text', text: textBuffer, citations: [] })
    textBuffer = ''
  }

  for (const part of parts) {
    const thoughtFlag = (part as any)?.thought
    if (thoughtFlag === true || typeof thoughtFlag === 'string') {
      continue
    }

    if (part?.text !== undefined) {
      textBuffer += String(part.text ?? '')
      continue
    }

    if (part?.functionCall) {
      flushText()
      const call = part.functionCall
      const name = String(call?.name ?? 'undefined_tool_name')
      const id = call?.id ? String(call.id) : createCallId(name)
      const args = call?.args && typeof call.args === 'object' ? call.args : {}
      const rawThoughtSignature =
        typeof (part as any).thoughtSignature === 'string'
          ? (part as any).thoughtSignature
          : typeof (part as any).thought_signature === 'string'
            ? (part as any).thought_signature
            : undefined
      const thoughtSignature =
        typeof rawThoughtSignature === 'string' && rawThoughtSignature.trim()
          ? rawThoughtSignature.trim()
          : undefined

      contentBlocks.push({
        type: 'tool_use',
        id,
        name,
        input: args,
        ...(thoughtSignature ? { thoughtSignature } : {}),
      })
      continue
    }
  }

  flushText()

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '(No content)', citations: [] })
  }

  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0

  return {
    type: 'assistant',
    uuid: randomUUID(),
    durationMs: options.durationMs,
    costUSD: 0,
    message: {
      id: randomUUID(),
      model: options.model,
      role: 'assistant',
      stop_reason: contentBlocks.some(b => b.type === 'tool_use')
        ? 'tool_use'
        : 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: contentBlocks,
    } as any,
  }
}
