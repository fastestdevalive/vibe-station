import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown in the fallback card so the user/dev knows roughly what broke. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort error boundary. Without one, ANY uncaught throw anywhere in the
 * tree unmounts the whole React root, leaving a blank page with no signal —
 * this is exactly what happened when `crypto.randomUUID()` threw on an
 * insecure-context origin (see lib/uuid.ts) with nothing above the workspace
 * tree to catch it. This boundary turns that failure mode into a visible
 * error card instead, and keeps the rest of the app framework (TopBar, route)
 * usable so the user isn't stuck.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          padding: 24,
          margin: 16,
          border: "1px solid var(--border-default, #444)",
          borderRadius: 8,
          background: "var(--bg-secondary, #1a1a1a)",
          color: "var(--fg-primary, #eee)",
          fontFamily: "var(--font-sans, sans-serif)",
          maxWidth: 640,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {this.props.label ? `${this.props.label} crashed` : "Something went wrong"}
        </div>
        <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {error.message}
        </div>
        <button
          type="button"
          onClick={this.reset}
          style={{
            font: "inherit",
            fontSize: 13,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--border-default, #444)",
            background: "var(--bg-primary, #111)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
