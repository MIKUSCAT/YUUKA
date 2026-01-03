import type { Command } from '@commands'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getMessagesGetter } from '@messages'
import type { Message } from '@query'
import { queryQuick } from '@services/claude'
import { extractTag } from '@utils/messages'
import { getCwd } from '@utils/state'

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

function appendToAgentsMd(agentsPath: string, contentToAppend: string): void {
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : ''
  const trimmedExisting = existing.trimEnd()
  const prefix = trimmedExisting ? `${trimmedExisting}\n\n` : ''
  writeFileSync(agentsPath, `${prefix}${contentToAppend.trim()}\n`, 'utf-8')
}

const memory = {
  type: 'local',
  name: 'memory',
  description: '把今天对话总结写入 AGENTS.md（含用户习惯/偏好）',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'memory'
  },
  async call(_args: string, context) {
    const getMessages = getMessagesGetter()
    const messages = typeof getMessages === 'function' ? getMessages() : []

    const transcript = buildTranscript(messages.slice(-120))
    if (!transcript.trim()) {
      return '没有可总结的对话内容（当前会话为空）'
    }

    const today = formatLocalDateYYYYMMDD()
    const nowHHMM = formatLocalTimeHHMM()
    const agentsPath = join(getCwd(), 'AGENTS.md')

    const systemPrompt = [
      '你是一个“工作记忆整理助手”。你要把今天的对话整理成一段会被追加到 AGENTS.md 的内容。',
      '要求：中文、口语化、短句为主，不要长篇大论。',
      '只输出最终要写入 AGENTS.md 的 Markdown 内容，不要解释你的过程，也不要输出“我将/我会”。',
      '必须包含两块：1) 今日对话总结 2) 用户习惯/偏好（尽量提炼成稳定规则）。',
      '如果对话里有明确的下一步/未决事项，可以加一块“下一步”。',
      '不要泄露任何思考链/推理过程。',
    ]

    const userPrompt = [
      `请基于下面“对话记录”，生成一段要追加到 AGENTS.md 的内容。`,
      `标题里要带日期：${today}，并写上时间：${nowHHMM}。`,
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

    appendToAgentsMd(agentsPath, cleaned)
    return `已写入：${agentsPath}`
  },
} satisfies Command

export default memory
