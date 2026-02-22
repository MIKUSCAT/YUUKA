import { generateSystemReminders } from '@services/systemReminder'
import { getMemoryBootstrapContext } from '@utils/memoryStore'
import { generateYuukaContext } from './yuukaContext'

export function formatSystemPromptWithContext(
  systemPrompt: string[],
  context: { [k: string]: string },
  agentId?: string,
  skipContextReminders = false,
): { systemPrompt: string[]; reminders: string } {
  const enhancedPrompt = [...systemPrompt]
  let reminders = ''

  try {
    const memoryBootstrap = getMemoryBootstrapContext(agentId)
    if (memoryBootstrap) {
      enhancedPrompt.push('\n---\n# 记忆上下文（开局必加载）\n')
      enhancedPrompt.push(memoryBootstrap)
      enhancedPrompt.push('\n---\n')
    }
  } catch {
    // 记忆上下文读取失败时不阻塞主流程
  }

  const hasContext = Object.entries(context).length > 0
  if (!hasContext) {
    return { systemPrompt: enhancedPrompt, reminders }
  }

  if (!skipContextReminders) {
    const yuukaContext = generateYuukaContext()
    if (yuukaContext) {
      enhancedPrompt.push('\n---\n# 项目上下文\n')
      enhancedPrompt.push(yuukaContext)
      enhancedPrompt.push('\n---\n')
    }
  }

  const reminderMessages = generateSystemReminders(hasContext, agentId)
  if (reminderMessages.length > 0) {
    reminders = reminderMessages.map(reminder => reminder.content).join('\n') + '\n'
  }

  enhancedPrompt.push(
    `\nAs you answer the user's questions, you can use the following context:\n`,
  )

  const filteredContext = Object.fromEntries(
    Object.entries(context).filter(
      ([key]) => key !== 'projectDocs' && key !== 'userDocs',
    ),
  )

  enhancedPrompt.push(
    ...Object.entries(filteredContext).map(
      ([key, value]) => `<context name="${key}">${value}</context>`,
    ),
  )

  return { systemPrompt: enhancedPrompt, reminders }
}
