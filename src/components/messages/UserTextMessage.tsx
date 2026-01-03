import { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { UserBashInputMessage } from './UserBashInputMessage'
import { UserCommandMessage } from './UserCommandMessage'
import { UserPromptMessage } from './UserPromptMessage'
import * as React from 'react'
import { NO_CONTENT_MESSAGE } from '@services/claude'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

export function UserTextMessage({ addMargin, param }: Props): React.ReactNode {
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  // Bash inputs!
  if (param.text.includes('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />
  }

  // Slash commands/
  if (
    param.text.includes('<command-name>') ||
    param.text.includes('<command-message>')
  ) {
    return <UserCommandMessage addMargin={addMargin} param={param} />
  }

  // User prompts>
  return <UserPromptMessage addMargin={addMargin} param={param} />
}
