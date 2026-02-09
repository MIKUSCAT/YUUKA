import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

type Props = {
  children: React.ReactNode
}

export function MessageResponse({ children }: Props): React.ReactNode {
  const theme = getTheme()
  return (
    <Box flexDirection="row" width="100%">
      <Text color={theme.secondaryText}>{TREE_END} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}
