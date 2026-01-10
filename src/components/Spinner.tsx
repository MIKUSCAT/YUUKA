import { Box, Text } from 'ink'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { getTheme } from '@utils/theme'
import { sample } from 'lodash-es'
import { getSessionState } from '@utils/sessionState'
import { SPINNER_FRAMES } from '@constants/figures'

const MESSAGES = [
  '正在处理',
  '在忙活',
  '在推理',
  '在分析',
  '在查找',
  '在整理',
  '在执行',
  '在准备',
  '在等待',
]

export function Spinner(): React.ReactNode {
  const frames = [...SPINNER_FRAMES]
  const [frame, setFrame] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const message = useRef(sample(MESSAGES))
  const startTime = useRef(Date.now())

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % frames.length)
    }, 120)

    return () => clearInterval(timer)
  }, [frames.length])

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime.current) / 1000))
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box flexWrap="nowrap" height={1} width={2}>
        <Text color={getTheme().kode}>{frames[frame]}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Text color={getTheme().kode} wrap="truncate-end">
          {(getSessionState('currentThought')?.subject?.trim() ||
            message.current ||
            '思考中') + '… '}
        </Text>
        <Text color={getTheme().secondaryText}>
          ({elapsedTime}s · <Text bold>Esc</Text> 取消)
        </Text>
        {getSessionState('currentError') ? (
          <Text color={getTheme().secondaryText}>
            {' '}
            · {getSessionState('currentError')}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

export function SimpleSpinner(): React.ReactNode {
  const frames = [...SPINNER_FRAMES]
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % frames.length)
    }, 120)

    return () => clearInterval(timer)
  }, [frames.length])

  return (
    <Box flexWrap="nowrap" height={1} width={2}>
      <Text color={getTheme().kode}>{frames[frame]}</Text>
    </Box>
  )
}
