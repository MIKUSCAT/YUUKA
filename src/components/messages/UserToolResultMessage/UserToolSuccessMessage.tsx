import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Text } from 'ink'
import * as React from 'react'
import { Tool } from '@tool'
import { Message, UserMessage } from '@query'
import { useGetToolFromMessages } from './utils'
import { getTheme } from '@utils/theme'
import { sanitizeLongLine } from '@utils/outputPreview'

type Props = {
  param: ToolResultBlockParam
  message: UserMessage
  messages: Message[]
  verbose: boolean
  tools: Tool[]
  width: number | string
}

export function UserToolSuccessMessage({
  param,
  message,
  messages,
  tools,
  verbose,
  width,
}: Props): React.ReactNode {
  const MAX_FALLBACK_LINES = 10
  const { tool } = useGetToolFromMessages(param.tool_use_id, tools, messages)

  const fallbackText = (() => {
    if (typeof message.toolUseResult?.resultForAssistant === 'string') {
      return message.toolUseResult.resultForAssistant
    }
    const content = message.message?.content
    if (Array.isArray(content)) {
      const block = content.find((c: any) => c?.type === 'tool_result')
      if (typeof block?.content === 'string') return block.content
    }
    return ''
  })()

  return (
    // TODO: Distinguish UserMessage from UserToolResultMessage
    <Box flexDirection="column" width={width}>
      {tool?.renderToolResultMessage?.(message.toolUseResult?.data as never, { verbose }) ??
        (fallbackText ? (
          <>
            <Text color={getTheme().secondaryText}>
              {(verbose
                ? fallbackText.split('\n')
                : fallbackText.split('\n').slice(0, MAX_FALLBACK_LINES)
              )
                .map(line => sanitizeLongLine(line))
                .join('\n')}
            </Text>
            {!verbose && fallbackText.split('\n').length > MAX_FALLBACK_LINES && (
              <Text color={getTheme().secondaryText}>
                ... (+{fallbackText.split('\n').length - MAX_FALLBACK_LINES} lines)
              </Text>
            )}
          </>
        ) : null)}
    </Box>
  )
}
