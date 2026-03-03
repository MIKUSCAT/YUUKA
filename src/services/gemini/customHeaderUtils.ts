/**
 * Parses custom headers and returns a map of key and values.
 *
 * This matches Gemini CLI behavior (GEMINI_CLI_CUSTOM_HEADERS).
 * Example:
 *   GEMINI_CLI_CUSTOM_HEADERS="x-foo: bar, x-baz: a,b,c, x-qux: hello:world"
 */
export function parseCustomHeaders(
  envValue: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!envValue) return headers

  // Split on commas that are followed by "key:", ignoring commas inside values.
  for (const entry of envValue.split(/,(?=\s*[^,:]+:)/)) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    const sep = trimmed.indexOf(':')
    if (sep === -1) continue

    const name = trimmed.slice(0, sep).trim()
    const value = trimmed.slice(sep + 1).trim()
    if (!name) continue

    headers[name] = value
  }

  return headers
}

export function getGeminiCliCustomHeaders(): Record<string, string> {
  return parseCustomHeaders(process.env['GEMINI_CLI_CUSTOM_HEADERS'])
}

