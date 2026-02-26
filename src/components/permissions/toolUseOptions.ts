import { type Option } from '@inkjs/ui'
import chalk from 'chalk'
import { type ToolUseConfirm } from './PermissionRequest'
import { getTheme } from '@utils/theme'
import { type OptionSubtree } from '@components/CustomSelect/select'

/**
 * Generates options for the tool use confirmation dialog
 */
export function toolUseOptions({
  toolUseConfirm,
  command,
  forceTemporaryOnly = false,
}: {
  toolUseConfirm: ToolUseConfirm
  command: string
  forceTemporaryOnly?: boolean
}): (Option | OptionSubtree)[] {
  if (forceTemporaryOnly) {
    return [
      {
        label: 'Yes',
        value: 'yes',
      },
      {
        label: `No, and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
        value: 'no',
      },
    ]
  }

  void command
  void toolUseConfirm
  const sessionLabel = `Yes, allow this exact command this session`

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
