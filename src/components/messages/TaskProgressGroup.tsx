import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '@utils/theme'
import { formatDuration } from '@utils/format'
import { SPINNER_FRAMES } from '@constants/figures'
import { useInterval } from '@hooks/useInterval'
import type { TaskProgressPayload } from './TaskProgressMessage'

export interface TaskProgressItem {
  description: string
  agentType: string
  progress: TaskProgressPayload | null
}

interface Props {
  items: TaskProgressItem[]
}

function formatTokens(count: number | undefined): string | null {
  if (typeof count !== 'number') return null
  return count >= 1000
    ? `${(count / 1000).toFixed(1)}k tokens`
    : `${count} tokens`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function TaskProgressGroup({ items }: Props) {
  const theme = getTheme()
  const allCompleted = items.every(
    item => item.progress?.status === '已完成',
  )
  const isActive = !allCompleted

  // Braille spinner
  const [spinnerIdx, setSpinnerIdx] = useState(0)
  useInterval(() => {
    if (isActive) {
      setSpinnerIdx(i => (i + 1) % SPINNER_FRAMES.length)
    }
  }, 120)

  const agentType = items[0]?.agentType ?? 'Task'
  const count = items.length
  const isMulti = count > 1

  // Header
  const indicator = isActive ? SPINNER_FRAMES[spinnerIdx] : '✓'
  const indicatorColor = isActive ? theme.yuuka : theme.success
  let headerText: string
  if (allCompleted) {
    headerText = isMulti
      ? `${count} ${agentType} agents completed`
      : `${agentType} agent completed`
  } else {
    headerText = isMulti
      ? `Running ${count} ${agentType} agents…`
      : `Running ${agentType} agent…`
  }

  return (
    <Box flexDirection="column">
      {/* Header line */}
      <Box flexDirection="row">
        <Text color={indicatorColor}>{indicator}</Text>
        <Text> {headerText}</Text>
      </Box>

      {/* Child items */}
      {items.map((item, idx) => {
        const isLast = idx === count - 1
        const branch = isLast ? '└─' : '├─'
        const continuation = isLast ? '   ' : '│  '
        const p = item.progress

        // First line: description · stats
        const parts: string[] = [item.description]
        if (p) {
          if (p.toolCount != null && p.toolCount > 0) {
            parts.push(`${p.toolCount} tool uses`)
          }
          const tokenLabel = formatTokens(p.tokenCount)
          if (tokenLabel) parts.push(tokenLabel)
          if (p.status === '已完成' && typeof p.elapsedMs === 'number' && p.elapsedMs > 0) {
            parts.push(formatDuration(p.elapsedMs))
          }
        }
        const firstLine = parts.join(' · ')

        // Second line: action detail
        let secondLineText: string
        let secondLineColor: string
        if (!p) {
          secondLineText = '启动中…'
          secondLineColor = theme.secondaryText
        } else if (p.status === '已完成') {
          secondLineText = '✓ 完成'
          secondLineColor = theme.success
        } else {
          const action = p.lastAction
            ? truncate(p.lastAction, 50)
            : p.status
          secondLineText = `${action}…`
          secondLineColor = theme.secondaryText
        }

        return (
          <Box flexDirection="column" key={idx}>
            <Box flexDirection="row">
              <Text color={theme.secondaryText}>  {branch} </Text>
              <Text>{firstLine}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={theme.secondaryText}>  {continuation}</Text>
              <Text color={secondLineColor}>└ {secondLineText}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
