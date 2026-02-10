import { Box, Text } from 'ink'
import { OutputLine } from './OutputLine'
import React from 'react'
import { getTheme } from '@utils/theme'
import { Out as BashOut } from './BashTool'
import { TREE_END } from '@constants/figures'

type Props = {
  content: Omit<BashOut, 'interrupted'>
  verbose: boolean
}

function BashToolResultMessage({ content, verbose }: Props): React.JSX.Element {
  const { stdout, stdoutLines, stderr, stderrLines } = content
  const theme = getTheme()

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.bashBorder}
      paddingX={1}
    >
      {stdout !== '' ? (
        <OutputLine content={stdout} lines={stdoutLines} verbose={verbose} />
      ) : null}
      {stderr !== '' ? (
        <OutputLine
          content={stderr}
          lines={stderrLines}
          verbose={verbose}
          isError
        />
      ) : null}
      {stdout === '' && stderr === '' ? (
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.secondaryText}>(No content)</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default BashToolResultMessage
