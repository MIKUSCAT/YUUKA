import type { Command } from '@commands'
import { Auth } from '@components/Auth'
import * as React from 'react'

const auth = {
  type: 'local-jsx',
  name: 'auth',
  description: '配置 Gemini Base URL / API Key（写入当前项目 ./.gemini/settings.json）',
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
