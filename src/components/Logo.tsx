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

export function Logo(): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()

  // 计算左侧 padding 使 Logo 居中
  const paddingLeft = Math.max(0, Math.floor((columns - LOGO_WIDTH) / 2))

  return (
    <Box flexDirection="column" marginY={1} alignItems="center" width="100%">
      <Box flexDirection="column">
        <Text color={theme.secondaryText}>{'✧ ˚  ✦'.padStart(Math.floor(LOGO_WIDTH / 2) + 3)}</Text>
        {YUUKA_LOGO_LINES.map((line, i) => (
          <Text key={i} color={theme.kode} bold>{line}</Text>
        ))}
      </Box>
    </Box>
  )
}
