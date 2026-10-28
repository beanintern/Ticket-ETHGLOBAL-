import { Component, type ReactNode } from 'react';

/**
 * Catches a rendering error anywhere in the app and shows a way back, instead of a blank page.
 * Nothing on Derive depends on the page: positions and funds are unaffected.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Ticket crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="loading" role="alert">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Ticket
        </div>
        <p>Something went wrong on this page.</p>
        <p className="loading-error">{this.state.error.message}</p>
        <p className="fine">Your positions and funds on Derive aren’t affected: they live on the exchange, not in this page.</p>
        <button className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
