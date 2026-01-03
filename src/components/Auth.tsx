import { Box, Text, useInput } from 'ink'
import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { getTheme } from '@utils/theme'
import {
  ensureGeminiSettings,
  getWorkspaceGeminiSettingsPath,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
} from '@utils/geminiSettings'

type Props = {
  onClose: () => void
}

type FieldId = 'baseUrl' | 'apiKey'

export function Auth({ onClose }: Props): React.ReactNode {
  ensureGeminiSettings()
  const settingsPath = getWorkspaceGeminiSettingsPath()
  const [settings, setSettings] = useState(() =>
    readGeminiSettingsFile(settingsPath),
  )

  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editing, setEditing] = useState(false)
  const [currentInput, setCurrentInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const theme = getTheme()

  const baseUrl =
    settings.security?.auth?.geminiApi?.baseUrl ??
    'https://generativelanguage.googleapis.com'
  const apiKey = settings.security?.auth?.geminiApi?.apiKey ?? ''
  const apiKeyDisplay = apiKey.trim()
    ? `...${apiKey.trim().slice(-6)}`
    : '(not set)'

  const fields = useMemo(
    () =>
      [
        {
          id: 'baseUrl' as const,
          label: 'Gemini Base URL',
          value: baseUrl,
          displayValue: baseUrl,
        },
        {
          id: 'apiKey' as const,
          label: 'Gemini API Key',
          value: apiKey,
          displayValue: apiKeyDisplay,
        },
      ] as const,
    [apiKey, apiKeyDisplay, baseUrl],
  )

  function writeSettings(next: any) {
    writeGeminiSettingsFile(settingsPath, next)
    setSettings(next)
  }

  function updateField(fieldId: FieldId, value: string) {
    const next = structuredClone(settings) as any
    next.security = next.security ?? {}
    next.security.auth = next.security.auth ?? {}
    next.security.auth.selectedType = 'gemini-api-key'
    next.security.auth.geminiApi = next.security.auth.geminiApi ?? {}
    next.security.auth.geminiApi.apiKeyAuthMode = 'bearer'

    if (fieldId === 'baseUrl') {
      const trimmed = value.trim()
      if (!trimmed) {
        throw new Error('Base URL 不能为空')
      }
      next.security.auth.geminiApi.baseUrl = trimmed
      writeSettings(next)
      return
    }

    if (fieldId === 'apiKey') {
      const trimmed = value.trim()
      if (!trimmed) {
        // 空输入 = 不改（避免误删）
        return
      }
      next.security.auth.geminiApi.apiKey = trimmed
      writeSettings(next)
      return
    }
  }

  useInput((input, key) => {
    if (editing) {
      if (key.return) {
        const currentField = fields[selectedIndex]
        if (!currentField) return
        try {
          updateField(currentField.id, currentInput)
          setEditing(false)
          setCurrentInput('')
          setInputError(null)
        } catch (error) {
          setInputError(error instanceof Error ? error.message : '输入不合法')
        }
        return
      }
      if (key.escape) {
        setEditing(false)
        setCurrentInput('')
        setInputError(null)
        return
      }
      if (key.backspace || key.delete) {
        setCurrentInput(prev => prev.slice(0, -1))
        return
      }
      if (input) {
        setCurrentInput(prev => prev + input)
      }
      return
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(fields.length - 1, prev + 1))
      return
    }
    if (key.return) {
      const currentField = fields[selectedIndex]
      if (!currentField) return

      // API Key 不回显，避免把完整 key 打到屏幕上
      if (currentField.id === 'apiKey') {
        setCurrentInput('')
      } else {
        setCurrentInput(currentField.value)
      }

      setEditing(true)
      setInputError(null)
      return
    }
    if (key.escape) {
      onClose()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.secondaryBorder}
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        <Text bold>Auth（Gemini）</Text>
        <Text color={theme.secondaryText}>写入：{settingsPath}</Text>

        <Box flexDirection="column" marginTop={1}>
          {fields.map((field, index) => {
            const isSelected = index === selectedIndex
            return (
              <Box key={field.id} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isSelected ? theme.success : theme.text}>
                    {isSelected ? figures.pointer : ' '} {field.label}
                  </Text>
                  <Text color={theme.suggestion}>{field.displayValue}</Text>
                </Box>
                {isSelected && editing && (
                  <Box flexDirection="column" marginLeft={2}>
                    <Text color={theme.suggestion}>
                      输入新值：{currentInput}
                    </Text>
                    {inputError && <Text color={theme.error}>{inputError}</Text>}
                    {field.id === 'apiKey' && (
                      <Text color={theme.secondaryText}>
                        提示：留空=不修改（避免误删）
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {editing ? 'Enter 保存 · Esc 取消' : '↑/↓ 选择 · Enter 编辑 · Esc 退出'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
