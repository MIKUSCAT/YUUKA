import type { GeminiGenerateContentConfig, GeminiTool } from './types'
import { normalizeGeminiModelName } from '@utils/geminiSettings'

export type GeminiModelKey = 'main' | 'task' | 'reasoning' | 'quick' | 'web-search' | 'web-fetch'

export type GeminiResolvedModelConfig = {
  model: string
  config: GeminiGenerateContentConfig
}

const DEFAULT_THINKING_BUDGET = 8192

function asTools(tools?: GeminiTool[]): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
}

function getThinkingConfig(modelName: string): Record<string, unknown> {
  const normalized = normalizeGeminiModelName(modelName)
    .replace(/^models\//, '')
    .toLowerCase()

  if (normalized.startsWith('gemini-3')) {
    return {
      includeThoughts: true,
      thinkingLevel: 'HIGH',
    }
  }

  return {
    includeThoughts: true,
    thinkingBudget: DEFAULT_THINKING_BUDGET,
  }
}

export function resolveGeminiModelConfig(
  modelKey: string,
  settings: { model?: { name?: string } },
  options?: { functionDeclarations?: any[] },
): GeminiResolvedModelConfig {
  const baseModel = normalizeGeminiModelName(settings.model?.name || '')

  const common: GeminiGenerateContentConfig = {
    generationConfig: {},
    // 启用并行工具调用：允许模型一次生成多个函数调用
    toolConfig: {
      functionCallingConfig: {
        mode: 'AUTO', // AUTO 允许模型决定是否调用以及调用多少个函数
      },
    },
  }

  const declaredTools = options?.functionDeclarations?.length
    ? ([{ functionDeclarations: options.functionDeclarations }] as GeminiTool[])
    : undefined

  // 默认：task/reasoning 都先跟 main 走同一个配置（稳妥版）
  switch (modelKey) {
    case 'quick': {
      return {
        model: baseModel,
        config: {
          ...common,
          tools: asTools(declaredTools),
          generationConfig: {
            temperature: 0,
            thinkingConfig: getThinkingConfig(baseModel),
          },
        },
      }
    }
    case 'web-search': {
      return {
        model: baseModel,
        config: {
          ...common,
          tools: [{ googleSearch: {} }],
          generationConfig: {
            temperature: 0.2,
          },
        },
      }
    }
    case 'web-fetch': {
      return {
        model: baseModel,
        config: {
          ...common,
          tools: [{ urlContext: {} }],
          generationConfig: {
            temperature: 0.2,
          },
        },
      }
    }
    case 'task':
    case 'reasoning':
    case 'main':
    default: {
      return {
        model: baseModel,
        config: {
          ...common,
          tools: asTools(declaredTools),
          generationConfig: {
            temperature: 1,
            thinkingConfig: getThinkingConfig(baseModel),
          },
        },
      }
    }
  }
}
