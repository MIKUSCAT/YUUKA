import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { UnaryEvent } from '@hooks/usePermissionRequestLogging'
import { saveSessionPermission } from '@permissions'
import { BashTool } from '@tools/BashTool/BashTool'
import { getTheme } from '@utils/theme'
import { usePermissionRequestLogging } from '@components/permissions/hooks'
import {
  type ToolUseConfirm,
} from '@components/permissions/PermissionRequest'
import { PermissionRequestTitle } from '@components/permissions/PermissionRequestTitle'
import { logUnaryPermissionEvent } from '@components/permissions/utils'
import { Select } from '@components/CustomSelect/select'
import { toolUseOptions } from '@components/permissions/toolUseOptions'
import {
  isHighRiskBashCommand,
} from '@utils/commands'
import { logError } from '@utils/log'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
}

export function BashPermissionRequest({
  toolUseConfirm,
  onDone,
}: Props): React.ReactNode {
  const theme = getTheme()

  // ok to use parse since we've already validated args earliers
  const { command } = BashTool.inputSchema.parse(toolUseConfirm.input)
  const isHighRiskCommand = isHighRiskBashCommand(command)

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.permission}
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      <PermissionRequestTitle
        title="Bash command"
        riskScore={toolUseConfirm.riskScore}
      />
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>{BashTool.renderToolUseMessage({ command })}</Text>
        <Text color={theme.secondaryText}>{toolUseConfirm.description}</Text>
        {isHighRiskCommand && (
          <Text color={theme.warning}>
            危险命令：该命令每次执行都需要你手动确认，不能会话放行。
          </Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>Do you want to proceed?</Text>
        <Select
          options={toolUseOptions({
            toolUseConfirm,
            command,
            forceTemporaryOnly: isHighRiskCommand,
          })}
          onChange={newValue => {
            switch (newValue) {
              case 'yes':
                logUnaryPermissionEvent(
                  'tool_use_single',
                  toolUseConfirm,
                  'accept',
                )
                onDone()
                toolUseConfirm.onAllow('temporary')
                break
              case 'yes-allow-session': {
                if (isHighRiskCommand) {
                  logUnaryPermissionEvent(
                    'tool_use_single',
                    toolUseConfirm,
                    'accept',
                  )
                  onDone()
                  toolUseConfirm.onAllow('temporary')
                  break
                }
                logUnaryPermissionEvent(
                  'tool_use_single',
                  toolUseConfirm,
                  'accept',
                )
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
              }
              case 'no':
                logUnaryPermissionEvent(
                  'tool_use_single',
                  toolUseConfirm,
                  'reject',
                )
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
