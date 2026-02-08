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
  const [frame, setFrame] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [message, setMessage] = useState(
    () => sample(MESSAGES) || MESSAGES[0] || '我在继续处理你的请求，请稍等。',
  )
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

  useEffect(() => {
    const timer = setInterval(() => {
      setMessage(prev => pickNextMessage(prev))
    }, 2600)

    return () => clearInterval(timer)
  }, [])

  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box flexWrap="nowrap" height={1} width={2}>
        <Text color={getTheme().yuuka}>{frames[frame]}</Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Text color={getTheme().yuuka} wrap="truncate-end">
          {(getSessionState('currentThought')?.subject?.trim() ||
            message ||
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
      <Text color={getTheme().yuuka}>{frames[frame]}</Text>
    </Box>
  )
}
