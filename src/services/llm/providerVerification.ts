import { normalizeGeminiApiRoot } from '@utils/geminiSettings'

/**
 * Verify Gemini API key by querying model list endpoint.
 * This helper remains named `verifyApiKey` for backward compatibility.
 */
export async function verifyApiKey(
  apiKey: string,
  baseURL?: string,
): Promise<boolean> {
  if (!apiKey?.trim()) {
    return false
  }

  const apiRoot = normalizeGeminiApiRoot(
    baseURL || 'https://generativelanguage.googleapis.com',
  )
  const url = new URL(`${apiRoot.replace(/\/+$/, '')}/models`)
  url.searchParams.set('key', apiKey.trim())

  try {
    const response = await fetch(url.toString(), { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}
