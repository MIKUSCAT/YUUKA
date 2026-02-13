import { randomUUID, UUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import {
  AssistantMessage,
  Message,
  ProgressMessage,
  UserMessage,
} from '@query'
import { getCommand, hasCommand } from '@commands'
import { MalformedCommandError } from './errors'
import { logError } from './log'
import { last, memoize } from 'lodash-es'
import type { SetToolJSXFn, Tool, ToolUseContext } from '@tool'
import { NO_CONTENT_MESSAGE } from '@services/llm'
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  Message as APIMessage,
  ContentBlockParam,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { getCwd } from '@utils/state'

// NOTE: Dynamic content processing for custom commands has been moved to
// src/services/customCommands.ts for better organization and reusability.
// The functions executeBashCommands and resolveFileReferences are no longer
// duplicated here but are imported when needed for custom command processing.

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
export const NO_RESPONSE_REQUESTED = 'No response requested.'

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

export const SYNTHETIC_ASSISTANT_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

function baseCreateAssistantMessage(
  content: ContentBlock[],
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    type: 'assistant',
    costUSD: 0,
    durationMs: 0,
    uuid: randomUUID(),
    message: {
      id: randomUUID(),
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
    },
    ...extra,
  }
}

export function createAssistantMessage(content: string): AssistantMessage {
  return baseCreateAssistantMessage([
    {
      type: 'text' as const,
      text: content === '' ? NO_CONTENT_MESSAGE : content,
      citations: [],
    },
  ])
}

export function createAssistantAPIErrorMessage(
  content: string,
): AssistantMessage {
  return baseCreateAssistantMessage(
    [
      {
        type: 'text' as const,
        text: content === '' ? NO_CONTENT_MESSAGE : content,
        citations: [],
      },
    ],
    { isApiErrorMessage: true },
  )
}

export type FullToolUseResult = {
  data: unknown // Matches tool's `Output` type
  resultForAssistant: ToolResultBlockParam['content']
}

export function createUserMessage(
  content: string | ContentBlockParam[],
  toolUseResult?: FullToolUseResult,
): UserMessage {
  const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    uuid: randomUUID(),
    toolUseResult,
  }
  return m
}

function stripWrappingQuotes(input: string): string {
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1)
  }
  return input
}

function isWindowsDrivePath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input)
}

function toWslPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/')
  const drive = normalized[0]?.toLowerCase()
  const rest = normalized.slice(2)
  const trimmed = rest.startsWith('/') ? rest.slice(1) : rest
  return `/mnt/${drive}/${trimmed}`
}

function normalizeCandidate(candidate: string): string {
  let cleaned = stripWrappingQuotes(candidate.trim())
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.slice(1)
  }
  cleaned = cleaned.replace(/[)\],;]+$/g, '')
  return cleaned
}

function extractImageCandidates(input: string): string[] {
  const text = stripWrappingQuotes(input.trim())
  if (!text) return []

  const candidates: string[] = []
  const ext = '(?:png|jpe?g|webp|heic|heif)'

  const bracket = new RegExp(`\\[([^\\s\\]]+\\.${ext})(?:\\s[^\\]]*)?\\]`, 'i')
  const bracketMatch = text.match(bracket)
  if (bracketMatch?.[1]) {
    candidates.push(bracketMatch[1])
  }

  const driveRegex = new RegExp(`([A-Za-z]:[\\\\/][^\\r\\n]*?\\.${ext})`, 'gi')
  let match: RegExpExecArray | null = null
  while ((match = driveRegex.exec(text)) !== null) {
    candidates.push(match[1])
  }

  const uncRegex = new RegExp(`(\\\\\\\\[^\\r\\n]*?\\.${ext})`, 'gi')
  while ((match = uncRegex.exec(text)) !== null) {
    candidates.push(match[1])
  }

  const posixRegex = new RegExp(`((?:~\\/|\\.{1,2}\\/|\\/)[^\\r\\n]*?\\.${ext})`, 'gi')
  while ((match = posixRegex.exec(text)) !== null) {
    candidates.push(match[1])
  }

  if (new RegExp(`\\.${ext}$`, 'i').test(text)) {
    candidates.push(text)
  }

  return candidates
}

