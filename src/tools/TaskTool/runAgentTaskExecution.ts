import { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { last, memoize } from 'lodash-es'
import { hasPermissionsToUseTool } from '@permissions'
import { getAgentPrompt } from '@constants/prompts'
import { getContext } from '@context'
import { Message as MessageType } from '@query'
import {
  getMessagesPath,
  getNextAvailableLogSidechainNumber,
  overwriteLog,
} from '@utils/log'
import {
  createUserMessage,
  getLastAssistantMessageId,
  INTERRUPT_MESSAGE,
} from '@utils/messages'
import { getMaxThinkingTokens } from '@utils/thinking'
import { generateAgentId } from '@utils/agentStorage'
import { getAgentByType, getAvailableAgentTypes } from '@utils/agentLoader'
import { normalizeAgentName, normalizeTeamName } from '@services/teamPaths'
import { setSessionState, getSessionState } from '@utils/sessionState'
import { runAgentRuntime } from '@utils/agentRuntime'
import { getTaskTools } from './prompt'
import type { PermissionMode } from '@yuuka-types/PermissionMode'
import { getGlobalConfig } from '@utils/config'

const DEFAULT_PARALLEL_AGENT_MODEL = 'gemini-3-flash-preview'

export interface TaskExecutionProgress {
  agentType: string
  model: string
  description: string
  status: string
  toolCount: number
  elapsedMs: number
  tokenCount?: number
  lastAction?: string
  teamName?: string
  agentName?: string
  taskId?: string
  taskState?: string
  eventType?: 'progress' | 'message' | 'status' | 'result'
  eventContent?: string
}

export interface RunAgentTaskExecutionInput {
  description: string
  prompt: string
  model_name?: string
  subagent_type?: string
  team_name?: string
  name?: string
  agent_id?: string
  safeMode: boolean
  permissionMode?: PermissionMode
  forkNumber: number
  messageLogName: string
  verbose: boolean
  abortController: AbortController
  readFileTimestamps: Record<string, number>
  canUseTool?: unknown
}

export interface RunAgentTaskExecutionResult {
  agentType: string
  model: string
  toolUseCount: number
  tokenCount: number
  durationMs: number
  data: TextBlock[]
  resultForAssistant: string
  interrupted: boolean
}

export type RunAgentTaskExecutionEvent =
  | { type: 'progress'; progress: TaskExecutionProgress }
  | { type: 'result'; result: RunAgentTaskExecutionResult }

function renderResultForAssistant(data: TextBlock[]): string {
  return data.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

function normalizePreview(text: string, maxLength = 200): string {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function formatToolAction(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Reading ${input.file_path || ''}`
    case 'Edit':
      return `Editing ${input.file_path || ''}`
    case 'Write':
      return `Writing ${input.file_path || ''}`
    case 'Bash':
      return `$ ${normalizePreview(String(input.command || ''), 80)}`
    case 'Grep':
      return `Searching "${input.pattern || ''}"`
    case 'Glob':
      return `Finding ${input.pattern || ''}`
    case 'WebFetch':
      return `Fetching ${input.url || ''}`
    case 'WebSearch':
      return `Searching: ${input.query || ''}`
    case 'Task':
      return `Spawning ${input.description || input.subagent_type || 'agent'}`
    default:
      return name
  }
}

function buildTeammateGuidance(teamName: string, teammateName: string): string {
  return `# Agent Teammate Communication

你正在作为团队 "${teamName}" 的成员 "${teammateName}" 运行。

重要规则：
- 你的普通文本输出对其他队友不可见；需要协作请使用 SendMessage
- 用户主要和 lead 交互，你的阶段结果要通过 TaskUpdate 与 SendMessage 汇报
- 输出文件路径时请使用绝对路径
- 向特定成员发消息用 SendMessage type="message"
- 广播消息成本高，仅在确实需要同步全员时使用 type="broadcast"
- 收到 shutdown_request 后，尽快完成当前安全步骤并发送 shutdown_response

Teammate 工作流：
1. 用 TaskList 查看共享任务（优先 open 且未 owner 的条目）
2. 认领任务时用 TaskUpdate(taskId, owner="${teammateName}", status="in_progress")
3. 完成后用 TaskUpdate 写入 status="completed" 和 result
4. 通过 SendMessage 给 lead 发简短汇报

补充：
- lead 可能会先并行启动多个队友（非阻塞），再在你运行期间持续发消息调度
- 收到新分工后优先更新共享任务板，避免与其他队友重复工作`
}

function resolveTaskAgentId(input: {
  team_name?: string
  name?: string
  agent_id?: string
}): string {
  if (input.agent_id && input.agent_id.trim()) {
    return normalizeAgentName(input.agent_id)
  }
  if (input.team_name || input.name) {
    const team = normalizeTeamName(input.team_name)
    const agent = normalizeAgentName(input.name || 'teammate')
    return `teammate-${team}-${agent}`
  }
  return generateAgentId()
}

export async function runAgentTaskExecution(
  input: RunAgentTaskExecutionInput,
  onProgress?: (progress: TaskExecutionProgress) => Promise<void> | void,
): Promise<RunAgentTaskExecutionResult> {
  for await (const event of runAgentTaskExecutionStream(input)) {
    if (event.type === 'progress') {
      await onProgress?.(event.progress)
      continue
    }
    return event.result
  }
  throw new Error('Task execution ended without result')
}

export async function* runAgentTaskExecutionStream(
  input: RunAgentTaskExecutionInput,
): AsyncGenerator<RunAgentTaskExecutionEvent, RunAgentTaskExecutionResult, unknown> {
  const {
    description,
    prompt,
    model_name,
    subagent_type,
    team_name,
    name,
    agent_id,
    safeMode,
    permissionMode,
    forkNumber,
    messageLogName,
    verbose,
    abortController,
    readFileTimestamps,
  } = input

  const startTime = Date.now()
  const agentType = subagent_type || 'general-purpose'
  let effectivePrompt = prompt
  const configuredParallelModel = String(
    getGlobalConfig().parallelAgentModel ?? '',
  ).trim()
  let effectiveModel =
    (typeof model_name === 'string' && model_name.trim()) ||
    configuredParallelModel ||
    DEFAULT_PARALLEL_AGENT_MODEL
  let toolFilter: string[] | '*' | null = null
  const normalizedTeamName = team_name ? normalizeTeamName(team_name) : undefined
  const normalizedTeammateName =
    team_name ? normalizeAgentName(name || 'anonymous') : undefined

  const agentConfig = await getAgentByType(agentType)
  if (!agentConfig) {
    const availableTypes = await getAvailableAgentTypes()
    throw new Error(
      `Agent type '${agentType}' not found. Available types: ${availableTypes.join(', ')}`,
    )
  }

  if (agentConfig.systemPrompt) {
    effectivePrompt = `${agentConfig.systemPrompt}\n\n${prompt}`
  }
  if (team_name) {
    const teammateGuidance = buildTeammateGuidance(
      normalizedTeamName!,
      normalizedTeammateName!,
    )
    effectivePrompt = `${teammateGuidance}\n\n${effectivePrompt}`
  }
  if (!model_name && agentConfig.model_name && agentConfig.model_name !== 'inherit') {
    effectiveModel = agentConfig.model_name as string
  }
  toolFilter = agentConfig.tools
  const taskId = resolveTaskAgentId({ team_name, name, agent_id })

  const messages: MessageType[] = [createUserMessage(effectivePrompt)]
  let tools = await getTaskTools(safeMode)

  if (toolFilter) {
    const isAllArray =
      Array.isArray(toolFilter) && toolFilter.length === 1 && toolFilter[0] === '*'
    if (toolFilter === '*' || isAllArray) {
      // keep all
    } else if (Array.isArray(toolFilter)) {
      tools = tools.filter(tool => toolFilter.includes(tool.name))
    }
  }

  const modelToUse = effectiveModel
  const canUseTool =
    typeof input.canUseTool === 'function'
      ? (input.canUseTool as any)
      : hasPermissionsToUseTool

  let toolUseCount = 0
  yield {
    type: 'progress',
    progress: {
      agentType,
      model: modelToUse,
      description,
      status: '启动中',
      toolCount: 0,
      elapsedMs: Date.now() - startTime,
      lastAction: normalizePreview(description, 120),
      teamName: normalizedTeamName,
      agentName: normalizedTeammateName,
      taskId: taskId,
      taskState: 'in_progress',
      eventType: 'progress',
    },
  }

  const [taskPrompt, context, maxThinkingTokens] = await Promise.all([
    getAgentPrompt(),
    getContext(),
    getMaxThinkingTokens(messages),
  ])

  const getSidechainNumber = memoize(() =>
    getNextAvailableLogSidechainNumber(messageLogName, forkNumber),
  )

  const queryOptions = {
    safeMode,
    autoMode: true,
    permissionMode,
    forkNumber,
    messageLogName,
    tools,
    commands: [],
    verbose,
    maxThinkingTokens,
    model: modelToUse,
    teamName: normalizedTeamName,
    teammateName: normalizedTeammateName,
  }

  // Suppress teammate thinking from leaking to main Spinner
  setSessionState('suppressThoughtDepth', getSessionState('suppressThoughtDepth') + 1)
  setSessionState('currentThought', null) // clear residual thought

  try {
  for await (const message of runAgentRuntime({
    messages,
    systemPrompt: taskPrompt,
    context,
    canUseTool,
    toolUseContext: {
      abortController,
      options: queryOptions,
      messageId: getLastAssistantMessageId(messages),
      agentId: taskId,
      readFileTimestamps,
      setToolJSX: () => {},
    },
  })) {
    messages.push(message)

    overwriteLog(
      getMessagesPath(messageLogName, forkNumber, getSidechainNumber()),
      messages.filter(_ => _.type !== 'progress'),
    )

    if (message.type !== 'assistant') {
      continue
    }

    for (const content of message.message.content) {
      if (content.type === 'text' && content.text && content.text !== INTERRUPT_MESSAGE) {
        yield {
          type: 'progress',
          progress: {
            agentType,
            model: modelToUse,
            description,
            status: '分析中',
            toolCount: toolUseCount,
            elapsedMs: Date.now() - startTime,
            lastAction: normalizePreview(content.text),
            teamName: normalizedTeamName,
            agentName: normalizedTeammateName,
            taskId: taskId,
            taskState: 'in_progress',
            eventType: 'progress',
          },
        }
      } else if (content.type === 'tool_use') {
        toolUseCount++
        yield {
          type: 'progress',
          progress: {
            agentType,
            model: modelToUse,
            description,
            status: '调用工具',
            toolCount: toolUseCount,
            elapsedMs: Date.now() - startTime,
            lastAction: formatToolAction(content.name, (content.input as Record<string, unknown>) || {}),
            teamName: normalizedTeamName,
            agentName: normalizedTeammateName,
            taskId: taskId,
            taskState: 'in_progress',
            eventType: 'progress',
          },
        }
      }
    }
  }
  } finally {
    setSessionState('suppressThoughtDepth', getSessionState('suppressThoughtDepth') - 1)
  }

  const lastMessage = last(messages)
  if (lastMessage?.type !== 'assistant') {
    throw new Error('Last message was not an assistant message')
  }

  const interrupted = lastMessage.message.content.some(
    _ => _.type === 'text' && _.text === INTERRUPT_MESSAGE,
  )
  const tokenCount =
    (lastMessage.message.usage.cache_creation_input_tokens ?? 0) +
    (lastMessage.message.usage.cache_read_input_tokens ?? 0) +
    lastMessage.message.usage.input_tokens +
    lastMessage.message.usage.output_tokens

  if (!interrupted) {
    yield {
      type: 'progress',
      progress: {
        agentType,
        model: modelToUse,
        description,
        status: '已完成',
        toolCount: toolUseCount,
        tokenCount,
        elapsedMs: Date.now() - startTime,
        lastAction: `工具调用 ${toolUseCount} 次`,
        teamName: normalizedTeamName,
        agentName: normalizedTeammateName,
        taskId: taskId,
        taskState: 'completed',
        eventType: 'result',
      },
    }
  }

  const data = lastMessage.message.content.filter(_ => _.type === 'text')
  const result: RunAgentTaskExecutionResult = {
    agentType,
    model: modelToUse,
    toolUseCount,
    tokenCount,
    durationMs: Date.now() - startTime,
    interrupted,
    data,
    resultForAssistant: renderResultForAssistant(data),
  }
  yield { type: 'result', result }
  return result
}
