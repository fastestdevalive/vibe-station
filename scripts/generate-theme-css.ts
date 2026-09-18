/**
 * Generates the curated theme data consumed by later phases:
 *
 *   - web-ui/src/styles/themes.generated.css  — one `[data-theme="..."]` root block
 *     AND one `.theme-scope[data-theme="..."]` scoped block per theme (same
 *     declarations, different selector prefix — the scoped variant is for the
 *     hover-preview panel in Settings).
 *   - web-ui/src/theme/registry.ts            — the curated 14-theme metadata list
 *     (id, name, appearance, shikiThemeId, cssVars).
 *
 * The 12 borrowed themes' chrome tokens are derived at build time from the live,
 * installed `@shikijs/themes` package via a deterministic key-lookup + `mix()`
 * fallback table. Nothing here is hardcoded from the human-readable roster.
 *
 * The two Vibestation themes (rows 1-2) are NOT derived from Shiki — their chrome
 * tokens are hand-authored in web-ui/src/styles/tokens.css. This script embeds
 * their cssVars (matching those blocks) directly into the registry so every
 * registry entry carries the same shape.
 *
 * Run from the repo root: `tsx scripts/generate-theme-css.ts`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ShikiTheme = {
  name: string;
  displayName?: string;
  type?: string;
  colors: Record<string, string>;
};

type Appearance = "dark" | "light";

type RosterEntry = {
  id: string;
  name: string;
  appearance: Appearance;
  shikiThemeId: string;
  /** @shikijs/themes subpath specifier, e.g. "dracula". Only for the 12 borrowed themes. */
  shikiSpec?: string;
  /** Hand-authored chrome values for the two Vibestation themes (from tokens.css). */
  vibestationVars?: Record<string, string>;
};

