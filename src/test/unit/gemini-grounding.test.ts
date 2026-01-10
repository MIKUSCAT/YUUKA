import { describe, expect, test } from 'vitest'
import { applyGroundingCitations, extractGeminiGrounding } from '../../services/gemini/grounding'

describe('Gemini grounding - extractGeminiGrounding', () => {
  test('extracts deduped http(s) sources, webSearchQueries, and maps groundingSupports to sources[]', () => {
    const resp = {
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: [' q1 ', 'q2', '', null],
            groundingChunks: [
              { web: { uri: 'https://example.com/a', title: 'A' } },
              { web: { uri: 'http://example.com/b', title: 'B' } },
              { web: { uri: 'https://example.com/a', title: 'A-dup' } },
              { web: { uri: 'file:///etc/passwd', title: 'NO' } },
              { web: { uri: 'not-a-url', title: 'NO' } },
              { other: { uri: 'https://example.com/c' } },
            ],
            groundingSupports: [
              { segment: { endIndex: 5 }, groundingChunkIndices: [0, 1] },
              { segment: { endIndex: 5 }, groundingChunkIndices: [2] }, // duplicate A -> should map to [1]
              { segment: { endIndex: 9 }, groundingChunkIndices: [999] }, // out of range -> ignored
              { segment: { endIndex: 12 }, groundingChunkIndices: [3] }, // invalid URI -> ignored
            ],
          },
        },
      ],
    } as any

    const { sources, webSearchQueries, supports } = extractGeminiGrounding(resp)

    expect(webSearchQueries).toEqual(['q1', 'q2'])
    expect(sources).toEqual([
      { uri: 'https://example.com/a', title: 'A' },
      { uri: 'http://example.com/b', title: 'B' },
    ])
    expect(supports).toEqual([{ endIndex: 5, sourceIndices: [0, 1] }])
  })

  test('falls back to top-level groundingMetadata', () => {
    const resp = {
      groundingMetadata: {
        webSearchQueries: ['q'],
        groundingChunks: [{ web: { uri: 'https://example.com', title: 'Home' } }],
      },
    } as any

    const { sources, webSearchQueries, supports } = extractGeminiGrounding(resp)

    expect(webSearchQueries).toEqual(['q'])
    expect(sources).toEqual([{ uri: 'https://example.com/', title: 'Home' }])
    expect(supports).toEqual([])
  })
})

describe('Gemini grounding - applyGroundingCitations', () => {
  test('inserts citation markers using UTF-8 byte indices', () => {
    const text = '你好世界'
    const encoder = new TextEncoder()
    const endIndex = encoder.encode('你好').length // 2 Chinese chars -> 6 bytes

    const withCitations = applyGroundingCitations(text, [
      { endIndex, sourceIndices: [0, 1] },
    ])

    expect(withCitations).toBe('你好[1][2]世界')
  })
})
