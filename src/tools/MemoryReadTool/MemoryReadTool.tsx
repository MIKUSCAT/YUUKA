import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { Box, Text } from 'ink'
import { join } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool } from '@tool'
import { MEMORY_DIR } from '@utils/env'
import { getGlobalConfig } from '@utils/config'
import { resolveAgentId } from '@utils/agentStorage'
import { DESCRIPTION, PROMPT } from './prompt'
import { getTheme } from '@utils/theme'
import { TREE_END } from '@constants/figures'
import { sanitizeLongLine } from '@utils/outputPreview'

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
    const agentId = resolveAgentId(context?.agentId)
    const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)

    if (file_path) {
      const fullPath = join(agentMemoryDir, file_path)
      if (!fullPath.startsWith(agentMemoryDir)) {
        return { result: false, message: 'Invalid memory file path' }
      }
      if (!existsSync(fullPath)) {
        return { result: false, message: 'Memory file does not exist' }
      }
    }
    return { result: true }
  },
  async *call({ file_path }, context) {
    const agentId = resolveAgentId(context?.agentId)
    const agentMemoryDir = join(MEMORY_DIR, 'agents', agentId)
    mkdirSync(agentMemoryDir, { recursive: true })

    // If a specific file is requested, return its contents
    if (file_path) {
      const fullPath = join(agentMemoryDir, file_path)
      if (!existsSync(fullPath)) {
        throw new Error('Memory file does not exist')
      }
      const content = readFileSync(fullPath, 'utf-8')
      yield {
        type: 'result',
        data: {
          content,
        },
        resultForAssistant: this.renderResultForAssistant({ content }),
      }
      return
    }

    // Otherwise return the index and file list for this agent
    const files = readdirSync(agentMemoryDir, { recursive: true })
      .map(f => join(agentMemoryDir, f.toString()))
      .filter(f => !lstatSync(f).isDirectory())
      .map(f => `- ${f}`)
      .join('\n')

    const indexPath = join(agentMemoryDir, 'index.md')
    const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : ''

    const quotes = "'''"
    const content = `Here are the contents of the agent memory file, \`${indexPath}\`:
${quotes}
${index}
${quotes}

Files in the agent memory directory:
${files}`
    yield {
      type: 'result',
      data: { content },
      resultForAssistant: this.renderResultForAssistant({ content }),
    }
  },
} satisfies Tool<typeof inputSchema, { content: string }>
