import type { HTMLAttributes, ReactNode } from "react";
import "./ui.css";

interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children: ReactNode;
  /** `neutral` = quiet outline; `warn` = `--fg-warning` accent. */
  tone?: "neutral" | "warn";
  /** `sm` = 16px tall (dense rows such as the schedule strip); `md` = `--h-chip`. */
  size?: "sm" | "md";
}

/** Small pill label. Shared by the schedule strip and the artifacts UI. */
export function Chip({ children, tone = "neutral", size = "md", className, ...rest }: ChipProps) {
  const classes = ["chip", `chip--${tone}`, `chip--${size}`, className].filter(Boolean).join(" ");
  return (
    <span {...rest} className={classes}>
      {children}
    </span>
  );
}
