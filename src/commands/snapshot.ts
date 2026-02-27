import type { Command } from '@commands'
import {
  createConversationSnapshot,
  listConversationSnapshots,
  loadConversationSnapshotMessages,
} from '@utils/snapshotStore'

function formatUsage(): string {
  return [
    '用法：',
    '/snapshot save [名称]      保存当前会话快照',
    '/snapshot list             列出最近快照',
    '/snapshot restore <编号|id> 恢复指定快照（编号从 1 开始）',
    '/snapshot help             显示帮助',
  ].join('\n')
}

export default {
  type: 'local',
  name: 'snapshot',
  description: '管理会话快照（保存 / 列表 / 恢复）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'snapshot'
  },
  async call(args, context) {
    const raw = String(args || '').trim()
    const tokens = raw ? raw.split(/\s+/) : []
    const action = (tokens[0] || 'save').toLowerCase()
    const rest = tokens.slice(1)

    const runtimeOptions = (context as any).options || {}
    const messageLogName = String(runtimeOptions.messageLogName || '').trim()
    const forkNumber = Number(runtimeOptions.forkNumber || 0)

    if (action === 'help' || action === '-h' || action === '--help') {
      return formatUsage()
    }

    if (action === 'list' || action === 'ls') {
      const snapshots = listConversationSnapshots(30)
      if (snapshots.length === 0) {
        return '当前还没有可用快照。'
      }
      const lines = ['最近快照（新 -> 旧）：']
      snapshots.forEach((snapshot, index) => {
        const label = snapshot.label ? ` · ${snapshot.label}` : ''
        lines.push(
          `${index + 1}. ${snapshot.id}${label} · ${snapshot.reason} · ${snapshot.messageCount} 条消息 · ${snapshot.createdAtIso}`,
        )
      })
      return lines.join('\n')
    }

    if (action === 'restore' || action === 'load') {
      const target = rest.join(' ').trim()
      if (!target) {
        return `缺少目标编号或 id。\n\n${formatUsage()}`
      }
      const tools = runtimeOptions.tools || []
      const { snapshot, messages } = loadConversationSnapshotMessages(target, tools)
      context.setForkConvoWithMessagesOnTheNextRender(messages as any)
      return `已恢复快照：${snapshot.id}（${snapshot.messageCount} 条消息）。`
    }

    if (action === 'save' || action === 'new' || action === 'create') {
      if (!messageLogName) {
        return '当前会话缺少 messageLogName，暂时无法创建快照。'
      }
      const label = rest.join(' ').trim() || undefined
      const snapshot = createConversationSnapshot({
        messageLogName,
        forkNumber,
        reason: 'manual',
        label,
      })
      return `快照已保存：${snapshot.id}（${snapshot.messageCount} 条消息）`
    }

    // 默认把未知 action 当作 save 的名称参数
    if (!messageLogName) {
      return '当前会话缺少 messageLogName，暂时无法创建快照。'
    }
    const fallbackLabel = raw || undefined
    const snapshot = createConversationSnapshot({
      messageLogName,
      forkNumber,
      reason: 'manual',
      label: fallbackLabel,
    })
    return `快照已保存：${snapshot.id}（${snapshot.messageCount} 条消息）`
  },
} satisfies Command
