import { Box, Text } from 'ink'
import { basename } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool } from '@tool'
import { getGlobalConfig } from '@utils/config'
import { DESCRIPTION, PROMPT } from './prompt'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'
import { sanitizeLongLine } from '@utils/outputPreview'
import {
  listMemoryFiles,
  readMemoryFile,
  resolveMemoryFilePath,
} from '@utils/memoryStore'

const MAX_RENDERED_LINES = 10

const inputSchema = z.strictObject({
  file_path: z
    .string()
    .optional()
    .describe('Optional path to a specific memory file to read'),
})

export const MemoryReadTool = {
  name: 'MemoryRead',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'Read Memory'
  },
  async isEnabled() {
    return getGlobalConfig().memoryReadEnabled ?? true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // MemoryRead is read-only, safe for concurrent execution
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
  async validateInput({ file_path }, context) {
    if (file_path) {
      try {
        resolveMemoryFilePath(file_path, context?.agentId)
      } catch {
        return { result: false, message: 'Invalid memory file path' }
      }
      if (readMemoryFile(file_path, context?.agentId) === null) {
        return { result: false, message: 'Memory file does not exist' }
      }
    }
    return { result: true }
  },
  async *call({ file_path }, context) {
    // If a specific file is requested, return its contents
    if (file_path) {
      const content = readMemoryFile(file_path, context?.agentId)
      if (content === null) {
        throw new Error('Memory file does not exist')
      }
      yield {
        type: 'result',
        data: {
          content,
        },
        resultForAssistant: this.renderResultForAssistant({ content }),
      }
      return
    }

    // Otherwise return YUUKA.md (user preference memory) and file list
    const yuukaMemoryPath = resolveMemoryFilePath('YUUKA.md', context?.agentId).fullPath
    const yuukaMemory = readMemoryFile('YUUKA.md', context?.agentId) || '(YUUKA.md 尚未创建)'
    const files = listMemoryFiles(context?.agentId)
      .filter(filePath => basename(filePath) !== 'index.md')
      .map(filePath => `- ${filePath}`)
      .join('\n')

    const quotes = "'''"
    const content = `Here are the contents of the primary user memory file, \`${yuukaMemoryPath}\`:
${quotes}
${yuukaMemory}
${quotes}

Files in the agent memory directory:
${files || '- (no files)'}`
    yield {
      type: 'result',
      data: { content },
      resultForAssistant: this.renderResultForAssistant({ content }),
    }
  },
} satisfies Tool<typeof inputSchema, { content: string }>
