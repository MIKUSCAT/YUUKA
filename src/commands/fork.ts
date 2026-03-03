import type { Command } from '@commands'
import { getMessagesGetter } from '@messages'

export default {
  type: 'local',
  name: 'fork',
  description: '从当前分支创建一个新会话（新 JSONL 文件）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'fork'
  },
  async call(_args, context) {
    const getMessages = getMessagesGetter()
    const messages = typeof getMessages === 'function' ? getMessages() : []
    const filtered = messages.filter(m => m.type !== 'progress') as any
    context.setForkConvoWithMessagesOnTheNextRender(filtered)
    return ''
  },
} satisfies Command

