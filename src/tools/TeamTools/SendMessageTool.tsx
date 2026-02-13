import React from 'react'
import { Box, Text } from 'ink'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import {
  appendMailboxMessage,
  TeamMailboxMessage,
  TeamMailboxMessageType,
} from '@services/mailbox'
import { normalizeAgentName, normalizeTeamName } from '@services/teamPaths'
import { readTeam } from '@services/teamManager'

const MESSAGE_TYPES = [
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
] as const

type SendMessageType = (typeof MESSAGE_TYPES)[number]

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  type: z.enum(MESSAGE_TYPES).default('message'),
  to: z.string().optional().describe('Target agent name (not required for broadcast)'),
  message: z.string().describe('Message content'),
  from: z
    .string()
    .optional()
    .default('lead')
    .describe('Optional sender name, default is "lead"'),
  summary: z.string().optional().describe('5-10字摘要，UI预览用'),
  request_id: z.string().optional(),
  approve: z.boolean().optional(),
})

type SendMessageOut = {
  teamName: string
  from: string
  type: SendMessageType
  to?: string
  targets: string[]
  count: number
  sent: boolean
}

export const SendMessageTool = {
  name: 'SendMessage',
  async description() {
    return 'Send a mailbox message to a teammate agent'
  },
  async prompt() {
    return `Use SendMessage to coordinate teammates.

Supported types:
- message: direct message to one teammate
- broadcast: send one message to all teammates in the team
- shutdown_request: ask a teammate to stop gracefully
- shutdown_response: reply approve/reject for shutdown request
- plan_approval_response: reply approve/reject for plan review`
  },
  inputSchema,
  userFacingName() {
    return 'SendMessage'
  },
  isEnabled: async () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  needsPermissions: () => false,
  async validateInput(input) {
    if (input.type !== 'broadcast' && !input.to) {
      return {
        result: false,
        message: '`to` is required unless type is "broadcast"',
      }
    }
    return { result: true }
  },
  async *call(input) {
    const teamName = normalizeTeamName(input.team_name)
    const messageType = input.type || 'message'
    const from = normalizeAgentName(input.from || 'lead')
    const createPayload = (
      to: string,
      type: TeamMailboxMessageType,
    ): TeamMailboxMessage => ({
      id: randomUUID(),
      teamName,
      from,
      to,
      type,
      content: input.message,
      summary: input.summary,
      requestId: input.request_id,
      approve: input.approve,
      createdAt: Date.now(),
    })

    const targets: string[] = []
    if (messageType === 'broadcast') {
      const team = readTeam(teamName)
      const candidateTargets = (team?.agents ?? [])
        .map(agent => normalizeAgentName(agent))
        .filter(agent => agent && agent !== from)
      if (candidateTargets.length === 0) {
        throw new Error(`Team "${teamName}" has no recipients for broadcast`)
      }
      for (const target of candidateTargets) {
        const payload = createPayload(target, 'broadcast')
        appendMailboxMessage('inbox', teamName, target, payload)
        appendMailboxMessage('outbox', teamName, from, payload)
        targets.push(target)
      }
    } else {
      const to = normalizeAgentName(input.to || '')
      const payload = createPayload(to, messageType)
      appendMailboxMessage('inbox', teamName, to, payload)
      appendMailboxMessage('outbox', teamName, from, payload)
      targets.push(to)
    }

    const data: SendMessageOut = {
      teamName,
      from,
      type: messageType,
      to: messageType === 'broadcast' ? undefined : targets[0],
      targets,
      count: targets.length,
      sent: true,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ type, to }) {
    if (type === 'broadcast') {
      return 'broadcast'
    }
    return `${type} → ${to}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: SendMessageOut) {
    const theme = getTheme()
    const targetsText = output.targets.join(', ')
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>
          {output.type} sent: {output.from} → {targetsText}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: SendMessageOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, SendMessageOut>