const THEMES: RosterEntry[] = [
  {
    id: "vibestation-dark",
    name: "Vibestation Dark",
    appearance: "dark",
    shikiThemeId: "dark-plus",
    vibestationVars: {
      "--accent": "#e5e5e5",
      "--chat-accent": "#8a8a8a",
      "--bg-primary": "#0f0f0f",
      "--bg-secondary": "#151515",
      "--bg-card": "#191919",
      "--bg-elevated": "#1e1e1e",
      "--bg-overlay": "rgba(0, 0, 0, 0.7)",
      "--bg-input": "#1e1e1e",
      "--bg-hover": "#222222",
      "--bg-active": "#2a2a2a",
      "--bg-sidebar": "#030303",
      "--bg-sidebar-secondary": "#090909",
      "--fg-primary": "#e5e5e5",
      "--fg-secondary": "#a3a3a3",
      "--fg-muted": "#6b6b6b",
      "--fg-faint": "#404040",
      "--fg-inverse": "#0a0a0a",
      "--fg-danger": "#f85149",
      "--fg-success": "#16a34a",
      "--fg-warning": "#d29922",
      "--border-default": "#262626",
      "--border-subtle": "#1e1e1e",
      "--border-strong": "#404040",
      "--border-hover": "rgba(229, 229, 229, 0.15)",
      "--destructive": "#dc2626",
      "--destructive-muted": "#7f1d1d",
      "--destructive-soft": "#e89b96",
      "--success": "#16a34a",
      "--success-muted": "#14532d",
      "--warning": "#ca8a04",
      "--warning-muted": "#713f12",
      "--status-working": "#eab308",
      "--status-waiting": "#ef4444",
      "--pr-open": "#22c55e",
      "--pr-merged": "#8250df",
      "--pr-draft": "#8a8a8a",
      "--pr-closed": "#6b6b6b",
      "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
      "--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.4)",
      "--shadow-lg": "0 8px 24px rgba(0, 0, 0, 0.5)",
      "--term-background": "#0f0f0f",
      "--term-foreground": "#e5e5e5",
      "--term-cursor": "#e5e5e5",
      "--term-cursor-accent": "#0f0f0f",
      "--term-selection-bg": "rgba(229,229,229,0.2)",
      "--term-black": "#262626",
      "--term-red": "#f85149",
      "--term-green": "#22c55e",
      "--term-yellow": "#eab308",
      "--term-blue": "#3b82f6",
      "--term-magenta": "#8250df",
      "--term-cyan": "#06b6d4",
      "--term-white": "#d4d4d4",
      "--term-bright-black": "#404040",
      "--term-bright-red": "#fca5a5",
      "--term-bright-green": "#86efac",
      "--term-bright-yellow": "#fde047",
      "--term-bright-blue": "#93c5fd",
      "--term-bright-magenta": "#c084fc",
      "--term-bright-cyan": "#67e8f9",
      "--term-bright-white": "#e5e5e5",
    },
  },
  {
    id: "vibestation-light",
    name: "Vibestation Light",
    appearance: "light",
    shikiThemeId: "light-plus",
    vibestationVars: {
      "--accent": "#1a1a1a",
      "--chat-accent": "#737373",
      "--bg-primary": "#fafafa",
      "--bg-secondary": "#f5f5f5",
      "--bg-card": "#ffffff",
      "--bg-elevated": "#ffffff",
      "--bg-overlay": "rgba(0, 0, 0, 0.3)",
      "--bg-input": "#f5f5f5",
      "--bg-hover": "#f0f0f0",
      "--bg-active": "#e5e5e5",
      "--bg-sidebar": "#eeeeee",
      "--bg-sidebar-secondary": "#f4f4f4",
      "--fg-primary": "#171717",
      "--fg-secondary": "#404040",
      "--fg-muted": "#737373",
      "--fg-faint": "#d4d4d4",
      "--fg-inverse": "#fafafa",
      "--fg-danger": "#dc2626",
      "--fg-success": "#15803d",
      "--fg-warning": "#a16207",
      "--border-default": "#e5e5e5",
      "--border-subtle": "#f0f0f0",
      "--border-strong": "#d4d4d4",
      "--border-hover": "rgba(23, 23, 23, 0.1)",
      "--destructive": "#dc2626",
      "--destructive-muted": "#fecaca",
      "--destructive-soft": "#b5544f",
      "--success": "#16a34a",
      "--success-muted": "#bbf7d0",
      "--warning": "#ca8a04",
      "--warning-muted": "#fef08a",
      "--status-working": "#a16207",
      "--status-waiting": "#dc2626",
      "--pr-open": "#15803d",
      "--pr-merged": "#6e40c9",
      "--pr-draft": "#737373",
      "--pr-closed": "#737373",
      "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.05)",
      "--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.08)",
      "--shadow-lg": "0 8px 24px rgba(0, 0, 0, 0.12)",
      "--term-background": "#fafafa",
      "--term-foreground": "#171717",
      "--term-cursor": "#171717",
      "--term-cursor-accent": "#fafafa",
      "--term-selection-bg": "rgba(23,23,23,0.15)",
      "--term-black": "#404040",
      "--term-red": "#dc2626",
      "--term-green": "#15803d",
      "--term-yellow": "#a16207",
      "--term-blue": "#1d4ed8",
      "--term-magenta": "#6e40c9",
      "--term-cyan": "#0e7490",
      "--term-white": "#737373",
      "--term-bright-black": "#a3a3a3",
      "--term-bright-red": "#ef4444",
      "--term-bright-green": "#22c55e",
      "--term-bright-yellow": "#ca8a04",
      "--term-bright-blue": "#3b82f6",
      "--term-bright-magenta": "#8250df",
      "--term-bright-cyan": "#06b6d4",
      "--term-bright-white": "#a3a3a3",
    },
  },
  // Dracula was removed 2026-09-17 (see .vibekit/reports/2026-09-17-theme-catalog-revision.md):
  // its panel.border/editorGroup.border (#BD93F9) sits at 5.90:1 contrast against its
  // background -- 4x the pack median (1.1-1.5:1) for the same token, a real outlier
  // making --border-default/--border-subtle unusually bright, not a matter of taste.
  { id: "nord", name: "Nord", appearance: "dark", shikiThemeId: "nord", shikiSpec: "nord" },
  { id: "one-dark-pro", name: "One Dark Pro", appearance: "dark", shikiThemeId: "one-dark-pro", shikiSpec: "one-dark-pro" },
  { id: "monokai", name: "Monokai", appearance: "dark", shikiThemeId: "monokai", shikiSpec: "monokai" },
  { id: "github-dark", name: "GitHub Dark", appearance: "dark", shikiThemeId: "github-dark", shikiSpec: "github-dark" },
  { id: "github-light", name: "GitHub Light", appearance: "light", shikiThemeId: "github-light", shikiSpec: "github-light" },
  { id: "solarized-dark", name: "Solarized Dark", appearance: "dark", shikiThemeId: "solarized-dark", shikiSpec: "solarized-dark" },
  { id: "gruvbox-dark-hard", name: "Gruvbox Dark", appearance: "dark", shikiThemeId: "gruvbox-dark-hard", shikiSpec: "gruvbox-dark-hard" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", appearance: "dark", shikiThemeId: "catppuccin-mocha", shikiSpec: "catppuccin-mocha" },
  { id: "tokyo-night", name: "Tokyo Night", appearance: "dark", shikiThemeId: "tokyo-night", shikiSpec: "tokyo-night" },
  { id: "night-owl", name: "Night Owl", appearance: "dark", shikiThemeId: "night-owl", shikiSpec: "night-owl" },
  { id: "ayu-dark", name: "Ayu Dark", appearance: "dark", shikiThemeId: "ayu-dark", shikiSpec: "ayu-dark" },
  // 7 light themes added 2026-09-17 (same report) to fix the 12-dark/2-light imbalance --
  // each mirrors an existing kept dark family and was checked against deriveChrome()'s
  // required VS Code keys (editor.background/.foreground, sideBar.background,
  // editorWidget.background, descriptionForeground, panel.border, focusBorder,
  // terminal.ansi*); one-light has the weakest key coverage of the seven (several keys
  // fall back to mix()) -- same fallback-leaning pattern as nord/gruvbox-dark-hard above,
  // not a new risk, but worth a visual spot-check after regenerating.
  { id: "solarized-light", name: "Solarized Light", appearance: "light", shikiThemeId: "solarized-light", shikiSpec: "solarized-light" },
  { id: "one-light", name: "One Light", appearance: "light", shikiThemeId: "one-light", shikiSpec: "one-light" },
  { id: "gruvbox-light-hard", name: "Gruvbox Light", appearance: "light", shikiThemeId: "gruvbox-light-hard", shikiSpec: "gruvbox-light-hard" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", appearance: "light", shikiThemeId: "catppuccin-latte", shikiSpec: "catppuccin-latte" },
  { id: "night-owl-light", name: "Night Owl Light", appearance: "light", shikiThemeId: "night-owl-light", shikiSpec: "night-owl-light" },
  { id: "ayu-light", name: "Ayu Light", appearance: "light", shikiThemeId: "ayu-light", shikiSpec: "ayu-light" },
  { id: "github-light-default", name: "GitHub Light Default", appearance: "light", shikiThemeId: "github-light-default", shikiSpec: "github-light-default" },
];

const DEFAULT_THEME_ID = "vibestation-dark";

/* ── Color helpers ─────────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const to = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Linear RGB interpolation from `a` toward `b` by `pct` (0..1). */
function mix(a: string, b: string, pct: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * pct, ag + (bg - ag) * pct, ab + (bb - ab) * pct]);
}

