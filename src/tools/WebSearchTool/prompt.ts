
export const TOOL_NAME_FOR_PROMPT = 'WebSearch'
export const DESCRIPTION = `- Allows Kode to search the web via Gemini hosted tool: googleSearch
- Provides up-to-date information for current events and recent data
- Returns a deduplicated SOURCES list (real URLs extracted from Gemini groundingMetadata)
- The NOTES section may include citation markers like [1][2] that map to SOURCES indices
- Use this tool for accessing information beyond the Kode's knowledge cutoff

Usage notes:
- Use when you need current information not in training data
- Effective for recent news, current events, product updates, or real-time data
- Search queries should be specific and well-targeted for best results
- Prefer citing URLs from the SOURCES section; do NOT invent URLs`
