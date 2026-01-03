import { Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

export function UserToolCanceledMessage(): React.ReactNode {
  const theme = getTheme()
  return (
    <Text>
      <Text color={theme.secondaryText}>{TREE_END} </Text>
      <Text color={theme.error}>Interrupted by user</Text>
    </Text>
  )
}
