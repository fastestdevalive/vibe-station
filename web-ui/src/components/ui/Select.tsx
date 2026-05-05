import type { SelectHTMLAttributes } from "react";

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        width: "100%",
        padding: "var(--space-2) var(--space-3)",
        borderRadius: "var(--radius-sm)",
        border: "var(--border-width) solid var(--border-default)",
        background: "var(--bg-input)",
        color: "var(--fg-primary)",
        ...props.style,
      }}
    />
  );
}
