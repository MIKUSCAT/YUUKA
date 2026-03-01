import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { Select } from '@components/CustomSelect/select'
import { relative } from 'path'
import { getTheme } from '@utils/theme'
import {
  PermissionRequestTitle,
  textColorForRiskScore,
} from '@components/permissions/PermissionRequestTitle'
import { logUnaryEvent } from '@utils/unaryLogging'
import { env } from '@utils/env'
import {
  type PermissionRequestProps,
  type ToolUseConfirm,
} from '@components/permissions/PermissionRequest'
import chalk from 'chalk'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '@hooks/usePermissionRequestLogging'
import { FileEditTool } from '@tools/FileEditTool/FileEditTool'
import { FileWriteTool } from '@tools/FileWriteTool/FileWriteTool'
import { GrepTool } from '@tools/GrepTool/GrepTool'
import { GlobTool } from '@tools/GlobTool/GlobTool'
import { LSTool } from '@tools/lsTool/lsTool'
import { FileReadTool } from '@tools/FileReadTool/FileReadTool'
import { NotebookEditTool } from '@tools/NotebookEditTool/NotebookEditTool'
import { NotebookReadTool } from '@tools/NotebookReadTool/NotebookReadTool'
import { FallbackPermissionRequest } from '@components/permissions/FallbackPermissionRequest'
import { saveSessionPermission } from '@permissions'
import {
  toAbsolutePath,
} from '@utils/permissions/filesystem'
import { getCwd } from '@utils/state'

function pathArgNameForToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  switch (toolUseConfirm.tool) {
    case FileWriteTool:
    case FileEditTool:
    case FileReadTool: {
      return 'file_path'
    }
    case GlobTool:
    case GrepTool:
    case LSTool: {
      return 'path'
    }
    case NotebookEditTool:
    case NotebookReadTool: {
      return 'notebook_path'
    }
  }
  return null
}

function isMultiFile(toolUseConfirm: ToolUseConfirm): boolean {
  switch (toolUseConfirm.tool) {
    case GlobTool:
    case GrepTool:
    case LSTool: {
      return true
    }
  }
  return false
}

function pathFromToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  const pathArgName = pathArgNameForToolUse(toolUseConfirm)
  const input = toolUseConfirm.input
  if (pathArgName && pathArgName in input) {
    if (typeof input[pathArgName] === 'string') {
      return toAbsolutePath(input[pathArgName])
    } else {
      return toAbsolutePath(getCwd())
    }
  }
  return null
}

function shouldUseFramelessStyle(toolUseConfirm: ToolUseConfirm): boolean {
  return toolUseConfirm.tool === NotebookEditTool
}

export function FilesystemPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: PermissionRequestProps): React.ReactNode {
  const path = pathFromToolUse(toolUseConfirm)
  if (!path) {
    // Fall back to generic permission request if no path is found
    return (
      <FallbackPermissionRequest
        toolUseConfirm={toolUseConfirm}
        onDone={onDone}
        verbose={verbose}
      />
    )
  }
  return (
    <FilesystemPermissionRequestImpl
      toolUseConfirm={toolUseConfirm}
      path={path}
      onDone={onDone}
      verbose={verbose}
    />
  )
}

function getSessionAllowOptions() {
  return [
    {
      label: 'Yes, allow this tool this session',
      value: 'yes-allow-session',
    },
  ]
}

type Props = {
  toolUseConfirm: ToolUseConfirm
  path: string
  onDone(): void
  verbose: boolean
}

function FilesystemPermissionRequestImpl({
  toolUseConfirm,
  path,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const userFacingName = toolUseConfirm.tool.userFacingName()

  const userFacingReadOrWrite = toolUseConfirm.tool.isReadOnly()
    ? 'Read'
    : 'Edit'
  const title = `${userFacingReadOrWrite} ${isMultiFile(toolUseConfirm) ? 'files' : 'file'}`
  const frameless = shouldUseFramelessStyle(toolUseConfirm)
  const displayPath = verbose ? path : relative(getCwd(), path)

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const details = (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        {userFacingName}(
        {toolUseConfirm.tool.renderToolUseMessage(
          toolUseConfirm.input as never,
          { verbose },
        )}
        )
      </Text>
    </Box>
  )

  const actions = (
    <Box flexDirection="column">
      <Text>Do you want to proceed?</Text>
      <Select
        options={[
          {
            label: 'Yes',
            value: 'yes',
          },
          ...getSessionAllowOptions(),
          {
            label: `No, and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
            value: 'no',
          },
        ]}
        onChange={newValue => {
          switch (newValue) {
            case 'yes':
              logUnaryEvent({
                completion_type: 'tool_use_single',
                event: 'accept',
                metadata: {
                  language_name: 'none',
                  message_id: toolUseConfirm.assistantMessage.message.id,
                  platform: env.platform,
                },
              })
              onDone()
              toolUseConfirm.onAllow('temporary')
              break
            case 'yes-allow-session':
              logUnaryEvent({
                completion_type: 'tool_use_single',
                event: 'accept',
                metadata: {
                  language_name: 'none',
                  message_id: toolUseConfirm.assistantMessage.message.id,
                  platform: env.platform,
                },
              })
              onDone()
              saveSessionPermission(toolUseConfirm.tool, toolUseConfirm.input, null)
                .then(() => {
                  toolUseConfirm.onAllow('session')
                })
                .catch(() => {
                  toolUseConfirm.onAllow('temporary')
                })
              break
            case 'no':
              logUnaryEvent({
                completion_type: 'tool_use_single',
                event: 'reject',
                metadata: {
                  language_name: 'none',
                  message_id: toolUseConfirm.assistantMessage.message.id,
                  platform: env.platform,
                },
              })
              onDone()
              toolUseConfirm.onReject()
              break
          }
        }}
      />
    </Box>
  )

  if (frameless) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Notebook Edit Request</Text>
          <Text dimColor>{displayPath}</Text>
          <Text dimColor>
            Review notebook changes, then choose: Yes / No / Allow this session.
          </Text>
        </Box>
        {details}
        {actions}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={textColorForRiskScore(toolUseConfirm.riskScore)}
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      <PermissionRequestTitle
        title={title}
        riskScore={toolUseConfirm.riskScore}
      />
      {details}
      {actions}
    </Box>
  )
}