/**
 * Subtract a fixed number of RGB units (clamped at 0) from a hex color —
 * deliberately NOT a percentage mix. A percentage mix toward black is nearly
 * invisible on an already-near-black --bg-primary (e.g. 35% of 15 is ~5) and
 * far too aggressive on a near-white one (35% of 250 is ~88 — a jarring
 * mid-grey sidebar next to a white content area). An absolute unit subtraction
 * stays visible-but-subtle at both extremes and matches how real IDEs
 * actually differentiate sidebar/editor chrome (e.g. VS Code Light+'s sidebar
 * #f3f3f3 vs. its editor #ffffff is exactly a 12-unit darken).
 */
function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([Math.max(0, r - amount), Math.max(0, g - amount), Math.max(0, b - amount)]);
}

function brighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([Math.min(255, r + amount), Math.min(255, g + amount), Math.min(255, b + amount)]);
}

/* ── Chrome-token derivation (Design Details → Theme Roster table) ─────────── */

function deriveTerminal(c: Record<string, string>, bg: string, fg: string, appearance: Appearance): Record<string, string> {
  const isDark = appearance === "dark";

  // Normalize primary key reads: strip 8-digit alpha (same mix(x,x,0) pattern as --accent at line 235-237,
  // to handle themes like Tokyo Night that use #RRGGBBAA values for terminal.* keys)
  function norm(raw: string | undefined): string | undefined {
    return raw != null ? mix(raw, raw, 0) : undefined;
  }

  // Regular ANSI colors — must be computed BEFORE bright fallbacks (which use these as inputs)
  const ansiRed     = norm(c["terminal.ansiRed"])     ?? "#ef4444";
  const ansiGreen   = norm(c["terminal.ansiGreen"])   ?? "#22c55e";
  const ansiYellow  = norm(c["terminal.ansiYellow"])  ?? "#eab308";
  const ansiBlue    = norm(c["terminal.ansiBlue"])    ?? "#3b82f6";
  const ansiMagenta = norm(c["terminal.ansiMagenta"]) ?? "#8250df";
  const ansiCyan    = norm(c["terminal.ansiCyan"])    ?? "#06b6d4";

  // Appearance-conditional fallbacks for black/white variants:
  // dark: black≈near-bg (low %), white≈near-fg (high %); light: reversed
  const termBlack       = norm(c["terminal.ansiBlack"])       ?? (isDark ? mix(bg, fg, 0.15) : mix(bg, fg, 0.85));
  const termWhite       = norm(c["terminal.ansiWhite"])       ?? (isDark ? mix(bg, fg, 0.85) : mix(bg, fg, 0.15));
  const termBrightBlack = norm(c["terminal.ansiBrightBlack"]) ?? (isDark ? mix(bg, fg, 0.35) : mix(bg, fg, 0.65));
  const termBrightWhite = norm(c["terminal.ansiBrightWhite"]) ?? (isDark ? mix(bg, fg, 0.95) : mix(bg, fg, 0.05));

  // selectionBackground: primary key normalized, fallback as rgba for overlay alpha
  const selBgRaw = norm(c["terminal.selectionBackground"]);
  let termSelectionBg: string;
  if (selBgRaw != null) {
    termSelectionBg = selBgRaw;
  } else {
    const [r, g, b] = hexToRgb(mix(fg, bg, 0.3));
    termSelectionBg = `rgba(${r},${g},${b},0.3)`;
  }

  return {
    "--term-background":    norm(c["terminal.background"])          ?? bg,
    "--term-foreground":    norm(c["terminal.foreground"])          ?? fg,
    "--term-cursor":        norm(c["terminalCursor.foreground"])    ?? fg,
    "--term-cursor-accent": norm(c["terminalCursor.background"])    ?? bg,
    "--term-selection-bg":  termSelectionBg,
    "--term-black":         termBlack,
    "--term-red":           ansiRed,
    "--term-green":         ansiGreen,
    "--term-yellow":        ansiYellow,
    "--term-blue":          ansiBlue,
    "--term-magenta":       ansiMagenta,
    "--term-cyan":          ansiCyan,
    "--term-white":         termWhite,
    "--term-bright-black":  termBrightBlack,
    "--term-bright-red":    norm(c["terminal.ansiBrightRed"])    ?? brighten(ansiRed,     20),
    "--term-bright-green":  norm(c["terminal.ansiBrightGreen"])  ?? brighten(ansiGreen,   20),
    "--term-bright-yellow": norm(c["terminal.ansiBrightYellow"]) ?? brighten(ansiYellow,  20),
    "--term-bright-blue":   norm(c["terminal.ansiBrightBlue"])   ?? brighten(ansiBlue,    20),
    "--term-bright-magenta":norm(c["terminal.ansiBrightMagenta"])  ?? brighten(ansiMagenta, 20),
    "--term-bright-cyan":   norm(c["terminal.ansiBrightCyan"])   ?? brighten(ansiCyan,    20),
    "--term-bright-white":  termBrightWhite,
  };
}

