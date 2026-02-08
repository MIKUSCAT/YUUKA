const DEFAULT_MAX_CHARS_PER_LINE = 400
const BASE64_MIN_LENGTH = 1000

/**
 * Shorten extremely long inline blobs (especially base64/data URLs) and
 * cap per-line length to keep terminal rendering stable.
 */
export function sanitizeLongLine(
  line: string,
  maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE,
): string {
  const dataUrlRegex =
    /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]{200,})/g
  let sanitized = line.replace(
    dataUrlRegex,
    (_m, mimeType: string, data: string) => {
      if (data.length < BASE64_MIN_LENGTH) return _m
      return `data:${mimeType};base64,[omitted ${data.length} chars]`
    },
  )

  const base64Regex = /[A-Za-z0-9+/]{1000,}={0,2}/g
  sanitized = sanitized.replace(base64Regex, (m: string) => {
    if (m.length < BASE64_MIN_LENGTH) return m
    return `[base64 omitted ${m.length} chars]`
  })

  if (sanitized.length <= maxCharsPerLine) return sanitized
  const head = sanitized.slice(0, 240)
  const tail = sanitized.slice(-120)
  const removed = sanitized.length - head.length - tail.length
  return `${head}…[${removed} chars omitted]…${tail}`
}

export function sanitizeMultilineText(
  text: string,
  maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE,
): string {
  return text
    .split('\n')
    .map(line => sanitizeLongLine(line, maxCharsPerLine))
    .join('\n')
}
