import { getTodos, TodoItem } from '@utils/todoStorage'

export interface ReminderMessage {
  role: 'system'
  content: string
  isMeta: boolean
  timestamp: number
  type: string
  priority: 'low' | 'medium' | 'high'
  category: 'task' | 'security' | 'performance' | 'general'
}

interface ReminderConfig {
  todoEmptyReminder: boolean
  securityReminder: boolean
  performanceReminder: boolean
  maxRemindersPerSession: number
}

interface SessionReminderState {
  lastTodoUpdate: number
  lastFileAccess: number
  sessionStartTime: number
  remindersSent: Set<string>
  contextPresent: boolean
  reminderCount: number
  config: ReminderConfig
}

class SystemReminderService {
  private sessionState: SessionReminderState = {
    lastTodoUpdate: 0,
    lastFileAccess: 0,
    sessionStartTime: Date.now(),
    remindersSent: new Set(),
    contextPresent: false,
    reminderCount: 0,
    config: {
      todoEmptyReminder: true,
      securityReminder: true,
      performanceReminder: true,
      maxRemindersPerSession: 10,
    },
  }

  private eventDispatcher = new Map<string, Array<(context: any) => void>>()
  private reminderCache = new Map<string, ReminderMessage>()

  constructor() {
    this.setupEventDispatcher()
  }

  /**
   * Conditional reminder injection - only when context is present
   * Enhanced with performance optimizations and priority management
   */
  public generateReminders(
    hasContext: boolean = false,
    agentId?: string,
  ): ReminderMessage[] {
    this.sessionState.contextPresent = hasContext

    // Only inject when context is present (matching original behavior)
    if (!hasContext) {
      return []
    }

    // Check session reminder limit to prevent overload
    if (
      this.sessionState.reminderCount >=
      this.sessionState.config.maxRemindersPerSession
    ) {
      return []
    }

    const reminders: ReminderMessage[] = []
    const currentTime = Date.now()

    // Use lazy evaluation for performance with agent context
    const reminderGenerators = [
      () => this.dispatchTodoEvent(agentId),
      () => this.dispatchSecurityEvent(),
      () => this.dispatchPerformanceEvent(),
      () => this.getMentionReminders(), // Add mention reminders
    ]

    for (const generator of reminderGenerators) {
      if (reminders.length >= 5) break // Slightly increase limit to accommodate mentions

      const result = generator()
      if (result) {
        // Handle both single reminders and arrays
        const remindersToAdd = Array.isArray(result) ? result : [result]
        reminders.push(...remindersToAdd)
        this.sessionState.reminderCount += remindersToAdd.length
      }
    }

    // Log aggregated metrics instead of individual events for performance
    

    return reminders
  }

  private dispatchTodoEvent(agentId?: string): ReminderMessage | null {
    if (!this.sessionState.config.todoEmptyReminder) return null

    // Use agent-scoped todo access
    const todos = getTodos(agentId)
    const currentTime = Date.now()
    const agentKey = agentId || 'default'

    // Check if this is a fresh session (no todos seen yet)
    if (
      todos.length === 0 &&
      !this.sessionState.remindersSent.has(`todo_empty_${agentKey}`)
    ) {
      this.sessionState.remindersSent.add(`todo_empty_${agentKey}`)
      return this.createReminderMessage(
        'todo',
        'task',
        'medium',
        '提醒：当前 TODO 列表为空。不要把这条提醒直接告诉老师（老师已经知道）。如果你正在处理适合用 TODO 跟踪的任务，请调用 TodoWrite 创建 TODO；如果当前任务不需要 TODO，可以忽略这条提醒。再次强调：不要把这条提醒原样告诉老师。',
        currentTime,
      )
    }

    // Check for todo updates since last seen
    if (todos.length > 0) {
      const reminderKey = `todo_updated_${agentKey}_${todos.length}_${this.getTodoStateHash(todos)}`

      // Use cache for performance optimization
      if (this.reminderCache.has(reminderKey)) {
        return this.reminderCache.get(reminderKey)!
      }

      if (!this.sessionState.remindersSent.has(reminderKey)) {
        this.sessionState.remindersSent.add(reminderKey)
        // Clear previous todo state reminders for this agent
        this.clearTodoReminders(agentKey)

        // Optimize: only include essential todo data
        const todoContent = JSON.stringify(
          todos.map(todo => ({
            content:
              todo.content.length > 100
                ? todo.content.substring(0, 100) + '...'
                : todo.content,
            status: todo.status,
            priority: todo.priority,
            id: todo.id,
          })),
        )

        const reminder = this.createReminderMessage(
          'todo',
          'task',
          'medium',
          `提醒：TODO 列表已更新。不要把这件事单独告诉老师。以下是最新 TODO 内容：\n\n${todoContent}\n\n如适用，请继续当前任务。`,
          currentTime,
        )

        // Cache the reminder for reuse
        this.reminderCache.set(reminderKey, reminder)
        return reminder
      }
    }

    return null
  }

