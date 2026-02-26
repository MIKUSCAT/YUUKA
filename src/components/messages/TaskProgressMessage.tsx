import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '@utils/theme'
import { formatDuration } from '@utils/format'
import { SPINNER_FRAMES } from '@constants/figures'
import { useInterval } from '@hooks/useInterval'

export interface TaskProgressPayload {
  agentType: string
  status: string
  description?: string   // 稳定的任务描述（不随工具切换变化）
  model?: string
  toolCount?: number
  tokenCount?: number
  elapsedMs?: number
  lastAction?: string
  timeline?: string[]
  teamName?: string
  agentName?: string
  taskId?: string
  taskState?: string
  eventType?: 'progress' | 'message' | 'status' | 'result'
  eventContent?: string
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
    if (parsed.teamName !== undefined && typeof parsed.teamName !== 'string') {
      return null
    }
    if (parsed.agentName !== undefined && typeof parsed.agentName !== 'string') {
      return null
    }
    if (parsed.taskId !== undefined && typeof parsed.taskId !== 'string') {
      return null
    }
    if (parsed.taskState !== undefined && typeof parsed.taskState !== 'string') {
      return null
    }
    if (
      parsed.eventType !== undefined &&
      !['progress', 'message', 'status', 'result'].includes(parsed.eventType)
    ) {
      return null
    }
    if (parsed.eventContent !== undefined && typeof parsed.eventContent !== 'string') {
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
  lastAction,
}: Props) {
  const theme = getTheme()
  const isActive = status !== '已完成'

  // Braille spinner animation (8 frames, ~120ms per frame)
  const [spinnerIdx, setSpinnerIdx] = useState(0)
  useInterval(() => {
    if (isActive) {
      setSpinnerIdx(i => (i + 1) % SPINNER_FRAMES.length)
    }
  }, 120)

  // Local running timer: starts from the server-provided elapsedMs and ticks every second
  const baseMs = useRef(typeof elapsedMs === 'number' ? elapsedMs : 0)
  const mountTime = useRef(Date.now())
  const [localElapsed, setLocalElapsed] = useState(
    typeof elapsedMs === 'number' ? elapsedMs : 0,
  )

  // Update base when server sends a new elapsedMs
  useEffect(() => {
    if (typeof elapsedMs === 'number') {
      baseMs.current = elapsedMs
      mountTime.current = Date.now()
      setLocalElapsed(elapsedMs)
    }
  }, [elapsedMs])

  // Tick every second so the timer flows continuously
  useEffect(() => {
    const id = setInterval(() => {
      setLocalElapsed(baseMs.current + (Date.now() - mountTime.current))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const elapsed = localElapsed > 0 ? formatDuration(localElapsed) : null
  const tokenLabel =
    typeof tokenCount === 'number'
      ? tokenCount >= 1000
        ? `${(tokenCount / 1000).toFixed(1)}k tokens`
        : `${tokenCount} tokens`
      : null

  // Truncate lastAction to 40 chars
  const actionLabel = lastAction
    ? lastAction.length > 40
      ? `${lastAction.slice(0, 40)}…`
      : lastAction
    : null

  // Status indicator: spinning braille when active, ✓ when completed
  const indicator = isActive ? SPINNER_FRAMES[spinnerIdx] : '✓'

  // 列宽对齐
  const namePad = agentType.length < 18
    ? agentType + ' '.repeat(18 - agentType.length)
    : agentType.slice(0, 18)

  // 中间信息部分
  const midParts: string[] = []
  if (actionLabel) {
    midParts.push(actionLabel)
  } else {
    midParts.push(status)
  }
  if (toolCount != null && toolCount > 0) midParts.push(`${toolCount} tools`)
  if (tokenLabel) midParts.push(tokenLabel)
  const midText = midParts.join(' · ')

  return (
    <Box flexDirection="row">
      <Text>{'  '}</Text>
      <Text color={isActive ? theme.yuuka : theme.success}>{indicator}</Text>
      <Text>{' '}</Text>
      <Text bold={isActive}>{namePad}</Text>
      <Text color={theme.secondaryText}>{midText}</Text>
      {elapsed && <Text color={theme.secondaryText}>{'     '}{elapsed}</Text>}
    </Box>
  )
}
