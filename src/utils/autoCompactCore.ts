import { Message } from '@query'
import { countTokens } from './tokens'
import { getMessagesGetter, getMessagesSetter } from '@messages'
import { getContext } from '@context'
import { getCodeStyle } from '@utils/style'
import { clearTerminal } from '@utils/terminal'
import { resetFileFreshnessSession } from '@services/fileFreshness'
import { createUserMessage, normalizeMessagesForAPI } from '@utils/messages'
import { queryLLM } from '@services/claude'
import { selectAndReadFiles } from './fileRecoveryCore'
import { addLineNumbers } from './file'
import { getModelManager } from './model'

/**
 * Threshold ratio for triggering automatic context compression
 * When context usage exceeds 92% of the model's limit, auto-compact activates
 */
const AUTO_COMPACT_THRESHOLD_RATIO = 0.92

/**
 * Retrieves the context length for the main model that should execute compression
 * Uses ModelManager to get the current model's context length
 */
async function getCompressionModelContextLimit(): Promise<number> {
  try {
    // 🔧 Fix: Use ModelManager instead of legacy config
    const modelManager = getModelManager()
    const modelProfile = modelManager.getModel('main')

    if (modelProfile?.contextLength) {
      return modelProfile.contextLength
    }

    // Fallback to a reasonable default
    return 200_000
  } catch (error) {
    return 200_000
  }
}

const COMPRESSION_PROMPT = `Please provide a comprehensive summary of our conversation structured as follows:

## Technical Context
Development environment, tools, frameworks, and configurations in use. Programming languages, libraries, and technical constraints. File structure, directory organization, and project architecture.

## Project Overview  
Main project goals, features, and scope. Key components, modules, and their relationships. Data models, APIs, and integration patterns.

## Code Changes
Files created, modified, or analyzed during our conversation. Specific code implementations, functions, and algorithms added. Configuration changes and structural modifications.

## Debugging & Issues
Problems encountered and their root causes. Solutions implemented and their effectiveness. Error messages, logs, and diagnostic information.

## Current Status
What we just completed successfully. Current state of the codebase and any ongoing work. Test results, validation steps, and verification performed.

## Pending Tasks
Immediate next steps and priorities. Planned features, improvements, and refactoring. Known issues, technical debt, and areas needing attention.

## User Preferences
Coding style, formatting, and organizational preferences. Communication patterns and feedback style. Tool choices and workflow preferences.

## Key Decisions
Important technical decisions made and their rationale. Alternative approaches considered and why they were rejected. Trade-offs accepted and their implications.

Focus on information essential for continuing the conversation effectively, including specific details about code, files, errors, and plans.`

/**
 * Calculates context usage thresholds based on the main model's capabilities
 * Uses the main model context length since compression tasks require a capable model
 */
async function calculateThresholds(tokenCount: number) {
  const contextLimit = await getCompressionModelContextLimit()
  const autoCompactThreshold = contextLimit * AUTO_COMPACT_THRESHOLD_RATIO

  return {
    isAboveAutoCompactThreshold: tokenCount >= autoCompactThreshold,
    percentUsed: Math.round((tokenCount / contextLimit) * 100),
    tokensRemaining: Math.max(0, autoCompactThreshold - tokenCount),
    contextLimit,
  }
}

/**
 * Determines if auto-compact should trigger based on token usage
 * Uses the main model context limit since compression requires a capable model
 */
async function shouldAutoCompact(messages: Message[]): Promise<boolean> {
  if (messages.length < 3) return false

  const tokenCount = countTokens(messages)
  const { isAboveAutoCompactThreshold } = await calculateThresholds(tokenCount)

  return isAboveAutoCompactThreshold
}

function isProgressMessage(message: Message | undefined): boolean {
  return !!message && message.type === 'progress'
}

function isToolResultUserMessage(message: Message | undefined): boolean {
  if (!message || message.type !== 'user') return false
  const content = (message as any)?.message?.content
  return Array.isArray(content) && content[0]?.type === 'tool_result'
}

function lastNonProgressIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isProgressMessage(messages[i])) return i
  }
  return -1
}

function prevNonProgressIndex(messages: Message[], start: number): number {
  for (let i = start; i >= 0; i--) {
    if (!isProgressMessage(messages[i])) return i
  }
  return -1
}

function collectToolResultIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (!isToolResultUserMessage(msg)) continue
    const content = (msg as any)?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        ids.add(block.tool_use_id)
      }
    }
  }
  return ids
}

