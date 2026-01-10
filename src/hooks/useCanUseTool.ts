import React, { useCallback } from 'react'
import { hasPermissionsToUseTool } from '@permissions'
import { REJECT_MESSAGE } from '@utils/messages'
import type { Tool as ToolType, ToolUseContext } from '@tool'
import { AssistantMessage } from '@query'
import { ToolUseConfirm } from '@components/permissions/PermissionRequest'
import { AbortError } from '@utils/errors'
import { logError } from '@utils/log'

type SetState<T> = React.Dispatch<React.SetStateAction<T>>

export type CanUseToolFn = (
  tool: ToolType,
  input: { [key: string]: unknown },
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
) => Promise<{ result: true } | { result: false; message: string }>

function useCanUseTool(
  setToolUseConfirm: SetState<ToolUseConfirm | null>,
): CanUseToolFn {
  return useCallback<CanUseToolFn>(
    async (tool, input, toolUseContext, assistantMessage) => {
      return new Promise(resolve => {
        function logCancelledEvent() {}

        function resolveWithCancelledAndAbortAllToolCalls() {
          resolve({
            result: false,
            message: REJECT_MESSAGE,
          })
          // Trigger a synthetic assistant message in query(), to cancel
          // any other pending tool uses and stop further requests to the
          // API and wait for user input.
          toolUseContext.abortController.abort()
        }

        if (toolUseContext.abortController.signal.aborted) {
          logCancelledEvent()
          resolveWithCancelledAndAbortAllToolCalls()
          return
        }

        return hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
        )
          .then(async result => {
            // Has permissions to use tool, granted in config
            if (result.result) {
              
              resolve({ result: true })
              return
            }

            const description = await (async () => {
              try {
                if (tool.cachedDescription) return tool.cachedDescription
                if (typeof tool.description === 'function') {
                  return await tool.description()
                }
                if (typeof tool.description === 'string') {
                  return tool.description
                }
              } catch (error) {
                logError(error)
              }
              return `Tool: ${tool.name}`
            })()

            if (toolUseContext.abortController.signal.aborted) {
              logCancelledEvent()
              resolveWithCancelledAndAbortAllToolCalls()
              return
            }

            // Does not have permissions to use tool, ask the user
            setToolUseConfirm({
              assistantMessage,
              tool,
              description,
              input,
              // 立刻弹确认：不做“命令前缀/注入检测”的后台解析
              commandPrefix: null,
              riskScore: null,
              onAbort() {
                logCancelledEvent()
                resolveWithCancelledAndAbortAllToolCalls()
              },
              onAllow(type) {
                if (type === 'session') {
                } else {
                }
                resolve({ result: true })
              },
              onReject() {
                resolveWithCancelledAndAbortAllToolCalls()
              },
            })
          })
          .catch(error => {
            if (error instanceof AbortError) {
              logCancelledEvent()
              resolveWithCancelledAndAbortAllToolCalls()
            } else {
              logError(error)
            }
          })
      })
    },
    [setToolUseConfirm],
  )
}

export default useCanUseTool
