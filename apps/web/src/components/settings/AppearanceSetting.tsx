import { useTheme } from "@/hooks/useTheme";
import { SectionHeader } from "./SectionHeader";

function Row({
  label,
  description,
  control,
}: {
  label: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "var(--space-3) 0",
        borderBottom: "var(--border-width) solid var(--border-subtle, var(--border-default))",
      }}
    >
      <div>
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--fg-primary)",
            marginBottom: 2,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
          {description}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

function SegmentedControl({
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

export function AppearanceSetting() {
  const { theme, font, toggleTheme, toggleFont } = useTheme();

  return (
    <div>
      <SectionHeader
        title="Appearance"
        description="Customize how vibe-station looks on your device."
      />

      <Row
        label="Brightness"
        description="Switch between dark and light interface themes."
        control={
          <SegmentedControl
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            value={theme}
            onChange={(v) => { if (v !== theme) toggleTheme(); }}
          />
        }
      />

      <Row
        label="Text style"
        description="Monospace is optimized for code; sans-serif is easier for reading prose."
        control={
          <SegmentedControl
            options={[
              { value: "mono", label: "Mono" },
              { value: "sans", label: "Sans" },
            ]}
            value={font}
            onChange={(v) => { if (v !== font) toggleFont(); }}
          />
        }
      />
    </div>
  );
}
