import { Box, Text } from 'ink'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ValidationResult } from '@tool'
import { setTodos, getTodos, TodoItem } from '@utils/todoStorage'
import { emitReminderEvent } from '@services/systemReminder'
import { startWatchingTodoFile } from '@services/fileFreshness'
import { DESCRIPTION, PROMPT } from './prompt'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

// 🔧 Fix: Module-level cache to store last updated todos for rendering
// This solves the issue where renderToolResultMessage can't access agentId
let lastUpdatedTodos: TodoItem[] = []

const TodoItemSchema = z.object({
  content: z.string().min(1).describe('The task description or content'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('Current status of the task'),
  priority: z
    .enum(['high', 'medium', 'low'])
    .describe('Priority level of the task'),
  id: z.string().min(1).describe('Unique identifier for the task'),
})

const inputSchema = z.strictObject({
  todos: z.array(TodoItemSchema).describe('The updated todo list'),
})

function validateTodos(todos: TodoItem[]): ValidationResult {
  // Check for duplicate IDs
  const ids = todos.map(todo => todo.id)
  const uniqueIds = new Set(ids)
  if (ids.length !== uniqueIds.size) {
    return {
      result: false,
      errorCode: 1,
      message: 'Duplicate todo IDs found',
      meta: {
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      },
    }
  }

  // Check for multiple in_progress tasks
  const inProgressTasks = todos.filter(todo => todo.status === 'in_progress')
  if (inProgressTasks.length > 1) {
    return {
      result: false,
      errorCode: 2,
      message: 'Only one task can be in_progress at a time',
      meta: { inProgressTaskIds: inProgressTasks.map(t => t.id) },
    }
  }

  // Validate each todo
  for (const todo of todos) {
    if (!todo.content?.trim()) {
      return {
        result: false,
        errorCode: 3,
        message: `Todo with ID "${todo.id}" has empty content`,
        meta: { todoId: todo.id },
      }
    }
    if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
      return {
        result: false,
        errorCode: 4,
        message: `Invalid status "${todo.status}" for todo "${todo.id}"`,
        meta: { todoId: todo.id, invalidStatus: todo.status },
      }
    }
    if (!['high', 'medium', 'low'].includes(todo.priority)) {
      return {
        result: false,
        errorCode: 5,
        message: `Invalid priority "${todo.priority}" for todo "${todo.id}"`,
        meta: { todoId: todo.id, invalidPriority: todo.priority },
      }
    }
  }

  return { result: true }
}

function generateTodoSummary(todos: TodoItem[]): string {
  const stats = {
    total: todos.length,
    pending: todos.filter(t => t.status === 'pending').length,
    inProgress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length,
  }

  // Enhanced summary with statistics
  let summary = `Updated ${stats.total} todo(s)`
  if (stats.total > 0) {
    summary += ` (${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed)`
  }
  summary += '. Continue tracking your progress with the todo list.'

  return summary
}

