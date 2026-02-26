import {
  Message as APIAssistantMessage,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from './types/common'
import type { Tool, ToolUseContext } from './Tool'
import {
  messagePairValidForBinaryFeedback,
  shouldUseBinaryFeedback,
} from '@components/binary-feedback/utils'
import { CanUseToolFn } from './hooks/useCanUseTool'
import {
  formatSystemPromptWithContext,
  queryLLM,
  queryModel,
} from '@services/llm'
import { emitReminderEvent } from '@services/systemReminder'
import { all } from '@utils/generators'
import { logError } from '@utils/log'
import {
  debug as debugLogger,
  markPhase,
  getCurrentRequest,
  logUserFriendly,
} from './utils/debugLogger'
import { getModelManager } from '@utils/model'
import {
  createAssistantMessage,
  createProgressMessage,
  createToolResultStopMessage,
  createUserMessage,
  FullToolUseResult,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NormalizedMessage,
  normalizeMessagesForAPI,
} from '@utils/messages'
import { BashTool } from '@tools/BashTool/BashTool'
import { getCwd } from './utils/state'
import { checkAutoCompact } from './utils/autoCompactCore'
import { setSessionState } from '@utils/sessionState'
import { setConversationScope } from '@utils/agentStorage'
import { TOOL_NAME as SKILL_TOOL_NAME } from '@tools/SkillTool/constants'
import { PermissionMode } from '@yuuka-types/PermissionMode'
import { getGlobalConfig } from '@utils/config'
import { ensureBuiltinRuntimeHooksRegistered } from '@utils/runtimeHooks'

// Extended ToolUseContext for query functions
interface ExtendedToolUseContext extends ToolUseContext {
  abortController: AbortController
  options: {
    commands: any[]
    forkNumber: number
    messageLogName: string
    tools: Tool[]
    verbose: boolean
    safeMode: boolean
    permissionMode?: PermissionMode
    maxThinkingTokens: number
    model?: string | import('./utils/config').ModelPointerType
  }
  readFileTimestamps: { [filename: string]: number }
  setToolJSX: (jsx: any) => void
  requestId?: string
}

export type Response = { costUSD: number; response: string }
export type UserMessage = {
  message: MessageParam
  type: 'user'
  uuid: UUID
  toolUseResult?: FullToolUseResult
  options?: {
    isCustomCommand?: boolean
    commandName?: string
    commandArgs?: string
  }
}

export type AssistantMessage = {
  costUSD: number
  durationMs: number
  message: APIAssistantMessage
  type: 'assistant'
  uuid: UUID
  isApiErrorMessage?: boolean
  responseId?: string // For GPT-5 Responses API state management
}

export type BinaryFeedbackResult =
  | { message: AssistantMessage | null; shouldSkipPermissionCheck: false }
  | { message: AssistantMessage; shouldSkipPermissionCheck: true }

export type ProgressMessage = {
  content: AssistantMessage
  normalizedMessages: NormalizedMessage[]
  siblingToolUseIDs: Set<string>
  tools: Tool[]
  toolUseID: string
  type: 'progress'
  uuid: UUID
}

// Each array item is either a single message or a message-and-response pair
export type Message = UserMessage | AssistantMessage | ProgressMessage

const DEFAULT_TOOL_USE_CONCURRENCY = 4
const MAX_TOOL_USE_CONCURRENCY_LIMIT = 20

function getToolUseConcurrencyCap(): number {
  const raw = Number(getGlobalConfig().maxToolUseConcurrency)
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TOOL_USE_CONCURRENCY
  }
  return Math.min(
    MAX_TOOL_USE_CONCURRENCY_LIMIT,
    Math.max(1, Math.floor(raw)),
  )
}

function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'object') {
    const name = (error as any).name
    if (name === 'AbortError') return true
    const code = (error as any).code
    if (code === 'ABORT_ERR') return true
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    if (typeof error.message === 'string' && /aborted/i.test(error.message)) {
      return true
    }
  }
  return false
}

function isRetryableNetworkError(
  error: unknown,
): { retryable: boolean; reason: string } {
  if (!error) return { retryable: false, reason: 'unknown' }
  if (isAbortError(error)) return { retryable: false, reason: 'aborted' }

  // Gemini transport errors（HTTP 状态）
  if (typeof error === 'object' && (error as any).name === 'GeminiHttpError') {
    const status = Number((error as any).status)
    if (status === 408 || status === 429) {
      return { retryable: true, reason: `HTTP ${status}` }
    }
    if (status >= 500 && status <= 599) {
      return { retryable: true, reason: `HTTP ${status}` }
    }
    return { retryable: false, reason: `HTTP ${status}` }
  }

  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error)

  if (
    /fetch failed/i.test(msg) ||
    /network/i.test(msg) ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(
      msg,
    )
  ) {
    return { retryable: true, reason: 'network' }
  }

  return { retryable: false, reason: 'non-retryable' }
}