function deriveChrome(theme: ShikiTheme, appearance: Appearance): Record<string, string> {
  const c = theme.colors;
  const bg = c["editor.background"] ?? "#000000";
  const fg = c["editor.foreground"] ?? "#ffffff";

  const bgSecondary = c["sideBar.background"] ?? bg;
  const bgCard = c["editorWidget.background"] ?? bg;
  const fgSecondary = c["descriptionForeground"] ?? mix(fg, bg, 0.25);
  const fgMuted = c["tab.inactiveForeground"] ?? mix(fg, bg, 0.45);
  const fgFaint = c["editorLineNumber.foreground"] ?? mix(fg, bg, 0.65);
  const borderDefault = c["panel.border"] ?? mix(bg, fg, 0.12);
  const borderSubtle = c["editorGroup.border"] ?? mix(bg, fg, 0.06);
  const borderStrong = c["focusBorder"] ?? mix(bg, fg, 0.25);
  // A UI accent is used for text/link colour, so it must be opaque — strip any
  // alpha the theme's focusBorder/button.background carries (e.g. Tokyo Night's
  // `#545c7e33`). mix(x, x, 0) normalizes an 8-digit hex to its 6-digit RGB.
  const accent = mix(c["focusBorder"] ?? c["button.background"] ?? fg, c["focusBorder"] ?? c["button.background"] ?? fg, 0);

  const ansiRed = c["terminal.ansiRed"] ?? "#ef4444";
  const ansiYellow = c["terminal.ansiYellow"] ?? "#eab308";
  const ansiGreen = c["terminal.ansiGreen"] ?? "#22c55e";
  const ansiMagenta = c["terminal.ansiMagenta"] ?? "#8250df";
  const ansiBrightBlack = c["terminal.ansiBrightBlack"] ?? fgMuted;
  const ansiBlack = c["terminal.ansiBlack"] ?? fgMuted;

  const destructive = c["errorForeground"] ?? ansiRed;
  const success = ansiGreen;
  const warning = ansiYellow;
  const isDark = appearance === "dark";

  const shadows = isDark
    ? {
        "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
        "--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.4)",
        "--shadow-lg": "0 8px 24px rgba(0, 0, 0, 0.5)",
      }
    : {
        "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.05)",
        "--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.08)",
        "--shadow-lg": "0 8px 24px rgba(0, 0, 0, 0.12)",
      };

  return {
    ...deriveTerminal(c, bg, fg, appearance),
    "--accent": accent,
    "--chat-accent": fgMuted,
    "--bg-primary": bg,
    "--bg-secondary": bgSecondary,
    "--bg-card": bgCard,
    "--bg-elevated": bgCard,
    // Sidebar layering (darkest → lightest: sidebar < sidebar-secondary < bg-primary).
    // See darken()'s doc comment for why this is an absolute unit subtraction, not
    // a per-theme VS Code key lookup — a guaranteed-consistent hierarchy across all
    // 14 themes matters more here than per-theme authenticity to activityBar/sideBar
    // values, which aren't reliably darker than editor.background in every theme.
    "--bg-sidebar": darken(bg, 12),
    "--bg-sidebar-secondary": darken(bg, 6),
    "--bg-overlay": isDark ? "rgba(0, 0, 0, 0.7)" : "rgba(0, 0, 0, 0.3)",
    "--bg-input": c["input.background"] ?? bgSecondary,
    "--bg-hover": c["list.hoverBackground"] ?? mix(bg, fg, 0.06),
    "--bg-active": c["list.activeSelectionBackground"] ?? mix(bg, fg, 0.1),
    "--fg-primary": fg,
    "--fg-secondary": fgSecondary,
    "--fg-muted": fgMuted,
    "--fg-faint": fgFaint,
    "--fg-inverse": bg,
    "--fg-danger": destructive,
    "--fg-success": success,
    "--fg-warning": warning,
    "--border-default": borderDefault,
    "--border-subtle": borderSubtle,
    "--border-strong": borderStrong,
    "--border-hover": `color-mix(in srgb, var(--fg-primary) 12%, transparent)`,
    "--destructive": destructive,
    "--destructive-muted": mix(destructive, bg, 0.6),
    "--destructive-soft": mix(destructive, fg, 0.3),
    "--success": success,
    "--success-muted": mix(success, bg, 0.6),
    "--warning": warning,
    "--warning-muted": mix(warning, bg, 0.6),
    "--status-working": c["terminal.ansiYellow"] ?? "#eab308",
    "--status-waiting": c["terminal.ansiRed"] ?? c["errorForeground"] ?? ansiRed,
    "--pr-open": c["terminal.ansiGreen"] ?? "#22c55e",
    "--pr-merged": c["terminal.ansiMagenta"] ?? "#8250df",
    "--pr-draft": c["terminal.ansiBrightBlack"] ?? c["descriptionForeground"] ?? fgMuted,
    "--pr-closed": c["terminal.ansiBlack"] ?? fgMuted,
    ...shadows,
  };
}

