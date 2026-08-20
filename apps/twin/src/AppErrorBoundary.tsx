import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: string | null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : 'Unknown rendering failure';
}

/** Keep a bad profile/scene from turning the entire engineering UI blank. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: errorMessage(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('KINO Twin render failure', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <main className="twin-fatal" role="alert">
        <p className="twin-fatal-kicker">KINO TWIN STOPPED</p>
        <h1>THE ENGINEERING VIEW COULD NOT RENDER</h1>
        <p>{this.state.error}</p>
        <button type="button" className="twin-btn" onClick={() => window.location.reload()}>
          RELOAD TWIN
        </button>
      </main>
    );
  }
}
