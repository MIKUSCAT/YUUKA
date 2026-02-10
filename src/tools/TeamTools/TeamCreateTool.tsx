import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import { ensureTeam } from '@services/teamManager'

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  agents: z.array(z.string()).optional().describe('Optional initial agent names'),
})

type TeamCreateOut = {
  teamName: string
  agents: string[]
  createdAt: number
}

export const TeamCreateTool = {
  name: 'TeamCreate',
  async description() {
    return 'Create a teammate workspace with metadata and task/mailbox folders'
  },
  async prompt() {
    return `Use TeamCreate to initialize a named team workspace before launching many teammate tasks.`
  },
  inputSchema,
  userFacingName() {
    return 'TeamCreate'
  },
  isEnabled: async () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  needsPermissions: () => false,
  async *call(input) {
    const team = ensureTeam(input.team_name, input.agents ?? [])
    const data: TeamCreateOut = {
      teamName: team.name,
      agents: team.agents,
      createdAt: team.createdAt,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ team_name }) {
    return `create ${team_name}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TeamCreateOut) {
    const theme = getTheme()
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>Team ready: {output.teamName}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: TeamCreateOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, TeamCreateOut>
