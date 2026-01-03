import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'

type Props = {
  tokenUsage: number
  maxTokens?: number
}

// 默认 1M 上下文
const DEFAULT_MAX_TOKENS = 1_000_000

export function TokenWarning({ tokenUsage, maxTokens = DEFAULT_MAX_TOKENS }: Props): React.ReactNode {
  const theme = getTheme()

  const warningThreshold = maxTokens * 0.6
  const errorThreshold = maxTokens * 0.8

  if (tokenUsage < warningThreshold) {
    return null
  }

  const isError = tokenUsage >= errorThreshold

  return (
    <Box flexDirection="row">
      <Text color={isError ? theme.error : theme.warning}>
        上下文不足 (剩余
        {Math.max(0, 100 - Math.round((tokenUsage / maxTokens) * 100))}%
        ) · 运行 /compact 压缩后继续
      </Text>
    </Box>
  )
}