function resolveImagePath(input: string): { data: string; mimeType: string } | null {
  const trimmed = stripWrappingQuotes(input.trim())
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return null

  const candidates = extractImageCandidates(trimmed).map(normalizeCandidate)
  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.startsWith('@')) continue

    let fullPath = candidate
    if (isWindowsDrivePath(candidate) && process.platform !== 'win32') {
      fullPath = toWslPath(candidate)
    } else if (!isAbsolute(candidate) && !candidate.startsWith('\\\\')) {
      fullPath = resolve(getCwd(), candidate)
    }

    if (!existsSync(fullPath)) continue

    try {
      const stat = statSync(fullPath)
      if (!stat.isFile()) continue
    } catch {
      continue
    }

    const ext = extname(fullPath).toLowerCase()
    const mimeType = IMAGE_MIME_TYPES[ext]
    if (!mimeType) continue

    try {
      const data = readFileSync(fullPath).toString('base64')
      return { data, mimeType }
    } catch {
      continue
    }
  }

  return null
}

export function createProgressMessage(
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  content: AssistantMessage,
  normalizedMessages: NormalizedMessage[],
  tools: Tool[],
): ProgressMessage {
  return {
    type: 'progress',
    content,
    normalizedMessages,
    siblingToolUseIDs,
    tools,
    toolUseID,
    uuid: randomUUID(),
  }
}

export function createToolResultStopMessage(
  toolUseID: string,
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}

export async function processUserInput(
  input: string,
  setToolJSX: SetToolJSXFn,
  context: ToolUseContext & {
    setForkConvoWithMessagesOnTheNextRender: (
      forkConvoWithMessages: Message[],
    ) => void
  },
  pastedImage: string | null,
): Promise<Message[]> {
  // Slash commands
  if (input.startsWith('/')) {
    const words = input.slice(1).split(' ')
    let commandName = words[0]
    if (!commandName) {
      
      return [
        createAssistantMessage('Commands are in the form `/command [args]`'),
      ]
    }

    // Check if it's a real command before processing
    if (!hasCommand(commandName, context.options.commands)) {
      // If not a real command, treat it as a regular user input
      
      return [createUserMessage(input)]
    }

    const args = input.slice(commandName.length + 2)
    const newMessages = await getMessagesForSlashCommand(
      commandName,
      args,
      setToolJSX,
      context,
    )

    // Local JSX commands
    if (newMessages.length === 0) {
      
      return []
    }

    // For invalid commands, preserve both the user message and error
    if (
      newMessages.length === 2 &&
      newMessages[0]!.type === 'user' &&
      newMessages[1]!.type === 'assistant' &&
      typeof newMessages[1]!.message.content === 'string' &&
      newMessages[1]!.message.content.startsWith('Unknown command:')
    ) {
      
      return newMessages
    }

    // User-Assistant pair (eg. local commands)
    if (newMessages.length === 2) {
      
      return newMessages
    }

    // A valid command
    
    return newMessages
  }

  // Regular user prompt
  

  // Create base message
  let userMessage: UserMessage

  if (pastedImage) {
    userMessage = createUserMessage([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: pastedImage,
        },
      },
      {
        type: 'text',
        text: input,
      },
    ])
  } else {
    const imageFromPath = resolveImagePath(input)
    if (imageFromPath) {
      userMessage = createUserMessage([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageFromPath.mimeType as ImageBlockParam.Source['media_type'],
            data: imageFromPath.data,
          },
        },
        {
          type: 'text',
          text: input,
        },
      ])
      return [userMessage]
    }

    // 仅保留 @mention 侧边能力（例如 @run-agent-xxx 触发提醒/委派）
    if (input.includes('@')) {
      try {
        const { processMentions } = await import('@services/mentionProcessor')
        await processMentions(input)
      } catch {
        // 忽略：不影响主流程
      }
    }

    userMessage = createUserMessage(input)
  }

  return [userMessage]
}