function computeReconnectBackoffMs(attempt: number): number {
  const base = 1500
  const cap = 20000
  const exp = Math.min(cap, Math.floor(base * Math.pow(2, Math.max(0, attempt - 1))))
  const jitter = Math.floor(Math.random() * 300)
  return Math.min(cap, exp + jitter)
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true
  return await new Promise(resolve => {
    const t = setTimeout(() => {
      cleanup()
      resolve(false)
    }, ms)
    const onAbort = () => {
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function applyToolUseSerialGate(
  assistantMessage: AssistantMessage,
  tools: Tool[],
): AssistantMessage {
  const content = assistantMessage.message.content
  if (!Array.isArray(content)) return assistantMessage

  const toolByName = new Map(tools.map(tool => [tool.name, tool]))

  let sawNonConcurrencySafeToolUse = false
  let didChange = false
  const filtered = content.filter(block => {
    if (!block || typeof block !== 'object' || (block as any).type !== 'tool_use') {
      return true
    }

    const toolName = String((block as any).name ?? '')
    const tool = toolByName.get(toolName)
    const concurrencySafe = tool?.isConcurrencySafe() ?? false

    // 更稳妥的“串行闸门”：
    // - 允许并行安全工具继续保留（例如 Task/Read/WebSearch）
    // - 仅保留第一个非并行安全工具（例如 Bash/Edit/Write/TodoWrite）
    // 这样可以避免在同一条消息里误砍掉后续并行任务。
    if (sawNonConcurrencySafeToolUse && !concurrencySafe) {
      didChange = true
      return false
    }

    if (!concurrencySafe) {
      sawNonConcurrencySafeToolUse = true
    }

    return true
  })

  if (!didChange) return assistantMessage

  return {
    ...assistantMessage,
    message: {
      ...assistantMessage.message,
      content: filtered,
    },
  }
}

type ActiveSkillConstraint = {
  skillName: string
  allowedTools: string[]
}

function getLatestActiveSkillConstraint(
  messages: Message[],
): ActiveSkillConstraint | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'user' || !message.toolUseResult) {
      continue
    }

    const resultData = message.toolUseResult.data as any
    if (!resultData || typeof resultData !== 'object') {
      continue
    }
    if (resultData.toolName !== SKILL_TOOL_NAME) {
      continue
    }
    if (resultData.error) {
      return null
    }

    const allowedTools =
      Array.isArray(resultData.allowedTools) &&
      resultData.allowedTools.every((item: unknown) => typeof item === 'string')
        ? (resultData.allowedTools as string[]).map(item => item.trim()).filter(Boolean)
        : []

    return {
      skillName: String(resultData.skillName ?? 'unknown-skill'),
      allowedTools,
    }
  }
  return null
}

function applyActiveSkillConstraintToTools(
  tools: Tool[],
  constraint: ActiveSkillConstraint | null,
): {
  tools: Tool[]
  prompt: string | null
} {
  if (!constraint || constraint.allowedTools.length === 0) {
    return { tools, prompt: null }
  }

  if (constraint.allowedTools.includes('*')) {
    return { tools, prompt: null }
  }

  const allowedToolNameSet = new Set(constraint.allowedTools)
  const filteredTools = tools.filter(
    tool => allowedToolNameSet.has(tool.name) || tool.name === SKILL_TOOL_NAME,
  )
  const effectiveTools =
    filteredTools.length > 0
      ? filteredTools
      : tools.filter(tool => tool.name === SKILL_TOOL_NAME)

  return {
    tools: effectiveTools,
    prompt: `\n# Active Skill Constraint
当前生效 skill：${constraint.skillName}
你现在只能使用这些工具：${constraint.allowedTools.join(', ')}
必须严格遵守该工具白名单；如需更换白名单，请先调用 ${SKILL_TOOL_NAME}。`,
  }
}

// Returns a message if we got one, or `null` if the user cancelled
async function queryWithBinaryFeedback(
  toolUseContext: ExtendedToolUseContext,
  getAssistantResponse: () => Promise<AssistantMessage>,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): Promise<BinaryFeedbackResult> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !getBinaryFeedbackResponse ||
    !(await shouldUseBinaryFeedback())
  ) {
    const assistantMessage = await getAssistantResponse()
    if (toolUseContext.abortController.signal.aborted) {
      return { message: null, shouldSkipPermissionCheck: false }
    }
    return { message: assistantMessage, shouldSkipPermissionCheck: false }
  }
  const [m1, m2] = await Promise.all([
    getAssistantResponse(),
    getAssistantResponse(),
  ])
  if (toolUseContext.abortController.signal.aborted) {
    return { message: null, shouldSkipPermissionCheck: false }
  }
  if (m2.isApiErrorMessage) {
    // If m2 is an error, we might as well return m1, even if it's also an error --
    // the UI will display it as an error as it would in the non-feedback path.
    return { message: m1, shouldSkipPermissionCheck: false }
  }
  if (m1.isApiErrorMessage) {
    return { message: m2, shouldSkipPermissionCheck: false }
  }
  if (!messagePairValidForBinaryFeedback(m1, m2)) {
    return { message: m1, shouldSkipPermissionCheck: false }
  }
  return await getBinaryFeedbackResponse(m1, m2)
}

