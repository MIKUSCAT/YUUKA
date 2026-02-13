import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import { createSharedTask, SharedTask } from '@services/sharedTaskManager'

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  subject: z.string().describe('Task subject/title'),
  description: z.string().describe('Task details'),
  blockedBy: z.array(z.number().int().positive()).optional(),
})

type TaskCreateOut = {
  teamName: string
  task: SharedTask
}

export const TaskCreateTool = {
  name: 'TaskCreate',
  async description() {
    return 'Create a new shared task in the team board'
  },
  async prompt() {
    return 'Use TaskCreate to add open tasks to the shared board before teammates claim them.'
  },
  inputSchema,
  userFacingName() {
    return 'TaskCreate'
  },
  isEnabled: async () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  needsPermissions: () => false,
  async *call(input) {
    const task = createSharedTask({
      teamName: input.team_name,
      subject: input.subject,
      description: input.description,
      blockedBy: input.blockedBy,
    })
    const data: TaskCreateOut = {
      teamName: input.team_name,
      task,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ subject }) {
    return subject
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TaskCreateOut) {
    const theme = getTheme()
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>
          Shared task created: #{output.task.id} {output.task.subject}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: TaskCreateOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, TaskCreateOut>
