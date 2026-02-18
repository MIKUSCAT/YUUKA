import { z } from 'zod'
import * as React from 'react'

/**
 * Core Tool interface for YUUKA's extensible tool system
 * Provides standardized contract for all tool implementations
 */

export type SetToolJSXFn = (jsx: {
  jsx: React.ReactNode | null
  shouldHidePromptInput: boolean
} | null) => void

export interface ToolUseContext {
  messageId: string | undefined
  agentId?: string
  safeMode?: boolean
  abortController: AbortController
  readFileTimestamps: { [filePath: string]: number }
  /**
   * 可选：交互式权限回调（用于 TaskTool 等“嵌套 query”场景）。
   * 主 REPL 会提供一个能弹确认框的 canUseTool；非交互场景可能为空。
   */
  canUseTool?: unknown
  options?: {
    commands?: any[]
    tools?: any[]
    verbose?: boolean
    slowAndCapableModel?: string
    safeMode?: boolean
    permissionMode?: string
    forkNumber?: number
    messageLogName?: string
    maxThinkingTokens?: any
    isCustomCommand?: boolean
  }
  // GPT-5 Responses API state management
  responseState?: {
    previousResponseId?: string
    conversationId?: string
  }
}

export interface ExtendedToolUseContext extends ToolUseContext {
  setToolJSX: SetToolJSXFn
}

export interface ValidationResult {
  result: boolean
  message?: string
  errorCode?: number
  meta?: any
}

export interface Tool<
  TInput extends z.ZodObject<any> = z.ZodObject<any>,
  TOutput = any,
> {
  name: string
  description?: string | (() => Promise<string>)
  inputSchema: TInput
  inputJSONSchema?: Record<string, unknown>
  prompt: (options?: { safeMode?: boolean }) => Promise<string>
  userFacingName?: () => string
  /** Cached description for synchronous access by adapters */
  cachedDescription?: string
  isEnabled: () => Promise<boolean>
  isReadOnly: () => boolean
  isConcurrencySafe: () => boolean
  needsPermissions: (input?: z.infer<TInput>) => boolean
  validateInput?: (
    input: z.infer<TInput>,
    context?: ToolUseContext,
  ) => Promise<ValidationResult>
  renderResultForAssistant: (output: TOutput) => string | any[]
  renderToolUseMessage: (
    input: z.infer<TInput>,
    options: { verbose: boolean },
  ) => string
  renderToolUseRejectedMessage?: (...args: any[]) => React.ReactElement
  renderToolResultMessage?: (
    output: TOutput,
    options?: { verbose?: boolean },
  ) => React.ReactElement
  call: (
    input: z.infer<TInput>,
    context: ToolUseContext,
  ) => AsyncGenerator<
    | { type: 'result'; data: TOutput; resultForAssistant?: string }
    | { type: 'progress'; content: any; normalizedMessages?: any[]; tools?: any[] },
    void,
    unknown
  >
}

/**
 * Get tool description synchronously for adapter usage.
 * Adapter code cannot await async descriptions, so we use cached or fallback values.
 */
export function getToolDescription(tool: Tool): string {
  // First try cached description (populated by tool initialization)
  if (tool.cachedDescription) {
    return tool.cachedDescription
  }

  // Then try string description
  if (typeof tool.description === 'string') {
    return tool.description
  }

  // Finally, use fallback name if description is async function
  return `Tool: ${tool.name}`
}
