import { Box, Text } from 'ink'
import React from 'react'
import { z } from 'zod'
import { Cost } from '@components/Cost'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'
import { queryGeminiToolsOnlyDetailed } from '@services/gemini/query'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

const inputSchema = z.strictObject({
  query: z.string().describe('The search query'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  query: string
  durationMs: number
  text: string
  textWithCitations: string
  sources: Array<{ uri: string; title?: string }>
  webSearchQueries: string[]
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
    const lines: string[] = []
    lines.push(`WEB_SEARCH_QUERY: ${JSON.stringify(output.query)}`)

    if (output.sources.length > 0) {
      lines.push('SOURCES:')
      output.sources.forEach((src, idx) => {
        const title = src.title?.trim() || 'Untitled'
        lines.push(`[${idx + 1}] ${title} (${src.uri})`)
      })
    } else {
      lines.push('SOURCES: (none)')
    }

    if (output.webSearchQueries.length > 0) {
      lines.push('SUGGESTED_QUERIES:')
      for (const q of output.webSearchQueries) {
        lines.push(`- ${q}`)
      }
    }

    const notes = output.textWithCitations.trim() || output.text.trim()
    if (notes) {
      lines.push('NOTES:')
      lines.push(notes)
    }

    return lines.join('\n').trim()
  },
  async *call({ query }: Input, context: ToolUseContext) {
    const start = Date.now()

    try {
      const result = await queryGeminiToolsOnlyDetailed({
        modelKey: 'web-search',
        prompt: query,
        signal: context.abortController?.signal,
      })

      const output: Output = {
        query,
        durationMs: Date.now() - start,
        text: result.text,
        textWithCitations: result.textWithCitations,
        sources: result.sources,
        webSearchQueries: result.webSearchQueries,
      }

      yield {
        type: 'result' as const,
        resultForAssistant: this.renderResultForAssistant(output),
        data: output,
      }
    } catch (error: any) {
      const output: Output = {
        query,
        durationMs: Date.now() - start,
        text: '',
        textWithCitations: '',
        sources: [],
        webSearchQueries: [],
      }
      yield {
        type: 'result' as const,
        resultForAssistant: `An error occurred during web search with Gemini: ${error.message}`,
        data: output,
      }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
