import type { InputHTMLAttributes } from "react";

interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export function Radio({ label, ...rest }: RadioProps) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        cursor: rest.disabled ? "not-allowed" : "pointer",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <input type="radio" {...rest} />
      {label}
    </label>
  );
}
