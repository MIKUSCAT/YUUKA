import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '@utils/theme'
import { MAX_RENDERED_LINES } from './prompt'
import chalk from 'chalk'
import { TREE_END } from '@constants/figures'

const MAX_CHARS_PER_LINE = 400
const BASE64_MIN_LENGTH = 1000

function shortenLongLine(line: string): string {
  // data:...;base64,... (very common in logs)
  const dataUrlRegex = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]{200,})/g
  let sanitized = line.replace(dataUrlRegex, (_m, mimeType: string, data: string) => {
    if (data.length < BASE64_MIN_LENGTH) return _m
    return `data:${mimeType};base64,[omitted ${data.length} chars]`
  })

  // raw base64 blobs inside JSON / logs
  const base64Regex = /[A-Za-z0-9+/]{1000,}={0,2}/g
  sanitized = sanitized.replace(base64Regex, (m: string) => {
    if (m.length < BASE64_MIN_LENGTH) return m
    return `[base64 omitted ${m.length} chars]`
  })

  if (sanitized.length <= MAX_CHARS_PER_LINE) return sanitized
  const head = sanitized.slice(0, 240)
  const tail = sanitized.slice(-120)
  const removed = sanitized.length - head.length - tail.length
  return `${head}…[${removed} chars omitted]…${tail}`
}

function renderTruncatedContent(content: string, totalLines: number): string {
  const allLines = content.split('\n')
  if (allLines.length <= MAX_RENDERED_LINES) {
    return allLines.map(shortenLongLine).join('\n')
  }

  // Show last 5 lines of output by default (matching reference implementation)
  const lastLines = allLines.slice(-MAX_RENDERED_LINES)
  return [
    chalk.grey(
      `Showing last ${MAX_RENDERED_LINES} lines of ${totalLines} total lines`,
    ),
    ...lastLines.map(shortenLongLine),
  ].join('\n')
}

export function OutputLine({
  content,
  lines,
  verbose,
  isError,
}: {
  content: string
  lines: number
  verbose: boolean
  isError?: boolean
  key?: React.Key
}) {
  const theme = getTheme()
  return (
    <Box justifyContent="space-between" width="100%">
      <Box flexDirection="row">
        <Text color={theme.secondaryText}>{TREE_END} </Text>
        <Box flexDirection="column">
          <Text color={isError ? theme.error : undefined}>
            {verbose
              ? content.trim()
              : renderTruncatedContent(content.trim(), lines)}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