/* ── Theme-invariant Markdown defaults (matching today's workspace.css) ────── */

const MD_SIZES = ["2.14em", "1.57em", "1.29em", "1.07em", "0.86em", "0.86em"]; // h1..h6
const MD_WEIGHT = "600";

const MD_INVARIANT: Record<string, string> = {
  "--md-code-font-family": "var(--font-mono)",
  "--md-italic-style": "italic",
  "--md-bold-weight": MD_WEIGHT,
};

const MD_COLOR_REFS: Record<string, string> = {
  "--md-h1-color": "var(--fg-primary)",
  "--md-h2-color": "var(--fg-primary)",
  "--md-h3-color": "var(--fg-primary)",
  "--md-h4-color": "var(--fg-primary)",
  "--md-h5-color": "var(--fg-primary)",
  "--md-h6-color": "var(--fg-primary)",
  "--md-bold-color": "var(--fg-primary)",
  "--md-italic-color": "var(--fg-secondary)",
  "--md-inline-code-bg": "var(--bg-secondary)",
  "--md-inline-code-color": "var(--fg-primary)",
  "--md-code-block-bg": "var(--bg-secondary)",
  "--md-code-block-color": "var(--fg-primary)",
  "--md-code-block-border": "var(--border-default)",
  "--md-blockquote-border": "var(--border-strong)",
  "--md-blockquote-color": "var(--fg-secondary)",
  "--md-link-color": "var(--accent)",
};

