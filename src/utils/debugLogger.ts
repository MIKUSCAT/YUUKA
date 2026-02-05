import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import chalk from 'chalk'
import envPaths from 'env-paths'
import { CONFIG_BASE_DIR, PRODUCT_COMMAND } from '@constants/product'
import { SESSION_ID } from './log'
import type { Message } from '@yuuka-types/conversation'

// 调试日志级别
export enum LogLevel {
  TRACE = 'TRACE',
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FLOW = 'FLOW',
  API = 'API',
  STATE = 'STATE',
  REMINDER = 'REMINDER', // 新增：系统提醒事件
}

// 调试模式检测
const isDebugMode = () =>
  process.argv.includes('--debug') || process.argv.includes('--debug-verbose')
const isVerboseMode = () => process.argv.includes('--verbose')
const isDebugVerboseMode = () => process.argv.includes('--debug-verbose')

// 终端日志级别配置 - 显示关键信息
const TERMINAL_LOG_LEVELS = new Set([
  LogLevel.ERROR,
  LogLevel.WARN,
  LogLevel.INFO, // 添加 INFO 级别，显示关键系统状态
  LogLevel.REMINDER, // 系统提醒事件，用户应该看到
])

// 在调试详细模式下显示更多日志级别
const DEBUG_VERBOSE_TERMINAL_LOG_LEVELS = new Set([
  LogLevel.ERROR,
  LogLevel.WARN,
  LogLevel.FLOW,
  LogLevel.API,
  LogLevel.STATE,
  LogLevel.INFO,
  LogLevel.REMINDER, // 系统提醒在详细模式下也显示
])

// 用户友好的日志级别 - 简化的高级日志
const USER_FRIENDLY_LEVELS = new Set([
  'SESSION_START',
  'QUERY_START',
  'QUERY_PROGRESS',
  'QUERY_COMPLETE',
  'TOOL_EXECUTION',
  'ERROR_OCCURRED',
  'PERFORMANCE_SUMMARY',
])

// 启动时间戳用于文件命名
const STARTUP_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')
const REQUEST_START_TIME = Date.now()