/**
 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
export async function* query(
  messages: Message[],
  systemPrompt: string[],
  context: { [k: string]: string },
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): AsyncGenerator<Message, void> {
  ensureBuiltinRuntimeHooksRegistered()
  const currentRequest = getCurrentRequest()

  markPhase('QUERY_INIT')
  setConversationScope(toolUseContext.options.messageLogName)

  // Auto-compact check
  const { messages: processedMessages, wasCompacted } = await checkAutoCompact(
    messages,
    toolUseContext,
  )
  if (wasCompacted) {
    messages = processedMessages
  }

  const activeSkillConstraint = getLatestActiveSkillConstraint(messages)
  const { tools: effectiveTools, prompt: skillConstraintPrompt } =
    applyActiveSkillConstraintToTools(
      toolUseContext.options.tools,
      activeSkillConstraint,
    )
  const effectiveToolUseContext: ExtendedToolUseContext = {
    ...toolUseContext,
    options: {
      ...toolUseContext.options,
      tools: effectiveTools,
    },
  }

  markPhase('SYSTEM_PROMPT_BUILD')

  // Collect tool prompts (especially SkillTool which lists available skills)
  const toolPrompts = await collectToolPrompts(effectiveTools)
  const extraPromptSections = [
    ...(toolPrompts.length > 0 ? ['\n# Tool Instructions\n', ...toolPrompts] : []),
    ...(skillConstraintPrompt ? [skillConstraintPrompt] : []),
  ]
  const systemPromptWithToolInstructions =
    extraPromptSections.length > 0
      ? [...systemPrompt, ...extraPromptSections]
      : systemPrompt

  const { systemPrompt: fullSystemPrompt, reminders } =
    formatSystemPromptWithContext(
      systemPromptWithToolInstructions,
      context,
      toolUseContext.agentId,
    )

  // Emit session startup event
  emitReminderEvent('session:startup', {
    agentId: toolUseContext.agentId,
    messages: messages.length,
    timestamp: Date.now(),
  })

  // Inject reminders into the latest *text* user message.
  // IMPORTANT: Do NOT inject into tool_result messages, or it will break Gemini's
  // "functionResponse must be adjacent to functionCall" requirement.
  if (reminders && messages.length > 0) {
    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.type !== 'user') continue

      const lastUserMessage = msg as UserMessage
      const content = lastUserMessage.message?.content
      const isToolResultMessage =
        Array.isArray(content) && content[0]?.type === 'tool_result'

      // If the last user message is tool_result, skip reminders injection for this turn.
      if (isToolResultMessage) break

      messages[i] = {
        ...lastUserMessage,
        message: {
          ...lastUserMessage.message,
          content:
            typeof content === 'string'
              ? reminders + content
              : [
                  ...(Array.isArray(content) ? content : []),
                  { type: 'text', text: reminders },
                ],
        },
      }
      break
    }
  }

  markPhase('LLM_PREPARATION')

  function getAssistantResponse() {
    return queryLLM(
      normalizeMessagesForAPI(messages),
      fullSystemPrompt,
      toolUseContext.options.maxThinkingTokens,
      effectiveTools,
      toolUseContext.abortController.signal,
      {
        safeMode: toolUseContext.options.safeMode ?? false,
        model: toolUseContext.options.model || 'main',
        prependCLISysprompt: true,
        toolUseContext: effectiveToolUseContext,
      },
    )
  }

  async function getAssistantResponseWithReconnect(): Promise<AssistantMessage> {
    const MAX_OUTER_ATTEMPTS = 3

    for (let attempt = 1; attempt <= MAX_OUTER_ATTEMPTS; attempt++) {
      try {
        const resp = await getAssistantResponse()
        setSessionState('currentError', null)
        return resp
      } catch (error) {
        if (toolUseContext.abortController.signal.aborted) {
          setSessionState('currentError', null)
          throw error
        }

        const meta = isRetryableNetworkError(error)
        if (attempt >= MAX_OUTER_ATTEMPTS || !meta.retryable) {
          setSessionState('currentError', null)
          throw error
        }

        const backoff = computeReconnectBackoffMs(attempt)
        setSessionState(
          'currentError',
          `网络波动，外层重试 ${attempt}/${MAX_OUTER_ATTEMPTS}（${meta.reason}，等待 ${backoff}ms）`,
        )
        const aborted = await sleepWithAbort(
          backoff,
          toolUseContext.abortController.signal,
        )
        if (aborted) {
          setSessionState('currentError', null)
          throw error
        }
      }
    }

    // 理论上不会到这
    return await getAssistantResponse()
  }

  const result = await queryWithBinaryFeedback(
    toolUseContext,
    getAssistantResponseWithReconnect,
    getBinaryFeedbackResponse,
  )

  // If request was cancelled, return immediately with interrupt message  
  if (toolUseContext.abortController.signal.aborted) {
    yield createAssistantMessage(INTERRUPT_MESSAGE)
    return
  }

  if (result.message === null) {
    yield createAssistantMessage(INTERRUPT_MESSAGE)
    return
  }

  let assistantMessage = result.message
  const shouldSkipPermissionCheck = result.shouldSkipPermissionCheck

  // 稳妥策略（升级版）：
  // - 非并行安全工具（Bash/Edit/Write/...）只保留第一个，后续非并行安全调用会被裁掉
  // - 并行安全工具（Task/Read/WebSearch/...）即使出现在后面也会保留
  // 这样既能抑制高风险连发，又不影响并行任务启动。
  assistantMessage = applyToolUseSerialGate(
    assistantMessage,
    effectiveTools,
  )

  yield assistantMessage

  // @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use
  // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
  const toolUseMessages = assistantMessage.message.content.filter(
    _ => _.type === 'tool_use',
  )

  // If there's no more tool use, we're done
  if (!toolUseMessages.length) {
    return
  }

  const toolResults: UserMessage[] = []

  const toolByName = new Map(effectiveTools.map(tool => [tool.name, tool]))
  const executionGroups: Array<{ concurrent: boolean; toolUses: ToolUseBlock[] }> = []
  let pendingConcurrent: ToolUseBlock[] = []

  for (const toolUse of toolUseMessages) {
    const tool = toolByName.get(toolUse.name)
    const concurrencySafe = tool?.isConcurrencySafe() ?? false

    if (concurrencySafe) {
      pendingConcurrent.push(toolUse)
      continue
    }

    if (pendingConcurrent.length > 0) {
      executionGroups.push({ concurrent: true, toolUses: pendingConcurrent })
      pendingConcurrent = []
    }

    executionGroups.push({ concurrent: false, toolUses: [toolUse] })
  }

  if (pendingConcurrent.length > 0) {
    executionGroups.push({ concurrent: true, toolUses: pendingConcurrent })
  }

  const toolUseConcurrencyCap = getToolUseConcurrencyCap()
  for (const group of executionGroups) {
    const runner = group.concurrent ? runToolsConcurrently : runToolsSerially
    for await (const message of runner(
      group.toolUses,
      assistantMessage,
      canUseTool,
      effectiveToolUseContext,
      shouldSkipPermissionCheck,
      toolUseConcurrencyCap,
    )) {
      yield message
      // progress messages are not sent to the server, so don't need to be accumulated for the next turn
      if (message.type === 'user') {
        toolResults.push(message)
      }
    }
  }

  if (toolUseContext.abortController.signal.aborted) {
    yield createAssistantMessage(INTERRUPT_MESSAGE_FOR_TOOL_USE)
    return
  }

  // Sort toolResults to match the order of toolUseMessages
  const orderedToolResults = toolResults.sort((a, b) => {
    const aIndex = toolUseMessages.findIndex(
      tu => tu.id === (a.message.content[0] as ToolUseBlock).id,
    )
    const bIndex = toolUseMessages.findIndex(
      tu => tu.id === (b.message.content[0] as ToolUseBlock).id,
    )
    return aIndex - bIndex
  })

  // Recursive query

  try {
    yield* await query(
      [...messages, assistantMessage, ...orderedToolResults],
      systemPrompt,
      context,
      canUseTool,
      toolUseContext,
      getBinaryFeedbackResponse,
    )
  } catch (error) {
    // Re-throw the error to maintain the original behavior
    throw error
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
  concurrencyCap: number = DEFAULT_TOOL_USE_CONCURRENCY,
): AsyncGenerator<Message, void> {
  yield* all(
    toolUseMessages.map(toolUse =>
      runToolUse(
        toolUse,
        new Set(toolUseMessages.map(_ => _.id)),
        assistantMessage,
        canUseTool,
        toolUseContext,
        shouldSkipPermissionCheck,
      ),
    ),
    concurrencyCap,
  )
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
  _concurrencyCap?: number,
): AsyncGenerator<Message, void> {
  for (const toolUse of toolUseMessages) {
    yield* runToolUse(
      toolUse,
      new Set(toolUseMessages.map(_ => _.id)),
      assistantMessage,
      canUseTool,
      toolUseContext,
      shouldSkipPermissionCheck,
    )
  }
}

export async function* runToolUse(
  toolUse: ToolUseBlock,
  siblingToolUseIDs: Set<string>,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<Message, void> {
  const currentRequest = getCurrentRequest()

  // Debug: 工具调用开始
  debugLogger.flow('TOOL_USE_START', {
    toolName: toolUse.name,
    toolUseID: toolUse.id,
    inputSize: JSON.stringify(toolUse.input).length,
    siblingToolCount: siblingToolUseIDs.size,
    shouldSkipPermissionCheck: !!shouldSkipPermissionCheck,
    requestId: currentRequest?.id,
  })

  logUserFriendly(
    'TOOL_EXECUTION',
    {
      toolName: toolUse.name,
      action: 'Starting',
      target: toolUse.input ? Object.keys(toolUse.input).join(', ') : '',
    },
    currentRequest?.id,
  )


  

  const toolName = toolUse.name
  const tool = toolUseContext.options.tools.find(t => t.name === toolName)

  // Check if the tool exists
  if (!tool) {
    debugLogger.error('TOOL_NOT_FOUND', {
      requestedTool: toolName,
      availableTools: toolUseContext.options.tools.map(t => t.name),
      toolUseID: toolUse.id,
      requestId: currentRequest?.id,
    })

    

    yield createUserMessage([
      {
        type: 'tool_result',
        content: `Error: No such tool available: ${toolName}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    return
  }

  const toolInput = toolUse.input as { [key: string]: string }

  debugLogger.flow('TOOL_VALIDATION_START', {
    toolName: tool.name,
    toolUseID: toolUse.id,
    inputKeys: Object.keys(toolInput),
    requestId: currentRequest?.id,
  })

  try {
    // Check for cancellation before starting tool execution
    if (toolUseContext.abortController.signal.aborted) {
      debugLogger.flow('TOOL_USE_CANCELLED_BEFORE_START', {
        toolName: tool.name,
        toolUseID: toolUse.id,
        abortReason: 'AbortController signal',
        requestId: currentRequest?.id,
      })

      

      const message = createUserMessage([
        createToolResultStopMessage(toolUse.id),
      ])
      yield message
      return
    }

    // Track if any progress messages were yielded
    let hasProgressMessages = false
    
    for await (const message of checkPermissionsAndCallTool(
      tool,
      toolUse.id,
      siblingToolUseIDs,
      toolInput,
      toolUseContext,
      canUseTool,
      assistantMessage,
      shouldSkipPermissionCheck,
    )) {
      // Check for cancellation during tool execution
      if (toolUseContext.abortController.signal.aborted) {
        debugLogger.flow('TOOL_USE_CANCELLED_DURING_EXECUTION', {
          toolName: tool.name,
          toolUseID: toolUse.id,
          hasProgressMessages,
          abortReason: 'AbortController signal during execution',
          requestId: currentRequest?.id,
        })

        // If we yielded progress messages but got cancelled, yield a cancellation result
        if (hasProgressMessages && message.type === 'progress') {
          yield message // yield the last progress message first
        }
        
        // Always yield a tool result message for cancellation to clear UI state
        const cancelMessage = createUserMessage([
          createToolResultStopMessage(toolUse.id),
        ])
        yield cancelMessage
        return
      }

      if (message.type === 'progress') {
        hasProgressMessages = true
      }
      
      yield message
    }
  } catch (e) {
    logError(e)
    
    // Even on error, ensure we yield a tool result to clear UI state
    const errorMessage = createUserMessage([
      {
        type: 'tool_result',
        content: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    yield errorMessage
  }
}

// TODO: Generalize this to all tools
export function normalizeToolInput(
  tool: Tool,
  input: { [key: string]: boolean | string | number },
): { [key: string]: boolean | string | number } {
  switch (tool) {
    case BashTool: {
      const { command, timeout, run_in_background } =
        BashTool.inputSchema.parse(input) // already validated upstream, won't throw
      return {
        command: command.replace(`cd ${getCwd()} && `, ''),
        ...(timeout ? { timeout } : {}),
        ...(run_in_background ? { run_in_background } : {}),
      }
    }
    default:
      return input
  }
}

async function* checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  input: { [key: string]: boolean | string | number },
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<UserMessage | ProgressMessage, void> {
  // Validate input types with zod
  // (surprisingly, the model is not great at generating valid input)
  const isValidInput = tool.inputSchema.safeParse(input)
  if (!isValidInput.success) {
    // Create a more helpful error message for common cases
    let errorMessage = `InputValidationError: ${isValidInput.error.message}`
    
    // Special handling for the "Read" tool being called with empty parameters
    if (tool.name === 'Read' && Object.keys(input).length === 0) {
      errorMessage = `Error: The Read tool requires a 'file_path' parameter to specify which file to read. Please provide the absolute path to the file you want to read. For example: {"file_path": "E:/path/to/file.txt"} (Windows) or {"file_path": "/path/to/file.txt"} (macOS/Linux)`
    }
    
    
    yield createUserMessage([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const normalizedInput = normalizeToolInput(tool, input)

  // Validate input values. Each tool has its own validation logic
  const isValidCall = await tool.validateInput?.(
    normalizedInput as never,
    context,
  )
  if (isValidCall?.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: isValidCall!.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // Check whether we have permission to use the tool,
  // and ask the user for permission if we don't
  const permissionResult = shouldSkipPermissionCheck
    ? ({ result: true } as const)
    : await canUseTool(tool, normalizedInput, context, assistantMessage)
  if (permissionResult.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: permissionResult.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // Call the tool
  try {
    const generator = tool.call(normalizedInput as never, {
      ...context,
      // 透传权限回调，方便像 TaskTool 这种“工具里再跑 query”时还能弹授权确认
      canUseTool,
    })
    for await (const result of generator) {
      switch (result.type) {
        case 'result':
          
          yield createUserMessage(
            [
              {
                type: 'tool_result',
                content: result.resultForAssistant || String(result.data),
                tool_use_id: toolUseID,
              },
            ],
            {
              data: result.data,
              resultForAssistant: result.resultForAssistant || String(result.data),
            },
          )
          return
        case 'progress':
          
          yield createProgressMessage(
            toolUseID,
            siblingToolUseIDs,
            result.content,
            result.normalizedMessages || [],
            result.tools || [],
          )
          break
      }
    }
  } catch (error) {
    const content = formatError(error)
    logError(error)
    
    yield createUserMessage([
      {
        type: 'tool_result',
        content,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
  }
}

/**
 * Collect prompt() outputs from tools that have meaningful instructions.
 * This injects tool-specific guidance (e.g., available skills list) into the system prompt
 * so the model knows WHEN and HOW to use each tool.
 */
async function collectToolPrompts(tools: Tool[]): Promise<string[]> {
  const promptResults = await Promise.all(
    tools.map(async tool => {
      try {
        if (typeof tool.prompt !== 'function') return null

        const enabled = typeof tool.isEnabled === 'function'
          ? await tool.isEnabled()
          : true
        if (!enabled) return null

        const prompt = await tool.prompt()
        if (!prompt || prompt.trim().length === 0) {
          return null
        }
        return prompt
      } catch {
        // Skip tools whose prompt() throws
        return null
      }
    }),
  )

  // Preserve the original tool order so prompt priority stays stable across runs.
  return promptResults.filter((prompt): prompt is string => Boolean(prompt))
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  const fullMessage = parts.filter(Boolean).join('\n')
  if (fullMessage.length <= 10000) {
    return fullMessage
  }
  const halfLength = 5000
  const start = fullMessage.slice(0, halfLength)
  const end = fullMessage.slice(-halfLength)
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`
}
