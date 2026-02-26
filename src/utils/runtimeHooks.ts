import type { Tool, ToolUseContext } from '@tool'
import type { CanUseToolFn } from '@hooks/useCanUseTool'
import type { AssistantMessage } from '@query'
import { registerBuiltinRuntimeHooks } from './runtimeBuiltinHooks'

export type RuntimeAgentEvent =
  | {
      type: 'runtime_start'
      agentId?: string
      sessionId?: string
      messageCount: number
    }
  | {
      type: 'runtime_end'
      agentId?: string
      sessionId?: string
      success: boolean
      error?: string
    }
  | {
      type: 'message'
      agentId?: string
      sessionId?: string
      messageType: 'user' | 'assistant' | 'progress'
    }
  | {
      type: 'assistant_message'
      agentId?: string
      sessionId?: string
      text: string
      toolUses: string[]
    }
  | {
      type: 'tool_start'
      agentId?: string
      sessionId?: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool_end'
      agentId?: string
      sessionId?: string
      toolName: string
      status: 'success' | 'error'
      error?: string
    }
  | {
      type: 'tool_progress'
      agentId?: string
      sessionId?: string
      toolName: string
    }
  | {
      type: 'permission_request'
      agentId?: string
      sessionId?: string
      toolName: string
      input: unknown
    }
  | {
      type: 'permission_result'
      agentId?: string
      sessionId?: string
      toolName: string
      allowed: boolean
      reason?: string
    }

export interface BeforePromptHookInput {
  systemPrompt: string[]
  context: Record<string, string>
  agentId?: string
  sessionId?: string
}

export type BeforePromptHookResult =
  | void
  | {
      systemPrompt?: string[]
      context?: Record<string, string>
    }

export interface BeforeToolHookInput {
  tool: Tool
  input: unknown
  context: ToolUseContext
  agentId?: string
  sessionId?: string
}

export interface AfterToolHookInput extends BeforeToolHookInput {
  status: 'success' | 'error'
  result?: unknown
  error?: unknown
}

export interface RuntimeHookSet {
  id?: string
  beforePrompt?: (
    input: BeforePromptHookInput,
  ) => Promise<BeforePromptHookResult> | BeforePromptHookResult
  beforeTool?: (input: BeforeToolHookInput) => Promise<void> | void
  afterTool?: (input: AfterToolHookInput) => Promise<void> | void
  onAgentEvent?: (event: RuntimeAgentEvent) => Promise<void> | void
  systemPromptHeader?: (input: {
    agentId?: string
    context: Record<string, string>
  }) => string | string[] | null | undefined
}

type RuntimeHookRecord = Required<Pick<RuntimeHookSet, 'id'>> & RuntimeHookSet

const HOOKS: RuntimeHookRecord[] = []

let builtinRegistered = false

function normalizeHookId(hooks: RuntimeHookSet): string {
  return hooks.id?.trim() || `runtime-hook-${HOOKS.length + 1}`
}

export function registerRuntimeHooks(hooks: RuntimeHookSet): () => void {
  const id = normalizeHookId(hooks)
  const existingIndex = HOOKS.findIndex(h => h.id === id)
  const record: RuntimeHookRecord = { id, ...hooks }
  if (existingIndex >= 0) {
    HOOKS.splice(existingIndex, 1, record)
  } else {
    HOOKS.push(record)
  }

  return () => {
    const idx = HOOKS.findIndex(h => h.id === id)
    if (idx >= 0) {
      HOOKS.splice(idx, 1)
    }
  }
}

export function listRuntimeHooks(): string[] {
  return HOOKS.map(h => h.id)
}

export async function runBeforePromptHooks(
  input: BeforePromptHookInput,
): Promise<BeforePromptHookInput> {
  let current = {
    ...input,
    systemPrompt: [...input.systemPrompt],
    context: { ...input.context },
  }

  for (const hooks of HOOKS) {
    if (!hooks.beforePrompt) continue
    const result = await hooks.beforePrompt(current)
    if (!result) continue
    if (result.systemPrompt) {
      current = { ...current, systemPrompt: [...result.systemPrompt] }
    }
    if (result.context) {
      current = { ...current, context: { ...result.context } }
    }
  }

  return current
}

export async function runBeforeToolHooks(input: BeforeToolHookInput): Promise<void> {
  for (const hooks of HOOKS) {
    if (!hooks.beforeTool) continue
    await hooks.beforeTool(input)
  }
}

export async function runAfterToolHooks(input: AfterToolHookInput): Promise<void> {
  for (const hooks of HOOKS) {
    if (!hooks.afterTool) continue
    await hooks.afterTool(input)
  }
}

export async function emitRuntimeAgentEvent(event: RuntimeAgentEvent): Promise<void> {
  for (const hooks of HOOKS) {
    if (!hooks.onAgentEvent) continue
    await hooks.onAgentEvent(event)
  }
}

export function collectSystemPromptHeaders(input: {
  agentId?: string
  context: Record<string, string>
}): string[] {
  const sections: string[] = []
  for (const hooks of HOOKS) {
    if (!hooks.systemPromptHeader) continue
    const result = hooks.systemPromptHeader(input)
    if (!result) continue
    if (Array.isArray(result)) {
      for (const item of result) {
        if (typeof item === 'string' && item.trim()) {
          sections.push(item)
        }
      }
      continue
    }
    if (typeof result === 'string' && result.trim()) {
      sections.push(result)
    }
  }
  return sections
}

export function ensureBuiltinRuntimeHooksRegistered(): void {
  if (builtinRegistered) return
  builtinRegistered = true
  registerBuiltinRuntimeHooks()
}

export type RuntimeCanUseToolFn = CanUseToolFn
export type RuntimeAssistantMessage = AssistantMessage