async function getMessagesForSlashCommand(
  commandName: string,
  args: string,
  setToolJSX: SetToolJSXFn,
  context: ToolUseContext & {
    setForkConvoWithMessagesOnTheNextRender: (
      forkConvoWithMessages: Message[],
    ) => void
  },
): Promise<Message[]> {
  try {
    const command = getCommand(commandName, context.options.commands)
    switch (command.type) {
      case 'local-jsx': {
        return new Promise(resolve => {
          command
            .call(r => {
              setToolJSX(null)
              const trimmed = typeof r === 'string' ? r.trim() : ''
	              if (!trimmed) {
	                resolve([
	                  createUserMessage(`<command-name>${command.userFacingName()}</command-name>
	          <command-message>${command.userFacingName()}</command-message>
	          <command-args>${args}</command-args>`),
	                  createAssistantMessage(NO_RESPONSE_REQUESTED),
	                ])
	                return
	              }

              resolve([
                createUserMessage(`<command-name>${command.userFacingName()}</command-name>
          <command-message>${command.userFacingName()}</command-message>
          <command-args>${args}</command-args>`),
                createAssistantMessage(r),
              ])
            }, context, args)
            .then(jsx => {
              setToolJSX({
                jsx,
                shouldHidePromptInput: true,
              })
            })
        })
      }
      case 'local': {
        const userMessage =
          createUserMessage(`<command-name>${command.userFacingName()}</command-name>
        <command-message>${command.userFacingName()}</command-message>
        <command-args>${args}</command-args>`)

        try {
          // Use the context's abortController for local commands
          const result = await command.call(args, {
            ...context,
            options: {
              commands: context.options.commands || [],
              tools: context.options.tools || [],
              slowAndCapableModel: context.options.slowAndCapableModel || 'main'
            }
          })

	          const trimmed = typeof result === 'string' ? result.trim() : ''
	          if (!trimmed) {
	            return [userMessage, createAssistantMessage(NO_RESPONSE_REQUESTED)]
	          }

          return [
            userMessage,
            createAssistantMessage(
              `<local-command-stdout>${result}</local-command-stdout>`,
            ),
          ]
        } catch (e) {
          logError(e)
          return [
            userMessage,
            createAssistantMessage(
              `<local-command-stderr>${String(e)}</local-command-stderr>`,
            ),
          ]
        }
      }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return [createAssistantMessage(e.message)]
    }
    throw e
  }
}

export function extractTagFromMessage(
  message: Message,
  tagName: string,
): string | null {
  if (message.type === 'progress') {
    return null
  }
  if (typeof message.message.content !== 'string') {
    return null
  }
  return extractTag(message.message.content, tagName)
}

export function extractTag(html: string, tagName: string): string | null {
  if (!html.trim() || !tagName.trim()) {
    return null
  }

  // Escape special characters in the tag name
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Create regex pattern that handles:
  // 1. Self-closing tags
  // 2. Tags with attributes
  // 3. Nested tags of the same type
  // 4. Multiline content
  const pattern = new RegExp(
    `<${escapedTag}(?:\\s+[^>]*)?>` + // Opening tag with optional attributes
      '([\\s\\S]*?)' + // Content (non-greedy match)
      `<\\/${escapedTag}>`, // Closing tag
    'gi',
  )

  let match
  let depth = 0
  let lastIndex = 0
  const openingTag = new RegExp(`<${escapedTag}(?:\\s+[^>]*?)?>`, 'gi')
  const closingTag = new RegExp(`<\\/${escapedTag}>`, 'gi')

  while ((match = pattern.exec(html)) !== null) {
    // Check for nested tags
    const content = match[1]
    const beforeMatch = html.slice(lastIndex, match.index)

    // Reset depth counter
    depth = 0

    // Count opening tags before this match
    openingTag.lastIndex = 0
    while (openingTag.exec(beforeMatch) !== null) {
      depth++
    }

    // Count closing tags before this match
    closingTag.lastIndex = 0
    while (closingTag.exec(beforeMatch) !== null) {
      depth--
    }

    // Only include content if we're at the correct nesting level
    if (depth === 0 && content) {
      return content
    }

    lastIndex = match.index + match[0].length
  }

  return null
}

export function isNotEmptyMessage(message: Message): boolean {
  if (message.type === 'progress') {
    return true
  }

  if (typeof message.message.content === 'string') {
    return message.message.content.trim().length > 0
  }

  if (message.message.content.length === 0) {
    return false
  }

  // Skip multi-block messages for now
  if (message.message.content.length > 1) {
    return true
  }

  if (message.message.content[0]!.type !== 'text') {
    return true
  }

  return (
    message.message.content[0]!.text.trim().length > 0 &&
    message.message.content[0]!.text !== NO_CONTENT_MESSAGE &&
    message.message.content[0]!.text !== INTERRUPT_MESSAGE_FOR_TOOL_USE
  )
}

