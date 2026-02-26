export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'

export interface PermissionContext {
  mode: PermissionMode
  allowedTools: string[]
  allowedPaths: string[]
  restrictions: {
    readOnly: boolean
    requireConfirmation: boolean
  }
  metadata: {
    activatedAt?: string
    previousMode?: PermissionMode
    transitionCount: number
  }
}

export interface ModeConfig {
  name: PermissionMode
  label: string
  icon: string
  color: string
  description: string
  allowedTools: string[]
  restrictions: {
    readOnly: boolean
    requireConfirmation: boolean
  }
}

export const MODE_CONFIGS: Record<PermissionMode, ModeConfig> = {
  default: {
    name: 'default',
    label: 'DEFAULT',
    icon: 'LOCK',
    color: 'blue',
    description: 'Standard permission checking',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: true,
    },
  },
  acceptEdits: {
    name: 'acceptEdits',
    label: 'ACCEPT EDITS',
    icon: 'OK',
    color: 'green',
    description: 'Auto-approve file edits/writes (Bash still requires approval)',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: true,
    },
  },
  plan: {
    name: 'plan',
    label: 'PLAN MODE',
    icon: 'PLAN',
    color: 'yellow',
    description: 'Planning mode - read/search tools plus planning coordination tools',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'LS',
      'WebSearch',
      'URLFetcher',
      'ReadNotebook',
      'MemoryRead',
      'MemorySearch',
      'Skill',
      'Think',
      'TodoRead',
      'TodoWrite',
      'Task',
      'TaskBatch',
      'TaskStatus',
      'TaskList',
      'TaskCreate',
      'TaskUpdate',
      'SendMessage',
    ],
    restrictions: {
      readOnly: true,
      requireConfirmation: true,
    },
  },
}

export function getNextPermissionMode(
  currentMode: PermissionMode,
): PermissionMode {
  switch (currentMode) {
    case 'default':
      return 'acceptEdits'
    case 'acceptEdits':
      return 'plan'
    case 'plan':
      return 'default'
    default:
      return 'default'
  }
}
