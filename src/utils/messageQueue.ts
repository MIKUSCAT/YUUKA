export type MessageQueueKind = 'steering' | 'follow-up'

export type MessageQueueDeliveryMode = 'one-at-a-time' | 'all'

export type QueuedMessage = {
  kind: MessageQueueKind
  text: string
  createdAt: number
}

export interface MessageQueueController {
  enqueue: (kind: MessageQueueKind, text: string) => void
  peek: (kind: MessageQueueKind) => number
  dequeue: (kind: MessageQueueKind, mode: MessageQueueDeliveryMode) => QueuedMessage[]
  drainAll: () => QueuedMessage[]
  clear: () => void
}

export function createMessageQueue(): MessageQueueController {
  const items: QueuedMessage[] = []

  function enqueue(kind: MessageQueueKind, text: string): void {
    const normalized = String(text ?? '').trim()
    if (!normalized) return
    items.push({ kind, text: normalized, createdAt: Date.now() })
  }

  function peek(kind: MessageQueueKind): number {
    return items.filter(item => item.kind === kind).length
  }

  function dequeue(
    kind: MessageQueueKind,
    mode: MessageQueueDeliveryMode,
  ): QueuedMessage[] {
    const indices: number[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind === kind) {
        indices.push(i)
        if (mode === 'one-at-a-time') {
          break
        }
      }
    }
    if (indices.length === 0) return []

    const result: QueuedMessage[] = indices.map(i => items[i]!).filter(Boolean)
    for (let i = indices.length - 1; i >= 0; i--) {
      items.splice(indices[i]!, 1)
    }
    return result
  }

  function drainAll(): QueuedMessage[] {
    const result = [...items]
    items.length = 0
    return result
  }

  function clear(): void {
    items.length = 0
  }

  return {
    enqueue,
    peek,
    dequeue,
    drainAll,
    clear,
  }
}

