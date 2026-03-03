import type { TextBlock, ToolUseBlock } from '@yuuka-types/llm'
import { AssistantMessage, BinaryFeedbackResult } from '@query'
import { MAIN_QUERY_TEMPERATURE } from '@services/llm'

import { isEqual, zip } from 'lodash-es'
import { getGitState } from '@utils/git'

export type BinaryFeedbackChoice =
  | 'prefer-left'
  | 'prefer-right'
  | 'neither'
  | 'no-preference'

export type BinaryFeedbackChoose = (choice: BinaryFeedbackChoice) => void

type BinaryFeedbackConfig = {
  sampleFrequency: number
}

async function getBinaryFeedbackConfig(): Promise<BinaryFeedbackConfig> {
  return { sampleFrequency: 0 }
}

function isTextBlock(cb: any): cb is TextBlock {
  return cb?.type === 'text' && typeof cb?.text === 'string'
}

function isToolUseBlock(cb: any): cb is ToolUseBlock {
  return cb?.type === 'tool_use' && typeof cb?.name === 'string'
}

function getMessageBlockSequence(m: AssistantMessage) {
  return m.message.content.map(cb => {
    if (cb.type === 'text') return 'text'
    if (cb.type === 'tool_use') return cb.name
    return cb.type // Handle other block types like 'thinking' or 'redacted_thinking'
  })
}

// Logging removed to minimize runtime surface area; behavior unaffected

function textContentBlocksEqual(cb1: TextBlock, cb2: TextBlock): boolean {
  return cb1.text === cb2.text
}

function contentBlocksEqual(
  cb1: TextBlock | ToolUseBlock,
  cb2: TextBlock | ToolUseBlock,
): boolean {
  if (cb1.type !== cb2.type) {
    return false
  }
  if (cb1.type === 'text') {
    return textContentBlocksEqual(cb1, cb2 as TextBlock)
  }
  cb2 = cb2 as ToolUseBlock
  return cb1.name === cb2.name && isEqual(cb1.input, cb2.input)
}

function allContentBlocksEqual(
  content1: (TextBlock | ToolUseBlock)[],
  content2: (TextBlock | ToolUseBlock)[],
): boolean {
  if (content1.length !== content2.length) {
    return false
  }
  return zip(content1, content2).every(([cb1, cb2]) =>
    contentBlocksEqual(cb1!, cb2!),
  )
}

export async function shouldUseBinaryFeedback(): Promise<boolean> {
  if (process.env.DISABLE_BINARY_FEEDBACK) {
    return false
  }
  if (process.env.FORCE_BINARY_FEEDBACK) {
    return true
  }
  if (process.env.USER_TYPE !== 'ant') {
    return false
  }
  if (process.env.NODE_ENV === 'test') {
    // Binary feedback breaks a couple tests related to checking for permission,
    // so we have to disable it in tests at the risk of hiding bugs
    return false
  }

  const config = await getBinaryFeedbackConfig()
  if (config.sampleFrequency === 0) {
    return false
  }
  if (Math.random() > config.sampleFrequency) {
    return false
  }
  return true
}

export function messagePairValidForBinaryFeedback(
  m1: AssistantMessage,
  m2: AssistantMessage,
): boolean {
  const logPass = () => {}
  const logFail = (_reason: string) => {}

  // Ignore thinking blocks, on the assumption that users don't find them very relevant
  // compared to other content types
  const nonThinkingBlocks1 = m1.message.content.filter(
    b => b.type !== 'thinking' && b.type !== 'redacted_thinking',
  )
  const nonThinkingBlocks2 = m2.message.content.filter(
    b => b.type !== 'thinking' && b.type !== 'redacted_thinking',
  )
  const toolUseBlocks1 = nonThinkingBlocks1.filter(isToolUseBlock)
  const toolUseBlocks2 = nonThinkingBlocks2.filter(isToolUseBlock)
  const hasToolUse = toolUseBlocks1.length > 0 || toolUseBlocks2.length > 0

  // If they're all text blocks, compare those
  if (!hasToolUse) {
    const textBlocks1 = nonThinkingBlocks1.filter(isTextBlock)
    const textBlocks2 = nonThinkingBlocks2.filter(isTextBlock)

    // If either side contains non-text blocks (images/tool_results/etc.), skip binary feedback.
    if (
      textBlocks1.length !== nonThinkingBlocks1.length ||
      textBlocks2.length !== nonThinkingBlocks2.length
    ) {
      return false
    }

    if (allContentBlocksEqual(textBlocks1, textBlocks2)) {
      logFail('contents_identical')
      return false
    }
    logPass()
    return true
  }

  // If there are tools, they're the most material difference between the messages.
  // Only show binary feedback if there's a tool use difference, ignoring text.
  if (
    allContentBlocksEqual(
      toolUseBlocks1,
      toolUseBlocks2,
    )
  ) {
    logFail('contents_identical')
    return false
  }

  logPass()
  return true
}

export function getBinaryFeedbackResultForChoice(
  m1: AssistantMessage,
  m2: AssistantMessage,
  choice: BinaryFeedbackChoice,
): BinaryFeedbackResult {
  switch (choice) {
    case 'prefer-left':
      return { message: m1, shouldSkipPermissionCheck: true }
    case 'prefer-right':
      return { message: m2, shouldSkipPermissionCheck: true }
    case 'no-preference':
      return {
        message: Math.random() < 0.5 ? m1 : m2,
        shouldSkipPermissionCheck: false,
      }
    case 'neither':
      return { message: null, shouldSkipPermissionCheck: false }
  }
}
// Keep a minimal exported stub to satisfy imports without side effects
export async function logBinaryFeedbackEvent(
  _m1: AssistantMessage,
  _m2: AssistantMessage,
  _choice: BinaryFeedbackChoice,
): Promise<void> {}
