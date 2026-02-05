import React from 'react'
import { Box, Text } from 'ink'
import type { TodoItem as TodoItemType } from '@utils/todoStorage'

export interface TodoItemProps {
  todo: TodoItemType
  children?: React.ReactNode
}

export const TodoItem: React.FC<TodoItemProps> = ({ todo, children }) => {
  const statusLabelMap = {
    completed: '[DONE]',
    in_progress: '[DOING]',
    pending: '[TODO]',
  } as const

  const statusColorMap = {
    completed: '#008000',
    in_progress: '#FFA500', 
    pending: '#FFD700',
  }

  const priorityLabelMap = {
    high: '[H]',
    medium: '[M]',
    low: '[L]',
  } as const

  const statusLabel = statusLabelMap[todo.status]
  const color = statusColorMap[todo.status]
  const priorityLabel = todo.priority ? priorityLabelMap[todo.priority] : ''

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={color}>{statusLabel}</Text>
      {priorityLabel && <Text>{priorityLabel}</Text>}
      <Text 
        color={color}
        strikethrough={todo.status === 'completed'}
        bold={todo.status === 'in_progress'}
      >
        {todo.content}
      </Text>
      {children}
    </Box>
  )
}
