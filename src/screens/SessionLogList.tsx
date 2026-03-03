import React, { useEffect, useState } from 'react'
import { SessionSelector, type SessionOption } from '@components/SessionSelector'
import { logError } from '@utils/log'
import { listSessions, SessionManager, type SessionListItem } from '@utils/sessionManager'

type Props = {
  context: { unmount?: () => void }
  logNumber?: number
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

export function SessionLogList({ context, logNumber }: Props): React.ReactNode {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [didSelectSession, setDidSelectSession] = useState(false)

  useEffect(() => {
    listSessions()
      .then(items => {
        if (logNumber !== undefined) {
          const idx = logNumber >= 0 ? logNumber : 0
          const session = items[idx]
          if (!session) {
            console.error('No session found at index', idx)
            process.exit(1)
          }
          const mgr = SessionManager.open(session.path)
          console.log(JSON.stringify(mgr.buildSessionContext().messages, null, 2))
          process.exit(0)
        }

        setSessions(items)
      })
      .catch(error => {
        logError(error)
        if (logNumber !== undefined) {
          process.exit(1)
        } else {
          context.unmount?.()
        }
      })
  }, [context, logNumber])

  async function onSelect(index: number): Promise<void> {
    const picked = sessions[index]
    if (!picked) return

    setDidSelectSession(true)
    setTimeout(() => {
      try {
        const mgr = SessionManager.open(picked.path)
        console.log(JSON.stringify(mgr.buildSessionContext().messages, null, 2))
        process.exit(0)
      } catch (e) {
        logError(`Failed to load session: ${e}`)
        process.exit(1)
      }
    }, 100)
  }

  // If logNumber is provided, don't render the selector.
  if (logNumber !== undefined) {
    return null
  }
  if (didSelectSession) {
    return null
  }

  return <SessionSelector sessions={toSessionOptions(sessions)} onSelect={onSelect} />
}

