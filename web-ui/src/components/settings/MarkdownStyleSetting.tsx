import { useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useMarkdownStyle } from "@/hooks/useMarkdownStyle";
import { SectionHeader } from "./SectionHeader";
import { SettingsPreviewFixture } from "./SettingsPreviewFixture";

/** Base reference used only for the display-only px↔em conversion of heading
 *  sizes. Sizes are stored and applied as `em` so they stay relative to the
 *  preview-zoom control (`workspace.css` / `FilePreviewPane.tsx:304`). */
const SIZE_BASE_PX = 14;

const SIZE_PRESETS: { px: number; em: string }[] = [
  { px: 12, em: "0.86em" },
  { px: 14, em: "1em" },
  { px: 16, em: "1.14em" },
  { px: 18, em: "1.29em" },
  { px: 20, em: "1.43em" },
  { px: 22, em: "1.57em" },
  { px: 24, em: "1.71em" },
  { px: 28, em: "2em" },
  { px: 30, em: "2.14em" },
  { px: 34, em: "2.43em" },
  { px: 36, em: "2.57em" },
  { px: 42, em: "3em" },
];

const WEIGHT_OPTIONS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Theme mono", value: "var(--font-mono)" },
  { label: "Theme sans", value: "var(--font-sans)" },
  { label: "JetBrains Mono", value: "'JetBrains Mono', monospace" },
  { label: "Fira Code", value: "'Fira Code', monospace" },
  { label: "SF Mono / Menlo", value: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
];

function pxToEm(px: number): string {
  return `${(px / SIZE_BASE_PX).toFixed(2)}em`;
}

function sizeSelectValue(em?: string): string {
  if (!em) return "default";
  for (const p of SIZE_PRESETS) if (p.em === em) return String(p.px);
  return "custom";
}

function validHex(v: string | undefined): v is string {
  return !!v && /^#[0-9a-fA-F]{6}$/.test(v);
}

const labelStyle: React.CSSProperties = {
  fontSize: "var(--font-size-xs)",
  color: "var(--fg-muted)",
  marginBottom: 2,
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: "var(--font-size-xs)",
  fontWeight: "var(--font-weight-medium)",
  color: "var(--fg-primary)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: "var(--space-1)",
};

const fieldInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-sm)",
  border: "var(--border-width) solid var(--border-default)",
  background: "var(--bg-input)",
  color: "var(--fg-primary)",
  font: "inherit",
  fontSize: "var(--font-size-xs)",
  height: 28,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onCommit: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <select style={fieldInputStyle} value={value} onChange={(e) => onCommit(e.target.value)}>
        <option value="default">Default</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ColorField({
  label,
  value,
  onPick,
  onClear,
}: {
  label: string;
  value?: string;
  onPick: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          type="color"
          aria-label={label}
          value={validHex(value) ? value : "#888888"}
          onChange={(e) => onPick(e.target.value)}
          style={{
            width: 34,
            height: 28,
            padding: 0,
            border: "var(--border-width) solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-input)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: value ? "var(--fg-primary)" : "var(--fg-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {value ? value : "default"}
        </span>
        {value && (
          <button
            type="button"
            title="Reset to theme default"
            onClick={onClear}
            style={{
              border: "var(--border-width) solid var(--border-default)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-input)",
              color: "var(--fg-muted)",
              width: 24,
              height: 28,
              lineHeight: 1,
              cursor: "pointer",
              font: "inherit",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        )}
      </div>
    </Field>
  );
}

function HGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "var(--space-3)" }}>
      <div style={groupLabelStyle}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>{children}</div>
    </div>
  );
}

/**
 * Markdown Style settings section — per-element controls (left) with a live
 * rendered preview (right). Every edit updates the preview instantly,
 * client-side only; the `PATCH /settings` fires on change/blur via the
 * `useMarkdownStyle` hook's `commit` (never per keystroke).
 */
export function MarkdownStyleSetting() {
  const { themeId } = useTheme();
  const { style, set, commit, reset, hasOverrides } = useMarkdownStyle();
  const isNarrow = useMediaQuery("(max-width: 1000px)");
  const [showH456, setShowH456] = useState(false);

  // Select controls: change is change-end, so set + commit immediately.
  // `weight` fields are `Option<u16>` on the wire (rust/vst-types/src/rest/settings.rs)
  // — sending the raw <select> string (e.g. "900") fails server-side validation
  // (expects a JSON number, not a string) with a 422 that the UI otherwise
  // swallows silently, leaving the edit un-persisted. Parse to a number for any
  // path ending in `.weight`; every other select field (size/style/font) stays
  // a string, matching the wire's `Option<String>` shape for those fields.
  function commitSelect(path: string, value: string) {
    if (value === "default") {
      set(path, undefined);
    } else if (path.endsWith(".weight")) {
      set(path, Number(value));
    } else {
      set(path, value);
    }
    void commit();
  }
  // Color controls: a color picker commits on each pick (its change is the
  // change-end), and the × clears back to the theme default.
  function commitColor(path: string, v: string) {
    set(path, v);
    void commit();
  }
  function clearColor(path: string) {
    set(path, undefined);
    void commit();
  }

  function headingControls(level: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
    const h = style[level];
    return (
      <HGroup key={level} title={`H${level.toUpperCase()}`}>
        <SelectField
          label="Size"
          value={sizeSelectValue(h?.size)}
          options={SIZE_PRESETS.map((p) => ({ label: `${p.px}px`, value: String(p.px) }))}
          onCommit={(v) => commitSelect(`${level}.size`, v === "default" ? "default" : pxToEm(parseInt(v, 10)))}
        />
        <ColorField
          label="Color"
          value={h?.color}
          onPick={(v) => commitColor(`${level}.color`, v)}
          onClear={() => clearColor(`${level}.color`)}
        />
        <SelectField
          label="Weight"
          value={h?.weight !== undefined ? String(h.weight) : "default"}
          options={WEIGHT_OPTIONS.map((w) => ({ label: String(w), value: String(w) }))}
          onCommit={(v) => commitSelect(`${level}.weight`, v)}
        />
      </HGroup>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          marginBottom: "var(--space-4)",
        }}
      >
        <div style={{ flex: 1 }}>
          <SectionHeader description="Fine-tune how Markdown renders in chat and file previews." />
        </div>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!hasOverrides}
          onClick={() => void reset()}
          style={{ flexShrink: 0, marginTop: 2 }}
        >
          Reset to theme
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isNarrow ? "1fr" : "minmax(320px, 400px) 1fr",
          gap: "var(--space-4)",
        }}
      >
        {/* ── Controls ─────────────────────────────────────────────── */}
        <div>
          {headingControls("h1")}
          {headingControls("h2")}
          {headingControls("h3")}

          <div style={{ marginBottom: "var(--space-2)" }}>
            <button
              type="button"
              onClick={() => setShowH456((s) => !s)}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent)",
                cursor: "pointer",
                font: "inherit",
                fontSize: "var(--font-size-xs)",
                padding: 0,
              }}
            >
              {showH456 ? "▾" : "▸"} H4-H6
            </button>
          </div>

          {showH456 && (
            <>
              {headingControls("h4")}
              {headingControls("h5")}
              {headingControls("h6")}
            </>
          )}

          <HGroup title="Bold">
            <SelectField
              label="Weight"
              value={style.bold?.weight !== undefined ? String(style.bold.weight) : "default"}
              options={WEIGHT_OPTIONS.map((w) => ({ label: String(w), value: String(w) }))}
              onCommit={(v) => commitSelect("bold.weight", v)}
            />
            <ColorField
              label="Color"
              value={style.bold?.color}
              onPick={(v) => commitColor("bold.color", v)}
              onClear={() => clearColor("bold.color")}
            />
          </HGroup>

          <HGroup title="Italic">
            <SelectField
              label="Style"
              value={style.italic?.style ?? "default"}
              options={[
                { label: "italic", value: "italic" },
                { label: "oblique", value: "oblique" },
              ]}
              onCommit={(v) => commitSelect("italic.style", v)}
            />
            <ColorField
              label="Color"
              value={style.italic?.color}
              onPick={(v) => commitColor("italic.color", v)}
              onClear={() => clearColor("italic.color")}
            />
          </HGroup>

          <HGroup title="Inline code">
            <ColorField
              label="Background"
              value={style.inlineCode?.bg}
              onPick={(v) => commitColor("inlineCode.bg", v)}
              onClear={() => clearColor("inlineCode.bg")}
            />
            <ColorField
              label="Text"
              value={style.inlineCode?.color}
              onPick={(v) => commitColor("inlineCode.color", v)}
              onClear={() => clearColor("inlineCode.color")}
            />
          </HGroup>

          <HGroup title="Code block">
            <ColorField
              label="Background"
              value={style.codeBlock?.bg}
              onPick={(v) => commitColor("codeBlock.bg", v)}
              onClear={() => clearColor("codeBlock.bg")}
            />
            <ColorField
              label="Text"
              value={style.codeBlock?.color}
              onPick={(v) => commitColor("codeBlock.color", v)}
              onClear={() => clearColor("codeBlock.color")}
            />
            <ColorField
              label="Border"
              value={style.codeBlock?.border}
              onPick={(v) => commitColor("codeBlock.border", v)}
              onClear={() => clearColor("codeBlock.border")}
            />
            <SelectField
              label="Font"
              value={style.codeFontFamily ?? "default"}
              options={FONT_OPTIONS}
              onCommit={(v) => commitSelect("codeFontFamily", v)}
            />
          </HGroup>

          <HGroup title="Blockquote">
            <ColorField
              label="Border"
              value={style.blockquote?.border}
              onPick={(v) => commitColor("blockquote.border", v)}
              onClear={() => clearColor("blockquote.border")}
            />
            <ColorField
              label="Text"
              value={style.blockquote?.color}
              onPick={(v) => commitColor("blockquote.color", v)}
              onClear={() => clearColor("blockquote.color")}
            />
          </HGroup>

          <HGroup title="Link">
            <ColorField
              label="Color"
              value={style.link?.color}
              onPick={(v) => commitColor("link.color", v)}
              onClear={() => clearColor("link.color")}
            />
          </HGroup>
        </div>

        {/* ── Live preview ─────────────────────────────────────────── */}
        <div
          style={{
            border: "var(--border-width) solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-3)",
            background: "var(--bg-secondary)",
            alignSelf: "start",
          }}
        >
          <div style={{ ...labelStyle, marginBottom: "var(--space-2)" }}>Live preview — updates as you edit</div>
          <SettingsPreviewFixture themeId={themeId} />
        </div>
      </div>
    </div>
  );
}
