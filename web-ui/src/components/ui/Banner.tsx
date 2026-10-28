import { AlertCircle, Info } from "lucide-react";
import type { ReactNode } from "react";
import "./ui.css";

interface BannerProps {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Full-width strip above content (design `.banner`). `error` is announced via `role="alert"`, the rest via `status`. */
export function Banner({ tone = "info", children, actions, className }: BannerProps) {
  const Icon = tone === "info" ? Info : AlertCircle;
  const classes = ["banner", tone === "info" ? null : `banner--${tone}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role={tone === "error" ? "alert" : "status"}>
      <Icon size={14} className="banner__icon" aria-hidden="true" />
      <span className="banner__body">{children}</span>
      {actions != null && <span className="banner__actions">{actions}</span>}
    </div>
  );
}
