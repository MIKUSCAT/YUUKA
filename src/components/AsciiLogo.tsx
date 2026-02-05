import { Box, Text } from 'ink'
import React from 'react'
import { getTheme } from '@utils/theme'
import { ASCII_LOGO } from '@constants/product'

export function AsciiLogo(): React.ReactNode {
  const theme = getTheme()
  return (
    <Box flexDirection="column" alignItems="center" width="100%">
      <Text color={theme.yuuka}>{ASCII_LOGO.trim()}</Text>
    </Box>
  )
}
