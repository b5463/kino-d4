import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  broken: boolean;
}

/**
 * A render error anywhere in a page used to leave a blank black screen. This
 * catches it and says so, with the one action that helps. Plain class
 * component: React has no hook for this.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { broken: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { broken: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('roll-web page crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.broken) return this.props.children;
    return (
      <main className="k-gate" role="alert">
        <h1>Something broke.</h1>
        <p>Reload.</p>
        <button type="button" className="k-save" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
