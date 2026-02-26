import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { Tool } from '@tool'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { getTheme } from '@utils/theme'
import {
  claimSharedTask,
  SharedTask,
  SharedTaskStatus,
  updateSharedTask,
} from '@services/sharedTaskManager'

const statusEnum = z.enum(['open', 'in_progress', 'completed', 'blocked'])

const inputSchema = z.object({
  team_name: z.string().describe('Team name'),
  taskId: z.number().int().positive(),
  status: statusEnum.optional(),
  owner: z.string().optional(),
  result: z.string().optional(),
  blockedBy: z.array(z.number().int().positive()).optional(),
  expectedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional optimistic concurrency check: task.version must match'),
})

type TaskUpdateOut = {
  teamName: string
  task: SharedTask
}

function shouldClaimTask(input: {
  status?: SharedTaskStatus
  owner?: string
  result?: string
  blockedBy?: number[]
}): boolean {
  return (
    input.status === 'in_progress' &&
    typeof input.owner === 'string' &&
    !input.result &&
    typeof input.blockedBy === 'undefined'
  )
}

export const TaskUpdateTool = {
  name: 'TaskUpdate',
  async description() {
    return 'Update shared task state, owner, dependencies, or completion result'
  },
  async prompt() {
    return 'Use TaskUpdate to claim tasks (owner + in_progress), report completion, or mark blockers.'
  },
  inputSchema,
  userFacingName() {
    return 'TaskUpdate'
  },
  isEnabled: async () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  needsPermissions: () => false,
  async *call(input) {
    const task = shouldClaimTask(input)
      ? await claimSharedTask({
          teamName: input.team_name,
          taskId: input.taskId,
          owner: input.owner || '',
        })
      : await updateSharedTask({
          teamName: input.team_name,
          taskId: input.taskId,
          status: input.status,
          owner: input.owner,
          result: input.result,
          blockedBy: input.blockedBy,
          expectedVersion: input.expectedVersion,
        })

    const data: TaskUpdateOut = {
      teamName: input.team_name,
      task,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: JSON.stringify(data, null, 2),
    }
  },
  renderToolUseMessage({ taskId, status, owner }) {
    const parts = [`#${taskId}`]
    if (status) parts.push(`status=${status}`)
    if (owner) parts.push(`owner=${owner}`)
    return parts.join(' ')
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: TaskUpdateOut) {
    const theme = getTheme()
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>
          Shared task updated: #{output.task.id} ({output.task.status})
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(output: TaskUpdateOut) {
    return JSON.stringify(output, null, 2)
  },
} satisfies Tool<typeof inputSchema, TaskUpdateOut>
