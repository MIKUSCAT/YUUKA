import type { Command } from '@commands'
import { Box, Text, useInput } from 'ink'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getTheme } from '@utils/theme'
import {
  ensureGlobalGeminiSettings,
  getGlobalGeminiSettingsPath,
  normalizeGeminiApiRoot,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
} from '@utils/geminiSettings'
import { Select } from '@components/CustomSelect/select'
import modelsCatalog from '@constants/models'
import { SimpleSpinner } from '@components/Spinner'
import { getValidGeminiCliAccessToken } from '@services/gemini/codeAssistAuth'

export const help =
  '选择/设置 Gemini 模型（写入全局 ~/.gemini/settings.json）；Enter 确认，Esc 退出'
export const description =
  '选择/设置 Gemini 模型（写入全局 ~/.gemini/settings.json）'
export const isEnabled = true
export const isHidden = false
export const name = 'model'
export const type = 'local-jsx'

export function userFacingName(): string {
  return name
}

function stripModelPrefix(modelName: string): string {
  return modelName.replace(/^models\//, '').replace(/^tunedModels\//, 'tunedModels/')
}

function setModelName(settingsPath: string, raw: string): string {
  const normalized = normalizeGeminiModelName(raw)
  const settings = readGeminiSettingsFile(settingsPath)
  const nextSettings = structuredClone(settings)
  nextSettings.model = nextSettings.model ?? {}
  nextSettings.model.name = normalized
  writeGeminiSettingsFile(settingsPath, nextSettings)
  return normalized
}

async function fetchGeminiModelsFromGoogle(options: {
  settingsPath: string
}): Promise<string[]> {
  const settings = readGeminiSettingsFile(options.settingsPath)
  const selectedType = settings.security?.auth?.selectedType ?? 'gemini-api-key'

  const baseUrl =
    settings.security?.auth?.geminiApi?.baseUrl ??
    'https://generativelanguage.googleapis.com'
  const apiRoot = normalizeGeminiApiRoot(baseUrl)
  const url = new URL(`${apiRoot.replace(/\/+$/, '')}/models`)

  const headers = new Headers()

  if (selectedType === 'gemini-cli-oauth') {
    const { accessToken } = await getValidGeminiCliAccessToken()
    headers.set('Authorization', `Bearer ${accessToken}`)
  } else {
    const apiKey = settings.security?.auth?.geminiApi?.apiKey ?? ''
    if (!apiKey.trim()) {
      throw new Error('未填写 Gemini API Key（请先用 /auth 选择“自提供 API Key”并填写）')
    }

    const rawMode = settings.security?.auth?.geminiApi?.apiKeyAuthMode
    const mode: 'x-goog-api-key' | 'query' | 'bearer' =
      rawMode === 'bearer' || rawMode === 'query' || rawMode === 'x-goog-api-key'
        ? rawMode
        : 'x-goog-api-key'

    if (mode === 'query') {
      url.searchParams.set('key', apiKey.trim())
    } else if (mode === 'bearer') {
      headers.set('Authorization', `Bearer ${apiKey.trim()}`)
    } else {
      headers.set('x-goog-api-key', apiKey.trim())
    }
  }

  const resp = await fetch(url, { headers })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`拉取模型列表失败 (HTTP ${resp.status})：${text.slice(0, 200)}`)
  }

  const json = (await resp.json()) as any
  const models = Array.isArray(json?.models) ? json.models : []
  const names = models
    .filter((m: any) => {
      const methods = Array.isArray(m?.supportedGenerationMethods)
        ? m.supportedGenerationMethods
        : []
      return methods.includes('generateContent')
    })
    .map((m: any) => String(m?.name ?? '').trim())
    .filter(Boolean)

  return names
}

