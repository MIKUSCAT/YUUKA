import * as React from 'react'
import { getTheme } from '@utils/theme'
import { Text } from 'ink'
import { PRODUCT_NAME } from '@constants/product'
import { TREE_END } from '@constants/figures'

export function FallbackToolUseRejectedMessage(): React.ReactNode {
  const theme = getTheme()
  return (
    <Text>
      <Text color={theme.secondaryText}>{TREE_END} </Text>
      <Text color={theme.error}>
        No (tell {PRODUCT_NAME} what to do differently)
      </Text>
    </Text>
  )
}
