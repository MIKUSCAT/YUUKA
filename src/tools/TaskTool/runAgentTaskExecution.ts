import { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { last, memoize } from 'lodash-es'
import { hasPermissionsToUseTool } from '@permissions'
import { getAgentPrompt } from '@constants/prompts'
import { getContext } from '@context'
import { Message as MessageType, query } from '@query'
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
import { getTaskTools } from './prompt'

export interface TaskExecutionProgress {
  agentType: string
  model: string
  status: string
  toolCount: number
  elapsedMs: number
  tokenCount?: number
  lastAction?: string
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
4. 通过 SendMessage 给 lead 发简短汇报`
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
    forkNumber,
    messageLogName,
    verbose,
    abortController,
    readFileTimestamps,
  } = input

  const startTime = Date.now()
  const agentType = subagent_type || 'general-purpose'
  let effectivePrompt = prompt
  let effectiveModel = model_name || 'task'
  let toolFilter: string[] | '*' | null = null

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
    const normalizedTeamName = normalizeTeamName(team_name)
    const teammateName = normalizeAgentName(name || 'anonymous')
    const teammateGuidance = buildTeammateGuidance(normalizedTeamName, teammateName)
    effectivePrompt = `${teammateGuidance}\n\n${effectivePrompt}`
  }
  if (!model_name && agentConfig.model_name && agentConfig.model_name !== 'inherit') {
    effectiveModel = agentConfig.model_name as string
  }
  toolFilter = agentConfig.tools

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
      status: '启动中',
      toolCount: 0,
      elapsedMs: Date.now() - startTime,
      lastAction: normalizePreview(description, 120),
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

  const taskId = resolveTaskAgentId({ team_name, name, agent_id })
  const queryOptions = {
    safeMode,
    forkNumber,
    messageLogName,
    tools,
    commands: [],
    verbose,
    maxThinkingTokens,
    model: modelToUse,
  }

  for await (const message of query(
    messages,
    taskPrompt,
    context,
    canUseTool,
    {
      abortController,
      options: queryOptions,
      messageId: getLastAssistantMessageId(messages),
      agentId: taskId,
      readFileTimestamps,
      setToolJSX: () => {},
    },
  )) {
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
            status: '分析中',
            toolCount: toolUseCount,
            elapsedMs: Date.now() - startTime,
            lastAction: normalizePreview(content.text),
          },
        }
      } else if (content.type === 'tool_use') {
        toolUseCount++
        yield {
          type: 'progress',
          progress: {
            agentType,
            model: modelToUse,
            status: '调用工具',
            toolCount: toolUseCount,
            elapsedMs: Date.now() - startTime,
            lastAction: content.name,
          },
        }
      }
    }
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
        status: '已完成',
        toolCount: toolUseCount,
        tokenCount,
        elapsedMs: Date.now() - startTime,
        lastAction: `工具调用 ${toolUseCount} 次`,
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
