import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '@utils/theme'
import { formatDuration } from '@utils/format'
import { TASK_DASH } from '@constants/figures'

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
}: Props) {
  const theme = getTheme()

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

  // Kode-style single-line compact format:
  // ⎯ [agent-type] status · N tool uses · Nk tokens · Ns
  const parts: string[] = []
  parts.push(status)
  if (toolCount != null && toolCount > 0) parts.push(`${toolCount} tool uses`)
  if (tokenLabel) parts.push(tokenLabel)
  if (elapsed) parts.push(elapsed)

  return (
    <Box flexDirection="row">
      <Text color={theme.yuuka}> {TASK_DASH} </Text>
      <Text bold>[{agentType}]</Text>
      <Text color={theme.secondaryText}> {parts.join(' · ')}</Text>
    </Box>
  )
}
