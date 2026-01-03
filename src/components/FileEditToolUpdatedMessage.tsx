import { Hunk } from 'diff'
import { Box, Text } from 'ink'
import * as React from 'react'
import { intersperse } from '@utils/array'
import { StructuredDiff } from './StructuredDiff'
import { getTheme } from '@utils/theme'
import { getCwd } from '@utils/state'
import { relative } from 'path'
import { useTerminalSize } from '@hooks/useTerminalSize'
import { TREE_END } from '@constants/figures'

type Props = {
  filePath: string
  structuredPatch?: Hunk[]
  verbose: boolean
}

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  verbose,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const theme = getTheme()
  const patches = Array.isArray(structuredPatch) ? structuredPatch : []
  const numAdditions = patches.reduce(
    (count, hunk) => count + hunk.lines.filter(_ => _.startsWith('+')).length,
    0,
  )
  const numRemovals = patches.reduce(
    (count, hunk) => count + hunk.lines.filter(_ => _.startsWith('-')).length,
    0,
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.secondaryText}>{TREE_END} </Text>
        <Text color={theme.success}>Updated </Text>
        <Text bold>{verbose ? filePath : relative(getCwd(), filePath)}</Text>
        {numAdditions > 0 || numRemovals > 0 ? ' with ' : ''}
        {numAdditions > 0 ? (
          <>
            <Text bold color={theme.success}>+{numAdditions}</Text>{' '}
          </>
        ) : null}
        {numAdditions > 0 && numRemovals > 0 ? '' : null}
        {numRemovals > 0 ? (
          <>
            <Text bold color={theme.error}>-{numRemovals}</Text>
          </>
        ) : null}
      </Text>
      {patches.length > 0 &&
        intersperse(
          patches.map(_ => (
            <Box flexDirection="column" paddingLeft={5} key={_.newStart}>
              <StructuredDiff patch={_} dim={false} width={columns - 12} />
            </Box>
          )),
          i => (
            <Box paddingLeft={5} key={`ellipsis-${i}`}>
              <Text color={theme.secondaryText}>...</Text>
            </Box>
          ),
        )}
    </Box>
  )
}
