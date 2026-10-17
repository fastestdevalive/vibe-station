import type { ReactNode } from "react";

interface DraftFieldRowProps {
  label: string;
  children: ReactNode;
  message?: ReactNode;
  className?: string;
}

/** A single 40px label/control row inside the draft box (see Architecture Diagram). */
export function DraftFieldRow({ label, children, message, className }: DraftFieldRowProps) {
  return (
    <div className={"draft-row" + (className ? " " + className : "")}>
      <div className="draft-row__line">
        <span className="draft-row__label">{label}</span>
        <span className="draft-row__control">{children}</span>
      </div>
      {message ? <div className="draft-row__msg">{message}</div> : null}
    </div>
  );
}
