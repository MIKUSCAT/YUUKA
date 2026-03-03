// Minimal local "LLM message" types.
// YUUKA historically used Anthropic's SDK types as a convenient shape for
// message/content blocks. We keep the same structure here to avoid vendor
// lock-in and to simplify internal data flow.

export interface TextBlockParam {
  type: 'text'
  text: string
  // Optional; kept for compatibility with existing rendering code.
  citations?: unknown[]
}

export interface TextBlock {
  type: 'text'
  text: string
  citations?: unknown[]
}

export interface ImageBlockParam {
  type: 'image'
  source: ImageBlockParam.Source
}

export namespace ImageBlockParam {
  export interface Source {
    type: 'base64'
    media_type: string
    data: string
  }
}

export interface ToolUseBlockParam {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

// Compatibility with the (historical) Anthropic block types.
// Gemini transport does not currently emit these, but parts of the UI and
// message utilities still know how to ignore them.
export interface ThinkingBlockParam {
  type: 'thinking'
  thinking: string
}

export interface RedactedThinkingBlockParam {
  type: 'redacted_thinking'
  data?: string
}

// In our codebase these two shapes are used interchangeably.
export type ToolUseBlock = ToolUseBlockParam

export interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlockParam[]
  is_error?: boolean
}

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam

export type ContentBlock = ContentBlockParam

export type MessageParam = {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlockParam[]
}

export type Message = {
  id?: string
  model?: string
  role: 'user' | 'assistant' | 'system'
  type?: 'message'
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  content: ContentBlock[]
}
