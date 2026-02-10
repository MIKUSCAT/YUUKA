import React from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '@utils/theme'
import { formatDuration } from '@utils/format'

export interface TaskProgressPayload {
  agentType: string
  status: string
  model?: string
  toolCount?: number
  tokenCount?: number
  elapsedMs?: number
  lastAction?: string
  timeline?: string[]
}

interface Props extends TaskProgressPayload {}

export const TASK_PROGRESS_PREFIX = '__YUUKA_TASK_PROGRESS__'

export function encodeTaskProgress(payload: TaskProgressPayload): string {
  return `${TASK_PROGRESS_PREFIX}${JSON.stringify(payload)}`
}

export function parseTaskProgressText(text: string): TaskProgressPayload | null {
  if (!text.startsWith(TASK_PROGRESS_PREFIX)) {
    return null
  }
  const raw = text.slice(TASK_PROGRESS_PREFIX.length)
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.agentType !== 'string' || typeof parsed.status !== 'string') {
      return null
    }
    if (
      parsed.timeline !== undefined &&
      (!Array.isArray(parsed.timeline) ||
        !parsed.timeline.every((item: unknown) => typeof item === 'string'))
    ) {
      return null
    }
    return parsed as TaskProgressPayload
  } catch {
    return null
  }
}

export function TaskProgressMessage({
  agentType,
  status,
  toolCount,
  tokenCount,
  elapsedMs,
  model,
  lastAction,
  timeline,
}: Props) {
  const theme = getTheme()
  const elapsed = typeof elapsedMs === 'number' ? formatDuration(elapsedMs) : null
  const tokenLabel = typeof tokenCount === 'number'
    ? tokenCount >= 1000 ? `${(tokenCount / 1000).toFixed(1)}k` : String(tokenCount)
    : null
  const shownAction =
    typeof lastAction === 'string' && lastAction.trim().length > 0
      ? lastAction.length > 80
        ? `${lastAction.slice(0, 80)}…`
        : lastAction
      : null

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={theme.secondaryBorder}
      paddingX={1}
      paddingY={0}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={theme.yuuka} bold>
          agent: {agentType}
        </Text>
        <Text color={theme.secondaryText}>
          {status}
          {elapsed ? ` (${elapsed})` : ''}
        </Text>
      </Box>
      <Text color={theme.secondaryText}>
        {model ? `模型: ${model}` : '模型: -'} · 工具: {toolCount ?? 0}
        {tokenLabel ? ` · ${tokenLabel}` : ''}
      </Text>
      {shownAction ? <Text color={theme.text}>&gt; {shownAction}</Text> : null}
    </Box>
  )
}