// TODO: replace this with plain UserMessage if/when PR #405 lands
type NormalizedUserMessage = {
  message: {
    content: [
      | TextBlockParam
      | ImageBlockParam
      | ToolUseBlockParam
      | ToolResultBlockParam,
    ]
    role: 'user'
  }
  type: 'user'
  uuid: UUID
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | AssistantMessage
  | ProgressMessage

function createDeterministicBlockUUID(
  assistantUUID: UUID,
  blockIndex: number,
): UUID {
  const parts = String(assistantUUID).split('-')
  if (parts.length !== 5) {
    return randomUUID()
  }

  const tail = Number.parseInt(parts[4]!, 16)
  const safeIndex = Math.max(0, blockIndex)
  const stableTail = Number.isFinite(tail)
    ? ((tail + safeIndex) % 0x1_0000_0000_0000)
        .toString(16)
        .padStart(12, '0')
    : safeIndex.toString(16).padStart(12, '0').slice(-12)

  return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${stableTail}` as UUID
}

// Split assistant messages, so each content block gets its own message.
// Keep user messages intact to avoid duplicating the same uuid when content has multiple blocks.
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  return messages.flatMap(message => {
    if (message.type === 'progress') {
      return [message] as NormalizedMessage[]
    }
    if (typeof message.message.content === 'string') {
      return [message] as NormalizedMessage[]
    }
    if (message.type === 'user') {
      return [message as NormalizedUserMessage]
    }

    return message.message.content.map((block, blockIndex) => {
      return {
        type: 'assistant',
        uuid: createDeterministicBlockUUID(message.uuid, blockIndex),
        message: {
          ...message.message,
          content: [block],
        },
        costUSD:
          (message as AssistantMessage).costUSD / message.message.content.length,
        durationMs: (message as AssistantMessage).durationMs,
      } as NormalizedMessage
    })
  })
}

type ToolUseRequestMessage = AssistantMessage & {
  message: { content: ToolUseBlock[] }
}

function isToolUseRequestMessage(
  message: Message,
): message is ToolUseRequestMessage {
  return (
    message.type === 'assistant' &&
    'costUSD' in message &&
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
    message.message.content.some(_ => _.type === 'tool_use')
  )
}

// Re-order, to move result messages to be after their tool use messages
export function reorderMessages(
  messages: NormalizedMessage[],
): NormalizedMessage[] {
  const ms: NormalizedMessage[] = []
  const toolUseMessages: ToolUseRequestMessage[] = []

  for (const message of messages) {
    // track tool use messages we've seen
    if (isToolUseRequestMessage(message)) {
      toolUseMessages.push(message)
    }

    // if it's a tool progress message...
    if (message.type === 'progress') {
      // replace any existing progress messages with this one
      const existingProgressMessage = ms.find(
        _ => _.type === 'progress' && _.toolUseID === message.toolUseID,
      )
      if (existingProgressMessage) {
        ms[ms.indexOf(existingProgressMessage)] = message
        continue
      }
      // otherwise, insert it after its tool use
      const toolUseMessage = toolUseMessages.find(
        _ => _.message.content[0]?.id === message.toolUseID,
      )
      if (toolUseMessage) {
        ms.splice(ms.indexOf(toolUseMessage) + 1, 0, message)
        continue
      }
    }

    // if it's a tool result, insert it after its tool use and progress messages
    if (
      message.type === 'user' &&
      Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'tool_result'
    ) {
      const toolUseID = (message.message.content[0] as ToolResultBlockParam)
        ?.tool_use_id

      // First check for progress messages
      const lastProgressMessage = ms.find(
        _ => _.type === 'progress' && _.toolUseID === toolUseID,
      )
      if (lastProgressMessage) {
        ms.splice(ms.indexOf(lastProgressMessage) + 1, 0, message)
        continue
      }

      // If no progress messages, check for tool use messages
      const toolUseMessage = toolUseMessages.find(
        _ => _.message.content[0]?.id === toolUseID,
      )
      if (toolUseMessage) {
        ms.splice(ms.indexOf(toolUseMessage) + 1, 0, message)
        continue
      }
    }

    // otherwise, just add it to the list
    else {
      ms.push(message)
    }
  }

  return ms
}

const getToolResultIDs = memoize(
  (normalizedMessages: NormalizedMessage[]): { [toolUseID: string]: boolean } =>
    Object.fromEntries(
      normalizedMessages.flatMap(_ =>
        _.type === 'user' && _.message.content[0]?.type === 'tool_result'
          ? [
              [
                _.message.content[0]!.tool_use_id,
                _.message.content[0]!.is_error ?? false,
              ],
            ]
          : ([] as [string, boolean][]),
      ),
    ),
)

export function getUnresolvedToolUseIDs(
  normalizedMessages: NormalizedMessage[],
): Set<string> {
  const toolResults = getToolResultIDs(normalizedMessages)
  return new Set(
    normalizedMessages
      .filter(
        (
          _,
        ): _ is AssistantMessage & {
          message: { content: [ToolUseBlockParam] }
        } =>
          _.type === 'assistant' &&
          Array.isArray(_.message.content) &&
          _.message.content[0]?.type === 'tool_use' &&
          !(_.message.content[0]?.id in toolResults),
      )
      .map(_ => _.message.content[0].id),
  )
}

/**
 * Tool uses are in flight if either:
 * 1. They have a corresponding progress message and no result message
 * 2. They are the first unresoved tool use
 *
 * TODO: Find a way to harden this logic to make it more explicit
 */
export function getInProgressToolUseIDs(
  normalizedMessages: NormalizedMessage[],
): Set<string> {
  const unresolvedToolUseIDs = getUnresolvedToolUseIDs(normalizedMessages)
  const toolUseIDsThatHaveProgressMessages = new Set(
    normalizedMessages.filter(_ => _.type === 'progress').map(_ => _.toolUseID),
  )
  return new Set(
    (
      normalizedMessages.filter(_ => {
        if (_.type !== 'assistant') {
          return false
        }
        if (_.message.content[0]?.type !== 'tool_use') {
          return false
        }
        const toolUseID = _.message.content[0].id
        if (toolUseID === unresolvedToolUseIDs.values().next().value) {
          return true
        }

        if (
          toolUseIDsThatHaveProgressMessages.has(toolUseID) &&
          unresolvedToolUseIDs.has(toolUseID)
        ) {
          return true
        }

        return false
      }) as AssistantMessage[]
    ).map(_ => (_.message.content[0]! as ToolUseBlockParam).id),
  )
}

export function getErroredToolUseMessages(
  normalizedMessages: NormalizedMessage[],
): AssistantMessage[] {
  const toolResults = getToolResultIDs(normalizedMessages)
  return normalizedMessages.filter(
    _ =>
      _.type === 'assistant' &&
      Array.isArray(_.message.content) &&
      _.message.content[0]?.type === 'tool_use' &&
      _.message.content[0]?.id in toolResults &&
      toolResults[_.message.content[0]?.id],
  ) as AssistantMessage[]
}

export function normalizeMessagesForAPI(
  messages: Message[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []
  messages
    .filter(_ => _.type !== 'progress')
    .forEach(message => {
      switch (message.type) {
        case 'user': {
          // If the current message is not a tool result, add it to the result
          if (
            !Array.isArray(message.message.content) ||
            message.message.content[0]?.type !== 'tool_result'
          ) {
            result.push(message)
            return
          }

          // If the last message is not a tool result, add it to the result
          const lastMessage = last(result)
          if (
            !lastMessage ||
            lastMessage?.type === 'assistant' ||
            !Array.isArray(lastMessage.message.content) ||
            lastMessage.message.content[0]?.type !== 'tool_result'
          ) {
            result.push(message)
            return
          }

          // Otherwise, merge the current message with the last message
          result[result.indexOf(lastMessage)] = {
            ...lastMessage,
            message: {
              ...lastMessage.message,
              content: [
                ...lastMessage.message.content,
                ...message.message.content,
              ],
            },
          }
          return
        }
        case 'assistant':
          result.push(message)
          return
      }
    })
  return result
}

// Sometimes the API returns empty messages (eg. "\n\n"). We need to filter these out,
// otherwise they will give an API error when we send them to the API next time we call query().
export function normalizeContentFromAPI(
  content: APIMessage['content'],
): APIMessage['content'] {
  const filteredContent = content.filter(
    _ => {
      // Fix: Filter out thinking and redacted_thinking blocks to prevent them from being rendered
      if ((_.type as string) === 'thinking' || (_.type as string) === 'redacted_thinking') {
        return false
      }
      // Filter out empty text blocks
      return _.type !== 'text' || _.text.trim().length > 0
    }
  )

  if (filteredContent.length === 0) {
    return [{ type: 'text', text: NO_CONTENT_MESSAGE, citations: [] }]
  }

  return filteredContent
}

export function isEmptyMessageText(text: string): boolean {
  return (
    stripSystemMessages(text).trim() === '' ||
    text.trim() === NO_CONTENT_MESSAGE
  )
}
const STRIPPED_TAGS = [
  'commit_analysis',
  'context',
  'function_analysis',
  'pr_analysis',
]

export function stripSystemMessages(content: string): string {
  const regex = new RegExp(`<(${STRIPPED_TAGS.join('|')})>.*?</\\1>\n?`, 'gs')
  return content.replace(regex, '').trim()
}

export function getToolUseID(message: NormalizedMessage): string | null {
  switch (message.type) {
    case 'assistant':
      if (message.message.content[0]?.type !== 'tool_use') {
        return null
      }
      return message.message.content[0].id
    case 'user':
      if (message.message.content[0]?.type !== 'tool_result') {
        return null
      }
      return message.message.content[0].tool_use_id
    case 'progress':
      return message.toolUseID
  }
}

export function getLastAssistantMessageId(
  messages: Message[],
): string | undefined {
  // Iterate from the end of the array to find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      return message.message.id
    }
  }
  return undefined
}
