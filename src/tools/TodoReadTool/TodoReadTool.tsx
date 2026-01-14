import { Box, Text } from 'ink'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import type { Tool } from '@tool'
import { getTheme } from '@utils/theme'
import { getTodos, TodoItem } from '@utils/todoStorage'
import { DESCRIPTION, PROMPT } from './prompt'
import { TREE_END } from '@constants/figures'

const inputSchema = z
  .strictObject({
    status: z
      .array(z.enum(['pending', 'in_progress', 'completed']))
      .optional()
      .describe('Optional: filter by status'),
    priority: z
      .array(z.enum(['high', 'medium', 'low']))
      .optional()
      .describe('Optional: filter by priority'),
    query: z
      .string()
      .optional()
      .describe('Optional: case-insensitive search in todo content'),
  })
  .describe('Read todos with optional filters')

type TodoReadInput = z.infer<typeof inputSchema>

type TodoReadResult = {
  todos: TodoItem[]
  summary: {
    total: number
    pending: number
    in_progress: number
    completed: number
  }
  filters?: {
    status?: TodoItem['status'][]
    priority?: TodoItem['priority'][]
    query?: string
  }
}

function summarizeTodos(todos: TodoItem[]): TodoReadResult['summary'] {
  return {
    total: todos.length,
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length,
  }
}

function formatTodosForAssistant(result: TodoReadResult): string {
  const { summary, todos } = result
  const lines = todos.map(t => {
    const status =
      t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending'
    return `- [${status}] (${t.priority}) ${t.content} {id:${t.id}}`
  })

  return [
    `Todo summary: ${summary.completed}/${summary.total} completed (${summary.in_progress} in_progress, ${summary.pending} pending)`,
    ...lines,
  ].join('\n')
}

function getPriorityColor(priority: string, theme: any): string {
  switch (priority) {
    case 'high':
      return '#FF6B6B'
    case 'medium':
      return '#FFE66D'
    case 'low':
      return '#4ECDC4'
    default:
      return theme.secondaryText
  }
}

function sortTodosForDisplay(todos: TodoItem[]): TodoItem[] {
  return [...todos].sort((a, b) => {
    if (a.status === 'in_progress' && b.status !== 'in_progress') return -1
    if (b.status === 'in_progress' && a.status !== 'in_progress') return 1

    const priorityOrder = { high: 3, medium: 2, low: 1 } as const
    return (priorityOrder[b.priority] ?? 0) - (priorityOrder[a.priority] ?? 0)
  })
}

export const TodoReadTool = {
  name: 'TodoRead',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'View Todos'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(output: TodoReadResult) {
    return formatTodosForAssistant(output)
  },
  renderToolUseMessage(input: TodoReadInput) {
    const parts: string[] = []
    if (input.status?.length) parts.push(`status=${input.status.join('|')}`)
    if (input.priority?.length)
      parts.push(`priority=${input.priority.join('|')}`)
    if (input.query?.trim()) parts.push(`query=${JSON.stringify(input.query.trim())}`)
    return parts.length ? parts.join(', ') : '(all)'
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TodoReadResult) {
    const theme = getTheme()
    const todos = sortTodosForDisplay(output.todos)

    if (todos.length === 0) {
      return (
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.secondaryText}>(No todos)</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.secondaryText}>
            {output.summary.completed}/{output.summary.total} completed ·{' '}
            {output.summary.in_progress} in progress · {output.summary.pending}{' '}
            pending
          </Text>
        </Box>
        {todos.map(todo => {
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
              <Text color={getPriorityColor(todo.priority, theme)}>
                {statusIcon}{' '}
              </Text>
              <Text
                color={textColor}
                bold={isBold}
                strikethrough={isStrikethrough}
              >
                {todo.content}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  },
  async *call(input: TodoReadInput, context) {
    const agentId = context?.agentId
    const allTodos = getTodos(agentId)

    let todos = allTodos

    if (input.status?.length) {
      todos = todos.filter(t => input.status!.includes(t.status))
    }

    if (input.priority?.length) {
      todos = todos.filter(t => input.priority!.includes(t.priority))
    }

    if (input.query?.trim()) {
      const q = input.query.trim().toLowerCase()
      todos = todos.filter(t => t.content.toLowerCase().includes(q))
    }

    const result: TodoReadResult = {
      todos,
      summary: summarizeTodos(todos),
      filters:
        input.status?.length || input.priority?.length || input.query?.trim()
          ? {
              ...(input.status?.length ? { status: input.status } : {}),
              ...(input.priority?.length ? { priority: input.priority } : {}),
              ...(input.query?.trim() ? { query: input.query.trim() } : {}),
            }
          : undefined,
    }

    yield {
      type: 'result',
      data: result,
      resultForAssistant: this.renderResultForAssistant(result),
    }
  },
} satisfies Tool<typeof inputSchema, TodoReadResult>

