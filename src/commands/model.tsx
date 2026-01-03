import type { Command } from '@commands'
import { Box, Text, useInput } from 'ink'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getTheme } from '@utils/theme'
import {
  ensureGeminiSettings,
  getWorkspaceGeminiSettingsPath,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
} from '@utils/geminiSettings'
import { Select } from '@components/CustomSelect/select'
import modelsCatalog from '@constants/models'

export const help =
  '选择/设置 Gemini 模型（写入当前项目 ./.gemini/settings.json）；Enter 确认，Esc 退出'
export const description =
  '选择/设置 Gemini 模型（写入当前项目 ./.gemini/settings.json）'
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

function ModelCommandUI({
  args,
  onDone,
}: {
  args?: string
  onDone: (result?: string) => void
}): React.ReactNode {
  ensureGeminiSettings()
  const theme = getTheme()
  const trimmed = (args ?? '').trim()
  const didAutoRun = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const settingsPath = getWorkspaceGeminiSettingsPath()

  const currentModelName = useMemo(() => {
    const settings = readGeminiSettingsFile(settingsPath)
    return settings.model?.name ?? ''
  }, [settingsPath])

  const options = useMemo(() => {
    const geminiList = (modelsCatalog as any)?.gemini ?? []
    const builtins: string[] = Array.isArray(geminiList)
      ? geminiList.map((m: any) => String(m?.model ?? '')).filter(Boolean)
      : []

    const normalizedBuiltins = builtins
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
  }, [currentModelName])

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
