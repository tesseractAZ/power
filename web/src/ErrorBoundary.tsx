import React from 'react';

interface State {
  error: Error | null;
}

/**
 * v0.11.3 — top-level error boundary.
 *
 * Before this existed, a render error in ANY component unmounted the entire
 * React tree → a blank white page, with the cause only visible in the dev
 * console. (A stale `bcast.speakerGroups.length` read in the Opus StatusDock
 * white-screened the whole dashboard for exactly this reason.) Now a stray
 * crash shows a readable message + the stack + a Reload button, instead of a
 * silent blank — so a single bad component can never take the whole panel down
 * invisibly again.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the console for remote diagnosis.
    console.error('EcoFlow Panel — render error:', error, info?.componentStack);
  }

  render() {
    const err = this.state.error;
    if (!err) return this.props.children;
    return (
      <div
        style={{
          padding: 24,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          color: '#f4e8c8',
          background: '#0a0806',
          minHeight: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <h2 style={{ color: '#ff8c1f', margin: '0 0 12px' }}>EcoFlow Panel hit an error</h2>
        <p style={{ margin: '0 0 12px', opacity: 0.85 }}>
          The dashboard caught a problem while rendering. The details below help pinpoint it.
        </p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            lineHeight: 1.5,
            background: 'rgba(255,255,255,0.06)',
            padding: 12,
            borderRadius: 8,
            maxWidth: 920,
            overflow: 'auto',
          }}
        >
          {String(err.stack || err.message || err)}
        </pre>
        <button
          onClick={() => {
            this.setState({ error: null });
            location.reload();
          }}
          style={{
            marginTop: 16,
            padding: '8px 16px',
            background: '#0e7490',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
