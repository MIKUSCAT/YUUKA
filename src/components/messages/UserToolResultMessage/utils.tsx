import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Message } from '@query'
import { useMemo } from 'react'
import { Tool } from '@tool'
import { GlobTool } from '@tools/GlobTool/GlobTool'
import { GrepTool } from '@tools/GrepTool/GrepTool'

function getToolUseFromMessages(
  toolUseID: string,
  messages: Message[],
): ToolUseBlockParam | null {
  let toolUse: ToolUseBlockParam | null = null
  for (const message of messages) {
    if (
      message.type !== 'assistant' ||
      !Array.isArray(message.message.content)
    ) {
      continue
    }
    for (const content of message.message.content) {
      if (content.type === 'tool_use' && content.id === toolUseID) {
        toolUse = content
      }
    }
  }
  return toolUse
}

export function useGetToolFromMessages(
  toolUseID: string,
  tools: Tool[],
  messages: Message[],
) {
  return useMemo(() => {
    const toolUse = getToolUseFromMessages(toolUseID, messages)
    if (!toolUse) {
      throw new ReferenceError(
        `Tool use not found for tool_use_id ${toolUseID}`,
      )
    }

    // 兼容：旧日志里可能存在已改名/已移除的工具；不要让 UI 崩溃
    const tool = [...tools, GlobTool, GrepTool].find(_ => _.name === toolUse.name) ?? null
    return { tool, toolUse }
  }, [toolUseID, messages, tools])
}
