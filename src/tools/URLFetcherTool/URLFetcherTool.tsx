import { Box, Text } from 'ink'
import React from 'react'
import { z } from 'zod'
import { Cost } from '@components/Cost'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext, ValidationResult } from '@tool'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'
import { queryGeminiToolsOnly } from '@services/gemini/query'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'

const inputSchema = z.strictObject({
  url: z.string().url().describe('The URL to fetch content from'),
  prompt: z.string().describe('The prompt to run on the fetched content'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  url: string
  aiAnalysis: string
  durationMs: number
}

function normalizeUrl(url: string): string {
  // Auto-upgrade HTTP to HTTPS
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://')
  }
  return url
}

function isHttpOrHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export const URLFetcherTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'URL Fetcher',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return false
  },
  async validateInput({ url }: Input): Promise<ValidationResult> {
    const normalizedUrl = normalizeUrl(url)
    if (!isHttpOrHttpsUrl(normalizedUrl)) {
      return {
        result: false,
        message:
          'URLFetcher 只支持 http(s) URL，不能读取本地文件/文件夹（例如 file://... 或 E:/...）。要看本地内容请用 View/GlobTool/GrepTool，或把内容写进文件再处理。',
      }
    }
    return { result: true }
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage({ url, prompt }: Input) {
    return `Fetching content from ${url} and analyzing with prompt: "${prompt}"`
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
          <Text color={theme.success}>URL analyzed (Gemini urlContext)</Text>
        </Box>
        <Cost costUSD={0} durationMs={output.durationMs} debug={false} />
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    if (!output.aiAnalysis.trim()) {
      return `No content could be analyzed from URL: ${output.url}`
    }
    
    return output.aiAnalysis
  },
  async *call({ url, prompt }: Input, context: ToolUseContext) {
    const normalizedUrl = normalizeUrl(url)
    const start = Date.now()
    
    try {
      const aiAnalysis = await queryGeminiToolsOnly({
        modelKey: 'web-fetch',
        prompt: `URL: ${normalizedUrl}\nRequest: ${prompt}`,
        signal: context.abortController?.signal,
      })

      const output: Output = {
        url: normalizedUrl,
        aiAnalysis: aiAnalysis || 'Unable to analyze content',
        durationMs: Date.now() - start,
      }

      yield {
        type: 'result' as const,
        resultForAssistant: this.renderResultForAssistant(output),
        data: output,
      }
    } catch (error: any) {
      const output: Output = {
        url: normalizedUrl,
        aiAnalysis: '',
        durationMs: Date.now() - start,
      }
      
      yield {
        type: 'result' as const,
        resultForAssistant: `Error processing URL ${normalizedUrl}: ${error.message}`,
        data: output,
      }
    }
  },
} satisfies Tool<typeof inputSchema, Output>
