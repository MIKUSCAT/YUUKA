import React from 'react'
import { render } from 'ink'
import type { Command } from '@commands'
import type { Tool } from '@tool'
import { logError } from '@utils/log'
import { SessionSelector, type SessionOption } from '@components/SessionSelector'
import type { SessionListItem } from '@utils/sessionManager'
import { REPL } from './REPL'

type Props = {
  commands: Command[]
  context: { unmount?: () => void }
  sessions: SessionListItem[]
  tools: Tool[]
  verbose: boolean | undefined
  safeMode?: boolean
}

function toSessionOptions(items: SessionListItem[]): SessionOption[] {
  return items.map((s, i) => ({
    id: s.id,
    fullPath: s.path,
    value: i,
    created: s.created,
    modified: s.modified,
    messageCount: s.messageCount,
    firstPrompt: (s.firstPrompt || '').split('\n')[0]?.slice(0, 50) || '(no prompt)',
    name: s.name,
    cwd: s.cwd,
  }))
}

export function ResumeSession({
  context,
  commands,
  sessions,
  tools,
  verbose,
  safeMode,
}: Props): React.ReactNode {
  async function onSelect(index: number) {
    const picked = sessions[index]
    if (!picked) return

    try {
      context.unmount?.()
      render(
        <REPL
          sessionPath={picked.path}
          initialPrompt=""
          shouldShowPromptInput={true}
          verbose={verbose}
          commands={commands}
          tools={tools}
          safeMode={safeMode}
        />,
        { exitOnCtrlC: false },
      )
    } catch (e) {
      logError(`Failed to resume session: ${e}`)
      throw e
    }
  }

  return <SessionSelector sessions={toSessionOptions(sessions)} onSelect={onSelect} />
}

