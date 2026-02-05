import { Box, Text } from 'ink'
import * as React from 'react'
import { TodoItem } from '@utils/todoStorage'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

const MAX_VISIBLE_TODOS = 12

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

function summarizeTodos(todos: TodoItem[]) {
  return {
    total: todos.length,
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length,
  }
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const theme = getTheme()
  const stats = summarizeTodos(todos)
  const sortedTodos = sortTodosForDisplay(todos)
  const visibleTodos = sortedTodos.slice(0, MAX_VISIBLE_TODOS)
  const remaining = Math.max(0, sortedTodos.length - visibleTodos.length)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.secondaryBorder}
      paddingX={1}
      paddingY={0}
      marginTop={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.secondaryText} bold>
            Todo
          </Text>
          <Text color={theme.secondaryText}>
            {' '}
            {stats.completed}/{stats.total} 完成 · {stats.in_progress} 进行中 ·{' '}
            {stats.pending} 待办
          </Text>
        </Box>
        <Text color={theme.secondaryText} dimColor>
          Alt+T 收起
        </Text>
      </Box>

      {visibleTodos.length === 0 ? (
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.secondaryText}>(空)</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleTodos.map(todo => {
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
              textColor = theme.yuuka
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

          {remaining > 0 && (
            <Box flexDirection="row">
              <Text color={theme.secondaryText}>{TREE_END} </Text>
              <Text color={theme.secondaryText} dimColor>
                ... (+{remaining} more)
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
