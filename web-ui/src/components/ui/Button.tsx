import "./ui.css";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "ghost" | "solid";
  /** `sm` = 24px compact action (state panels, notices); styled in `ui.css`. */
  size?: "sm";
}

export function Button({
  children,
  variant = "solid",
  type = "button",
  size,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={[size ? "ui-btn ui-btn--sm" : null, className].filter(Boolean).join(" ") || undefined}
      style={{
        ...(variant === "ghost"
          ? { background: "transparent", borderColor: "transparent" }
          : {}),
        ...rest.style,
      }}
    >
      {children}
    </button>
  );
}
