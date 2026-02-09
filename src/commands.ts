import React from 'react'
import clear from './commands/clear'
import compact from './commands/compact'
import config from './commands/config'
import mcp from './commands/mcp'
import * as model from './commands/model'
import { Tool, ToolUseContext } from './Tool'
import resume from './commands/resume'
import agents from './commands/agents'
import auth from './commands/auth'
import memory from './commands/memory'
import skills from './commands/skills'
import status from './commands/status'
import { memoize } from 'lodash-es'
import type { Message } from './query'

type LocalCommand = {
  type: 'local'
  call(
    args: string,
    context: {
      options: {
        commands: Command[]
        tools: Tool[]
        slowAndCapableModel: string
      }
      abortController: AbortController
      setForkConvoWithMessagesOnTheNextRender: (
        forkConvoWithMessages: Message[],
      ) => void
    },
  ): Promise<string>
}

type LocalJSXCommand = {
  type: 'local-jsx'
  call(
    onDone: (result?: string) => void,
    context: ToolUseContext & {
      setForkConvoWithMessagesOnTheNextRender: (
        forkConvoWithMessages: Message[],
      ) => void
    },
    args?: string,
  ): Promise<React.ReactNode>
}

export type Command = {
  description: string
  isEnabled: boolean
  isHidden: boolean
  name: string
  aliases?: string[]
  userFacingName(): string
} & (LocalCommand | LocalJSXCommand)

// Declared as a function so that we don't run this until getCommands is called,
// since underlying functions read from config, which can't be read at module initialization time
const COMMANDS = memoize((): Command[] => [
  agents,
  auth,
  clear,
  compact,
  config,
  memory,
  mcp,
  model,
  resume,
  skills,
  status,
])

export const getCommands = memoize(async (): Promise<Command[]> => {
  return COMMANDS().filter(_ => _.isEnabled)
})

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return commands.some(
    _ => _.userFacingName() === commandName || _.aliases?.includes(commandName),
  )
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = commands.find(
    _ => _.userFacingName() === commandName || _.aliases?.includes(commandName),
  ) as Command | undefined
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = _.userFacingName()
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .join(', ')}`,
    )
  }

  return command
}
