import { useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useWorkspaceStore } from "@/hooks/useStore";
import { themes, type ThemeRegistryEntry } from "@/theme/registry";
import { SectionHeader } from "./SectionHeader";
import { SettingsPreviewFixture } from "./SettingsPreviewFixture";

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

/** Fixed square footprint for every swatch, regardless of theme-name length
 *  or hover/active state -- this is what makes the grid uniformly sized
 *  (option C: icon-only by default; the name only appears as an overlay
 *  painted ON TOP of this same fixed box, never by growing it). */
const SWATCH_SIZE = 52;

function ThemeSwatch({
  entry,
  active,
  onHover,
  onLeave,
  onCommit,
}: {
  entry: ThemeRegistryEntry;
  active: boolean;
  onHover: () => void;
  onLeave: () => void;
  onCommit: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = entry.cssVars["--bg-primary"];
  const bgSecondary = entry.cssVars["--bg-secondary"];
  const fg = entry.cssVars["--fg-primary"];
  const accent = entry.cssVars["--accent"];
  const showName = active || hovered;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={entry.name}
      onMouseEnter={() => {
        setHovered(true);
        onHover();
      }}
      onFocus={() => {
        setHovered(true);
        onHover();
      }}
      onMouseLeave={() => {
        setHovered(false);
        onLeave();
      }}
      onBlur={() => {
        setHovered(false);
        onLeave();
      }}
      onClick={onCommit}
      title={entry.name}
      style={{
        position: "relative",
        display: "block",
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        flexShrink: 0,
        padding: 0,
        border: `${active ? 2 : 1}px solid ${active ? "var(--accent)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-md)",
        background: bg,
        cursor: "pointer",
        font: "inherit",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 6,
          left: 0,
          right: 0,
          textAlign: "center",
          background: bgSecondary,
          color: fg,
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 1,
          padding: "2px 0",
          margin: "0 6px",
          borderRadius: 4,
          opacity: showName ? 0 : 1,
          transition: "opacity 100ms ease",
        }}
      >
        Aa
      </span>
      <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: accent }} />
      {/* Name overlay -- painted on top of the fixed-size swatch, never
          resizes it. Shown on hover/focus (a live look before committing)
          and permanently once this theme is the committed one. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "4px 3px",
          fontSize: 9,
          fontWeight: 600,
          lineHeight: 1.15,
          color: fg,
          background: `color-mix(in srgb, ${bg} 72%, transparent)`,
          opacity: showName ? 1 : 0,
          pointerEvents: "none",
          transition: "opacity 100ms ease",
        }}
      >
        {active ? "✓ " : ""}
        {entry.name}
      </span>
    </button>
  );
}

function ThemeGroup({
  label,
  entries,
  committedId,
  hoveredId,
  onHover,
  onLeave,
  onCommit,
}: {
  label: string;
  entries: ThemeRegistryEntry[];
  committedId: string;
  hoveredId: string | null;
  onHover: (id: string) => void;
  onLeave: () => void;
  onCommit: (id: string) => void;
}) {
  return (
    <div
      style={{
        border: "var(--border-width) solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <div
        style={{
          fontSize: "var(--font-size-xs)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </div>
      <div
        role="radiogroup"
        aria-label={`${label} themes`}
        style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}
      >
        {entries.map((entry) => (
          <ThemeSwatch
            key={entry.id}
            entry={entry}
            active={committedId === entry.id}
            onHover={() => onHover(entry.id)}
            onLeave={onLeave}
            onCommit={() => onCommit(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function AppearanceSetting() {
  const { themeId, font, setTheme, toggleFont } = useTheme();
  const showAgentStatusBorders = useWorkspaceStore((s) => s.showAgentStatusBorders);
  const toggleAgentStatusBorders = useWorkspaceStore((s) => s.toggleAgentStatusBorders);
  const themeAgentTerminals = useWorkspaceStore((s) => s.themeAgentTerminals);
  const toggleThemeAgentTerminals = useWorkspaceStore((s) => s.toggleThemeAgentTerminals);

  const darkThemes = themes.filter((t) => t.appearance === "dark");
  const lightThemes = themes.filter((t) => t.appearance === "light");

  // The theme currently shown in the live preview. Hovering/focusing a swatch
  // previews it (no PATCH /settings); clearing back to null falls back to the
  // committed theme (e.g. on touch devices with no hover).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const previewId = hoveredId ?? themeId;
  const previewEntry = themes.find((t) => t.id === previewId);

  return (
    <div>
      <SectionHeader description="Customize how vibe-station looks on your device." />

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
            onChange={(v) => {
              if (v !== font) toggleFont();
            }}
          />
        }
      />

      <Row
        label="Agent status borders"
        description="Color the border around agent panes and workspace tiles by interaction state (waiting for human, needs review, working, etc)."
        control={
          <SegmentedControl
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={showAgentStatusBorders ? "on" : "off"}
            onChange={(v) => {
              if ((v === "on") !== showAgentStatusBorders) toggleAgentStatusBorders();
            }}
          />
        }
      />

      <Row
        label="Theme agent terminals"
        description="Apply the selected theme's colors to agent panes' terminal output. The standalone terminal dock/tile (Ctrl/Cmd+Shift+Z) always keeps its own fixed colors."
        control={
          <SegmentedControl
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={themeAgentTerminals ? "on" : "off"}
            onChange={(v) => {
              if ((v === "on") !== themeAgentTerminals) toggleThemeAgentTerminals();
            }}
          />
        }
      />

      <div style={{ marginTop: "var(--space-3)" }}>
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--fg-primary)",
            marginBottom: 2,
          }}
        >
          Theme
        </div>
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", marginBottom: "var(--space-2)" }}>
          Pick a theme. Hover to preview; click to apply.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <ThemeGroup
            label="Dark"
            entries={darkThemes}
            committedId={themeId}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            onLeave={() => setHoveredId(null)}
            onCommit={setTheme}
          />
          <ThemeGroup
            label="Light"
            entries={lightThemes}
            committedId={themeId}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            onLeave={() => setHoveredId(null)}
            onCommit={setTheme}
          />
        </div>
      </div>

      <div style={{ marginTop: "var(--space-4)" }}>
        <div
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--fg-muted)",
            marginBottom: "var(--space-2)",
          }}
        >
          Live preview — {previewEntry?.name ?? ""} (updates on hover; commits on click)
        </div>
        {/* Phase 2.3's `.theme-scope[data-theme=...]` block applies within this
            subtree only — previewing a theme never touches document.documentElement. */}
        <div
          className="theme-scope"
          data-theme={previewId}
          style={{
            border: "var(--border-width) solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-3)",
            background: "var(--bg-secondary)",
          }}
        >
          <SettingsPreviewFixture themeId={previewId} />
        </div>
      </div>
    </div>
  );
}
