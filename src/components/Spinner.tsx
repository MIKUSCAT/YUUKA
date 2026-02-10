import { Box, Text } from 'ink'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { getTheme } from '@utils/theme'
import { sample } from 'lodash-es'
import { getSessionState } from '@utils/sessionState'
import { SPINNER_FRAMES } from '@constants/figures'

const MESSAGES = [
  'Thinking',
  'Analyzing',
  'Planning',
  'Reasoning',
  'Parsing',
  'Drafting',
  'Executing',
  'Reviewing',
  'Syncing',
  'Refining',
  'Validating',
  'Mapping',
  'Calibrating',
  'Optimizing',
  'Scanning',
  'Indexing',
  'Resolving',
  'Structuring',
  'Tracing',
  'Testing',
  'Aligning',
  'Verifying',
  'Iterating',
  'Integrating',
  'Profiling',
  'Estimating',
  'Stabilizing',
  'Rechecking',
  'Fine-tuning',
  'Consolidating',
  'Prioritizing',
  'Contextualizing',
  'Compiling',
  'Polishing',
  'Wrapping up',
  'Almost there',
  'Réflexion',
  'Analyse',
  'Planification',
  'Vérification',
  'Exécution',
  'Validation',
  'Optimisation',
  'Ajustement',
  'Affinage',
  'Résolution',
  'Intégration',
  'Finalisation',
  'Consolidation',
  'Pensando',
  'Analizando',
  'Planificando',
  'Verificando',
  'Ejecutando',
  'Validando',
  'Optimizando',
  'Ajustando',
  'Refinando',
  'Sincronizando',
  'Resolviendo',
  'Integrando',
  'Iterando',
  'Estabilizando',
  'Calculando',
  'Finalizing',
  'Consolidando',
]

const NETWORK_ERROR_PATTERN =
  /(网络波动|network|timeout|timed out|连接|connect|ECONN|ENOTFOUND|EAI_AGAIN)/i
const COLOR_TRANSITION_STEP = 0.12
const MESSAGE_SWITCH_TICKS = 22 // ~2640ms at 120ms interval

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function hexToRgb(color: string): [number, number, number] | null {
  const normalized = color.trim()
  const fullHex =
    normalized.length === 4 && normalized.startsWith('#')
      ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
      : normalized

  const match = /^#([a-fA-F0-9]{6})$/.exec(fullHex)
  if (!match) return null

  return [
    parseInt(match[1].slice(0, 2), 16),
    parseInt(match[1].slice(2, 4), 16),
    parseInt(match[1].slice(4, 6), 16),
  ]
}

function interpolateColor(from: string, to: string, progress: number): string {
  const fromRgb = hexToRgb(from)
  const toRgb = hexToRgb(to)
  if (!fromRgb || !toRgb) return progress >= 0.5 ? to : from

  const ratio = clamp(progress)
  const mixed = fromRgb.map((value, index) =>
    Math.round(value + (toRgb[index] - value) * ratio),
  ) as [number, number, number]

  return `#${mixed.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function isNetworkIssueMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && NETWORK_ERROR_PATTERN.test(message)
}

function pickNextMessage(current: string): string {
  if (MESSAGES.length <= 1) return MESSAGES[0] || '我在继续处理你的请求，请稍等。'

  let next = current
  while (next === current) {
    next = sample(MESSAGES) || MESSAGES[0]
  }
  return next
}

export function Spinner(): React.ReactNode {
  const frames = [...SPINNER_FRAMES]
  const theme = getTheme()
  const [frame, setFrame] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [message, setMessage] = useState(
    () => sample(MESSAGES) || MESSAGES[0] || '我在继续处理你的请求，请稍等。',
  )
  const [networkWarningTone, setNetworkWarningTone] = useState(() =>
    isNetworkIssueMessage(getSessionState('currentError')) ? 1 : 0,
  )
  const startTime = useRef(Date.now())
  const tickRef = useRef(0)

  // 合并为单一主循环，减少重渲染次数
  useEffect(() => {
    const timer = setInterval(() => {
      tickRef.current++

      // 动画帧：每120ms
      setFrame(f => (f + 1) % frames.length)

      // 秒数：整秒更新
      setElapsedTime(
        Math.floor((Date.now() - startTime.current) / 1000),
      )

      // 网络警告色彩过渡
      setNetworkWarningTone(prev => {
        const target = isNetworkIssueMessage(getSessionState('currentError'))
          ? 1
          : 0
        if (Math.abs(target - prev) <= COLOR_TRANSITION_STEP) return target
        return target > prev
          ? prev + COLOR_TRANSITION_STEP
          : prev - COLOR_TRANSITION_STEP
      })

      // 消息切换：约每2640ms
      if (tickRef.current % MESSAGE_SWITCH_TICKS === 0) {
        setMessage(prev => pickNextMessage(prev))
      }
    }, 120)

    return () => clearInterval(timer)
  }, [frames.length])

  const currentError = getSessionState('currentError')
  const isNetworkIssue = isNetworkIssueMessage(currentError)
  const spinnerColor = interpolateColor(
    theme.yuuka,
    theme.error,
    networkWarningTone,
  )

  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box flexWrap="nowrap" height={1} width={2}>
        <Text color={spinnerColor}>{frames[frame]}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Text color={spinnerColor} wrap="truncate-end">
          {(getSessionState('currentThought')?.subject?.trim() ||
            message ||
            '思考中') + '… '}
        </Text>
        <Text color={theme.secondaryText}>
          ({elapsedTime}s · <Text bold>Esc</Text> 取消)
        </Text>
        {currentError && !isNetworkIssue ? (
          <Text color={theme.secondaryText}>
            {' '}
            · {currentError}
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
      <Text color={getTheme().yuuka}>{frames[frame]}</Text>
    </Box>
  )
}
