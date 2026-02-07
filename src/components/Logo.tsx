import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'
import { useTerminalSize } from '@hooks/useTerminalSize'
import stringWidth from 'string-width'

export const MIN_LOGO_WIDTH = 50

// 大号YUUKA ASCII艺术
const YUUKA_LOGO_LINES = [
  '██    ██ ██    ██ ██    ██ ██   ██  █████',
  ' ██  ██  ██    ██ ██    ██ ██  ██  ██   ██',
  '  ████   ██    ██ ██    ██ █████   ███████',
  '   ██    ██    ██ ██    ██ ██  ██  ██   ██',
  '   ██     ██████   ██████  ██   ██ ██   ██',
]

// 计算 Logo 最大显示宽度
const LOGO_WIDTH = Math.max(...YUUKA_LOGO_LINES.map(line => stringWidth(line)))
const LOGO_RIGHT_SHIFT = 11

function getLogoLeftPadding(columns: number, shift = 0): number {
  return Math.max(0, Math.floor((columns - LOGO_WIDTH) / 2) + shift)
}

function alignToLogoLeft(
  line: string,
  columns: number,
  shift = 0,
): string {
  const leftPadding = Math.max(0, getLogoLeftPadding(columns, shift))
  return `${' '.repeat(leftPadding)}${line}`
}

export function Logo(): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()

  // Onboarding 会复用 MIN_LOGO_WIDTH，保持不变；启动界面实际居中按终端宽度计算
  const centeredLogoWidth = Math.max(MIN_LOGO_WIDTH, LOGO_WIDTH)
  const renderColumns = Math.max(columns, centeredLogoWidth)

  return (
    <Box flexDirection="column" marginY={1} width="100%">
      <Box flexDirection="column">
        {YUUKA_LOGO_LINES.map((line, i) => (
          <React.Fragment key={i}>
            <Text color={theme.yuuka} bold>
              {alignToLogoLeft(line, renderColumns, LOGO_RIGHT_SHIFT)}
            </Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  )
}
