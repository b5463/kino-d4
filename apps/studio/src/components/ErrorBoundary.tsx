// The one thing standing between a thrown render error and a white window.
//
// Studio had no boundary anywhere, so any throw below the root unmounted the
// whole tree: a single capture with three frames indexing `frames[3]` took the
// menu bar, the connection strip and the camera session down with it, and left
// nothing on screen to say what happened. React gives no other way to recover
// from a render throw, and no hook equivalent — it has to be a class.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /**
   * What broke, in the operator's words: `Gallery`, `KINO Studio`. Printed, so
   * the notice says which part of the application is down and, by omission,
   * which parts are not.
   */
  what: string;
  /**
   * Changing this remounts the children — the section id, so navigating away
   * from a broken page and back gives it a fresh attempt rather than a
   * permanently dead panel.
   */
  resetKey?: string | number;
  /** Extra affordance under the message, e.g. a way back to Overview. */
  action?: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: string | number | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: undefined };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Not the device log: `LogSource` is the firmware contract's own set and
    // has no host entry, and a Studio bug is not something the camera said.
    // The console is where the stack has to go, and it is what a bug report
    // needs — the notice below is deliberately short.
    console.error(`KINO Studio: ${this.props.what} failed to render`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="notice notice--err" role="alert" style={{ alignItems: 'flex-start' }}>
        <span>
          <strong>{this.props.what} stopped working.</strong> {error.message}
          <br />
          Nothing was written to the camera by this fault. The full stack is in the browser
          console.
        </span>
        {this.props.action}
      </div>
    );
  }
}
