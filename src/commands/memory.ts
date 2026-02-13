import type { Command } from '@commands'
import { getMessagesGetter } from '@messages'
import type { Message } from '@query'
import { queryQuick } from '@services/llm'
import { extractTag } from '@utils/messages'
import { getGlobalConfig } from '@utils/config'
import {
  deleteMemoryFile,
  readMemoryFile,
  writeMemoryFile,
} from '@utils/memoryStore'

function formatLocalDateYYYYMMDD(date = new Date()): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatLocalTimeHHMM(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function messageToTranscriptLine(msg: Message): string | null {
  if (msg.type === 'progress') return null

  if (msg.type === 'user') {
    const content = msg.message.content
    if (typeof content === 'string') {
      // slash commands / local command wrapper
      if (content.includes('<command-name>') || content.includes('<command-message>')) {
        const cmd = extractTag(content, 'command-message') || extractTag(content, 'command-name')
        const args = extractTag(content, 'command-args') || ''
        return cmd ? `用户：执行命令 /${cmd}${args ? ` ${args}` : ''}` : null
      }

      // bash input wrapper
      if (content.includes('<bash-input>')) {
        const bash = extractTag(content, 'bash-input')
        return bash ? `用户（bash）：${bash}` : null
      }

      const text = content.trim()
      return text ? `用户：${text}` : null
    }

    // multimodal
    if (Array.isArray(content)) {
      const textParts = content
        .filter(p => (p as any)?.type === 'text')
        .map(p => String((p as any).text ?? '').trim())
        .filter(Boolean)
      const hasImage = content.some(p => (p as any)?.type === 'image')
      const text = textParts.join('\n')
      if (!text && !hasImage) return null
      if (hasImage && text) return `用户：[图片] ${text}`
      if (hasImage) return '用户：[图片]'
      return `用户：${text}`
    }
  }

  if (msg.type === 'assistant') {
    const blocks = msg.message.content
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()
    return text ? `助手：${text}` : null
  }

  return null
}

function buildTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const line = messageToTranscriptLine(m)
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

const memory = {
  type: 'local',
  name: 'memory',
  description: '更新用户偏好记忆（lead/YUUKA.md）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'memory'
  },
  async call(_args: string, context) {
    if (!(getGlobalConfig().memoryWriteEnabled ?? true)) {
      return 'MemoryWrite 已关闭，无法更新记忆。请先在 /config 里打开 MemoryWrite。'
    }

    const getMessages = getMessagesGetter()
    const messages = typeof getMessages === 'function' ? getMessages() : []

    const transcript = buildTranscript(messages.slice(-120))
    if (!transcript.trim()) {
      return '没有可总结的对话内容（当前会话为空）'
    }

    const today = formatLocalDateYYYYMMDD()
    const nowHHMM = formatLocalTimeHHMM()
    const memoryFilePath = 'YUUKA.md'
    const existingMemory = readMemoryFile(memoryFilePath, 'lead')?.trim() || ''

    const systemPrompt = [
      '你是一个“用户偏好记忆整理助手”。你要更新 YUUKA.md。',
      '目标：基于“已有记忆 + 本次对话”，输出完整的新 YUUKA.md（覆盖旧内容，不是追加）。',
      '要求：中文、口语化、短句为主，不要长篇大论。',
      '只保留跨会话有价值的稳定偏好、沟通习惯、长期工作方式。',
      '不要记录临时任务、一次性细节、敏感信息。',
      '遇到重复内容要去重；遇到冲突时，以本次对话最新表达为准。',
      '必须输出 Markdown，且至少包含：# 用户偏好记忆、## 沟通偏好、## 工作偏好、## 其他长期约定、## 最后更新。',
      '不要泄露任何思考链/推理过程。',
      '只输出最终 Markdown，不要解释过程，也不要输出“我将/我会”。',
    ]

    const userPrompt = [
      '请更新 YUUKA.md。',
      `最后更新时间请写：${today} ${nowHHMM}。`,
      '',
      '已有记忆（可能为空）：',
      existingMemory || '(暂无)',
      '',
      '对话记录：',
      transcript,
    ].join('\n')

    const result = await queryQuick({
      systemPrompt,
      userPrompt,
      signal: context.abortController.signal,
    })

    const text =
      typeof result.message.content === 'string'
        ? result.message.content
        : Array.isArray(result.message.content)
          ? result.message.content
              .filter(b => b.type === 'text')
              .map(b => (b.type === 'text' ? b.text : ''))
              .join('\n')
          : ''

    const cleaned = text.trim()
    if (!cleaned) {
      return '生成失败：模型没有返回可写入的内容'
    }

    const fullPath = writeMemoryFile(memoryFilePath, cleaned, 'lead')
    deleteMemoryFile('index.md', 'lead')
    return `已更新：${fullPath}`
  },
} satisfies Command

export default memory
