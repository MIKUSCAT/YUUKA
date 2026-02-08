import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'
import { MAX_RENDERED_LINES } from './prompt'
import chalk from 'chalk'
import { TREE_END } from '@constants/figures'
import { sanitizeLongLine } from '@utils/outputPreview'

function renderTruncatedContent(content: string, totalLines: number): string {
  const allLines = content.split('\n')
  if (allLines.length <= MAX_RENDERED_LINES) {
    return allLines.map(sanitizeLongLine).join('\n')
  }

  // Show last 5 lines of output by default (matching reference implementation)
  const lastLines = allLines.slice(-MAX_RENDERED_LINES)
  return [
    chalk.grey(
      `Showing last ${MAX_RENDERED_LINES} lines of ${totalLines} total lines`,
    ),
    ...lastLines.map(sanitizeLongLine),
  ].join('\n')
}

export function OutputLine({
  content,
  lines,
  verbose,
  isError,
}: {
  content: string
  lines: number
  verbose: boolean
  isError?: boolean
  key?: React.Key
}) {
  const theme = getTheme()
  return (
    <Box justifyContent="space-between" width="100%">
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>{TREE_END} </Text>
        <Box flexDirection="column">
          <Text color={isError ? theme.error : undefined}>
            {verbose
              ? content.trim()
              : renderTruncatedContent(content.trim(), lines)}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
