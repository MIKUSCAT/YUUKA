import React from 'react'
import { Box, Text } from 'ink'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import { appendMailboxMessage } from '@services/mailbox'
import { normalizeAgentName, normalizeTeamName } from '@services/teamPaths'

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  to: z.string().describe('Target agent name'),
  message: z.string().describe('Message content'),
  from: z
    .string()
    .optional()
    .describe('Optional sender name, default is "lead"'),
})

type SendMessageOut = {
  teamName: string
  from: string
  to: string
  sent: boolean
}

export const SendMessageTool = {
  name: 'SendMessage',
  async description() {
    return 'Send a mailbox message to a teammate agent'
  },
  async prompt() {
    return `Use SendMessage to push instructions or updates to teammate inboxes.`
  },
  inputSchema,
  userFacingName() {
    return 'SendMessage'
  },
  isEnabled: async () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  needsPermissions: () => false,
  async *call(input) {
    const teamName = normalizeTeamName(input.team_name)
    const to = normalizeAgentName(input.to)
    const from = normalizeAgentName(input.from || 'lead')
    const now = Date.now()

    const payload = {
      id: randomUUID(),
      teamName,
      from,
      to,
      type: 'message' as const,
      content: input.message,
      createdAt: now,
    }

    appendMailboxMessage('inbox', teamName, to, payload)
    appendMailboxMessage('outbox', teamName, from, payload)

    const data: SendMessageOut = {
      teamName,
      from,
      to,
      sent: true,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ to }) {
    return `to ${to}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: SendMessageOut) {
    const theme = getTheme()
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>
          Message sent: {output.from} → {output.to}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: SendMessageOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, SendMessageOut>
