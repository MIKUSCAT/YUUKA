import { last } from 'lodash-es'
import { Command } from '@commands'
import { getSystemPrompt } from '@constants/prompts'
import { getContext } from '@context'
import { getTotalCost } from '@costTracker'
import { Message } from '@query'
import { CanUseToolFn } from '@hooks/useCanUseTool'
import { Tool } from '@tool'
import { getModelManager } from '@utils/model'
import { setCwd } from './state'
import { createUserMessage } from './messages'
import { runAgentRuntime } from './agentRuntime'
import { SessionManager } from './sessionManager'

type Props = {
  commands: Command[]
  safeMode?: boolean
  hasPermissionsToUseTool: CanUseToolFn
  prompt: string
  cwd: string
  tools: Tool[]
  verbose?: boolean
}

// Sends a single prompt and returns the response (non-interactive mode).
// Assumes that claude is being used non-interactively -- will not
// ask the user for permissions or further input.
export async function ask({
  commands,
  safeMode,
  hasPermissionsToUseTool,
  prompt,
  cwd,
  tools,
  verbose = false,
}: Props): Promise<{
  resultText: string
  totalCost: number
  sessionFile: string
}> {
  await setCwd(cwd)
  const sessionManager = SessionManager.create(cwd)
  const sessionFile = sessionManager.getSessionFile() || ''
  const sessionId = sessionManager.getSessionId()

  const message = createUserMessage(prompt)
  const messages: Message[] = [message]
  sessionManager.appendMessage(message)

  const [systemPrompt, context, model] = await Promise.all([
    getSystemPrompt(),
    getContext(),
    getModelManager().getModelName('main'),
  ])

  for await (const m of runAgentRuntime({
    messages,
    systemPrompt,
    context,
    canUseTool: hasPermissionsToUseTool,
    toolUseContext: {
      options: {
        commands,
        tools,
        verbose,
        safeMode,
        autoMode: true,
        sessionId,
        sessionPath: sessionFile || undefined,
        maxThinkingTokens: 0,
      },
      abortController: new AbortController(),
      sessionManager,
      messageId: undefined,
      agentId: 'lead',
      readFileTimestamps: {},
      setToolJSX: () => {}, // No-op function for non-interactive use
    },
  })) {
    messages.push(m)
    if (m.type === 'user' || m.type === 'assistant') {
      sessionManager.appendMessage(m)
    }
  }

  const result = last(messages)
  if (!result || result.type !== 'assistant') {
    throw new Error('Expected content to be an assistant message')
  }
  if (result.message.content[0]?.type !== 'text') {
    throw new Error(
      `Expected first content item to be text, but got ${JSON.stringify(
        result.message.content[0],
        null,
        2,
      )}`,
    )
  }

  return {
    resultText: result.message.content[0].text,
    totalCost: getTotalCost(),
    sessionFile,
  }
}
