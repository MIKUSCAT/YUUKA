import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import { listSharedTasks, SharedTask } from '@services/sharedTaskManager'

const statusEnum = z.enum(['open', 'in_progress', 'completed', 'blocked'])

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  status: statusEnum.optional(),
  owner: z.string().optional().describe('Optional owner filter'),
})

type TaskListOut = {
  teamName: string
  total: number
  tasks: SharedTask[]
}

export const TaskListTool = {
  name: 'TaskList',
  async description() {
    return 'List shared tasks in team board, with optional filters'
  },
  async prompt() {
    return 'Use TaskList to inspect open/in_progress/blocked/completed shared work before claiming new tasks.'
  },
  inputSchema,
  userFacingName() {
    return 'TaskList'
  },
  isEnabled: async () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  needsPermissions: () => false,
  async *call(input) {
    const tasks = listSharedTasks({
      teamName: input.team_name,
      status: input.status,
      owner: input.owner,
    })
    const data: TaskListOut = {
      teamName: input.team_name,
      total: tasks.length,
      tasks,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ team_name, status, owner }) {
    const filters = [status ? `status=${status}` : null, owner ? `owner=${owner}` : null]
      .filter(Boolean)
      .join(', ')
    return filters ? `${team_name} (${filters})` : team_name
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TaskListOut) {
    const theme = getTheme()
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>
          Shared tasks: {output.total}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: TaskListOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, TaskListOut>
