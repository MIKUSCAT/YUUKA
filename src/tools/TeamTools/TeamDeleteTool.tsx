import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import { deleteTeam } from '@services/teamManager'

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  force: z.boolean().optional().describe('Force delete even if tasks exist'),
})

type TeamDeleteOut = {
  teamName: string
  deleted: boolean
}

export const TeamDeleteTool = {
  name: 'TeamDelete',
  async description() {
    return 'Delete teammate workspace folders and metadata'
  },
  async prompt() {
    return `Use TeamDelete only when a team is no longer needed.`
  },
  inputSchema,
  userFacingName() {
    return 'TeamDelete'
  },
  isEnabled: async () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  needsPermissions: () => false,
  async *call(input) {
    deleteTeam(input.team_name, Boolean(input.force))
    const data: TeamDeleteOut = {
      teamName: input.team_name,
      deleted: true,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ team_name }) {
    return `delete ${team_name}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TeamDeleteOut) {
    const theme = getTheme()
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>Team deleted: {output.teamName}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: TeamDeleteOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, TeamDeleteOut>
