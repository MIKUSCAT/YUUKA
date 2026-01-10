export type GeminiRole = 'user' | 'model'

export type GeminiTextPart = { text: string }
export type GeminiInlineDataPart = {
  inlineData: { mimeType: string; data: string }
}

export type GeminiFunctionCall = {
  id?: string
  name: string
  args?: Record<string, unknown>
}
export type GeminiFunctionCallPart = {
  functionCall: GeminiFunctionCall
  thoughtSignature?: string
}

export type GeminiFunctionResponsePart = {
  functionResponse: {
    id: string
    name: string
    response: Record<string, unknown>
  }
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

export type GeminiContent = {
  role: GeminiRole
  parts: GeminiPart[]
}

export type GeminiFunctionDeclaration = {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export type GeminiTool =
  | { functionDeclarations: GeminiFunctionDeclaration[] }
  | { googleSearch: Record<string, never> }
  | { urlContext: Record<string, never> }

export type GeminiGenerateContentConfig = {
  abortSignal?: AbortSignal
  systemInstruction?: GeminiContent
  tools?: GeminiTool[]
  toolConfig?: Record<string, unknown>
  generationConfig?: Record<string, unknown>
}

export type GeminiGenerateContentParameters = {
  model: string
  contents: GeminiContent[]
  config?: GeminiGenerateContentConfig
}

export type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: GeminiContent
    finishReason?: string
    groundingMetadata?: unknown
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  groundingMetadata?: unknown
  // Gemini CLI 会补一个方便字段；这里也保留以便统一处理
  functionCalls?: GeminiFunctionCall[]
}
