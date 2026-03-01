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
  const addedLinesLabel = `${numAdditions} line${numAdditions === 1 ? '' : 's'}`
  const removedLinesLabel = `${numRemovals} line${numRemovals === 1 ? '' : 's'}`

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.secondaryText}>{TREE_END} </Text>
        {numAdditions > 0 || numRemovals > 0 ? (
          <>
            <Text color={theme.success}>Added </Text>
            <Text bold color={theme.success}>{addedLinesLabel}</Text>
            <Text>, removed </Text>
            <Text bold color={theme.error}>{removedLinesLabel}</Text>
          </>
        ) : (
          <>
            <Text color={theme.success}>Updated </Text>
            <Text bold>{verbose ? filePath : relative(getCwd(), filePath)}</Text>
          </>
        )}
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
