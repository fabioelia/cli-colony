import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary] crash:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="crash-page">
          <div className="crash-content">
            <div className="crash-icon">!</div>
            <h1>Something went wrong</h1>
            <p className="crash-message">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <div className="crash-actions">
              <button className="crash-reload" onClick={() => window.location.reload()}>
                Reload App
              </button>
              <button className="crash-dismiss" onClick={() => this.setState({ hasError: false, error: null })}>
                Try to Continue
              </button>
            </div>
            {this.state.error?.stack && (
              <details className="crash-details">
                <summary>Error Details</summary>
                <pre>{this.state.error.stack}</pre>
              </details>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