function ModelCommandUI({
  args,
  onDone,
}: {
  args?: string
  onDone: (result?: string) => void
}): React.ReactNode {
  ensureGlobalGeminiSettings()
  const theme = getTheme()
  const trimmed = (args ?? '').trim()
  const didAutoRun = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [modelListLoading, setModelListLoading] = useState(false)
  const [modelListError, setModelListError] = useState<string | null>(null)
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null)

  const settingsPath = getGlobalGeminiSettingsPath()

  const currentModelName = useMemo(() => {
    const settings = readGeminiSettingsFile(settingsPath)
    return settings.model?.name ?? ''
  }, [settingsPath])

  useEffect(() => {
    if (trimmed) return
    let mounted = true
    setModelListLoading(true)
    setModelListError(null)

    void (async () => {
      try {
        const list = await fetchGeminiModelsFromGoogle({ settingsPath })
        if (!mounted) return
        setRemoteModels(list)
      } catch (e) {
        if (!mounted) return
        const msg = e instanceof Error ? e.message : String(e)
        setModelListError(msg)
        setRemoteModels(null)
      } finally {
        if (!mounted) return
        setModelListLoading(false)
      }
    })()

    return () => {
      mounted = false
    }
  }, [settingsPath, trimmed])

  const options = useMemo(() => {
    const sourceList = (() => {
      if (Array.isArray(remoteModels) && remoteModels.length > 0) {
        return remoteModels
      }
      const geminiList = (modelsCatalog as any)?.gemini ?? []
      const builtins: string[] = Array.isArray(geminiList)
        ? geminiList.map((m: any) => String(m?.model ?? '')).filter(Boolean)
        : []
      return builtins
    })()

    const normalizedBuiltins = sourceList
      .map(m => {
        try {
          return normalizeGeminiModelName(m)
        } catch {
          return ''
        }
      })
      .filter(Boolean)

    const unique = Array.from(new Set(normalizedBuiltins))
    const currentNormalized = (() => {
      try {
        return currentModelName ? normalizeGeminiModelName(currentModelName) : ''
      } catch {
      return currentModelName
    }
    })()
    if (currentNormalized && !unique.includes(currentNormalized)) {
      unique.unshift(currentNormalized)
    }

    return unique.map(v => {
      const labelBase = stripModelPrefix(v)
      const label = v === currentNormalized ? `${labelBase} (当前)` : labelBase
      return { label, value: v }
    })
  }, [currentModelName, remoteModels])

  useEffect(() => {
    if (!trimmed || didAutoRun.current) return
    didAutoRun.current = true

    try {
      if (trimmed === '--show-paths') {
        onDone(
          [`settings：${settingsPath}`].join('\n'),
        )
        return
      }

      const normalized = setModelName(settingsPath, trimmed)
      onDone(`已设置 model.name=${normalized}（写入：${settingsPath}）`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      onDone(`设置失败：${msg}`)
    }
  }, [settingsPath, onDone, trimmed])

  useInput((_input, key) => {
    if (key.escape && !trimmed) {
      onDone()
    }
  })

  if (trimmed) {
    return (
      <Box
        flexDirection="column"
        gap={1}
        padding={1}
        borderStyle="round"
        borderColor={theme.secondaryBorder}
      >
        <Text bold>Model</Text>
        <Text color={theme.secondaryText}>处理中…</Text>
        {error && <Text color={theme.error}>{error}</Text>}
      </Box>
    )
  }

  return (
    <>
      <Box
        flexDirection="column"
        gap={1}
        padding={1}
        borderStyle="round"
        borderColor={theme.secondaryBorder}
      >
        <Text bold>选择模型（Gemini）</Text>
        <Text color={theme.secondaryText}>
          当前：{currentModelName ? stripModelPrefix(currentModelName) : '(未设置)'}
        </Text>
        <Text color={theme.secondaryText}>写入：{settingsPath}</Text>
        {modelListLoading ? (
          <Box flexDirection="row" gap={1}>
            <SimpleSpinner />
            <Text color={theme.secondaryText}>正在拉取模型列表…</Text>
          </Box>
        ) : null}
        {modelListError ? (
          <Text color={theme.warning}>
            模型列表拉取失败，已回退到内置列表：{modelListError}
          </Text>
        ) : null}

        <Select
          options={options}
          defaultValue={(() => {
            try {
              return currentModelName
                ? normalizeGeminiModelName(currentModelName)
                : options[0]?.value
            } catch {
              return options[0]?.value
            }
          })()}
          onChange={value => {
            try {
              const normalized = setModelName(settingsPath, value)
              onDone(`已设置 model.name=${normalized}（写入：${settingsPath}）`)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              onDone(`设置失败：${msg}`)
            }
          }}
        />
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>Enter 确认 · Esc 退出 · 也可以用 /model &lt;name&gt; 自定义</Text>
      </Box>
    </>
  )
}

export async function call(
  onDone: (result?: string) => void,
  _context: any,
  args?: string,
): Promise<React.ReactNode> {
  return <ModelCommandUI args={args} onDone={onDone} />
}
