import * as React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export class SentryErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    ;(this as any).state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error): void {
    // Ignore user-initiated cancellations
    if (error.name === 'AbortError' || 
        error.message?.includes('abort') ||
        error.message?.includes('The operation was aborted')) {
      return
    }
    // No external reporting configured yet; keep boundary behavior only.
  }

  render(): React.ReactNode {
    if ((this as any).state.hasError) {
      return null
    }

    return (this as any).props.children
  }
}
