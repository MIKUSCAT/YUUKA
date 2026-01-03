import { Box, Text } from 'ink'
import React from 'react'
import { z } from 'zod'
import { Cost } from '@components/Cost'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'
import { queryGeminiToolsOnly } from '@services/gemini/query'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

const inputSchema = z.strictObject({
  query: z.string().describe('The search query'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  durationMs: number
  response: string
}


export const WebSearchTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Web Search',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return false
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage({ query }: Input) {
    return `Searching for: "${query}" (Gemini googleSearch)`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output) {
    const theme = getTheme()
    return (
      <Box justifyContent="space-between" width="100%">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.success}>Web search complete (Gemini)</Text>
        </Box>
        <Cost costUSD={0} durationMs={output.durationMs} debug={false} />
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    return output.response.trim() || 'No results returned by Gemini.'
  },
  async *call({ query }: Input, context: ToolUseContext) {
    const start = Date.now()

    try {
      const output: Output = {
        durationMs: Date.now() - start,
        response: await queryGeminiToolsOnly({
          modelKey: 'web-search',
          prompt: query,
          signal: context.abortController?.signal,
        }),
      }

      yield {
        type: 'result' as const,
        resultForAssistant: this.renderResultForAssistant(output),
        data: output,
      }
    } catch (error: any) {
      const output: Output = {
        durationMs: Date.now() - start,
        response: '',
      }
      yield {
        type: 'result' as const,
        resultForAssistant: `An error occurred during web search with Gemini: ${error.message}`,
        data: output,
      }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
