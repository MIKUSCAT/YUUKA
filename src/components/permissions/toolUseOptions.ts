import { type Option } from '@inkjs/ui'
import chalk from 'chalk'
import { type ToolUseConfirm, toolUseConfirmGetPrefix } from './PermissionRequest'
import { isUnsafeCompoundCommand } from '@utils/commands'
import { getTheme } from '@utils/theme'
import { type OptionSubtree } from '@components/CustomSelect/select'

/**
 * Generates options for the tool use confirmation dialog
 */
export function toolUseOptions({
  toolUseConfirm,
  command,
}: {
  toolUseConfirm: ToolUseConfirm
  command: string
}): (Option | OptionSubtree)[] {
  const prefix = toolUseConfirmGetPrefix(toolUseConfirm)
  const canUsePrefix =
    !isUnsafeCompoundCommand(command) &&
    toolUseConfirm.commandPrefix &&
    !toolUseConfirm.commandPrefix.commandInjectionDetected &&
    prefix !== null

  const sessionLabel = canUsePrefix
    ? `Yes, allow ${chalk.bold(prefix)} commands this session`
    : `Yes, allow this exact command this session`

  return [
    {
      label: 'Yes',
      value: 'yes',
    },
    {
      label: sessionLabel,
      value: 'yes-allow-session',
    },
    {
      label: `No, and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
      value: 'no',
    },
  ]
}
