/** Small radiogroup of mutually exclusive options (Settings rows). */
export function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      style={{
        display: "inline-flex",
        background: "var(--bg-card)",
        border: "var(--border-width) solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            border: "none",
            borderRadius: "calc(var(--radius-md) - 2px)",
            padding: "var(--space-1) var(--space-3)",
            cursor: "pointer",
            font: "inherit",
            fontSize: "var(--font-size-xs)",
            fontWeight: "var(--font-weight-medium)",
            whiteSpace: "nowrap",
            background: value === opt.value ? "var(--bg-active)" : "transparent",
            color: value === opt.value ? "var(--fg-primary)" : "var(--fg-muted)",
            transition: "background 120ms ease, color 120ms ease",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
