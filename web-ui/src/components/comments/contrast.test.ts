import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Parse `--token: #hex;` from one `[data-theme="..."]` block of themes.generated.css. */
function tokens(theme: string): Record<string, string> {
  const css = readFileSync(resolve(__dirname, "../../styles/themes.generated.css"), "utf8");
  const start = css.indexOf(`\n[data-theme="${theme}"] {`);
  const end = css.indexOf("\n}", start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `color-mix(in srgb, A 75%, B)` of two hex colours, as tokens.css defines `--comment-muted`. */
function mix(a: string, b: string, aShare: number): string {
  const ch = (i: number) => Math.round(parseInt(a.slice(i, i + 2), 16) * aShare + parseInt(b.slice(i, i + 2), 16) * (1 - aShare));
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}

// `--comment` is `var(--fg-primary)` in both themes (tokens.css), so a pin icon is --fg-inverse on --fg-primary.
const TEXT: Array<[string, string, string]> = [
  ["primary text on a comment box / tray", "fg-primary", "bg-elevated"],
  ["--comment-muted meta on the tray / box", "comment-muted", "bg-elevated"],
  ["--comment-muted meta on the list", "comment-muted", "bg-secondary"],
  ["--comment-muted meta on the chat footer body", "comment-muted", "bg-secondary"],
  ["warning copy (restored, timed out, outdated note) on the tray", "fg-warning", "bg-elevated"],
  ["warning copy on the list", "fg-warning", "bg-secondary"],
  ["danger copy (agent exited) on the tray", "fg-danger", "bg-elevated"],
  ["secondary text on cards", "fg-secondary", "bg-card"],
];
const PINS: Array<[string, string, string]> = [
  ["pin icon on --comment", "fg-inverse", "fg-primary"],
  ["outdated pin icon on --fg-warning", "fg-inverse", "fg-warning"],
  ["draft pin icon --comment on --bg-primary", "fg-primary", "bg-primary"],
];

describe("--comment-muted is defined as that mix in tokens.css", () => {
  it("matches", () => {
    const css = readFileSync(resolve(__dirname, "../../styles/tokens.css"), "utf8");
    expect(css).toMatch(/--comment-muted:\s*color-mix\(in srgb, var\(--fg-muted\) 75%, var\(--fg-primary\)\);/);
  });
});

describe.each(["vibestation-dark", "vibestation-light"])("contrast in %s (7.3, R87)", (theme) => {
  const t = tokens(theme);
  // the derived token (tokens.css): 75% muted, 25% primary foreground
  t["comment-muted"] = mix(t["fg-muted"]!, t["fg-primary"]!, 0.75);
  it.each(TEXT)("text >= 4.5:1: %s", (_n, fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it.each(PINS)("pins >= 3:1: %s", (_n, fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});
