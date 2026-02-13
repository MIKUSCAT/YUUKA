import { Box, Text } from 'ink'
import React from 'react'
import { logError } from '@utils/log'
import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Tool } from '@tool'
import { Cost } from '@components/Cost'
import { ToolUseLoader } from '@components/ToolUseLoader'
import { getTheme } from '@utils/theme'
import { ASSISTANT_PREFIX } from '@constants/figures'
import { ThinkTool } from '@tools/ThinkTool/ThinkTool'
import { TaskToolMessage } from './TaskToolMessage'

type Props = {
  param: ToolUseBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  verbose: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
}

export function AssistantToolUseMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  verbose,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
}: Props): React.ReactNode {
  const theme = getTheme()
  const tool = tools.find(_ => _.name === param.name)
  if (!tool) {
    logError(`Tool ${param.name} not found`)
    return null
  }
  const isQueued =
    !inProgressToolUseIDs.has(param.id) && unresolvedToolUseIDs.has(param.id)
  // Keeping color undefined makes the OS use the default color regardless of appearance
  const color = isQueued ? theme.secondaryText : undefined

  // Handle thinking tool with specialized rendering
  if (tool === ThinkTool) {
    return null
  }

  const userFacingToolName = tool.userFacingName
    ? tool.userFacingName()
    : tool.name
  const toolMessage = tool.renderToolUseMessage(param.input as never, {
    verbose,
  })
  const summary =
    typeof toolMessage === 'string' && toolMessage.trim()
      ? toolMessage.trim()
      : ''
  const isBashTool = tool.name === 'Bash'
  const bashCommandPreview =
    summary.length > 180 ? `${summary.slice(0, 180)}…` : summary
  const prefixWidth = 2
  // 简洁显示格式: ToolName summary
  const labelText = `${userFacingToolName}`
  const indicator = (() => {
    if (!unresolvedToolUseIDs.has(param.id)) return null
    if (isQueued) {
      return <Text color={theme.secondaryText}>…</Text>
    }
    return (
      <ToolUseLoader
        shouldAnimate={shouldAnimate}
        isUnresolved={unresolvedToolUseIDs.has(param.id)}
        isError={erroredToolUseIDs.has(param.id)}
      />
    )
  })()

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexDirection="row" flexGrow={1} minWidth={0}>
          <Box minWidth={prefixWidth}>
            {shouldShowDot ? (
              <Text color={theme.yuuka}>{ASSISTANT_PREFIX}</Text>
            ) : (
              <Text>{'  '}</Text>
            )}
          </Box>
          <Box flexDirection="row" flexGrow={1} minWidth={0}>
            {tool.name === 'Task' && param.input ? (
              <TaskToolMessage
                agentType={String((param.input as any).subagent_type || 'general-purpose')}
                bold={Boolean(!isQueued)}
                children={labelText}
              />
            ) : (
              <Text color={color} bold={!isQueued} wrap="truncate-end">
                {labelText}
              </Text>
            )}
            {summary && !isBashTool ? (
              <Text color={theme.secondaryText} wrap="truncate-end">
                {' '}
                {summary}
              </Text>
            ) : null}
            {indicator ? (
              <Box marginLeft={1} width={2}>
                {indicator}
              </Box>
            ) : null}
          </Box>
        </Box>
        <Cost costUSD={costUSD} durationMs={durationMs} debug={debug} />
      </Box>
      {isBashTool && bashCommandPreview ? (
        <Box marginLeft={2}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {bashCommandPreview}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
