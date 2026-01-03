import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'

export const MIN_LOGO_WIDTH = 50

// 大号YUUKA ASCII艺术
const YUUKA_LOGO = `██    ██ ██    ██ ██    ██ ██   ██  █████
 ██  ██  ██    ██ ██    ██ ██  ██  ██   ██
  ████   ██    ██ ██    ██ █████   ███████
   ██    ██    ██ ██    ██ ██  ██  ██   ██
   ██     ██████   ██████  ██   ██ ██   ██`

export function Logo(): React.ReactNode {
  const theme = getTheme()

  return (
    <Box flexDirection="column" width="100%" alignItems="center" marginY={1}>
      {/* 星星点缀 + 大字YUUKA */}
      <Box flexDirection="column" alignItems="center">
        <Text>
          <Text color={theme.secondaryText}>✧ ˚</Text>
        </Text>
        <Text>
          <Text color={theme.secondaryText}> ✦  </Text>
          <Text color={theme.kode} bold>{YUUKA_LOGO.split('\n')[0]}</Text>
        </Text>
        {YUUKA_LOGO.split('\n').slice(1).map((line, i) => (
          <React.Fragment key={i}>
            <Text>
              <Text>    </Text>
              <Text color={theme.kode} bold>{line}</Text>
            </Text>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  )
}
