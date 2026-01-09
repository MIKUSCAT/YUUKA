export const TOOL_NAME_FOR_PROMPT = 'URLFetcher'
export const DESCRIPTION = `- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content via Gemini hosted tool: urlContext
- Processes the content with the prompt and returns the model's response about the content
- Returns a SOURCES list (real URLs extracted from Gemini groundingMetadata)
- The ANALYSIS section may include citation markers like [1][2] that map to SOURCES indices
- Use this tool when you need to retrieve and analyze web content

Usage notes:
- IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".
- The URL must be a fully-formed valid HTTP(S) URL (e.g., https://example.com). Local file paths and file:// URLs are not supported.
- HTTP URLs will be automatically upgraded to HTTPS
- The prompt should describe what information you want to extract from the page
- This tool is read-only and does not modify any files
- Prefer citing URLs from the SOURCES section; do NOT invent URLs`
