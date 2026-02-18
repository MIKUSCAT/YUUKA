import type { CanUseToolFn } from './hooks/useCanUseTool'
import { Tool, ToolUseContext } from './Tool'
import { BashTool, inputSchema } from './tools/BashTool/BashTool'
import { FileEditTool } from './tools/FileEditTool/FileEditTool'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '@utils/config'
import { AbortError } from './utils/errors'
import { logError } from './utils/log'
import { grantWritePermissionForOriginalDir } from './utils/permissions/filesystem'
import { PRODUCT_NAME } from './constants/product'
import {
  MODE_CONFIGS,
  PermissionMode,
} from '@yuuka-types/PermissionMode'
import { isHighRiskBashCommand } from '@utils/commands'

// Commands that are known to be safe for execution
const SAFE_COMMANDS = new Set([
  'git status',
  'git diff',
  'git log',
  'git branch',
  'pwd',
  'tree',
  'date',
  'which',
])

// In-memory approvals that reset each session ("this conversation" whitelist)
const SESSION_ALLOWED_TOOLS = new Set<string>()

function normalizePermissionMode(rawMode: unknown): PermissionMode {
  if (
    typeof rawMode === 'string' &&
    Object.prototype.hasOwnProperty.call(MODE_CONFIGS, rawMode)
  ) {
    return rawMode as PermissionMode
  }
  return 'default'
}

function modeAllowsTool(mode: PermissionMode, toolName: string): boolean {
  const allowedTools = MODE_CONFIGS[mode].allowedTools
  return allowedTools.includes('*') || allowedTools.includes(toolName)
}

function createPermissionDeniedMessage(toolName: string): string {
  return `${PRODUCT_NAME} requested permissions to use ${toolName}, but you haven't granted it yet.`
}

export const bashToolCommandHasExactMatchPermission = (
  tool: Tool,
  command: string,
  allowedTools: string[],
): boolean => {
  if (isHighRiskBashCommand(command)) {
    return false
  }
  if (SAFE_COMMANDS.has(command)) {
    return true
  }
  // 只允许“完整命令”匹配（不做 prefix/注入检测的后台解析）
  return allowedTools.includes(getPermissionKey(tool, { command }, null))
}

export const bashToolCommandHasPermission = (
  tool: Tool,
  command: string,
  prefix: string | null,
  allowedTools: string[],
): boolean => {
  // 保留签名兼容，但不再支持 prefix 匹配（避免额外模型解析）
  void prefix
  return bashToolCommandHasExactMatchPermission(tool, command, allowedTools)
}

export const bashToolHasPermission = async (
  tool: Tool,
  command: string,
  context: ToolUseContext,
  allowedTools: string[],
): Promise<PermissionResult> => {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  if (isHighRiskBashCommand(command)) {
    return {
      result: false,
      message: 'Dangerous command requires explicit confirmation every time.',
    }
  }

  if (bashToolCommandHasExactMatchPermission(tool, command, allowedTools)) {
    return { result: true }
  }

  // 不再做“命令前缀/注入检测”的后台解析：直接请示用户确认
  return {
    result: false,
    message: createPermissionDeniedMessage(tool.name),
  }
}

type PermissionResult = { result: true } | { result: false; message: string }

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  _assistantMessage,
): Promise<PermissionResult> => {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  const permissionMode = normalizePermissionMode(context.options?.permissionMode)
  const modeConfig = MODE_CONFIGS[permissionMode]

  if (!modeAllowsTool(permissionMode, tool.name)) {
    return {
      result: false,
      message: `Tool ${tool.name} is not available in ${permissionMode} mode.`,
    }
  }

  // Check if the tool needs permissions
  try {
    if (!tool.needsPermissions(input as never)) {
      return { result: true }
    }
  } catch (e) {
    logError(`Error checking permissions: ${e}`)
    return { result: false, message: 'Error checking permissions' }
  }

  // High-risk bash commands are always confirmed, regardless of mode or safe flag.
  if (tool === BashTool) {
    const parsedInput = inputSchema.safeParse(input)
    if (parsedInput.success && isHighRiskBashCommand(parsedInput.data.command)) {
      return {
        result: false,
        message: 'Dangerous command requires explicit confirmation every time.',
      }
    }
  }

  if (modeConfig.restrictions.bypassValidation) {
    return { result: true }
  }

  if (!modeConfig.restrictions.requireConfirmation) {
    return { result: true }
  }

  // Non-safe default mode stays permissive except high-risk bash commands handled above.
  if (!context.options?.safeMode && permissionMode === 'default') {
    return { result: true }
  }

  const projectConfig = getCurrentProjectConfig()
  const allowedTools = Array.from(
    new Set([...(projectConfig.allowedTools ?? []), ...SESSION_ALLOWED_TOOLS]),
  )
  // Special case for BashTool to allow blanket commands without exposing them in the UI
  if (tool === BashTool && allowedTools.includes(BashTool.name)) {
    return { result: true }
  }

  // TODO: Move this into tool definitions (done for read tools!)
  switch (tool) {
    // For bash tool, check each sub-command's permissions separately
    case BashTool: {
      // The types have already been validated by the tool,
      // so we can safely parse the input (as opposed to safeParse).
      const { command } = inputSchema.parse(input)
      return await bashToolHasPermission(tool, command, context, allowedTools)
    }
    // For file editing tools, check session-only permissions
    case FileEditTool:
    case FileWriteTool:
    case NotebookEditTool: {
      // The types have already been validated by the tool,
      // so we can safely pass this in
      if (!tool.needsPermissions(input)) {
        return { result: true }
      }
      return {
        result: false,
        message: createPermissionDeniedMessage(tool.name),
      }
    }
    // For other tools, check persistent permissions
    default: {
      const permissionKey = getPermissionKey(tool, input, null)
      if (allowedTools.includes(permissionKey)) {
        return { result: true }
      }

      return {
        result: false,
        message: createPermissionDeniedMessage(tool.name),
      }
    }
  }
}

export async function savePermission(
  tool: Tool,
  input: { [k: string]: unknown },
  prefix: string | null,
): Promise<void> {
  const key = getPermissionKey(tool, input, prefix)

  // For file editing tools, store write permissions only in memory
  if (
    tool === FileEditTool ||
    tool === FileWriteTool ||
    tool === NotebookEditTool
  ) {
    grantWritePermissionForOriginalDir()
    return
  }

  // For other tools, store permissions on disk
  const projectConfig = getCurrentProjectConfig()
  if (projectConfig.allowedTools.includes(key)) {
    return
  }

  projectConfig.allowedTools.push(key)
  projectConfig.allowedTools.sort()

  saveCurrentProjectConfig(projectConfig)
}

export async function saveSessionPermission(
  tool: Tool,
  input: { [k: string]: unknown },
  prefix: string | null,
): Promise<void> {
  const key = getPermissionKey(tool, input, prefix)
  SESSION_ALLOWED_TOOLS.add(key)
}

export function clearSessionPermissionsForTest(): void {
  SESSION_ALLOWED_TOOLS.clear()
}

function getPermissionKey(
  tool: Tool,
  input: { [k: string]: unknown },
  prefix: string | null,
): string {
  switch (tool) {
    case BashTool:
      if (prefix) {
        return `${BashTool.name}(${prefix}:*)`
      }
      return `${BashTool.name}(${BashTool.renderToolUseMessage(input as never)})`
    default:
      return tool.name
  }
}