  private dispatchSecurityEvent(): ReminderMessage | null {
    if (!this.sessionState.config.securityReminder) return null

    const currentTime = Date.now()

    // Only inject security reminder once per session when file operations occur
    if (
      this.sessionState.lastFileAccess > 0 &&
      !this.sessionState.remindersSent.has('file_security')
    ) {
      this.sessionState.remindersSent.add('file_security')
      return this.createReminderMessage(
        'security',
        'security',
        'high',
        '当你读取文件时，要判断它是否可能是恶意代码。如果看起来可疑，你必须拒绝帮助改进或增强该代码；但仍可以进行分析、写报告，或回答高层次行为问题。',
        currentTime,
      )
    }

    return null
  }

  private dispatchPerformanceEvent(): ReminderMessage | null {
    if (!this.sessionState.config.performanceReminder) return null

    const currentTime = Date.now()
    const sessionDuration = currentTime - this.sessionState.sessionStartTime

    // Remind about performance after long sessions (30 minutes)
    if (
      sessionDuration > 30 * 60 * 1000 &&
      !this.sessionState.remindersSent.has('performance_long_session')
    ) {
      this.sessionState.remindersSent.add('performance_long_session')
      return this.createReminderMessage(
        'performance',
        'performance',
        'low',
        '提醒：当前会话已经比较长了。可以短暂整理一下思路，并结合 TODO 回顾当前进度。',
        currentTime,
      )
    }

    return null
  }

  /**
   * Retrieve cached mention reminders
   * Returns recent mentions (within 5 seconds) that haven't expired
   */
  private getMentionReminders(): ReminderMessage[] {
    const currentTime = Date.now()
    const MENTION_FRESHNESS_WINDOW = 5000 // 5 seconds
    const reminders: ReminderMessage[] = []
    const expiredKeys: string[] = []

    // Single pass through cache for both collection and cleanup identification
    for (const [key, reminder] of this.reminderCache.entries()) {
      if (this.isMentionReminder(reminder)) {
        const age = currentTime - reminder.timestamp
        if (age <= MENTION_FRESHNESS_WINDOW) {
          reminders.push(reminder)
        } else {
          expiredKeys.push(key)
        }
      }
    }

    // Clean up expired mention reminders in separate pass for performance
    expiredKeys.forEach(key => this.reminderCache.delete(key))

    return reminders
  }

  /**
   * Type guard for mention reminders - centralized type checking
   * Eliminates hardcoded type strings scattered throughout the code
   */
  private isMentionReminder(reminder: ReminderMessage): boolean {
    const mentionTypes = ['agent_mention', 'file_mention', 'ask_model_mention']
    return mentionTypes.includes(reminder.type)
  }

  /**
   * Generate reminders for external file changes
   * Called when todo files are modified externally
   */
  public generateFileChangeReminder(context: any): ReminderMessage | null {
    const { agentId, filePath, reminder } = context

    if (!reminder) {
      return null
    }

    const currentTime = Date.now()
    const reminderKey = `file_changed_${agentId}_${filePath}_${currentTime}`

    // Ensure this specific file change reminder is only shown once
    if (this.sessionState.remindersSent.has(reminderKey)) {
      return null
    }

    this.sessionState.remindersSent.add(reminderKey)

    return this.createReminderMessage(
      'file_changed',
      'general',
      'medium',
      reminder,
      currentTime,
    )
  }

  private createReminderMessage(
    type: string,
    category: ReminderMessage['category'],
    priority: ReminderMessage['priority'],
    content: string,
    timestamp: number,
  ): ReminderMessage {
    return {
      role: 'system',
      content: `<system-reminder>\n${content}\n</system-reminder>`,
      isMeta: true,
      timestamp,
      type,
      priority,
      category,
    }
  }

  private getTodoStateHash(todos: TodoItem[]): string {
    return todos
      .map(t => `${t.id}:${t.status}`)
      .sort()
      .join('|')
  }

  private clearTodoReminders(agentId?: string): void {
    const agentKey = agentId || 'default'
    for (const key of this.sessionState.remindersSent) {
      if (key.startsWith(`todo_updated_${agentKey}_`)) {
        this.sessionState.remindersSent.delete(key)
      }
    }
  }