export const TodoWriteTool = {
  name: 'TodoWrite',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'Update Todos'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false // TodoWrite modifies state, not safe for concurrent execution
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(result) {
    // Match official implementation - return static confirmation message
    return 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable'
  },
  renderToolUseMessage(input, { verbose }) {
    const todos = input.todos || []
    const total = todos.length
    const completed = todos.filter((t: any) => t.status === 'completed').length
    return `${completed}/${total} tasks`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output) {
    const isError = typeof output === 'string' && output.startsWith('Error')
    const theme = getTheme()

    // For non-error output, use the cached todos instead of reading from storage
    // This fixes the issue where getTodos() without agentId returns empty list
    if (!isError && typeof output === 'string') {
      // 🔧 Fix: Use lastUpdatedTodos cache instead of getTodos()
      const currentTodos = lastUpdatedTodos

      if (currentTodos.length === 0) {
        return (
          <Box flexDirection="column">
            <Text color={theme.secondaryText}>{TREE_END} (No content)</Text>
          </Box>
        )
      }

      // 按优先级排序，进行中的排最前
      const sortedTodos = [...currentTodos].sort((a, b) => {
        // 进行中的排最前
        if (a.status === 'in_progress' && b.status !== 'in_progress') return -1
        if (b.status === 'in_progress' && a.status !== 'in_progress') return 1
        // 然后按优先级
        const priorityOrder = { high: 3, medium: 2, low: 1 } as const
        return (priorityOrder[b.priority] ?? 0) - (priorityOrder[a.priority] ?? 0)
      })

      // 优先级颜色
      const getPriorityColor = (priority: string) => {
        switch (priority) {
          case 'high': return '#FF6B6B'
          case 'medium': return '#FFE66D'
          case 'low': return '#4ECDC4'
          default: return theme.secondaryText
        }
      }

      // 渲染单个 todo 项 - 简洁平铺样式
      const renderTodoItem = (todo: TodoItem) => {
        let statusIcon: string
        let textColor: string
        let isBold = false
        let isStrikethrough = false

        if (todo.status === 'completed') {
          statusIcon = '●'
          textColor = theme.secondaryText
          isStrikethrough = true
        } else if (todo.status === 'in_progress') {
          statusIcon = '◐'
          textColor = theme.warning
          isBold = true
        } else {
          statusIcon = '○'
          textColor = theme.kode
        }

        return (
          <Box key={todo.id} flexDirection="row">
            <Text color={theme.secondaryText}>{TREE_END} </Text>
            <Text color={todo.status === 'completed' ? theme.secondaryText : getPriorityColor(todo.priority)}>{statusIcon} </Text>
            <Text color={textColor} bold={isBold} strikethrough={isStrikethrough}>
              {todo.content}
            </Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {sortedTodos.map(todo => renderTodoItem(todo))}
        </Box>
      )
    }

    // Fallback to simple text rendering for errors or string output
    return (
      <Box flexDirection="row">
        <Text color={isError ? theme.error : theme.success}>
          {TREE_END} {typeof output === 'string' ? output : JSON.stringify(output)}
        </Text>
      </Box>
    )
  },
  async validateInput({ todos }: z.infer<typeof inputSchema>) {
    // Type assertion to ensure todos match TodoItem[] interface
    const todoItems = todos as TodoItem[]
    const validation = validateTodos(todoItems)
    if (!validation.result) {
      return validation
    }
    return { result: true }
  },
  async *call({ todos }: z.infer<typeof inputSchema>, context) {
    try {
      // Get agent ID from context
      const agentId = context?.agentId

      // Start watching todo file for this agent if not already watching
      if (agentId) {
        startWatchingTodoFile(agentId)
      }

      // Store previous todos for comparison (agent-scoped)
      const previousTodos = getTodos(agentId)

      // Type assertion to ensure todos match TodoItem[] interface
      const todoItems = todos as TodoItem[]

      // Note: Validation already done in validateInput, no need for duplicate validation
      // This eliminates the double validation issue

      // Update the todos in storage (agent-scoped)
      setTodos(todoItems, agentId)

      // 🔧 Fix: Update module-level cache for renderToolResultMessage
      lastUpdatedTodos = [...todoItems]

      // Emit todo change event for system reminders (optimized - only if todos actually changed)
      const hasChanged =
        JSON.stringify(previousTodos) !== JSON.stringify(todoItems)
      if (hasChanged) {
        emitReminderEvent('todo:changed', {
          previousTodos,
          newTodos: todoItems,
          timestamp: Date.now(),
          agentId: agentId || 'default',
          changeType:
            todoItems.length > previousTodos.length
              ? 'added'
              : todoItems.length < previousTodos.length
                ? 'removed'
                : 'modified',
        })
      }

      // Generate enhanced summary
      const summary = generateTodoSummary(todoItems)

      // Enhanced result data for rendering
      const resultData = {
        oldTodos: previousTodos,
        newTodos: todoItems,
        summary,
      }

      yield {
        type: 'result',
        data: summary, // Return string to satisfy interface
        resultForAssistant: summary,
        // Store todo data in a way accessible to the renderer
        // We'll modify the renderToolResultMessage to get todos from storage
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'
      const errorResult = `Error updating todos: ${errorMessage}`

      // Emit error event for system monitoring
      emitReminderEvent('todo:error', {
        error: errorMessage,
        timestamp: Date.now(),
        agentId: context?.agentId || 'default',
        context: 'TodoWriteTool.call',
      })

      yield {
        type: 'result',
        data: errorResult,
        resultForAssistant: errorResult,
      }
    }
  },
} satisfies Tool<typeof inputSchema, string>
