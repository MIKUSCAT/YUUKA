import React, { useMemo, useState } from 'react'
import { Box, Newline, Text, useInput } from 'ink'
import { useExitOnCtrlCD } from '@hooks/useExitOnCtrlCD'
import { getTheme } from '@utils/theme'
import {
  ModelPointerType,
  setAllPointersToModel,
  setModelPointer,
} from '@utils/config'
import { getModelManager } from '@utils/model'
import TextInput from './TextInput'
import {
  getGlobalGeminiSettingsPath,
  normalizeGeminiModelName,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
} from '@utils/geminiSettings'

type Props = {
  onDone: () => void
  abortController?: AbortController
  targetPointer?: ModelPointerType
  isOnboarding?: boolean
  onCancel?: () => void
  skipModelType?: boolean
}

type Screen = 'model' | 'name' | 'maxTokens' | 'contextLength' | 'confirm'

const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_CONTEXT_LENGTH = 128000

function stripModelPrefix(modelName: string): string {
  return modelName.replace(/^models\//, '').replace(/^tunedModels\//, 'tunedModels/')
}

function ensurePositiveInt(raw: string, fieldName: string): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} 必须是正整数`)
  }
  return value
}

function saveGeminiModelName(modelName: string): void {
  const settingsPath = getGlobalGeminiSettingsPath()
  const settings = readGeminiSettingsFile(settingsPath)
  const nextSettings = structuredClone(settings)
  nextSettings.model = nextSettings.model ?? {}
  nextSettings.model.name = modelName
  writeGeminiSettingsFile(settingsPath, nextSettings)
}

export function ModelSelector({
  onDone,
  targetPointer,
  isOnboarding = false,
  onCancel,
}: Props): React.ReactNode {
  const theme = getTheme()
  const exitState = useExitOnCtrlCD(() => process.exit(0))
  const settingsPath = getGlobalGeminiSettingsPath()
  const currentSettings = useMemo(
    () => readGeminiSettingsFile(settingsPath),
    [settingsPath],
  )

  const initialModelName = (() => {
    const current = currentSettings.model?.name ?? ''
    try {
      return normalizeGeminiModelName(current || 'models/gemini-3-flash-preview')
    } catch {
      return 'models/gemini-3-flash-preview'
    }
  })()

  const [screen, setScreen] = useState<Screen>('model')
  const [modelName, setModelName] = useState(initialModelName)
  const [profileName, setProfileName] = useState(`Gemini ${stripModelPrefix(initialModelName)}`)
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS))
  const [contextLength, setContextLength] = useState(String(DEFAULT_CONTEXT_LENGTH))
  const [modelCursorOffset, setModelCursorOffset] = useState(modelName.length)
  const [nameCursorOffset, setNameCursorOffset] = useState(profileName.length)
  const [maxTokensCursorOffset, setMaxTokensCursorOffset] = useState(maxTokens.length)
  const [contextCursorOffset, setContextCursorOffset] = useState(
    contextLength.length,
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const goBack = () => {
    setError(null)
    if (screen === 'model') {
      if (onCancel) {
        onCancel()
      } else {
        onDone()
      }
      return
    }
    if (screen === 'name') {
      setScreen('model')
      return
    }
    if (screen === 'maxTokens') {
      setScreen('name')
      return
    }
    if (screen === 'contextLength') {
      setScreen('maxTokens')
      return
    }
    setScreen('contextLength')
  }

  async function handleConfirm(): Promise<void> {
    setError(null)
    setSaving(true)

    try {
      const normalizedModelName = normalizeGeminiModelName(modelName.trim())
      const normalizedProfileName =
        profileName.trim() || `Gemini ${stripModelPrefix(normalizedModelName)}`
      const normalizedMaxTokens = ensurePositiveInt(maxTokens, 'maxTokens')
      const normalizedContextLength = ensurePositiveInt(
        contextLength,
        'contextLength',
      )

      const modelManager = getModelManager()
      const modelId = await modelManager.addModel({
        name: normalizedProfileName,
        provider: 'gemini',
        modelName: normalizedModelName,
        baseURL: '',
        apiKey: '',
        maxTokens: normalizedMaxTokens,
        contextLength: normalizedContextLength,
        reasoningEffort: 'medium',
      })

      saveGeminiModelName(normalizedModelName)
      setModelPointer('main', modelId)

      if (isOnboarding) {
        setAllPointersToModel(modelId)
      } else if (targetPointer && targetPointer !== 'main') {
        setModelPointer(targetPointer, modelId)
      }

      onDone()
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : '保存配置失败'
      setError(message)
      setSaving(false)
    }
  }

  const handleModelSubmit = (value: string) => {
    try {
      const normalized = normalizeGeminiModelName(value.trim())
      setModelName(normalized)
      if (!profileName.trim()) {
        setProfileName(`Gemini ${stripModelPrefix(normalized)}`)
        setNameCursorOffset(`Gemini ${stripModelPrefix(normalized)}`.length)
      }
      setError(null)
      setScreen('name')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '模型名不合法')
    }
  }

  const handleNameSubmit = (value: string) => {
    const nextName = value.trim() || `Gemini ${stripModelPrefix(modelName)}`
    setProfileName(nextName)
    setNameCursorOffset(nextName.length)
    setError(null)
    setScreen('maxTokens')
  }

  const handleMaxTokensSubmit = (value: string) => {
    try {
      const normalized = String(ensurePositiveInt(value, 'maxTokens'))
      setMaxTokens(normalized)
      setMaxTokensCursorOffset(normalized.length)
      setError(null)
      setScreen('contextLength')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'maxTokens 不合法')
    }
  }

  const handleContextLengthSubmit = (value: string) => {
    try {
      const normalized = String(ensurePositiveInt(value, 'contextLength'))
      setContextLength(normalized)
      setContextCursorOffset(normalized.length)
      setError(null)
      setScreen('confirm')
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'contextLength 不合法',
      )
    }
  }

  useInput((_, key) => {
    if (saving) return
    if (key.escape) {
      goBack()
      return
    }
    if (screen === 'confirm' && key.return) {
      void handleConfirm()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Box
        flexDirection="column"
        gap={1}
        borderStyle="round"
        borderColor={theme.secondaryBorder}
        paddingX={2}
        paddingY={1}
      >
        <Text bold>
          Gemini Model Setup{' '}
          {exitState.pending ? `(press ${exitState.keyName} again to exit)` : ''}
        </Text>
        <Text color={theme.secondaryText}>
          当前仅支持 Gemini。Esc 返回，Enter 提交当前项。
        </Text>
      </Box>

      <Box
        flexDirection="column"
        gap={1}
        borderStyle="round"
        borderColor={theme.secondaryBorder}
        paddingX={2}
        paddingY={1}
      >
        {screen === 'model' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>1) 输入 Gemini 模型名</Text>
            <Text color={theme.secondaryText}>
              示例：`models/gemini-3-flash-preview`
            </Text>
            <TextInput
              value={modelName}
              onChange={value => {
                setModelName(value)
                setModelCursorOffset(value.length)
              }}
              onSubmit={handleModelSubmit}
              cursorOffset={modelCursorOffset}
              onChangeCursorOffset={setModelCursorOffset}
              columns={90}
              showCursor={true}
            />
          </Box>
        )}

        {screen === 'name' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>2) 输入配置名称</Text>
            <Text color={theme.secondaryText}>
              这是你在模型列表里看到的名称。
            </Text>
            <TextInput
              value={profileName}
              onChange={value => {
                setProfileName(value)
                setNameCursorOffset(value.length)
              }}
              onSubmit={handleNameSubmit}
              cursorOffset={nameCursorOffset}
              onChangeCursorOffset={setNameCursorOffset}
              columns={90}
              showCursor={true}
            />
          </Box>
        )}

        {screen === 'maxTokens' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>3) 设置 maxTokens</Text>
            <Text color={theme.secondaryText}>默认：{DEFAULT_MAX_TOKENS}</Text>
            <TextInput
              value={maxTokens}
              onChange={value => {
                setMaxTokens(value.replace(/[^\d]/g, ''))
                setMaxTokensCursorOffset(value.replace(/[^\d]/g, '').length)
              }}
              onSubmit={handleMaxTokensSubmit}
              cursorOffset={maxTokensCursorOffset}
              onChangeCursorOffset={setMaxTokensCursorOffset}
              columns={32}
              showCursor={true}
            />
          </Box>
        )}

        {screen === 'contextLength' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>4) 设置 contextLength</Text>
            <Text color={theme.secondaryText}>默认：{DEFAULT_CONTEXT_LENGTH}</Text>
            <TextInput
              value={contextLength}
              onChange={value => {
                setContextLength(value.replace(/[^\d]/g, ''))
                setContextCursorOffset(value.replace(/[^\d]/g, '').length)
              }}
              onSubmit={handleContextLengthSubmit}
              cursorOffset={contextCursorOffset}
              onChangeCursorOffset={setContextCursorOffset}
              columns={32}
              showCursor={true}
            />
          </Box>
        )}

        {screen === 'confirm' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>5) 确认保存</Text>
            <Text>Profile: {profileName.trim() || '(auto)'}</Text>
            <Text>Model: {modelName}</Text>
            <Text>maxTokens: {maxTokens}</Text>
            <Text>contextLength: {contextLength}</Text>
            <Text color={theme.secondaryText}>
              保存后会把 `main` 指针切到该模型，并把 Gemini settings 的 `model.name`
              更新为同一值。
            </Text>
            <Text>
              <Text color={theme.suggestion}>
                [{saving ? 'Saving...' : 'Press Enter to Save'}]
              </Text>
              <Newline />
              <Text color={theme.secondaryText}>按 Esc 返回上一步修改。</Text>
            </Text>
          </Box>
        )}

        {error && (
          <Box>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
