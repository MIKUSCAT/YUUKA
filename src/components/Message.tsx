import { Box } from 'ink'
import * as React from 'react'
import type { AssistantMessage, Message as QueryMessage, UserMessage } from '@query'
import type {
  ContentBlock,
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Tool } from '@tool'
import { logError } from '@utils/log'
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage'
import { AssistantTextMessage } from './messages/AssistantTextMessage'
import { UserTextMessage } from './messages/UserTextMessage'
import { NormalizedMessage } from '@utils/messages'
import { useTerminalSize } from '@hooks/useTerminalSize'
import { ThinkTool } from '@tools/ThinkTool/ThinkTool'

type MessageProps = {
  message: UserMessage | AssistantMessage
  messages: NormalizedMessage[]
  // TODO: Find a way to remove this, and leave spacing to the consumer
  addMargin: boolean
  tools: Tool[]
  verbose: boolean
  debug: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
  width?: number | string
}

function areEqualStringSets(a: Set<string>, b: Set<string>): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false
    }
  }
  return true
}

function areMessagePropsEqual(
  prev: MessageProps,
  next: MessageProps,
): boolean {
  return (
    prev.message.uuid === next.message.uuid &&
    prev.messages === next.messages &&
    prev.addMargin === next.addMargin &&
    prev.tools === next.tools &&
    prev.verbose === next.verbose &&
    prev.debug === next.debug &&
    prev.shouldAnimate === next.shouldAnimate &&
    prev.shouldShowDot === next.shouldShowDot &&
    prev.width === next.width &&
    areEqualStringSets(prev.erroredToolUseIDs, next.erroredToolUseIDs) &&
    areEqualStringSets(prev.inProgressToolUseIDs, next.inProgressToolUseIDs) &&
    areEqualStringSets(prev.unresolvedToolUseIDs, next.unresolvedToolUseIDs)
  )
}

function MessageComponent({
  message,
  messages,
  addMargin,
  tools,
  verbose,
  debug,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
  width,
}: MessageProps): React.ReactNode {
  // Assistant message
  if (message.type === 'assistant') {
    const firstRenderableIndex = message.message.content.findIndex(block => {
      if (block.type === 'text') return true
      if (block.type === 'tool_use') {
        const tool = tools.find(item => item.name === block.name)
        return tool && tool !== ThinkTool
      }
      return false
    })
    return (
      <Box flexDirection="column" width="100%">
        {message.message.content.map((_, index) => (
          <AssistantMessage
            key={index}
            param={_}
            costUSD={message.costUSD}
            durationMs={message.durationMs}
            addMargin={addMargin}
            tools={tools}
            debug={debug}
            options={{ verbose }}
            erroredToolUseIDs={erroredToolUseIDs}
            inProgressToolUseIDs={inProgressToolUseIDs}
            unresolvedToolUseIDs={unresolvedToolUseIDs}
            shouldAnimate={shouldAnimate}
            shouldShowDot={shouldShowDot && index === firstRenderableIndex}
            width={width}
          />
        ))}
      </Box>
    )
  }

  // User message
  // TODO: normalize upstream
  const content =
    typeof message.message.content === 'string'
      ? [{ type: 'text', text: message.message.content } as TextBlockParam]
      : message.message.content
  return (
    <Box flexDirection="column" width="100%">
      {content.map((_, index) => (
        <UserMessage
          key={index}
          message={message}
          messages={messages}
          addMargin={addMargin}
          tools={tools}
          param={_ as TextBlockParam}
          options={{ verbose }}
        />
      ))}
    </Box>
  )
}

function UserMessage({
  message,
  messages,
  addMargin,
  tools,
  param,
  options: { verbose },
}: {
  message: UserMessage
  messages: QueryMessage[]
  addMargin: boolean
  tools: Tool[]
  param:
    | TextBlockParam
    | DocumentBlockParam
    | ImageBlockParam
    | ToolUseBlockParam
    | ToolResultBlockParam
  options: {
    verbose: boolean
  }
  key?: React.Key
}): React.ReactNode {
  const { columns } = useTerminalSize()
  switch (param.type) {
    case 'text':
      return <UserTextMessage addMargin={addMargin} param={param} />
    case 'tool_result':
      return (
        <UserToolResultMessage
          param={param}
          message={message}
          messages={messages}
          tools={tools}
          verbose={verbose}
          width={columns - 5}
        />
      )
  }
}

function AssistantMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  options: { verbose },
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
  width,
}: {
  param:
    | ContentBlock
    | TextBlockParam
    | ImageBlockParam
    | ThinkingBlockParam
    | ToolUseBlockParam
    | ToolResultBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  options: {
    verbose: boolean
  }
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
  width?: number | string
  key?: React.Key
}): React.ReactNode {
  switch (param.type) {
    case 'tool_use':
      return (
        <AssistantToolUseMessage
          param={param}
          costUSD={costUSD}
          durationMs={durationMs}
          addMargin={addMargin}
          tools={tools}
          debug={debug}
          verbose={verbose}
          erroredToolUseIDs={erroredToolUseIDs}
          inProgressToolUseIDs={inProgressToolUseIDs}
          unresolvedToolUseIDs={unresolvedToolUseIDs}
          shouldAnimate={shouldAnimate}
          shouldShowDot={shouldShowDot}
        />
      )
    case 'text':
      return (
        <AssistantTextMessage
          param={param}
          costUSD={costUSD}
          durationMs={durationMs}
          debug={debug}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
        />
      )
    case 'redacted_thinking':
      return null
    case 'thinking':
      return null
    default:
      logError(`Unable to render message type: ${param.type}`)
      return null
  }
}

export const Message = React.memo(MessageComponent, areMessagePropsEqual)
