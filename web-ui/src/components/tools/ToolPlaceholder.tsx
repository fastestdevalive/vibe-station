import type { ReactNode } from "react";

interface ToolPlaceholderProps {
  icon: ReactNode;
  title: string;
  description: string;
  /** Optional toolbar rendered above the body (e.g. a disabled URL bar). */
  toolbar?: ReactNode;
  /** Optional footer (e.g. an upload affordance). */
  footer?: ReactNode;
}

/**
 * Shared empty-state for tool panels that aren't wired to a backend yet
 * (Browser, Emulator, Artifacts). Establishes the layout so the real
 * implementation can drop into the same slot later.
 */
export function ToolPlaceholder({ icon, title, description, toolbar, footer }: ToolPlaceholderProps) {
  return (
    <div className="tool-placeholder">
      {toolbar ? <div className="tool-placeholder__toolbar">{toolbar}</div> : null}
      <div className="tool-placeholder__body">
        <div className="tool-placeholder__icon" aria-hidden>{icon}</div>
        <div className="tool-placeholder__title">{title}</div>
        <p className="tool-placeholder__desc">{description}</p>
        <span className="tool-placeholder__badge">Coming soon</span>
      </div>
      {footer ? <div className="tool-placeholder__footer">{footer}</div> : null}
    </div>
  );
}
