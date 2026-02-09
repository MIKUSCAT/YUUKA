type GeminiModelInfo = {
  model: string
  provider: 'gemini'
  mode: 'chat'
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_parallel_function_calling?: boolean
  supports_vision?: boolean
  supports_prompt_caching?: boolean
  supports_system_messages?: boolean
  supports_tool_choice?: boolean
  supports_response_schema?: boolean
  supports_reasoning_effort?: boolean
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
}

const geminiModels: GeminiModelInfo[] = [
  {
    model: 'models/gemini-3-flash-preview',
    provider: 'gemini',
    mode: 'chat',
    max_tokens: 8192,
    max_input_tokens: 1_048_576,
    max_output_tokens: 8192,
    supports_function_calling: true,
    supports_parallel_function_calling: true,
    supports_vision: true,
    supports_prompt_caching: true,
    supports_system_messages: true,
    supports_tool_choice: true,
    supports_response_schema: true,
    supports_reasoning_effort: true,
  },
  {
    model: 'models/gemini-3-pro-preview',
    provider: 'gemini',
    mode: 'chat',
    max_tokens: 8192,
    max_input_tokens: 1_048_576,
    max_output_tokens: 8192,
    supports_function_calling: true,
    supports_parallel_function_calling: true,
    supports_vision: true,
    supports_prompt_caching: true,
    supports_system_messages: true,
    supports_tool_choice: true,
    supports_response_schema: true,
    supports_reasoning_effort: true,
  },
  {
    model: 'models/gemini-2.5-flash',
    provider: 'gemini',
    mode: 'chat',
    max_tokens: 8192,
    max_input_tokens: 1_048_576,
    max_output_tokens: 8192,
    supports_function_calling: true,
    supports_parallel_function_calling: true,
    supports_vision: true,
    supports_prompt_caching: true,
    supports_system_messages: true,
    supports_tool_choice: true,
    supports_response_schema: true,
    supports_reasoning_effort: true,
  },
]

const modelsCatalog = {
  gemini: geminiModels,
}

export default modelsCatalog