// 路径配置 - 统一使用 ~/.gemini/yuuka 目录
const YUUKA_DIR = join(homedir(), CONFIG_BASE_DIR)
function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const DEBUG_PATHS = {
  base: () => join(YUUKA_DIR, getProjectDir(process.cwd()), 'debug'),
  detailed: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-detailed.log`),
  flow: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-flow.log`),
  api: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-api.log`),
  state: () => join(DEBUG_PATHS.base(), `${STARTUP_TIMESTAMP}-state.log`),
}

// 确保调试目录存在
function ensureDebugDir() {
  const debugDir = DEBUG_PATHS.base()
  if (!existsSync(debugDir)) {
    mkdirSync(debugDir, { recursive: true })
  }
}

// 日志条目接口
interface LogEntry {
  timestamp: string
  level: LogLevel
  phase: string
  requestId?: string
  data: any
  elapsed?: number
}

// 当前请求上下文
class RequestContext {
  public readonly id: string
  public readonly startTime: number
  private phases: Map<string, number> = new Map()

  constructor() {
    this.id = randomUUID().slice(0, 8)
    this.startTime = Date.now()
  }

  markPhase(phase: string) {
    this.phases.set(phase, Date.now() - this.startTime)
  }

  getPhaseTime(phase: string): number {
    return this.phases.get(phase) || 0
  }

  getAllPhases(): Record<string, number> {
    return Object.fromEntries(this.phases)
  }
}

// 全局请求上下文管理
const activeRequests = new Map<string, RequestContext>()
let currentRequest: RequestContext | null = null

// 核心日志记录函数
function writeToFile(filePath: string, entry: LogEntry) {
  if (!isDebugMode()) return

  try {
    ensureDebugDir()
    const logLine =
      JSON.stringify(
        {
          ...entry,
          sessionId: SESSION_ID,
          pid: process.pid,
          uptime: Date.now() - REQUEST_START_TIME,
        },
        null,
        2,
      ) + ',\n'

    appendFileSync(filePath, logLine)
  } catch (error) {
    // 静默失败，避免调试日志影响主功能
  }
}

// 日志去重机制
const recentLogs = new Map<string, number>()
const LOG_DEDUPE_WINDOW_MS = 5000 // 5秒内相同日志视为重复

// 生成日志去重键
function getDedupeKey(level: LogLevel, phase: string, data: any): string {
  // 对于配置相关的日志，使用文件路径和操作类型作为键
  if (phase.startsWith('CONFIG_')) {
    const file = data?.file || ''
    return `${level}:${phase}:${file}`
  }

  // 对于其他日志，使用阶段作为键
  return `${level}:${phase}`
}

// 检查是否应该记录日志（去重）
function shouldLogWithDedupe(
  level: LogLevel,
  phase: string,
  data: any,
): boolean {
  const key = getDedupeKey(level, phase, data)
  const now = Date.now()
  const lastLogTime = recentLogs.get(key)

  // 如果是第一次记录，或者超过去重时间窗口，则允许记录
  if (!lastLogTime || now - lastLogTime > LOG_DEDUPE_WINDOW_MS) {
    recentLogs.set(key, now)

    // 清理过期的日志记录
    for (const [oldKey, oldTime] of recentLogs.entries()) {
      if (now - oldTime > LOG_DEDUPE_WINDOW_MS) {
        recentLogs.delete(oldKey)
      }
    }

    return true
  }

  return false
}
function formatMessages(messages: any): string {
  if (Array.isArray(messages)) {
    // 只显示最近 5 条消息
    const recentMessages = messages.slice(-5)
    return recentMessages
      .map((msg, index) => {
        const role = msg.role || 'unknown'
        let content = ''

        if (typeof msg.content === 'string') {
          // 每条消息最长 300 字符，超出省略
          content =
            msg.content.length > 300
              ? msg.content.substring(0, 300) + '...'
              : msg.content
        } else if (typeof msg.content === 'object') {
          content = '[complex_content]'
        } else {
          content = String(msg.content || '')
        }

        const totalIndex = messages.length - recentMessages.length + index
        return `[${totalIndex}] ${chalk.dim(role)}: ${content}`
      })
      .join('\n    ')
  }

  if (typeof messages === 'string') {
    try {
      const parsed = JSON.parse(messages)
      if (Array.isArray(parsed)) {
        return formatMessages(parsed) // 递归处理解析后的数组
      }
    } catch {
      // 如果解析失败，返回截断的字符串
    }
  }

  // 对于非消息数组的长字符串，也进行截断
  if (typeof messages === 'string' && messages.length > 200) {
    return messages.substring(0, 200) + '...'
  }

  return typeof messages === 'string' ? messages : JSON.stringify(messages)
}

// 判断是否应该在终端显示日志
function shouldShowInTerminal(level: LogLevel): boolean {
  if (!isDebugMode()) return false

  // 在调试详细模式下显示更多日志级别
  if (isDebugVerboseMode()) {
    return DEBUG_VERBOSE_TERMINAL_LOG_LEVELS.has(level)
  }

  // 默认只显示错误和警告
  return TERMINAL_LOG_LEVELS.has(level)
}

// 终端彩色输出
function logToTerminal(entry: LogEntry) {
  // 使用新的过滤逻辑
  if (!shouldShowInTerminal(entry.level)) return

  const { level, phase, data, requestId, elapsed } = entry
  const timestamp = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS

  let prefix = ''
  let color = chalk.gray

  switch (level) {
    case LogLevel.FLOW:
      prefix = '[FLOW]'
      color = chalk.cyan
      break
    case LogLevel.API:
      prefix = '[API]'
      color = chalk.yellow
      break
    case LogLevel.STATE:
      prefix = '[STATE]'
      color = chalk.blue
      break
    case LogLevel.ERROR:
      prefix = '[ERROR]'
      color = chalk.red
      break
    case LogLevel.WARN:
      prefix = '[WARN]'
      color = chalk.yellow
      break
    case LogLevel.INFO:
      prefix = '[INFO]'
      color = chalk.green
      break
    case LogLevel.TRACE:
      prefix = '[TRACE]'
      color = chalk.magenta
      break
    default:
      prefix = '[DEBUG]'
      color = chalk.gray
  }

  const reqId = requestId ? chalk.dim(`[${requestId}]`) : ''
  const elapsedStr = elapsed !== undefined ? chalk.dim(`+${elapsed}ms`) : ''

  // 特殊处理一些数据格式
  let dataStr = ''
  if (typeof data === 'object' && data !== null) {
    if (data.messages) {
      // 格式化消息数组
      const formattedMessages = formatMessages(data.messages)
      dataStr = JSON.stringify(
        {
          ...data,
          messages: `\n    ${formattedMessages}`,
        },
        null,
        2,
      )
    } else {
      dataStr = JSON.stringify(data, null, 2)
    }
  } else {
    dataStr = typeof data === 'string' ? data : JSON.stringify(data)
  }

  console.log(
    `${color(`[${timestamp}]`)} ${prefix} ${color(phase)} ${reqId} ${dataStr} ${elapsedStr}`,
  )
}

// 主要调试日志函数
export function debugLog(
  level: LogLevel,
  phase: string,
  data: any,
  requestId?: string,
) {
  if (!isDebugMode()) return

  // 检查是否应该记录（去重检查）
  if (!shouldLogWithDedupe(level, phase, data)) {
    return // 跳过重复的日志
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    phase,
    data,
    requestId: requestId || currentRequest?.id,
    elapsed: currentRequest ? Date.now() - currentRequest.startTime : undefined,
  }

  // 写入对应的日志文件
  writeToFile(DEBUG_PATHS.detailed(), entry)

  switch (level) {
    case LogLevel.FLOW:
      writeToFile(DEBUG_PATHS.flow(), entry)
      break
    case LogLevel.API:
      writeToFile(DEBUG_PATHS.api(), entry)
      break
    case LogLevel.STATE:
      writeToFile(DEBUG_PATHS.state(), entry)
      break
  }

  // 终端输出（也会被过滤）
  logToTerminal(entry)
}

// 便捷的日志函数
export const debug = {
  flow: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.FLOW, phase, data, requestId),

  api: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.API, phase, data, requestId),

  state: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.STATE, phase, data, requestId),

  info: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.INFO, phase, data, requestId),

  warn: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.WARN, phase, data, requestId),

  error: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.ERROR, phase, data, requestId),

  trace: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.TRACE, phase, data, requestId),

  // 新增UI相关的调试函数 (只记录到文件，不显示在终端)
  ui: (phase: string, data: any, requestId?: string) =>
    debugLog(LogLevel.STATE, `UI_${phase}`, data, requestId),
}

// 请求生命周期管理
export function startRequest(): RequestContext {
  const ctx = new RequestContext()
  currentRequest = ctx
  activeRequests.set(ctx.id, ctx)

  debug.flow('REQUEST_START', {
    requestId: ctx.id,
    activeRequests: activeRequests.size,
  })

  return ctx
}

export function endRequest(ctx?: RequestContext) {
  const request = ctx || currentRequest
  if (!request) return

  debug.flow('REQUEST_END', {
    requestId: request.id,
    totalTime: Date.now() - request.startTime,
    phases: request.getAllPhases(),
  })

  activeRequests.delete(request.id)
  if (currentRequest === request) {
    currentRequest = null
  }
}

export function getCurrentRequest(): RequestContext | null {
  return currentRequest
}

// 阶段标记函数
export function markPhase(phase: string, data?: any) {
  if (!currentRequest) return

  currentRequest.markPhase(phase)
  debug.flow(`PHASE_${phase.toUpperCase()}`, {
    requestId: currentRequest.id,
    elapsed: currentRequest.getPhaseTime(phase),
    data,
  })
}

// 新增：Reminder 事件日志记录
export function logReminderEvent(
  eventType: string,
  reminderData: any,
  agentId?: string,
) {
  if (!isDebugMode()) return

  debug.info('REMINDER_EVENT_TRIGGERED', {
    eventType,
    agentId: agentId || 'default',
    reminderType: reminderData.type || 'unknown',
    reminderCategory: reminderData.category || 'general',
    reminderPriority: reminderData.priority || 'medium',
    contentLength: reminderData.content ? reminderData.content.length : 0,
    timestamp: Date.now(),
  })
}

// API错误日志功能
export function logAPIError(context: {
  model: string
  endpoint: string
  status: number
  error: any
  request?: any
  response?: any
  provider?: string
}) {
  const errorDir = join(YUUKA_DIR, 'logs', 'error', 'api')
  
  // 确保目录存在
  if (!existsSync(errorDir)) {
    try {
      mkdirSync(errorDir, { recursive: true })
    } catch (err) {
      console.error('Failed to create error log directory:', err)
      return // Exit early if we can't create the directory
    }
  }
  
  // 生成文件名
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sanitizedModel = context.model.replace(/[^a-zA-Z0-9-_]/g, '_')
  const filename = `${sanitizedModel}_${timestamp}.log`
  const filepath = join(errorDir, filename)
  
  // 准备完整的日志内容（文件中保存所有信息）
  const fullLogContent = {
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    requestId: getCurrentRequest()?.id,
    model: context.model,
    provider: context.provider,
    endpoint: context.endpoint,
    status: context.status,
    error: context.error,
    request: context.request, // 保存完整请求
    response: context.response, // 保存完整响应
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    }
  }
  
  // 写入文件（保存完整信息）
  try {
    appendFileSync(filepath, JSON.stringify(fullLogContent, null, 2) + '\n')
    appendFileSync(filepath, '='.repeat(80) + '\n\n')
  } catch (err) {
    console.error('Failed to write API error log:', err)
  }
  
  // 在调试模式下记录到系统日志
  if (isDebugMode()) {
    debug.error('API_ERROR', {
      model: context.model,
      status: context.status,
      error: typeof context.error === 'string' ? context.error : context.error?.message || 'Unknown error',
      endpoint: context.endpoint,
      logFile: filename,
    })
  }
  
  // 优雅的终端显示（仅在verbose模式下）
  if (isVerboseMode() || isDebugVerboseMode()) {
    console.log()
    console.log(chalk.red('━'.repeat(60)))
    console.log(chalk.red.bold('API Error'))
    console.log(chalk.red('━'.repeat(60)))
    
    // 显示关键信息
    console.log(chalk.white('  Model:  ') + chalk.yellow(context.model))
    console.log(chalk.white('  Status: ') + chalk.red(context.status))
    
    // 格式化错误消息
    let errorMessage = 'Unknown error'
    if (typeof context.error === 'string') {
      errorMessage = context.error
    } else if (context.error?.message) {
      errorMessage = context.error.message
    } else if (context.error?.error?.message) {
      errorMessage = context.error.error.message
    }
    
    // 错误消息换行显示
    console.log(chalk.white('  Error:  ') + chalk.red(errorMessage))
    
    // 如果有响应体，显示格式化的响应
    if (context.response) {
      console.log()
      console.log(chalk.gray('  Response:'))
      const responseStr = typeof context.response === 'string' 
        ? context.response 
        : JSON.stringify(context.response, null, 2)
      
      // 缩进显示响应内容
      responseStr.split('\n').forEach(line => {
        console.log(chalk.gray('    ' + line))
      })
    }
    
    console.log()
    console.log(chalk.dim(`  Full log: ${filepath}`))
    console.log(chalk.red('━'.repeat(60)))
    console.log()
  }
}

// 新增：LLM 交互核心调试信息
export function logLLMInteraction(context: {
  systemPrompt: string
  messages: any[]
  response: any
  usage?: { inputTokens: number; outputTokens: number }
  timing: { start: number; end: number }
  apiFormat?: 'anthropic' | 'openai'
}) {
  if (!isDebugMode()) return

  const duration = context.timing.end - context.timing.start

  console.log('\n' + chalk.blue('LLM CALL DEBUG'))
  console.log(chalk.gray('━'.repeat(60)))

  // 显示上下文基本信息
  console.log(chalk.yellow('Context Overview:'))
  console.log(`   Messages Count: ${context.messages.length}`)
  console.log(`   System Prompt Length: ${context.systemPrompt.length} chars`)
  console.log(`   Duration: ${duration.toFixed(0)}ms`)

  if (context.usage) {
    console.log(
      `   Token Usage: ${context.usage.inputTokens} → ${context.usage.outputTokens}`,
    )
  }

  // 显示真实发送给 LLM API 的 messages（完整还原API调用）
  const apiLabel = context.apiFormat
    ? ` (${context.apiFormat.toUpperCase()})`
    : ''
  console.log(chalk.cyan(`\nReal API Messages${apiLabel} (last 10):`))

  // 这里展示的是真正发送给LLM API的messages，不是内部处理的版本
  const recentMessages = context.messages.slice(-10)
  recentMessages.forEach((msg, index) => {
    const globalIndex = context.messages.length - recentMessages.length + index
    const roleColor =
      msg.role === 'user'
        ? 'green'
        : msg.role === 'assistant'
          ? 'blue'
          : msg.role === 'system'
            ? 'yellow'
            : 'gray'

    let content = ''
    let isReminder = false

    if (typeof msg.content === 'string') {
      // 检查是否是 system-reminder
      if (msg.content.includes('<system-reminder>')) {
        isReminder = true
        // 提取 reminder 的核心内容，显示更多字符，记得加省略号
        const reminderContent = msg.content
          .replace(/<\/?system-reminder>/g, '')
          .trim()
        content = `[REMINDER] ${reminderContent.length > 800 ? reminderContent.substring(0, 800) + '...' : reminderContent}`
      } else {
        // 增加普通消息的显示字符数 - 用户消息和系统消息显示更多
        const maxLength =
          msg.role === 'user' ? 1000 : msg.role === 'system' ? 1200 : 800
        content =
          msg.content.length > maxLength
            ? msg.content.substring(0, maxLength) + '...'
            : msg.content
      }
    } else if (Array.isArray(msg.content)) {
      // Anthropic格式：content是对象数组
      const textBlocks = msg.content.filter(
        (block: any) => block.type === 'text',
      )
      const toolBlocks = msg.content.filter(
        (block: any) => block.type === 'tool_use',
      )
      if (textBlocks.length > 0) {
        const text = textBlocks[0].text || ''
        // Assistant消息显示更多内容
        const maxLength = msg.role === 'assistant' ? 1000 : 800
        content =
          text.length > maxLength ? text.substring(0, maxLength) + '...' : text
      }
      if (toolBlocks.length > 0) {
        content += ` [+ ${toolBlocks.length} tool calls]`
      }
      if (textBlocks.length === 0 && toolBlocks.length === 0) {
        content = `[${msg.content.length} blocks: ${msg.content.map(b => b.type || 'unknown').join(', ')}]`
      }
    } else {
      content = '[complex_content]'
    }

    // 根据消息类型使用不同的显示样式 - 更友好的视觉格式
    if (isReminder) {
      console.log(
        `   [${globalIndex}] ${chalk.magenta('REMINDER')}: ${chalk.dim(content)}`,
      )
    } else {
      console.log(
        `   [${globalIndex}] ${(chalk as any)[roleColor](msg.role.toUpperCase())}: ${content}`,
      )
    }

    // 显示工具调用信息（Anthropic格式）- 更清晰的格式
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolCalls = msg.content.filter(
        (block: any) => block.type === 'tool_use',
      )
      if (toolCalls.length > 0) {
        console.log(
          chalk.cyan(
            `       Tool calls (${toolCalls.length}): ${toolCalls.map((t: any) => t.name).join(', ')}`,
          ),
        )
        // 显示每个工具的详细参数
        toolCalls.forEach((tool: any, idx: number) => {
          const inputStr = JSON.stringify(tool.input || {})
          const maxLength = 200
          const displayInput =
            inputStr.length > maxLength
              ? inputStr.substring(0, maxLength) + '...'
              : inputStr
          console.log(
            chalk.dim(`         [${idx}] ${tool.name}: ${displayInput}`),
          )
        })
      }
    }
    // OpenAI格式的工具调用
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(
        chalk.cyan(
          `       Tool calls (${msg.tool_calls.length}): ${msg.tool_calls.map((t: any) => t.function.name).join(', ')}`,
        ),
      )
      msg.tool_calls.forEach((tool: any, idx: number) => {
        const inputStr = tool.function.arguments || '{}'
        const maxLength = 200
        const displayInput =
          inputStr.length > maxLength
            ? inputStr.substring(0, maxLength) + '...'
            : inputStr
        console.log(
          chalk.dim(`         [${idx}] ${tool.function.name}: ${displayInput}`),
        )
      })
    }
  })

  // 显示 LLM 响应核心信息 - 更详细友好的格式
  console.log(chalk.magenta('\nLLM Response:'))

  // Handle different response formats (Anthropic vs OpenAI vs UnifiedResponse)
  let responseContent = ''
  let toolCalls: any[] = []

  if (Array.isArray(context.response.content)) {
    // Anthropic format: content is array of blocks
    const textBlocks = context.response.content.filter(
      (block: any) => block.type === 'text',
    )
    responseContent = textBlocks.length > 0 ? textBlocks[0].text || '' : ''
    toolCalls = context.response.content.filter(
      (block: any) => block.type === 'tool_use',
    )
  } else if (typeof context.response.content === 'string') {
    // OpenAI/UnifiedResponse format: content is string
    responseContent = context.response.content
    // Tool calls are separate in OpenAI format or UnifiedResponse
    toolCalls = context.response.tool_calls || context.response.toolCalls || []
  } else if (context.response.message?.content) {
    // Handle internal message format (from streaming responses)
    if (Array.isArray(context.response.message.content)) {
      // Internal format with content blocks
      const textBlocks = context.response.message.content.filter(
        (block: any) => block.type === 'text',
      )
      responseContent = textBlocks.length > 0 ? textBlocks[0].text || '' : ''
      toolCalls = context.response.message.content.filter(
        (block: any) => block.type === 'tool_use',
      )
    } else if (typeof context.response.message.content === 'string') {
      responseContent = context.response.message.content
    }
  } else {
    responseContent = JSON.stringify(context.response.content || context.response || '')
  }

  // 显示更多响应内容
  const maxResponseLength = 1000
  const displayContent =
    responseContent.length > maxResponseLength
      ? responseContent.substring(0, maxResponseLength) + '...'
      : responseContent
  console.log(`   Content: ${displayContent}`)

  if (toolCalls.length > 0) {
    const toolNames = toolCalls.map(
      (t: any) => t.name || t.function?.name || 'unknown',
    )
    console.log(
      chalk.cyan(
        `   Tool Calls (${toolCalls.length}): ${toolNames.join(', ')}`,
      ),
    )
    toolCalls.forEach((tool: any, index: number) => {
      const toolName = tool.name || tool.function?.name || 'unknown'
      const toolInput = tool.input || tool.function?.arguments || '{}'
      const inputStr =
        typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
      // 显示更多工具参数内容
      const maxToolInputLength = 300
      const displayInput =
        inputStr.length > maxToolInputLength
          ? inputStr.substring(0, maxToolInputLength) + '...'
          : inputStr
      console.log(chalk.dim(`     [${index}] ${toolName}: ${displayInput}`))
    })
  }

  console.log(
    `   Stop Reason: ${context.response.stop_reason || context.response.finish_reason || 'unknown'}`,
  )
  console.log(chalk.gray('━'.repeat(60)))
}

// 新增：系统提示构建过程调试
export function logSystemPromptConstruction(construction: {
  basePrompt: string
  yuukaContext?: string
  reminders: string[]
  finalPrompt: string
}) {
  if (!isDebugMode()) return

  console.log('\n' + chalk.yellow('SYSTEM PROMPT CONSTRUCTION'))
  console.log(`   Base Prompt: ${construction.basePrompt.length} chars`)

  if (construction.yuukaContext) {
    console.log(`   + YUUKA Context: ${construction.yuukaContext.length} chars`)
  }

  if (construction.reminders.length > 0) {
    console.log(
      `   + Dynamic Reminders: ${construction.reminders.length} items`,
    )
    construction.reminders.forEach((reminder, index) => {
      console.log(chalk.dim(`     [${index}] ${reminder.substring(0, 80)}...`))
    })
  }

  console.log(`   = Final Length: ${construction.finalPrompt.length} chars`)
}

// 新增：上下文压缩过程调试
export function logContextCompression(compression: {
  beforeMessages: number
  afterMessages: number
  trigger: string
  preservedFiles: string[]
  compressionRatio: number
}) {
  if (!isDebugMode()) return

  console.log('\n' + chalk.red('CONTEXT COMPRESSION'))
  console.log(`   Trigger: ${compression.trigger}`)
  console.log(
    `   Messages: ${compression.beforeMessages} → ${compression.afterMessages}`,
  )
  console.log(
    `   Compression Ratio: ${(compression.compressionRatio * 100).toFixed(1)}%`,
  )

  if (compression.preservedFiles.length > 0) {
    console.log(`   Preserved Files: ${compression.preservedFiles.join(', ')}`)
  }
}

// 新增：用户友好的日志显示
export function logUserFriendly(type: string, data: any, requestId?: string) {
  if (!isDebugMode()) return

  const timestamp = new Date().toLocaleTimeString()
  let message = ''
  let color = chalk.gray
  let icon = '•'

  switch (type) {
    case 'SESSION_START':
      icon = '[START]'
      color = chalk.green
      message = `Session started with ${data.model || 'default model'}`
      break
    case 'QUERY_START':
      icon = '[QUERY]'
      color = chalk.blue
      message = `Processing query: "${data.query?.substring(0, 50)}${data.query?.length > 50 ? '...' : ''}"`
      break
    case 'QUERY_PROGRESS':
      icon = '[PROGRESS]'
      color = chalk.yellow
      message = `${data.phase} (${data.elapsed}ms)`
      break
    case 'QUERY_COMPLETE':
      icon = '[DONE]'
      color = chalk.green
      message = `Query completed in ${data.duration}ms - Cost: $${data.cost} - ${data.tokens} tokens`
      break
    case 'TOOL_EXECUTION':
      icon = '[TOOL]'
      color = chalk.cyan
      message = `${data.toolName}: ${data.action} ${data.target ? '→ ' + data.target : ''}`
      break
    case 'ERROR_OCCURRED':
      icon = '[ERROR]'
      color = chalk.red
      message = `${data.error} ${data.context ? '(' + data.context + ')' : ''}`
      break
    case 'PERFORMANCE_SUMMARY':
      icon = '[SUMMARY]'
      color = chalk.magenta
      message = `Session: ${data.queries} queries, $${data.totalCost}, ${data.avgResponseTime}ms avg`
      break
    default:
      message = JSON.stringify(data)
  }

  const reqId = requestId ? chalk.dim(`[${requestId.slice(0, 8)}]`) : ''
  console.log(`${color(`[${timestamp}]`)} ${icon} ${color(message)} ${reqId}`)
}

// 初始化日志系统
export function initDebugLogger() {
  if (!isDebugMode()) return

  debug.info('DEBUG_LOGGER_INIT', {
    startupTimestamp: STARTUP_TIMESTAMP,
    sessionId: SESSION_ID,
    debugPaths: {
      detailed: DEBUG_PATHS.detailed(),
      flow: DEBUG_PATHS.flow(),
      api: DEBUG_PATHS.api(),
      state: DEBUG_PATHS.state(),
    },
  })

  // 显示终端输出过滤信息
  const terminalLevels = isDebugVerboseMode()
    ? Array.from(DEBUG_VERBOSE_TERMINAL_LOG_LEVELS).join(', ')
    : Array.from(TERMINAL_LOG_LEVELS).join(', ')

  console.log(
    chalk.dim(`[DEBUG] Terminal output filtered to: ${terminalLevels}`),
  )
  console.log(
    chalk.dim(`[DEBUG] Complete logs saved to: ${DEBUG_PATHS.base()}`),
  )
  if (!isDebugVerboseMode()) {
    console.log(
      chalk.dim(
        `[DEBUG] Use --debug-verbose for detailed system logs (FLOW, API, STATE)`,
      ),
    )
  }
}

// 新增：错误诊断和恢复建议系统
interface ErrorDiagnosis {
  errorType: string
  category:
    | 'NETWORK'
    | 'API'
    | 'PERMISSION'
    | 'CONFIG'
    | 'SYSTEM'
    | 'USER_INPUT'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  description: string
  suggestions: string[]
  debugSteps: string[]
  relatedLogs?: string[]
}

export function diagnoseError(error: any, context?: any): ErrorDiagnosis {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorStack = error instanceof Error ? error.stack : undefined

  // AbortController 相关错误
  if (
    errorMessage.includes('aborted') ||
    errorMessage.includes('AbortController')
  ) {
    return {
      errorType: 'REQUEST_ABORTED',
      category: 'SYSTEM',
      severity: 'MEDIUM',
      description:
        'Request was aborted, often due to user cancellation or timeout',
      suggestions: [
        '检查是否按下了 ESC 键取消请求',
        '检查网络连接是否稳定',
        '验证 AbortController 状态: isActive 和 signal.aborted 应该一致',
        '查看是否有重复的请求导致冲突',
      ],
      debugSteps: [
        '使用 --debug-verbose 模式查看详细的请求流程',
        '检查 debug 日志中的 BINARY_FEEDBACK_* 事件',
        '验证 REQUEST_START 和 REQUEST_END 日志配对',
        '查看 QUERY_ABORTED 事件的触发原因',
      ],
    }
  }

  // API 密钥相关错误
  if (
    errorMessage.includes('api-key') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('401')
  ) {
    return {
      errorType: 'API_AUTHENTICATION',
      category: 'API',
      severity: 'HIGH',
      description: 'API authentication failed - invalid or missing API key',
      suggestions: [
        '在 /config 面板里设置 Gemini API Key',
        '检查 ~/.gemini/settings.json 中的 security.auth.geminiApi.apiKey',
        '验证 API 密钥是否已过期或被撤销',
        '确认 baseUrl 配置正确（如使用了自建网关）',
      ],
      debugSteps: [
        '检查 CONFIG_LOAD 日志中的 Gemini API Key/baseUrl 状态',
        '运行 yuuka doctor 检查系统健康状态',
        '查看 API_ERROR 日志了解详细错误信息',
        '使用 yuuka config 命令查看当前配置',
      ],
    }
  }

  // 网络连接错误
  if (
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('timeout')
  ) {
    return {
      errorType: 'NETWORK_CONNECTION',
      category: 'NETWORK',
      severity: 'HIGH',
      description: 'Network connection failed - unable to reach API endpoint',
      suggestions: [
        '检查网络连接是否正常',
        '确认防火墙没有阻止相关端口',
        '检查 proxy 设置是否正确',
        '尝试切换到不同的网络环境',
        '验证 baseURL 配置是否正确',
      ],
      debugSteps: [
        '检查 API_REQUEST_START 和相关网络日志',
        '查看 LLM_REQUEST_ERROR 中的详细错误信息',
        '使用 ping 或 curl 测试 API 端点连通性',
        '检查企业网络是否需要代理设置',
      ],
    }
  }

  // 权限相关错误
  if (
    errorMessage.includes('permission') ||
    errorMessage.includes('EACCES') ||
    errorMessage.includes('denied')
  ) {
    return {
      errorType: 'PERMISSION_DENIED',
      category: 'PERMISSION',
      severity: 'MEDIUM',
      description: 'Permission denied - insufficient access rights',
      suggestions: [
        '检查文件和目录的读写权限',
        '确认当前用户有足够的系统权限',
        '查看是否需要管理员权限运行',
        '检查工具权限设置是否正确配置',
      ],
      debugSteps: [
        '查看 PERMISSION_* 日志了解权限检查过程',
        '检查文件系统权限: ls -la',
        '验证工具审批状态',
        '查看 TOOL_* 相关的调试日志',
      ],
    }
  }

  // LLM 响应格式错误
  if (
    errorMessage.includes('substring is not a function') ||
    errorMessage.includes('content')
  ) {
    return {
      errorType: 'RESPONSE_FORMAT',
      category: 'API',
      severity: 'MEDIUM',
      description: 'LLM response format mismatch between different providers',
      suggestions: [
        '确认当前版本只使用 Gemini 原生 API',
        '验证 SSE/JSON 响应解析逻辑是否匹配 Gemini',
        '检查 functionCall/functionResponse 的桥接是否正确',
      ],
      debugSteps: [
        '查看 LLM_CALL_DEBUG 中的响应格式',
        '检查 Gemini 配置（baseUrl/model/apiKey）和实际请求路径',
        '对比请求体 contents/parts 与返回 parts 的结构',
      ],
    }
  }

  // 上下文窗口溢出
  if (
    errorMessage.includes('too long') ||
    errorMessage.includes('context') ||
    errorMessage.includes('token')
  ) {
    return {
      errorType: 'CONTEXT_OVERFLOW',
      category: 'SYSTEM',
      severity: 'MEDIUM',
      description: 'Context window exceeded - conversation too long',
      suggestions: [
        '运行 /compact 手动压缩对话历史',
        '检查自动压缩设置是否正确配置',
        '减少单次输入的内容长度',
        '清理不必要的上下文信息',
      ],
      debugSteps: [
        '查看 AUTO_COMPACT_* 日志检查压缩触发',
        '检查 token 使用量和阈值',
        '查看 CONTEXT_COMPRESSION 相关日志',
        '验证模型的最大 token 限制',
      ],
    }
  }

  // 配置相关错误
  if (
    errorMessage.includes('config') ||
    (errorMessage.includes('undefined') && context?.configRelated)
  ) {
    return {
      errorType: 'CONFIGURATION',
      category: 'CONFIG',
      severity: 'MEDIUM',
      description: 'Configuration error - missing or invalid settings',
      suggestions: [
        '运行 yuuka config 检查配置设置',
        '删除损坏的配置文件重新初始化',
        '检查 JSON 配置文件语法是否正确',
        '验证环境变量设置',
      ],
      debugSteps: [
        '查看 CONFIG_LOAD 和 CONFIG_SAVE 日志',
        '检查配置文件路径和权限',
        '验证 JSON 格式: cat ~/.gemini/settings.json | jq',
        '查看配置缓存相关的调试信息',
      ],
    }
  }

  // 通用错误兜底
  return {
    errorType: 'UNKNOWN',
    category: 'SYSTEM',
    severity: 'MEDIUM',
    description: `Unexpected error: ${errorMessage}`,
    suggestions: [
      '重新启动应用程序',
      '检查系统资源是否充足',
      '查看完整的错误日志获取更多信息',
      '如果问题持续，请报告此错误',
    ],
    debugSteps: [
      '使用 --debug-verbose 获取详细日志',
      '检查 error.log 中的完整错误信息',
      '查看系统资源使用情况',
      '收集重现步骤和环境信息',
    ],
    relatedLogs: errorStack ? [errorStack] : undefined,
  }
}

export function logErrorWithDiagnosis(
  error: any,
  context?: any,
  requestId?: string,
) {
  if (!isDebugMode()) return

  const diagnosis = diagnoseError(error, context)
  const errorMessage = error instanceof Error ? error.message : String(error)

  // 记录标准错误日志
  debug.error(
    'ERROR_OCCURRED',
    {
      error: errorMessage,
      errorType: diagnosis.errorType,
      category: diagnosis.category,
      severity: diagnosis.severity,
      context,
    },
    requestId,
  )

  // 在终端显示诊断信息
  console.log('\n' + chalk.red('ERROR DIAGNOSIS'))
  console.log(chalk.gray('━'.repeat(60)))

  console.log(chalk.red(`ERROR: ${diagnosis.errorType}`))
  console.log(
    chalk.dim(
      `Category: ${diagnosis.category} | Severity: ${diagnosis.severity}`,
    ),
  )
  console.log(`\n${diagnosis.description}`)

  console.log(chalk.yellow('\nRecovery Suggestions:'))
  diagnosis.suggestions.forEach((suggestion, index) => {
    console.log(`   ${index + 1}. ${suggestion}`)
  })

  console.log(chalk.cyan('\nDebug Steps:'))
  diagnosis.debugSteps.forEach((step, index) => {
    console.log(`   ${index + 1}. ${step}`)
  })

  if (diagnosis.relatedLogs && diagnosis.relatedLogs.length > 0) {
    console.log(chalk.magenta('\nRelated Information:'))
    diagnosis.relatedLogs.forEach((log, index) => {
      const truncatedLog =
        log.length > 200 ? log.substring(0, 200) + '...' : log
      console.log(chalk.dim(`   ${truncatedLog}`))
    })
  }

  const debugPath = DEBUG_PATHS.base()
  console.log(chalk.gray(`\nComplete logs: ${debugPath}`))
  console.log(chalk.gray('━'.repeat(60)))
}
export function getDebugInfo() {
  return {
    isDebugMode: isDebugMode(),
    isVerboseMode: isVerboseMode(),
    isDebugVerboseMode: isDebugVerboseMode(),
    startupTimestamp: STARTUP_TIMESTAMP,
    sessionId: SESSION_ID,
    currentRequest: currentRequest?.id,
    activeRequests: Array.from(activeRequests.keys()),
    terminalLogLevels: isDebugVerboseMode()
      ? Array.from(DEBUG_VERBOSE_TERMINAL_LOG_LEVELS)
      : Array.from(TERMINAL_LOG_LEVELS),
    debugPaths: {
      detailed: DEBUG_PATHS.detailed(),
      flow: DEBUG_PATHS.flow(),
      api: DEBUG_PATHS.api(),
      state: DEBUG_PATHS.state(),
    },
  }
}
