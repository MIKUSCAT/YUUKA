import React, { useState } from 'react'
import { PRODUCT_NAME } from '@constants/product'
import { Box, Newline, Text, useInput } from 'ink'
import {
  getGlobalConfig,
  saveGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
} from '@utils/config'
import { OrderedList } from '@inkjs/ui'
import { useExitOnCtrlCD } from '@hooks/useExitOnCtrlCD'
import { Select } from './CustomSelect/select'
import { StructuredDiff } from './StructuredDiff'
import { getTheme, type ThemeNames } from '@utils/theme'
import { clearTerminal } from '@utils/terminal'
import { PressEnterToContinue } from './PressEnterToContinue'
type StepId = 'theme' | 'usage' | 'gemini'

interface OnboardingStep {
  id: StepId
  component: React.ReactNode
}

type Props = {
  onDone(): void
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const config = getGlobalConfig()

  const [selectedTheme, setSelectedTheme] = useState(
    DEFAULT_GLOBAL_CONFIG.theme,
  )
  const theme = getTheme()
  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1
      setCurrentStepIndex(nextIndex)
    }
  }

  function handleThemeSelection(newTheme: string) {
    saveGlobalConfig({
      ...config,
      theme: newTheme as ThemeNames,
    })
    goToNextStep()
  }

  function handleThemePreview(newTheme: string) {
    setSelectedTheme(newTheme as ThemeNames)
  }

  const exitState = useExitOnCtrlCD(() => process.exit(0))

  useInput(async (_, key) => {
    const currentStep = steps[currentStepIndex]
    if (!key.return || !currentStep) return
    if (currentStep.id === 'theme') return

    if (currentStepIndex === steps.length - 1) {
      onDone()
      return
    }

    // HACK: for some reason there's now a jump here otherwise :(
    await clearTerminal()
    goToNextStep()
  })

  // Define all onboarding steps
  const themeStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text>Let&apos;s get started.</Text>
      <Box flexDirection="column">
        <Text bold>Choose the option that looks best when you select it:</Text>
        <Text dimColor>To change this later, run /config</Text>
      </Box>
      <Select
        options={[
          { label: 'Light text', value: 'dark' },
          { label: 'Dark text', value: 'light' },
          {
            label: 'Light text (colorblind-friendly)',
            value: 'dark-daltonized',
          },
          {
            label: 'Dark text (colorblind-friendly)',
            value: 'light-daltonized',
          },
        ]}
        onFocus={handleThemePreview}
        onChange={handleThemeSelection}
      />
      <Box flexDirection="column">
        <Box
          paddingLeft={1}
          marginRight={1}
          borderStyle="round"
          borderColor="gray"
          flexDirection="column"
        >
          <StructuredDiff
            patch={{
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 3,
              lines: [
                'function greet() {',
                '-  console.log("Hello, World!");',
                '+  console.log("Hello, anon!");',
                '}',
              ],
            }}
            dim={false}
            width={40}
            overrideTheme={selectedTheme}
          />
        </Box>
      </Box>
    </Box>
  )

  const usageStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Using {PRODUCT_NAME} effectively:</Text>
      <Box flexDirection="column" width={70}>
        <OrderedList children={[]}>
          <OrderedList.Item children={[]}>
            <Text>
              Start in your project directory
              <Newline />
              <Text color={theme.secondaryText}>
                Files are automatically added to context when needed.
              </Text>
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item children={[]}>
            <Text>
              Use {PRODUCT_NAME} as a development partner
              <Newline />
              <Text color={theme.secondaryText}>
                Get help with file analysis, editing, bash commands,
                <Newline />
                and git history.
                <Newline />
              </Text>
            </Text>
          </OrderedList.Item>
          <OrderedList.Item children={[]}>
            <Text>
              Provide clear context
              <Newline />
              <Text color={theme.secondaryText}>
                Be as specific as you would with another engineer. <Newline />
                The better the context, the better the results. <Newline />
              </Text>
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  )

  const geminiStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>配置 Gemini：</Text>
      <Box flexDirection="column" width={70}>
        <Text>
          <Text color={theme.secondaryText}>
            现在只支持 Gemini 原生 API（Bearer + 可配 baseUrl）。
            <Newline />
            配置只放在全局 ~/.yuuka/settings.json。
          </Text>
        </Text>
        <Box marginTop={1}>
          <Text>
            你需要做两步：
            <Newline />
            1) 在 ~/.yuuka/settings.json 填写 security.auth.geminiApi.apiKey
            <Newline />
            2) 运行 /model &lt;name&gt; 设置 model.name（写入全局 settings）
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text>
            另外：如果你要读 PDF/DOCX/XLSX/PPTX 等文档，建议先配置 MCP：
            <Newline />
            <Text color={theme.secondaryText}>
              yuuka mcp add office-reader npx -y yuuka-mcp-office-reader
            </Text>
          </Text>
        </Box>
      </Box>
      <PressEnterToContinue />
    </Box>
  )

  const steps: OnboardingStep[] = []
  steps.push({ id: 'theme', component: themeStep })
  steps.push({ id: 'usage', component: usageStep })
  steps.push({ id: 'gemini', component: geminiStep })

  return (
    <Box flexDirection="column" gap={1}>
      <>
        <Box flexDirection="column" gap={1}>
          <Text bold>
            {PRODUCT_NAME}{' '}
            {exitState.pending
              ? `(press ${exitState.keyName} again to exit)`
              : ''}
          </Text>
          {steps[currentStepIndex]?.component}
        </Box>
      </>
    </Box>
  )
}
