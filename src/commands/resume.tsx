import * as React from 'react'
import type { Command } from '@commands'
import { ResumeSession } from '@screens/ResumeSession'
import { render } from 'ink'
import { listSessions } from '@utils/sessionManager'

export default {
  type: 'local-jsx',
  name: 'resume',
  description: '恢复一段历史会话',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'resume'
  },
  async call(onDone, context) {
    const { commands = [], tools = [], verbose = false } = context.options || {}
    const sessions = await listSessions()
    render(
      <ResumeSession
        commands={commands}
        context={{ unmount: onDone }}
        sessions={sessions}
        tools={tools}
        verbose={verbose}
      />,
    )
    // This return is here for type only
    return null
  },
} satisfies Command
