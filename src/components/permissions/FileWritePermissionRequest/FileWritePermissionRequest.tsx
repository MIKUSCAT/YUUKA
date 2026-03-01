import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { Select } from '@components/CustomSelect/select'
import { basename, extname } from 'path'
import { getTheme } from '@utils/theme'
import { logUnaryEvent } from '@utils/unaryLogging'
import { env } from '@utils/env'
import { saveSessionPermission } from '@permissions'
import {
  type ToolUseConfirm,
} from '@components/permissions/PermissionRequest'
import { existsSync } from 'fs'
import chalk from 'chalk'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '@hooks/usePermissionRequestLogging'
import { FileWriteToolDiff } from './FileWriteToolDiff'
import { useTerminalSize } from '@hooks/useTerminalSize'
import { logError } from '@utils/log'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

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

export function FileWritePermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const { file_path, content } = toolUseConfirm.input as {
    file_path: string
    content: string
  }
  const fileExists = useMemo(() => existsSync(file_path), [file_path])
  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'write_file_single',
      language_name: extractLanguageName(file_path),
    }),
    [file_path],
  )
  const { columns } = useTerminalSize()
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  return (
    <Box
      flexDirection="column"
      marginTop={1}
    >
      <Box flexDirection="column">
        <FileWriteToolDiff
          file_path={file_path}
          content={content}
          verbose={verbose}
          width={columns - 12}
          useBorder={false}
        />
      </Box>
      <Box flexDirection="column">
        <Text>
          Do you want to {fileExists ? 'make this edit to' : 'create'}{' '}
          <Text bold>{basename(file_path)}</Text>?
        </Text>
        <Select
          options={getOptions()}
          onChange={newValue => {
            switch (newValue) {
              case 'yes':
                extractLanguageName(file_path).then(language => {
                  logUnaryEvent({
                    completion_type: 'write_file_single',
                    event: 'accept',
                    metadata: {
                      language_name: language,
                      message_id: toolUseConfirm.assistantMessage.message.id,
                      platform: env.platform,
                    },
                  })
                })
                onDone()
                toolUseConfirm.onAllow('temporary')
                break
              case 'yes-allow-session':
                extractLanguageName(file_path).then(language => {
                  logUnaryEvent({
                    completion_type: 'write_file_single',
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
                  .catch(error => {
                    logError(error)
                    toolUseConfirm.onAllow('temporary')
                  })
                break
              case 'no':
                extractLanguageName(file_path).then(language => {
                  logUnaryEvent({
                    completion_type: 'write_file_single',
                    event: 'reject',
                    metadata: {
                      language_name: language,
                      message_id: toolUseConfirm.assistantMessage.message.id,
                      platform: env.platform,
                    },
                  })
                })
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
