import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '@utils/theme'
import { formatDuration } from '@utils/format'
import { useInterval } from '@hooks/useInterval'
import { useTerminalSize } from '@hooks/useTerminalSize'
import {
  BOX_TOP_LEFT,
  BOX_TOP_RIGHT,
  BOX_BOTTOM_LEFT,
  BOX_BOTTOM_RIGHT,
  BOX_HORIZONTAL,
  BOX_VERTICAL,
  CHECK_MARK,
  PENDING_CIRCLE,
  SUB_CONNECTOR,
  SPINNER_FRAMES,
  PROGRESS_FILLED,
  PROGRESS_EMPTY,
} from '@constants/figures'
import type { TaskProgressPayload } from './TaskProgressMessage'
import { summarizeTaskResultText } from '@utils/taskResultSummary'

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

// ── 常量 ──────────────────────────────────────────

const NAME_WIDTH = 18
const STATUS_WIDTH = 20
const TIME_WIDTH = 6

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  return text + ' '.repeat(width - text.length)
}

function padStart(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  return ' '.repeat(width - text.length) + text
}

function normalizeInline(text: string | null | undefined): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized || null
}

type BoardState = 'open' | 'queued' | 'in_progress' | 'completed' | 'failed'

function normalizeTaskState(progress: TaskProgressPayload | null): BoardState {
  const rawState = String(progress?.taskState || '').trim().toLowerCase()
  const rawStatus = String(progress?.status || '').trim()

  if (rawState === 'failed' || rawState === 'cancelled') {
    return 'failed'
  }
  if (rawState === 'completed') {
    return 'completed'
  }
  if (rawState === 'in_progress' || rawState === 'running') {
    return 'in_progress'
  }
  if (rawState === 'open' || rawState === 'pending' || rawState === 'blocked') {
    return 'queued'
  }

  if (rawStatus === '已结束' || rawStatus === '失败') return 'failed'
  if (rawStatus === '已完成') return 'completed'
  if (
    rawStatus === '重试中' ||
    rawStatus === '分析中' ||
    rawStatus === '调用工具' ||
    rawStatus === '收到消息' ||
    rawStatus === '状态更新' ||
    rawStatus === '队友消息'
  ) {
    return 'in_progress'
  }
  if (rawStatus === '排队中' || rawStatus === '启动中' || rawStatus === '等待中') {
    return 'queued'
  }
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

// ── 子组件 ────────────────────────────────────────

function AgentRow({
  agentName,
  state,
  statusText,
  elapsedMs,
  subStatus,
  panelWidth,
}: {
  agentName: string
  state: BoardState
  statusText: string
  elapsedMs: number | null
  subStatus: string | null
  panelWidth: number
}) {
  const theme = getTheme()
  const [spinnerIdx, setSpinnerIdx] = useState(0)
  const isActive = state === 'in_progress'
  const isFailed = state === 'failed'
  const isQueued = state === 'queued' || state === 'open'

  useInterval(() => {
    if (isActive) {
      setSpinnerIdx(i => (i + 1) % SPINNER_FRAMES.length)
    }
  }, 120)

  // 本地计时
  const baseMs = useRef(typeof elapsedMs === 'number' ? elapsedMs : 0)
  const mountTime = useRef(Date.now())
  const [localElapsed, setLocalElapsed] = useState(
    typeof elapsedMs === 'number' ? elapsedMs : 0,
  )

  useEffect(() => {
    if (typeof elapsedMs === 'number') {
      baseMs.current = elapsedMs
      mountTime.current = Date.now()
      setLocalElapsed(elapsedMs)
    }
  }, [elapsedMs])

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => {
      setLocalElapsed(baseMs.current + (Date.now() - mountTime.current))
    }, 1000)
    return () => clearInterval(id)
  }, [isActive])

  const icon = isActive
    ? SPINNER_FRAMES[spinnerIdx]
    : state === 'completed'
      ? CHECK_MARK
      : state === 'failed'
        ? '✖'
        : PENDING_CIRCLE
  const iconColor = isActive
    ? theme.yuuka
    : state === 'completed'
      ? theme.success
      : state === 'failed'
        ? theme.error
        : theme.secondaryText

  const elapsed = localElapsed > 0 ? formatDuration(localElapsed) : '—'
  const nameStr = pad(truncate(agentName, NAME_WIDTH - 1), NAME_WIDTH)
  const statusStr = pad(truncate(statusText, STATUS_WIDTH - 1), STATUS_WIDTH)
  const timeStr = padStart(elapsed, TIME_WIDTH)

  // 内容宽度 = panelWidth - 2(边框) - 4(内边距)
  const contentWidth = panelWidth - 6

  const subStatusColor = isFailed
    ? theme.error
    : isQueued
      ? theme.secondaryText
      : theme.secondaryText

  return (
    <>
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
        <Text>{'  '}</Text>
        <Text color={iconColor}>{icon}</Text>
        <Text>{' '}</Text>
        <Text bold={isActive}>{nameStr}</Text>
        <Text color={theme.secondaryText}>{statusStr}</Text>
        <Text color={theme.secondaryText}>{timeStr}</Text>
        <Text>
          {' '.repeat(Math.max(0, contentWidth - 3 - NAME_WIDTH - STATUS_WIDTH - TIME_WIDTH))}
        </Text>
        <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
      </Box>
      {subStatus && (isActive || state === 'completed' || state === 'failed' || isQueued) && (
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
          <Text>{'    '}</Text>
          <Text color={subStatusColor}>
            {SUB_CONNECTOR} {truncate(subStatus, contentWidth - 6)}
          </Text>
          <Text>
            {' '.repeat(Math.max(0, contentWidth - 6 - Math.min(subStatus.length, contentWidth - 6)))}
          </Text>
          <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
        </Box>
      )}
    </>
  )
}

