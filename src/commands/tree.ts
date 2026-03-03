import type { Command } from '@commands'

export default {
  type: 'local',
  name: 'tree',
  description: '打开会话树，跳到任意节点继续（同一 session 文件内分支）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'tree'
  },
  async call(_args, context) {
    const open = (context as any).openSessionTree
    if (typeof open === 'function') {
      open()
      return ''
    }
    return '当前环境不支持 /tree（仅交互式 REPL 可用）'
  },
} satisfies Command

