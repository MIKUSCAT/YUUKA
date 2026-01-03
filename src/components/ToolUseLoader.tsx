import { Box, Text } from 'ink'
import React from 'react'
import { useInterval } from '@hooks/useInterval'
import { getTheme } from '@utils/theme'
import { ASSISTANT_PREFIX, SPINNER_FRAMES } from '@constants/figures'

type Props = {
  isError: boolean
  isUnresolved: boolean
  shouldAnimate: boolean
}

export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
}: Props): React.ReactNode {
  const [frame, setFrame] = React.useState(0)

  useInterval(() => {
    if (!shouldAnimate) {
      return
    }
    setFrame(_ => (_ + 1) % SPINNER_FRAMES.length)
  }, 120)

  const color = isUnresolved
    ? getTheme().kode
    : isError
      ? getTheme().error
      : getTheme().success

  return (
    <Box minWidth={2}>
      <Text color={color}>
        {shouldAnimate ? SPINNER_FRAMES[frame] : ASSISTANT_PREFIX}
      </Text>
    </Box>
  )
}
