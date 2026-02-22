import { Box, Text } from 'ink'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool } from '@tool'
import { getGlobalConfig } from '@utils/config'
import { recordFileEdit } from '@services/fileFreshness'
import { DESCRIPTION, PROMPT } from './prompt'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'
import {
  resolveMemoryFilePath,
  upsertMemoryIndexEntry,
  writeMemoryFile,
} from '@utils/memoryStore'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to the memory file to write'),
  content: z.string().describe('Content to write to the file'),
  title: z.string().optional().describe('Short title shown in memory index'),
  tags: z.array(z.string()).optional().describe('Tags for memory index'),
  summary: z.string().optional().describe('One-line summary for memory index'),
  layer: z
    .enum(['core', 'retrievable', 'episodic'])
    .optional()
    .describe('Memory layer type'),
})

export const MemoryWriteTool = {
  name: 'MemoryWrite',
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  inputSchema,
  userFacingName() {
    return 'Write Memory'
  },
  async isEnabled() {
    return getGlobalConfig().memoryWriteEnabled ?? true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false // MemoryWrite modifies state, not safe for concurrent execution
  },
  needsPermissions() {
    return false
  },
  renderResultForAssistant(content) {
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
  renderToolResultMessage() {
    const theme = getTheme()
    return (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.success}>Updated memory</Text>
        </Box>
      </Box>
    )
  },
  async validateInput({ file_path }, context) {
    try {
      resolveMemoryFilePath(file_path, context?.agentId)
    } catch {
      return { result: false, message: 'Invalid memory file path' }
    }
    return { result: true }
  },
  async *call({ file_path, content, title, tags, summary, layer }, context) {
    const fullPath = writeMemoryFile(file_path, content, context?.agentId)

    upsertMemoryIndexEntry(
      file_path,
      {
        title,
        tags,
        summary,
        layer,
      },
      context?.agentId,
    )

    // Record Agent edit operation for file freshness tracking
    recordFileEdit(fullPath, content)

    yield {
      type: 'result',
      data: 'Saved',
      resultForAssistant: 'Saved',
    }
  },
} satisfies Tool<typeof inputSchema, string>
