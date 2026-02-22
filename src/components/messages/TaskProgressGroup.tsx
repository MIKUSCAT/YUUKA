import React from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '@utils/theme'
import { formatDuration } from '@utils/format'
import type { TaskProgressPayload } from './TaskProgressMessage'

export interface TaskProgressItem {
  description: string
  agentType: string
  progress: TaskProgressPayload | null
  teamName?: string
  agentName?: string
  taskId?: string
  events?: Array<{
    type: 'message' | 'progress' | 'status' | 'result'
    content: string
  }>
}

interface Props {
  items: TaskProgressItem[]
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

type BoardState = 'open' | 'in_progress' | 'completed'

const PREFIX_WIDTH = '[PROGRESS]'.length

function prefixCell(prefix: string): string {
  return prefix.padEnd(PREFIX_WIDTH, ' ')
}

function normalizeTaskState(progress: TaskProgressPayload | null): BoardState {
  const rawState = String(progress?.taskState || '').trim().toLowerCase()
  const rawStatus = String(progress?.status || '').trim()

  if (rawState === 'completed' || rawState === 'failed' || rawState === 'cancelled') {
    return 'completed'
  }
  if (rawState === 'in_progress' || rawState === 'running') {
    return 'in_progress'
  }
  if (rawState === 'open' || rawState === 'pending' || rawState === 'blocked') {
    return 'open'
  }

  if (rawStatus === '已完成') return 'completed'
  if (
    rawStatus === '分析中' ||
    rawStatus === '调用工具' ||
    rawStatus === '启动中' ||
    rawStatus === '排队中' ||
    rawStatus === '收到消息'
  ) {
    return 'in_progress'
  }
  return 'open'
}

function summarizeStates(items: TaskProgressItem[]) {
  const total = items.length
  const completed = items.filter(item => normalizeTaskState(item.progress) === 'completed').length
  const inProgress = items.filter(item => normalizeTaskState(item.progress) === 'in_progress').length
  const open = Math.max(0, total - completed - inProgress)
  return { total, completed, inProgress, open }
}

function statusIcon(state: BoardState): string {
  if (state === 'completed') return '●'
  if (state === 'in_progress') return '◐'
  return '○'
}

function stateLabel(state: BoardState): string {
  if (state === 'completed') return 'completed'
  if (state === 'in_progress') return 'in_progress'
  return 'open'
}

function groupByAgent(items: TaskProgressItem[]) {
  const byAgent = new Map<string, TaskProgressItem[]>()
  for (const item of items) {
    const agentKey = item.agentName || item.progress?.agentName || item.agentType || 'agent'
    if (!byAgent.has(agentKey)) {
      byAgent.set(agentKey, [])
    }
    byAgent.get(agentKey)!.push(item)
  }
  return Array.from(byAgent.entries())
}

export function TaskProgressGroup({ items }: Props) {
  const theme = getTheme()
  const teamName = items[0]?.teamName || items[0]?.progress?.teamName || 'default-team'
  const teamStats = summarizeStates(items)
  const agents = groupByAgent(items)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>{prefixCell('[TEAM]')} </Text>
        <Text bold>{teamName}</Text>
        <Text color={theme.secondaryText}>
          {' '}
          open:{teamStats.open} in_progress:{teamStats.inProgress} completed:
          {teamStats.completed}
        </Text>
      </Box>

      {agents.map(([agentName, agentItems], agentIndex) => {
        const isLastAgent = agentIndex === agents.length - 1
        const agentStats = summarizeStates(agentItems)
        return (
          <Box flexDirection="column" key={agentName}>
            <Box flexDirection="row">
              <Text color={theme.secondaryText}>{isLastAgent ? '└─' : '├─'}</Text>
              <Text color={theme.secondaryText}>{prefixCell('[AGENT]')} </Text>
              <Text bold>{agentName}</Text>
              <Text color={theme.secondaryText}>
                {' '}
                open:{agentStats.open} in_progress:{agentStats.inProgress} completed:
                {agentStats.completed}
              </Text>
            </Box>

            {agentItems.map((item, taskIndex) => {
              const isLastTask = taskIndex === agentItems.length - 1
              const state = normalizeTaskState(item.progress)
              const icon = statusIcon(state)
              const taskLabel = item.taskId || item.progress?.taskId || '-'
              const taskDesc = item.description || '未命名任务'
              const elapsed =
                typeof item.progress?.elapsedMs === 'number' && item.progress.elapsedMs > 0
                  ? formatDuration(item.progress.elapsedMs)
                  : null

              const progressText = item.progress?.lastAction
                ? truncate(item.progress.lastAction, 88)
                : item.progress?.status
                  ? truncate(item.progress.status, 88)
                  : 'waiting...'

              const eventNodes = (item.events || [])
                .filter(event => Boolean(event.content?.trim()))
                .slice(-4)

              return (
                <Box flexDirection="column" key={`${agentName}-${taskLabel}-${taskIndex}`}>
                  <Box flexDirection="row">
                    <Text color={theme.secondaryText}>
                      {isLastAgent ? '   ' : '│  '}
                      {isLastTask ? '└─' : '├─'}
                    </Text>
                    <Text color={theme.secondaryText}>{prefixCell('[TASK]')} </Text>
                    <Text color={state === 'completed' ? theme.secondaryText : theme.yuuka}>
                      {icon}{' '}
                    </Text>
                    <Text
                      strikethrough={state === 'completed'}
                      color={state === 'completed' ? theme.secondaryText : undefined}
                    >
                      {taskLabel} {taskDesc}
                    </Text>
                    <Text color={theme.secondaryText}> · {stateLabel(state)}</Text>
                    {elapsed && <Text color={theme.secondaryText}> · {elapsed}</Text>}
                  </Box>

                  <Box flexDirection="row">
                    <Text color={theme.secondaryText}>
                      {isLastAgent ? '   ' : '│  '}
                      {isLastTask ? '   ' : '│  '}
                      {eventNodes.length === 0 ? '└─' : '├─'}
                    </Text>
                    <Text color={theme.secondaryText}>{prefixCell('[PROGRESS]')} </Text>
                    <Text color={theme.secondaryText}>{progressText}</Text>
                  </Box>

                  {eventNodes.map((event, eventIndex) => {
                    const isLastEvent = eventIndex === eventNodes.length - 1
                    const prefix =
                      event.type === 'message'
                        ? '[MSG]'
                        : event.type === 'status'
                          ? '[STATUS]'
                          : event.type === 'result'
                            ? '[STATUS]'
                            : '[PROGRESS]'
                    return (
                      <Box
                        flexDirection="row"
                        key={`${agentName}-${taskLabel}-event-${eventIndex}`}
                      >
                        <Text color={theme.secondaryText}>
                          {isLastAgent ? '   ' : '│  '}
                          {isLastTask ? '   ' : '│  '}
                          {isLastEvent ? '└─' : '├─'}
                        </Text>
                        <Text color={theme.secondaryText}>{prefixCell(prefix)} </Text>
                        <Text color={theme.secondaryText}>{truncate(event.content, 88)}</Text>
                      </Box>
                    )
                  })}
                </Box>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}
