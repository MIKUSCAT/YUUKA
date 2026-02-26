import { registerRuntimeHooks } from './runtimeHooks'
import { buildInstructionResourcesPromptHeader } from './resourceRegistry'
import { appendRuntimeEventToJournal } from './runtimeSessionJournal'

let registered = false

export function registerBuiltinRuntimeHooks(): void {
  if (registered) return
  registered = true

  registerRuntimeHooks({
    id: 'builtin-workspace-instructions',
    systemPromptHeader() {
      return buildInstructionResourcesPromptHeader()
    },
    onAgentEvent(event) {
      appendRuntimeEventToJournal(event)
    },
  })
}
