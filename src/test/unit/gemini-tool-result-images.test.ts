import { describe, expect, test } from 'vitest'
import { kodeMessagesToGeminiContents } from '../../services/gemini/adapter'

describe('Gemini adapter - tool_result images', () => {
  test('preserves image blocks from tool_result as inlineData parts', () => {
    const toolUseId = 'tool-use-1'
    const toolName = 'mcp__windows_mcp__screenshot_control'

    const assistantMessage = {
      type: 'assistant',
      uuid: 'a' as any,
      costUSD: 0,
      durationMs: 0,
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: {},
          },
        ],
      },
    } as any

    const userMessage = {
      type: 'user',
      uuid: 'u' as any,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: false,
            content: [
              { type: 'text', text: 'ok: true' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'AAA=',
                },
              },
            ],
          },
        ],
      },
    } as any

    const contents = kodeMessagesToGeminiContents([assistantMessage, userMessage])
    const userTurns = contents.filter(c => c.role === 'user')
    expect(userTurns.length).toBeGreaterThanOrEqual(2)

    const responseTurn = userTurns.find(t =>
      (t.parts as any[]).some(p => !!p.functionResponse),
    )
    const imageTurn = userTurns.find(t => (t.parts as any[]).some(p => !!p.inlineData))

    expect(responseTurn).toBeTruthy()
    const functionResponsePart = (responseTurn!.parts as any[]).find(p => !!p.functionResponse)
    expect(functionResponsePart).toBeTruthy()
    expect(functionResponsePart.functionResponse.name).toBe(toolName)
    expect(functionResponsePart.functionResponse.id).toBe(toolUseId)
    expect(functionResponsePart.functionResponse.response.output).toContain('ok: true')
    expect(String(functionResponsePart.functionResponse.response.output)).not.toContain('AAA=')

    expect(imageTurn).toBeTruthy()
    const inlineDataPart = (imageTurn!.parts as any[]).find(p => !!p.inlineData)
    expect(inlineDataPart).toBeTruthy()
    expect(inlineDataPart.inlineData.mimeType).toBe('image/png')
    expect(inlineDataPart.inlineData.data).toBe('AAA=')
  })
})
