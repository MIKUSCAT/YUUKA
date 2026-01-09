type GroundingSource = { uri: string; title?: string }

type GroundingSupport = {
  // Gemini 返回的 groundingSupports.segment.endIndex 是 UTF-8 byte index（官方 gemini-cli 注释如此）
  endIndex: number
  // 指向 sources[] 的下标（已做去重映射）
  sourceIndices: number[]
}

type GroundingExtractionResult = {
  sources: GroundingSource[]
  webSearchQueries: string[]
  supports: GroundingSupport[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const s = pickString(item)
    if (s) out.push(s)
  }
  return out
}

function getGroundingMetadata(response: unknown): unknown {
  if (!isRecord(response)) return undefined

  const candidates = Array.isArray(response.candidates) ? response.candidates : undefined
  const firstCandidate = candidates?.[0]
  if (isRecord(firstCandidate) && 'groundingMetadata' in firstCandidate) {
    const meta = (firstCandidate as any).groundingMetadata
    if (meta !== undefined) return meta
  }

  return (response as any).groundingMetadata
}

function normalizeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const int = Math.floor(value)
  if (int < 0) return null
  return int
}

function extractSourcesAndChunkMap(meta: unknown): {
  sources: GroundingSource[]
  chunkIndexToSourceIndex: Array<number | null>
} {
  if (!isRecord(meta)) return { sources: [], chunkIndexToSourceIndex: [] }

  const chunks = Array.isArray((meta as any).groundingChunks) ? (meta as any).groundingChunks : []
  const sources: GroundingSource[] = []
  const sourceIndexByUri = new Map<string, number>()
  const chunkIndexToSourceIndex: Array<number | null> = []

  for (const chunk of chunks) {
    if (!isRecord(chunk)) {
      chunkIndexToSourceIndex.push(null)
      continue
    }
    const web = (chunk as any).web
    if (!isRecord(web)) {
      chunkIndexToSourceIndex.push(null)
      continue
    }

    const uriRaw = pickString(web.uri)
    if (!uriRaw) {
      chunkIndexToSourceIndex.push(null)
      continue
    }
    const uri = normalizeHttpUrl(uriRaw)
    if (!uri) {
      chunkIndexToSourceIndex.push(null)
      continue
    }

    const title = pickString(web.title)

    const existingIndex = sourceIndexByUri.get(uri)
    if (existingIndex !== undefined) {
      chunkIndexToSourceIndex.push(existingIndex)
      // 如果第一次没有 title，后面补上
      if (!sources[existingIndex]?.title && title) {
        sources[existingIndex] = { uri, title }
      }
      continue
    }

    const nextIndex = sources.length
    sourceIndexByUri.set(uri, nextIndex)
    sources.push({ uri, ...(title ? { title } : {}) })
    chunkIndexToSourceIndex.push(nextIndex)
  }

  return { sources, chunkIndexToSourceIndex }
}

function extractSupports(meta: unknown, chunkIndexToSourceIndex: Array<number | null>): GroundingSupport[] {
  if (!isRecord(meta)) return []

  const supportsRaw = Array.isArray((meta as any).groundingSupports)
    ? (meta as any).groundingSupports
    : []

  // 合并同一个 endIndex 的多个引用，避免重复插 marker
  const sourceIndexSetsByEndIndex = new Map<number, Set<number>>()

  for (const support of supportsRaw) {
    if (!isRecord(support)) continue

    const segment = (support as any).segment
    if (!isRecord(segment)) continue

    const endIndex = toNonNegativeInt((segment as any).endIndex)
    if (endIndex === null) continue

    const chunkIndices = Array.isArray((support as any).groundingChunkIndices)
      ? (support as any).groundingChunkIndices
      : []
    if (chunkIndices.length === 0) continue

    const set =
      sourceIndexSetsByEndIndex.get(endIndex) ?? new Set<number>()

    for (const rawChunkIndex of chunkIndices) {
      const chunkIndex = toNonNegativeInt(rawChunkIndex)
      if (chunkIndex === null) continue
      const mapped = chunkIndexToSourceIndex[chunkIndex]
      if (typeof mapped === 'number') {
        set.add(mapped)
      }
    }

    if (set.size > 0) {
      sourceIndexSetsByEndIndex.set(endIndex, set)
    }
  }

  const supports: GroundingSupport[] = []
  for (const [endIndex, set] of sourceIndexSetsByEndIndex.entries()) {
    supports.push({
      endIndex,
      sourceIndices: Array.from(set).sort((a, b) => a - b),
    })
  }

  supports.sort((a, b) => a.endIndex - b.endIndex)
  return supports
}

function buildCitationMarker(sourceIndices: number[]): string {
  const uniqSorted = Array.from(new Set(sourceIndices)).sort((a, b) => a - b)
  return uniqSorted.map(i => `[${i + 1}]`).join('')
}

export function applyGroundingCitations(text: string, supports: GroundingSupport[]): string {
  if (!text) return text
  if (!Array.isArray(supports) || supports.length === 0) return text

  const insertions: Array<{ index: number; marker: string }> = []
  for (const support of supports) {
    if (!support || typeof support !== 'object') continue
    const index = toNonNegativeInt((support as any).endIndex)
    if (index === null) continue
    const sourceIndices = Array.isArray((support as any).sourceIndices)
      ? ((support as any).sourceIndices as unknown[])
          .map(toNonNegativeInt)
          .filter((v): v is number => typeof v === 'number')
      : []
    if (sourceIndices.length === 0) continue
    const marker = buildCitationMarker(sourceIndices)
    if (!marker) continue
    insertions.push({ index, marker })
  }

  if (insertions.length === 0) return text

  // 按 index 逆序插入，避免后续 index 偏移；index 是 UTF-8 byte index
  insertions.sort((a, b) => b.index - a.index)
  const encoder = new TextEncoder()
  const baseBytes = encoder.encode(text)

  const parts: Uint8Array[] = []
  let lastIndex = baseBytes.length
  for (const ins of insertions) {
    const pos = Math.max(0, Math.min(ins.index, lastIndex))
    parts.unshift(baseBytes.subarray(pos, lastIndex))
    parts.unshift(encoder.encode(ins.marker))
    lastIndex = pos
  }
  parts.unshift(baseBytes.subarray(0, lastIndex))

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const finalBytes = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    finalBytes.set(part, offset)
    offset += part.length
  }

  return new TextDecoder().decode(finalBytes)
}

export function extractGeminiGrounding(response: unknown): GroundingExtractionResult {
  const meta = getGroundingMetadata(response)
  const { sources, chunkIndexToSourceIndex } = extractSourcesAndChunkMap(meta)

  let webSearchQueries: string[] = []
  if (isRecord(meta)) {
    webSearchQueries = pickStringArray((meta as any).webSearchQueries)
  }

  const supports = extractSupports(meta, chunkIndexToSourceIndex)

  return { sources, webSearchQueries, supports }
}

export type { GroundingSource, GroundingSupport, GroundingExtractionResult }