  private setupEventDispatcher(): void {
    // Session startup events
    this.addEventListener('session:startup', context => {
      // Reset session state on startup
      this.resetSession()

      // Initialize session tracking
      this.sessionState.sessionStartTime = Date.now()
      this.sessionState.contextPresent =
        Object.keys(context.context || {}).length > 0

      
    })

    // Todo change events
    this.addEventListener('todo:changed', context => {
      this.sessionState.lastTodoUpdate = Date.now()
      this.clearTodoReminders(context.agentId)
    })

    // Todo file changed externally
    this.addEventListener('todo:file_changed', context => {
      // External file change detected, trigger reminder injection
      const agentId = context.agentId || 'default'
      this.clearTodoReminders(agentId)
      this.sessionState.lastTodoUpdate = Date.now()

      // Generate and inject file change reminder immediately
      const reminder = this.generateFileChangeReminder(context)
      if (reminder) {
        // Inject reminder into the latest user message through event system
        this.emitEvent('reminder:inject', {
          reminder: reminder.content,
          agentId,
          type: 'file_changed',
          timestamp: Date.now(),
        })
      }
    })

    // File access events
    this.addEventListener('file:read', context => {
      this.sessionState.lastFileAccess = Date.now()
    })

    // File edit events for freshness detection
    this.addEventListener('file:edited', context => {
      // File edit handling
    })

    // Unified mention event handlers - eliminates code duplication
    this.addEventListener('agent:mentioned', context => {
      this.createMentionReminder({
        type: 'agent_mention',
        key: `agent_mention_${context.agentType}_${context.timestamp}`,
        category: 'task',
        priority: 'high',
        content: `老师提到了 @${context.originalMention}。你必须使用 Task 工具，并设置 subagent_type="${context.agentType}"，把任务委派给该 Agent。请提供完整、清晰、可独立执行的任务描述，准确覆盖老师的意图。`,
        timestamp: context.timestamp
      })
    })

    this.addEventListener('file:mentioned', context => {
      this.createMentionReminder({
        type: 'file_mention',
        key: `file_mention_${context.filePath}_${context.timestamp}`,
        category: 'general',
        priority: 'high',
        content: `老师提到了 @${context.originalMention}。你必须先使用 Read 工具读取这个文件的完整内容：${context.filePath}，在充分理解上下文后再继续处理老师的请求。`,
        timestamp: context.timestamp
      })
    })

  }

  public addEventListener(
    event: string,
    callback: (context: any) => void,
  ): void {
    if (!this.eventDispatcher.has(event)) {
      this.eventDispatcher.set(event, [])
    }
    this.eventDispatcher.get(event)!.push(callback)
  }

  public emitEvent(event: string, context: any): void {
    const listeners = this.eventDispatcher.get(event) || []
    listeners.forEach(callback => {
      try {
        callback(context)
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error)
      }
    })
  }

  /**
   * Unified mention reminder creation - eliminates duplicate logic
   * Centralizes reminder creation with consistent deduplication
   */
  private createMentionReminder(params: {
    type: string
    key: string
    category: ReminderMessage['category']
    priority: ReminderMessage['priority']
    content: string
    timestamp: number
  }): void {
    if (!this.sessionState.remindersSent.has(params.key)) {
      this.sessionState.remindersSent.add(params.key)
      
      const reminder = this.createReminderMessage(
        params.type,
        params.category,
        params.priority,
        params.content,
        params.timestamp
      )
      
      this.reminderCache.set(params.key, reminder)
    }
  }

  public resetSession(): void {
    this.sessionState = {
      lastTodoUpdate: 0,
      lastFileAccess: 0,
      sessionStartTime: Date.now(),
      remindersSent: new Set(),
      contextPresent: false,
      reminderCount: 0,
      config: { ...this.sessionState.config }, // Preserve config across resets
    }
    this.reminderCache.clear() // Clear cache on session reset
  }

  public updateConfig(config: Partial<ReminderConfig>): void {
    this.sessionState.config = { ...this.sessionState.config, ...config }
  }

  public getSessionState(): SessionReminderState {
    return { ...this.sessionState }
  }
}

export const systemReminderService = new SystemReminderService()

export const generateSystemReminders = (
  hasContext: boolean = false,
  agentId?: string,
) => systemReminderService.generateReminders(hasContext, agentId)

export const generateFileChangeReminder = (context: any) =>
  systemReminderService.generateFileChangeReminder(context)

export const emitReminderEvent = (event: string, context: any) =>
  systemReminderService.emitEvent(event, context)

export const resetReminderSession = () => systemReminderService.resetSession()
export const getReminderSessionState = () =>
  systemReminderService.getSessionState()