for (let i = 0; i < 6; i++) {
  const n = i + 1;
  MD_INVARIANT[`--md-h${n}-size`] = MD_SIZES[i] ?? "";
  MD_INVARIANT[`--md-h${n}-weight`] = MD_WEIGHT;
}

function fullPropertySet(chrome: Record<string, string>): Record<string, string> {
  return {
    ...chrome,
    ...MD_COLOR_REFS,
    ...MD_INVARIANT,
  };
}

/* ── Registry + CSS emission ───────────────────────────────────────────────── */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function quote(v: string): string {
  return JSON.stringify(v);
}

function cssVarLines(props: Record<string, string>, colorScheme: Appearance): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(props)) {
    lines.push(`  ${name}: ${value};`);
  }
  lines.push(`  color-scheme: ${colorScheme};`);
  return lines;
}

function emitThemeCss(entry: RosterEntry, props: Record<string, string>): string {
  const scheme = entry.appearance;
  const rootBlock = `[data-theme=${quote(entry.id)}] {\n${cssVarLines(props, scheme).join("\n")}\n}`;
  const scopedBlock = `.theme-scope[data-theme=${quote(entry.id)}] {\n${cssVarLines(props, scheme).join("\n")}\n}`;
  return `${rootBlock}\n\n${scopedBlock}`;
}

