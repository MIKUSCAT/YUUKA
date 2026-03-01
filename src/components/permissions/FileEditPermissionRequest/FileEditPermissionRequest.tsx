import { Select } from '@components/CustomSelect/select'
import chalk from 'chalk'
import { Box, Text } from 'ink'
import { basename, extname, relative } from 'path'
import React, { useMemo } from 'react'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '@hooks/usePermissionRequestLogging'
import { saveSessionPermission } from '@permissions'
import { env } from '@utils/env'
import { getTheme } from '@utils/theme'
import { logUnaryEvent } from '@utils/unaryLogging'
import {
  type ToolUseConfirm,
} from '@components/permissions/PermissionRequest'
import { getCwd } from '@utils/state'

function getOptions() {
  return [
    {
      label: 'Yes',
      value: 'yes',
    },
    {
      label: 'Yes, allow this tool this session',
      value: 'yes-allow-session',
    },
    {
      label: `No, and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
      value: 'no',
    },
  ]
}

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

export function FileEditPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const { file_path, new_string, old_string } = toolUseConfirm.input as {
    file_path: string
    new_string: string
    old_string: string
  }
  const displayPath = verbose ? file_path : relative(getCwd(), file_path)
  const oldLineCount = countLines(old_string)
  const newLineCount = countLines(new_string)
  const lineDelta = newLineCount - oldLineCount
  const deltaLabel =
    lineDelta === 0
      ? 'line count unchanged'
      : lineDelta > 0
        ? `+${lineDelta} lines`
        : `${lineDelta} lines`

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'str_replace_single',
      language_name: extractLanguageName(file_path),
    }),
    [file_path],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Edit Request</Text>
        <Text>
          Target: <Text bold>{basename(file_path)}</Text>
        </Text>
        <Text dimColor>{displayPath}</Text>
        <Text dimColor>
          Change summary: {oldLineCount} to {newLineCount} lines ({deltaLabel})
        </Text>
        <Text dimColor>
          Confirm this operation: Yes / No / Allow this session.
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text>
          Confirm edit for{' '}
          <Text bold>{basename(file_path)}</Text>?
        </Text>
        <Select
          options={getOptions()}
          onChange={newValue => {
            switch (newValue) {
              case 'yes':
                extractLanguageName(file_path).then(language => {
                  logUnaryEvent({
                    completion_type: 'str_replace_single',
                    event: 'accept',
                    metadata: {
                      language_name: language,
                      message_id: toolUseConfirm.assistantMessage.message.id,
                      platform: env.platform,
                    },
                  })
                })
                // Note: We call onDone before onAllow to hide the
                // permission request before we render the next message
                onDone()
                toolUseConfirm.onAllow('temporary')
                break
              case 'yes-allow-session':
                extractLanguageName(file_path).then(language => {
                  logUnaryEvent({
                    completion_type: 'str_replace_single',
                    event: 'accept',
                    metadata: {
                      language_name: language,
                      message_id: toolUseConfirm.assistantMessage.message.id,
                      platform: env.platform,
                    },
                  })
                })
                onDone()
                saveSessionPermission(
                  toolUseConfirm.tool,
                  toolUseConfirm.input,
                  null,
                )
                  .then(() => {
                    toolUseConfirm.onAllow('session')
                  })
                  .catch(() => {
                    toolUseConfirm.onAllow('temporary')
                  })
                break
              case 'no':
                extractLanguageName(file_path).then(language => {
                  logUnaryEvent({
                    completion_type: 'str_replace_single',
                    event: 'reject',
                    metadata: {
                      language_name: language,
                      message_id: toolUseConfirm.assistantMessage.message.id,
                      platform: env.platform,
                    },
                  })
                })
                // Note: We call onDone before onAllow to hide the
                // permission request before we render the next message
                onDone()
                toolUseConfirm.onReject()
                break
            }
          }}
        />
      </Box>
    </Box>
  )
}

function countLines(value: string): number {
  if (!value) return 0
  return value.split('\n').length
}

async function extractLanguageName(file_path: string): Promise<string> {
  const ext = extname(file_path)
  if (!ext) {
    return 'unknown'
  }
  const Highlight = (await import('highlight.js')) as unknown as {
    default: { getLanguage(ext: string): { name: string | undefined } }
  }
  return Highlight.default.getLanguage(ext.slice(1))?.name ?? 'unknown'
}
