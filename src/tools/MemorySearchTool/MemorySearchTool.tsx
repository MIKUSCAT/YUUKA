import { Box, Text } from 'ink'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { TREE_END } from '@constants/figures'
import { Tool } from '@tool'
import { getGlobalConfig } from '@utils/config'
import { sanitizeLongLine } from '@utils/outputPreview'
import { searchMemoryIndex } from '@utils/memoryStore'
import { getTheme } from '@utils/theme'
import { DESCRIPTION, PROMPT } from './prompt'

const MAX_RENDERED_LINES = 10

const inputSchema = z.strictObject({
  query: z.string().describe('Search query for memory retrieval'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Number of results to return (recommended: 1-3)'),
  include_archived: z
    .boolean()
    .optional()
    .describe('Whether archived memories should be included'),
})

export const MemorySearchTool = {
  name: 'MemorySearch',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'Search Memory'
  },
  async isEnabled() {
    return getGlobalConfig().memoryReadEnabled ?? true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant({ content }) {
    return content
  },
  renderToolUseMessage(input) {
    return Object.entries(input)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output) {
    const theme = getTheme()
    const rawContent =
      typeof output?.content === 'string' ? output.content.trim() : ''
    const lines = rawContent ? rawContent.split('\n') : []
    const shown = lines
      .slice(0, MAX_RENDERED_LINES)
      .map(line => sanitizeLongLine(line))
      .join('\n')
    return (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Box flexDirection="column">
            <Text>{shown || '(No content)'}</Text>
            {lines.length > MAX_RENDERED_LINES && (
              <Text color={theme.secondaryText}>
                ... (+{lines.length - MAX_RENDERED_LINES} lines)
              </Text>
            )}
          </Box>
        </Box>
      </Box>
    )
  },
  async *call({ query, limit, include_archived }, context) {
    const results = searchMemoryIndex(query, context?.agentId, {
      limit,
      includeArchived: include_archived ?? false,
    })

    let content = ''
    if (results.length === 0) {
      content = `未找到与「${query}」相关的记忆。请换一个关键词重试，或直接 MemoryRead() 查看索引摘要。`
    } else {
      const lines = results
        .map(
          (entry, index) =>
            `${index + 1}. file_path: ${entry.file_path}\n   标题: ${entry.title}\n   标签: ${entry.tags.length ? entry.tags.join(', ') : '无'}\n   摘要: ${entry.summary}\n   强度: ${entry.strength}\n   最近使用: ${entry.last_used_at || '未使用'}`,
        )
        .join('\n')

      content = [
        `找到 ${results.length} 条相关记忆候选：`,
        lines,
        '',
        '下一步请用 MemoryRead(file_path=...) 读取细节。',
      ].join('\n')
    }

    yield {
      type: 'result',
      data: { content },
      resultForAssistant: this.renderResultForAssistant({ content }),
    }
  },
} satisfies Tool<typeof inputSchema, { content: string }>
