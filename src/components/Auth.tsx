import { Box, Text, useInput } from 'ink'
import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getTheme } from '@utils/theme'
import { Select } from '@components/CustomSelect/select'
import {
  clearGeminiCliOAuthCreds,
  getGlobalGeminiOauthCredsPath,
  loginWithGoogleForGeminiCli,
  readGeminiCliOAuthCreds,
  type GeminiCliOAuthCreds,
} from '@services/gemini/codeAssistAuth'
import {
  ensureGlobalGeminiSettings,
  getGlobalGeminiSettingsPath,
  readGeminiSettingsFile,
  writeGeminiSettingsFile,
} from '@utils/geminiSettings'

type Props = {
  onClose: () => void
}

type FieldId = 'baseUrl' | 'apiKey'
type AuthMode = 'gemini-api-key' | 'gemini-cli-oauth'
type Screen = 'choose-mode' | 'api-key' | 'google-oauth'

export function Auth({ onClose }: Props): React.ReactNode {
  ensureGlobalGeminiSettings()
  const settingsPath = getGlobalGeminiSettingsPath()
  const [settings, setSettings] = useState(() =>
    readGeminiSettingsFile(settingsPath),
  )

  const selectedType =
    (settings.security?.auth?.selectedType as AuthMode | undefined) ??
    'gemini-api-key'
  const [modeFocus, setModeFocus] = useState<AuthMode>(selectedType)

  const [screen, setScreen] = useState<Screen>('choose-mode')

  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editing, setEditing] = useState(false)
  const [currentInput, setCurrentInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)

  const oauthCredsPath = getGlobalGeminiOauthCredsPath()
  const [oauthCreds, setOauthCreds] = useState<GeminiCliOAuthCreds | null>(
    null,
  )
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthStatus, setOauthStatus] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void (async () => {
      const creds = await readGeminiCliOAuthCreds()
      if (mounted) setOauthCreds(creds)
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    setModeFocus(selectedType)
  }, [selectedType])

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
    next.security.auth.geminiApi.apiKeyAuthMode = 'x-goog-api-key'

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

  function setSelectedType(selectedType: AuthMode) {
    const next = structuredClone(settings) as any
    next.security = next.security ?? {}
    next.security.auth = next.security.auth ?? {}
    next.security.auth.selectedType = selectedType
    writeSettings(next)
  }

  function enterMode(mode: AuthMode) {
    setSelectedType(mode)
    setEditing(false)
    setCurrentInput('')
    setInputError(null)
    setOauthError(null)
    setOauthStatus(null)
    setOauthAuthUrl(null)
    setScreen(mode === 'gemini-cli-oauth' ? 'google-oauth' : 'api-key')
  }

  function refreshOauthCreds() {
    void (async () => {
      const creds = await readGeminiCliOAuthCreds()
      setOauthCreds(creds)
    })()
  }

  function startGoogleLogin() {
    if (oauthBusy) return
    setOauthBusy(true)
    setOauthAuthUrl(null)
    setOauthError(null)
    setOauthStatus('正在打开浏览器并等待回调…')

    void (async () => {
      try {
        const { email, projectId } = await loginWithGoogleForGeminiCli({
          onAuthUrl(url) {
            setOauthAuthUrl(url)
          },
        })
        refreshOauthCreds()
        setSelectedType('gemini-cli-oauth')
        setOauthStatus(
          `登录成功${email ? `：${email}` : ''}${projectId ? '（project_id 已获取）' : ''}`,
        )
      } catch (e) {
        setOauthError(e instanceof Error ? e.message : String(e))
        setOauthStatus(null)
      } finally {
        setOauthBusy(false)
      }
    })()
  }

  function logoutGoogle() {
    if (oauthBusy) return
    setOauthBusy(true)
    setOauthError(null)
    setOauthStatus('正在退出登录…')
    void (async () => {
      try {
        await clearGeminiCliOAuthCreds()
        setOauthCreds(null)
        setSelectedType('gemini-api-key')
        setOauthStatus('已退出登录（已删除 oauth_creds.json）')
        setScreen('choose-mode')
      } catch (e) {
        setOauthError(e instanceof Error ? e.message : String(e))
        setOauthStatus(null)
      } finally {
        setOauthBusy(false)
      }
    })()
  }

  useInput((input, key) => {
    if (screen === 'choose-mode') {
      if (key.return) {
        enterMode(modeFocus)
        return
      }
      if (key.escape) onClose()
      return
    }

    if (screen === 'google-oauth') {
      const lower = input?.toLowerCase?.() ?? ''
      if (lower === 'g') {
        startGoogleLogin()
        return
      }
      if (lower === 'l') {
        logoutGoogle()
        return
      }
      if (key.escape) {
        setScreen('choose-mode')
      }
      return
    }

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

    const lower = input?.toLowerCase?.() ?? ''

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
      setScreen('choose-mode')
    }
  })

  if (screen === 'choose-mode') {
    const apiOk = !!apiKey.trim()
    const oauthOk = !!oauthCreds?.refresh_token
    const modeOptions = [
      { label: 'Google 官方登录（Gemini CLI OAuth）', value: 'gemini-cli-oauth' },
      { label: '自提供 API URL + API Key（Gemini 原生格式）', value: 'gemini-api-key' },
    ] as const

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
          <Text color={theme.secondaryText}>
            先选一种登录方式（两者只能激活一种；切换不会删除另一边的数据）
          </Text>

          <Box flexDirection="column" marginTop={1} gap={1}>
            <Box flexDirection="column">
              <Text color={theme.text}>选择登录方式：</Text>
              <Select
                options={[...modeOptions]}
                defaultValue={selectedType}
                onFocus={value => setModeFocus(value as AuthMode)}
                onChange={value => setModeFocus(value as AuthMode)}
              />
            </Box>

            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.secondaryText}>
                当前状态（仅展示，不代表已启用）：
              </Text>
              <Text color={theme.secondaryText}>
                · API Key：{' '}
                <Text color={apiOk ? theme.success : theme.warning}>
                  {apiOk ? apiKeyDisplay : '未填写'}
                </Text>
              </Text>
              <Text color={theme.secondaryText}>
                · Google：{' '}
                <Text color={oauthOk ? theme.success : theme.warning}>
                  {oauthOk ? '已登录' : '未登录'}
                </Text>
                {oauthCreds?.user_email ? (
                  <Text color={theme.suggestion}>
                    {`（${oauthCreds.user_email}）`}
                  </Text>
                ) : null}
              </Text>
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 进入 · Esc 退出</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  if (screen === 'api-key') {
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
          <Text bold>Auth（自提供 Gemini API）</Text>
          <Text color={theme.secondaryText}>写入：{settingsPath}</Text>
          <Text color={theme.secondaryText}>
            已激活：<Text color={theme.success}>gemini-api-key</Text>（此模式不会使用 Google OAuth）
          </Text>
          <Text color={theme.secondaryText}>
            你需要填写：API URL（Gemini 接口根地址）+ API Key；/model 会按这个 URL 拉取模型列表
          </Text>

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
              {editing
                ? 'Enter 保存 · Esc 取消'
                : '↑/↓ 选择 · Enter 编辑 · Esc 返回选择'}
            </Text>
          </Box>
        </Box>
      </Box>
    )
  }

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
        <Text bold>Auth（Google 官方登录 / Gemini CLI）</Text>
        <Text color={theme.secondaryText}>写入：{oauthCredsPath}</Text>
        <Text color={theme.secondaryText}>
          已激活：<Text color={theme.success}>gemini-cli-oauth</Text>（此模式不会使用 API Key）
        </Text>

        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text}>
            状态：
            <Text
              color={oauthCreds?.refresh_token ? theme.success : theme.warning}
            >
              {' '}
              {oauthCreds?.refresh_token ? '已登录' : '未登录'}
            </Text>
            {oauthCreds?.user_email ? (
              <Text color={theme.suggestion}>
                {`（${oauthCreds.user_email}）`}
              </Text>
            ) : null}
          </Text>
          <Text color={theme.secondaryText}>
            project_id: {oauthCreds?.project_id ?? '(not set)'}
          </Text>
        </Box>

        {oauthAuthUrl ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.suggestion}>
              如果没自动打开浏览器，手动打开这个链接：
            </Text>
            <Text color={theme.secondaryText}>{oauthAuthUrl}</Text>
          </Box>
        ) : null}

        {oauthStatus ? <Text color={theme.suggestion}>{oauthStatus}</Text> : null}
        {oauthError ? <Text color={theme.error}>{oauthError}</Text> : null}

        <Box marginTop={1}>
          <Text dimColor>
            快捷键：G 开始登录 · L 退出登录 · Esc 返回选择
            {oauthBusy ? '（进行中…）' : ''}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
