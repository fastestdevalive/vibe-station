import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "ghost" | "solid";
}

export function Button({
  children,
  variant = "solid",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
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
