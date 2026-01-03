import * as React from 'react'
import { OrderedList } from '@inkjs/ui'
import { Box, Text } from 'ink'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '@utils/config'
import { homedir } from 'os'
import { getTheme } from '@utils/theme'
import { PRODUCT_COMMAND, PRODUCT_NAME } from '@constants/product'

// Function to mark onboarding as complete
export function markProjectOnboardingComplete(): void {
  const projectConfig = getCurrentProjectConfig()
  if (!projectConfig.hasCompletedProjectOnboarding) {
    saveCurrentProjectConfig({
      ...projectConfig,
      hasCompletedProjectOnboarding: true,
    })
  }
}

type Props = {
  workspaceDir: string
}

export default function ProjectOnboarding({
  workspaceDir,
}: Props): React.ReactNode {
  // Check if project onboarding has already been completed
  const projectConfig = getCurrentProjectConfig()
  const showOnboarding = !projectConfig.hasCompletedProjectOnboarding

  if (!showOnboarding) {
    return null
  }

  const theme = getTheme()

  return (
    <Box flexDirection="column" gap={1} padding={1} paddingBottom={0}>
      <Text color={theme.secondaryText}>快速开始：</Text>
      {/* @ts-expect-error - OrderedList children prop issue */}
      <OrderedList>
        {/* @ts-expect-error - OrderedList.Item children prop issue */}
        <OrderedList.Item>
          <Text color={theme.secondaryText}>
            先用 <Text color={theme.text}>/auth</Text> 配好 baseUrl 和 API Key
          </Text>
        </OrderedList.Item>
        {/* @ts-expect-error - OrderedList.Item children prop issue */}
        <OrderedList.Item>
          <Text color={theme.secondaryText}>
            用 <Text color={theme.text}>/model</Text> 选/添加常用模型
          </Text>
        </OrderedList.Item>
        {/* @ts-expect-error - OrderedList.Item children prop issue */}
        <OrderedList.Item>
          <Text color={theme.secondaryText}>
            用 <Text color={theme.text}>/agents</Text> 管理你的个人子代理
          </Text>
        </OrderedList.Item>
        {/* @ts-expect-error - OrderedList.Item children prop issue */}
        <OrderedList.Item>
          <Text color={theme.secondaryText}>
            用 <Text color={theme.text}>/mcp</Text> 查看 MCP 连接状态
          </Text>
        </OrderedList.Item>
        {/* @ts-expect-error - OrderedList.Item children prop issue */}
        <OrderedList.Item>
          <Text color={theme.secondaryText}>
            <Text color={theme.text}>/clear</Text> 清空对话，<Text color={theme.text}>/compact</Text> 压缩上下文，<Text color={theme.text}>/resume</Text> 恢复会话
          </Text>
        </OrderedList.Item>
      </OrderedList>

      {workspaceDir === homedir() && (
        <Text color={getTheme().warning}>
          提醒：你现在是在 home 目录启动的。建议在一个单独的工作目录里运行（例如 `~/workspace`），免得误操作。
        </Text>
      )}

      <Text color={theme.secondaryText}>
        终端里随时可用 <Text color={theme.text}>{PRODUCT_COMMAND} -h</Text> 看 CLI 参数
      </Text>
    </Box>
  )
}