function ProgressBar({
  completed,
  total,
  panelWidth,
}: {
  completed: number
  total: number
  panelWidth: number
}) {
  const theme = getTheme()
  // 进度条宽度 = panelWidth - 2(边框) - 4(内边距)
  const barWidth = Math.max(8, panelWidth - 6)
  const ratio = total > 0 ? completed / total : 0
  const filledCount = Math.round(ratio * barWidth)
  const emptyCount = barWidth - filledCount
  const bar = PROGRESS_FILLED.repeat(filledCount) + PROGRESS_EMPTY.repeat(emptyCount)

  return (
    <Box flexDirection="row">
      <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
      <Text>{'  '}</Text>
      <Text color={theme.yuuka}>{bar.slice(0, filledCount)}</Text>
      <Text color={theme.secondaryText} dimColor>{bar.slice(filledCount)}</Text>
      <Text>{'  '}</Text>
      <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
    </Box>
  )
}

// ── 主组件 ────────────────────────────────────────

export function TaskProgressGroup({ items }: Props) {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const panelWidth = Math.min(columns - 2, 60)

  const teamName = items[0]?.teamName || items[0]?.progress?.teamName || 'default-team'
  const agents = groupByAgent(items)

  // 统计
  const total = items.length
  const completed = items.filter(item => {
    const state = normalizeTaskState(item.progress)
    return state === 'completed' || state === 'failed'
  }).length

  // ── 顶部边框 ──
  const headerLabel = ` ${teamName} `
  const doneLabel = ` ${completed}/${total} done `
  const topBarFill = Math.max(0, panelWidth - 2 - headerLabel.length - doneLabel.length)
  const topLeftLine = BOX_HORIZONTAL.repeat(Math.min(3, topBarFill))
  const topRightLine = BOX_HORIZONTAL.repeat(Math.max(0, topBarFill - 3))

  // ── 底部边框 ──
  const bottomLine = BOX_HORIZONTAL.repeat(Math.max(0, panelWidth - 2))

  // ── 空行 ──
  const emptyLine = (
    <Box flexDirection="row">
      <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
      <Text>{' '.repeat(Math.max(0, panelWidth - 2))}</Text>
      <Text color={theme.secondaryText}>{BOX_VERTICAL}</Text>
    </Box>
  )

  return (
    <Box flexDirection="column">
      {/* 顶部圆角边框 */}
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>{BOX_TOP_LEFT}{topLeftLine}</Text>
        <Text color={theme.yuuka} bold>{headerLabel}</Text>
        <Text color={theme.secondaryText}>{topRightLine}</Text>
        <Text color={theme.secondaryText}>{doneLabel}</Text>
        <Text color={theme.secondaryText}>{BOX_TOP_RIGHT}</Text>
      </Box>

      {emptyLine}

      {/* Agent 行 */}
      {agents.map(([agentName, agentItems], agentIndex) => {
        // 取该 agent 下最"活跃"的任务来展示
        const bestItem =
          agentItems.find(i => normalizeTaskState(i.progress) === 'in_progress') ||
          agentItems.find(i => normalizeTaskState(i.progress) === 'completed') ||
          agentItems[0]
        const state = normalizeTaskState(bestItem.progress)

        const rawStatus = bestItem.progress?.status || ''
        const stateHintText = `${bestItem.progress?.lastAction || ''} ${bestItem.progress?.eventContent || ''}`
        const isRetrying = /重试|retry/i.test(`${rawStatus} ${stateHintText}`)
        let statusText = rawStatus || '等待中'
        if (state === 'queued') {
          statusText = '排队中'
        } else if (state === 'failed') {
          statusText = '失败'
        } else if (state === 'completed') {
          statusText = '已完成'
        } else if (isRetrying) {
          statusText = '重试中'
        }

        const elapsedMs =
          typeof bestItem.progress?.elapsedMs === 'number' && bestItem.progress.elapsedMs > 0
            ? bestItem.progress.elapsedMs
            : null

        // 子状态：当前操作详情
        const parsedFinal = summarizeTaskResultText(bestItem.progress?.eventContent || '')
        let subStatus = bestItem.progress?.lastAction || null
        if (state === 'completed' || state === 'failed') {
          if (parsedFinal.reportPath) {
            subStatus = `REPORT_PATH: ${parsedFinal.reportPath}`
          } else if (parsedFinal.errorSummary) {
            subStatus = parsedFinal.errorSummary
          } else if (
            bestItem.progress?.eventType === 'result' ||
            bestItem.progress?.eventType === 'status'
          ) {
            subStatus = normalizeInline(bestItem.progress?.eventContent) || subStatus
          }
        }

        return (
          <React.Fragment key={agentName}>
            <AgentRow
              agentName={agentName}
              state={state}
              statusText={statusText}
              elapsedMs={elapsedMs}
              subStatus={subStatus}
              panelWidth={panelWidth}
            />
            {/* agent 之间的呼吸空行 */}
            {agentIndex < agents.length - 1 && emptyLine}
          </React.Fragment>
        )
      })}

      {emptyLine}

      {/* 进度条 */}
      <ProgressBar completed={completed} total={total} panelWidth={panelWidth} />

      {emptyLine}

      {/* 底部圆角边框 */}
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>
          {BOX_BOTTOM_LEFT}{bottomLine}{BOX_BOTTOM_RIGHT}
        </Text>
      </Box>
    </Box>
  )
}
