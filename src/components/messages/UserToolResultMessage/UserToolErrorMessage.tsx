import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

const MAX_RENDERED_LINES = 10

type Props = {
  param: ToolResultBlockParam
  verbose: boolean
}

export function UserToolErrorMessage({
  param,
  verbose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const error =
    typeof param.content === 'string' ? param.content.trim() : 'Error'
  return (
    <Box flexDirection="row" width="100%">
      <Text color={theme.secondaryText}>{TREE_END} </Text>
      <Box flexDirection="column">
        <Text color={theme.error}>
          {verbose
            ? error
            : error.split('\n').slice(0, MAX_RENDERED_LINES).join('\n') || ''}
        </Text>
        {!verbose && error.split('\n').length > MAX_RENDERED_LINES && (
          <Text color={theme.secondaryText}>
            ... (+{error.split('\n').length - MAX_RENDERED_LINES} lines)
          </Text>
        )}
      </Box>
    </Box>
  )
}
