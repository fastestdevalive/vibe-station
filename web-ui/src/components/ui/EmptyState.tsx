import type { ReactNode } from "react";
import "./ui.css";

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  /** Muted description line(s) under the title. */
  children?: ReactNode;
  /** Smaller meta line (hints, code samples). */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Centered empty / error / state panel (design `.empty`). */
export function EmptyState({ icon, title, children, meta, actions, className }: EmptyStateProps) {
  return (
    <div className={["ui-empty", className].filter(Boolean).join(" ")}>
      {icon}
      <b className="ui-empty__title">{title}</b>
      {children != null && <span>{children}</span>}
      {meta != null && <span className="ui-empty__meta">{meta}</span>}
      {actions != null && <div className="ui-empty__actions">{actions}</div>}
    </div>
  );
}
