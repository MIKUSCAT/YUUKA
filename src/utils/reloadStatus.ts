type ReloadDomain = 'agents' | 'skills'
type ReloadState = 'loading' | 'ok'

export type ReloadStatusEvent = {
  domain: ReloadDomain
  state: ReloadState
}

const EVENT_NAME = 'yuuka:reload-status'

export function emitReloadStatus(event: ReloadStatusEvent): void {
  ;(process as any).emit(EVENT_NAME, event)
}

export function subscribeReloadStatus(
  listener: (event: ReloadStatusEvent) => void,
): () => void {
  const handler = (event: ReloadStatusEvent) => listener(event)
  ;(process as any).on(EVENT_NAME, handler)
  return () => {
    ;(process as any).off(EVENT_NAME, handler)
  }
}