function registryCssVarsLiteral(chrome: Record<string, string>): string {
  const props = fullPropertySet(chrome);
  const body = Object.entries(props)
    .map(([k, v]) => `      ${quote(k)}: ${quote(v)},`)
    .join("\n");
  return `{\n${body}\n    }`;
}

async function loadTheme(entry: RosterEntry): Promise<ShikiTheme | null> {
  if (!entry.shikiSpec) return null;
  const mod = (await import(`@shikijs/themes/${entry.shikiSpec}`)) as { default: ShikiTheme };
  return mod.default;
}

async function main(): Promise<void> {
  const registryEntries: { entry: RosterEntry; cssVars: Record<string, string> }[] = [];

  const cssBlocks: string[] = [
    "/* GENERATED by scripts/generate-theme-css.ts — do not edit by hand.",
    "   Regenerate with: `tsx scripts/generate-theme-css.ts`.",
    "   One root `[data-theme=...]` block and one `.theme-scope[data-theme=...]` block",
    "   per theme (the scoped variant powers the Settings hover-preview panel).",
    "   These blocks key on `[data-theme=...]` only; the `data-appearance` attribute",
    "   is written by JS (useTheme.ts), never by CSS. */",
    "",
  ];

  for (const entry of THEMES) {
    let chrome: Record<string, string>;
    if (entry.vibestationVars) {
      chrome = entry.vibestationVars;
    } else {
      const theme = await loadTheme(entry);
      if (!theme) throw new Error(`No shiki theme spec for ${entry.id}`);
      chrome = deriveChrome(theme, entry.appearance);
    }
    registryEntries.push({ entry, cssVars: fullPropertySet(chrome) });
    cssBlocks.push(emitThemeCss(entry, fullPropertySet(chrome)));
  }

  const registry = `// GENERATED by scripts/generate-theme-css.ts — do not edit by hand.
// Regenerate with: \`tsx scripts/generate-theme-css.ts\`.
// The 12 borrowed themes' cssVars are derived from the live @shikijs/themes
// package; the 2 Vibestation themes' cssVars mirror web-ui/src/styles/tokens.css.

export type ThemeAppearance = "dark" | "light";

export interface ThemeRegistryEntry {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  shikiThemeId: string;
  cssVars: Record<string, string>;
}

export const defaultThemeId = ${quote(DEFAULT_THEME_ID)};

export const themes: ThemeRegistryEntry[] = [
${registryEntries
  .map(
    ({ entry, cssVars }) => `  {
    id: ${quote(entry.id)},
    name: ${quote(entry.name)},
    appearance: ${quote(entry.appearance)},
    shikiThemeId: ${quote(entry.shikiThemeId)},
    cssVars: ${registryCssVarsLiteral(cssVars)},
  },`,  )
  .join("\n")}
];

export const themeById: Record<string, ThemeRegistryEntry> = Object.fromEntries(
  themes.map((t) => [t.id, t]),
);
`;

  const themeDir = resolve(repoRoot, "web-ui/src/theme");
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(resolve(themeDir, "registry.ts"), registry, "utf8");
  writeFileSync(resolve(repoRoot, "web-ui/src/styles/themes.generated.css"), cssBlocks.join("\n"), "utf8");

  console.log(`Wrote ${registryEntries.length} themes:`);
  for (const { entry } of registryEntries) {
    console.log(`  ${entry.id} (${entry.appearance})`);
  }
  console.log("→ web-ui/src/theme/registry.ts");
  console.log("→ web-ui/src/styles/themes.generated.css");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