function findTailStartIndex(messages: Message[]): number {
  const end = lastNonProgressIndex(messages)
  if (end < 0) return 0

  // 1) 默认至少保留最后一条非 progress 消息（通常是当前用户输入/或 tool_result）
  let tailStart = end

  // 2) 如果尾部是一串 tool_result，全部一起保留（避免只留一半）
  if (isToolResultUserMessage(messages[tailStart])) {
    while (true) {
      const prev = prevNonProgressIndex(messages, tailStart - 1)
      if (prev < 0) break
      if (!isToolResultUserMessage(messages[prev])) break
      tailStart = prev
    }
  }

  // 3) 如果保留段里包含 tool_result，必须把对应的 tool_use assistant 一起保留（Gemini 邻接约束）
  const toolUseIds = collectToolResultIds(messages.slice(tailStart, end + 1))
  if (toolUseIds.size === 0) return tailStart

  for (let i = tailStart - 1; i >= 0 && toolUseIds.size > 0; i--) {
    const msg = messages[i]
    if (!msg || msg.type !== 'assistant') continue
    const content = (msg as any)?.message?.content
    if (!Array.isArray(content)) continue

    let hit = false
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        if (toolUseIds.has(block.id)) {
          toolUseIds.delete(block.id)
          hit = true
        }
      }
    }
    if (hit) {
      tailStart = i
    }
  }

  return tailStart
}

/**
 * Main entry point for automatic context compression
 *
 * This function is called before each query to check if the conversation
 * has grown too large and needs compression. When triggered, it:
 * - Generates a structured summary of the conversation using the main model
 * - Recovers recently accessed files to maintain development context
 * - Resets conversation state while preserving essential information
 *
 * Uses the main model for compression tasks to ensure high-quality summaries
 *
 * @param messages Current conversation messages
 * @param toolUseContext Execution context with model and tool configuration
 * @returns Updated messages (compressed if needed) and compression status
 */
export async function checkAutoCompact(
  messages: Message[],
  toolUseContext: any,
): Promise<{ messages: Message[]; wasCompacted: boolean }> {
  if (!(await shouldAutoCompact(messages))) {
    return { messages, wasCompacted: false }
  }

  try {
    const compactedMessages = await executeAutoCompact(messages, toolUseContext)

    return {
      messages: compactedMessages,
      wasCompacted: true,
    }
  } catch (error) {
    // Graceful degradation: if auto-compact fails, continue with original messages
    // This ensures system remains functional even if compression encounters issues
    console.error(
      'Auto-compact failed, continuing with original messages:',
      error,
    )
    return { messages, wasCompacted: false }
  }
}

/**
 * Executes the conversation compression process using the main model
 *
 * This function generates a comprehensive summary using the main model
 * which is better suited for complex summarization tasks. It also
 * automatically recovers important files to maintain development context.
 */
async function executeAutoCompact(
  messages: Message[],
  toolUseContext: any,
): Promise<Message[]> {
  const endIndex = lastNonProgressIndex(messages)
  const tailStartIndex = findTailStartIndex(messages)
  const tailMessages =
    endIndex >= 0 ? messages.slice(tailStartIndex, endIndex + 1) : []
  const olderMessages =
    tailStartIndex > 0 ? messages.slice(0, tailStartIndex) : []

  const summaryRequest = createUserMessage(COMPRESSION_PROMPT)

  const summaryResponse = await queryLLM(
    normalizeMessagesForAPI([...olderMessages, summaryRequest]),
    [
      'You are a helpful AI assistant tasked with creating comprehensive conversation summaries that preserve all essential context for continuing development work.',
    ],
    0,
    toolUseContext.options.tools,
    toolUseContext.abortController.signal,
    {
      safeMode: false,
      model: 'main', // 使用模型指针，让queryLLM统一解析
      prependCLISysprompt: true,
    },
  )

  const content = summaryResponse.message.content
  const summary =
    typeof content === 'string'
      ? content
      : content.length > 0 && content[0]?.type === 'text'
        ? content[0].text
        : null

  if (!summary) {
    throw new Error(
      'Failed to generate conversation summary - response did not contain valid text content',
    )
  }

  summaryResponse.message.usage = {
    input_tokens: 0,
    output_tokens: summaryResponse.message.usage.output_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  // Automatic file recovery: preserve recently accessed development files
  // This maintains coding context even after conversation compression
  const recoveredFiles = await selectAndReadFiles()

  const compactedMessages = [
    createUserMessage(
      '（已自动压缩上下文，保留摘要与关键内容；请继续完成我最新的请求。）',
    ),
    summaryResponse,
  ]

  // Append recovered files to maintain development workflow continuity
  // Files are prioritized by recency and importance, with strict token limits
  if (recoveredFiles.length > 0) {
    for (const file of recoveredFiles) {
      const contentWithLines = addLineNumbers({
        content: file.content,
        startLine: 1,
      })
      const recoveryMessage = createUserMessage(
        `**Recovered File: ${file.path}**\n\n\`\`\`\n${contentWithLines}\n\`\`\`\n\n` +
          `*Automatically recovered (${file.tokens} tokens)${file.truncated ? ' [truncated]' : ''}*`,
      )
      compactedMessages.push(recoveryMessage)
    }
  }

  // State cleanup to ensure fresh context after compression
  // Mirrors the cleanup sequence from manual /compact command
  const nextMessages = [
    ...compactedMessages,
    // 关键：保留“尾部”真实上下文（尤其是最后一条用户消息 / tool_result），否则会像“开新对话”
    ...tailMessages.filter(m => !isProgressMessage(m)),
  ]
  getMessagesSetter()(nextMessages)
  getContext.cache.clear?.()
  getCodeStyle.cache.clear?.()
  resetFileFreshnessSession()

  return nextMessages
}
