import { Info, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import "./ui.css";

interface ToastProps {
  children: ReactNode;
  /** Renders the ✕ button and (with `autoDismissMs`) the timer. */
  onDismiss?: () => void;
  /** Calls `onDismiss` after this many ms. */
  autoDismissMs?: number;
  className?: string;
}

/** Inline status notice (design `.toast`): info icon, body, optional dismiss. `role="status"`. */
export function Toast({ children, onDismiss, autoDismissMs, className }: ToastProps) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!autoDismissMs) return;
    const t = setTimeout(() => cb.current?.(), autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs]);
  return (
    <div className={["toast", className].filter(Boolean).join(" ")} role="status">
      <Info size={14} className="toast__icon" aria-hidden="true" />
      <span className="toast__body">{children}</span>
      {onDismiss && (
        <button type="button" className="toast__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}
