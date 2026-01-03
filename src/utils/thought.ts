export type ThoughtSummary = {
  subject: string
  description: string
}

const START_DELIMITER = '**'
const END_DELIMITER = '**'

// 参考 Gemini CLI：把原始 thought 解析成“标题 + 描述”
export function parseThought(rawText: string): ThoughtSummary {
  const text = String(rawText ?? '').trim()
  const startIndex = text.indexOf(START_DELIMITER)
  if (startIndex === -1) {
    return { subject: '', description: text }
  }

  const endIndex = text.indexOf(END_DELIMITER, startIndex + START_DELIMITER.length)
  if (endIndex === -1) {
    return { subject: '', description: text }
  }

  const subject = text
    .substring(startIndex + START_DELIMITER.length, endIndex)
    .trim()

  const description = (
    text.substring(0, startIndex) +
    text.substring(endIndex + END_DELIMITER.length)
  ).trim()

  return { subject, description }
}

