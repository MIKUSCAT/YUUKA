import type { Command } from '@commands'
import { Auth } from '@components/Auth'
import * as React from 'react'

const auth = {
  type: 'local-jsx',
  name: 'auth',
  description:
    '配置 Gemini API Key / Google OAuth（写入 ~/.gemini/settings.json 和 ~/.gemini/oauth_creds.json）',
  isEnabled: true,
  isHidden: false,
  async call(onDone) {
    return <Auth onClose={onDone} />
  },
  userFacingName() {
    return 'auth'
  },
} satisfies Command

export default auth
