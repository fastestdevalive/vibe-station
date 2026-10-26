import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(resolve(process.cwd(), "src/styles", f), "utf8");
const tokens = read("tokens.css");
const generated = read("themes.generated.css");
const updateCss = read("update.css");

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const varIn = (body: string, name: string) =>
  new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body)?.[1];

/** Ink: `:root` default, overridden by a `[data-theme="x"]` block in tokens.css. */
function ink(theme: string, name: string): string {
  const own = new RegExp(`\\[data-theme="${theme}"\\] \\{([^}]*)\\}`).exec(tokens)?.[1] ?? "";
  const root = /:root \{([^}]*--fg-on-success[^}]*)\}/.exec(tokens)?.[1] ?? "";
  return (varIn(own, name) ?? varIn(root, name))!;
}

const themes = [...generated.matchAll(/^\[data-theme="([^"]+)"\] \{([\s\S]*?)^\}/gm)].map((m) => ({
  id: m[1]!,
  success: varIn(m[2]!, "success")!,
  warning: varIn(m[2]!, "warning")!,
}));

describe("update chip text contrast", () => {
  it("covers every theme", () => {
    expect(themes.length).toBeGreaterThanOrEqual(20);
  });

  it("restart-pending / rolled-back chips use the on-fill ink tokens", () => {
    expect(updateCss).toMatch(/--restart[^}]*color:\s*var\(--fg-on-success\)/s);
    expect(updateCss).toMatch(/--rolled-back[^}]*color:\s*var\(--fg-on-warning\)/s);
  });

  it.each(themes.map((t) => [t.id, t.success, t.warning] as [string, string, string]))(
    "%s: ink on success/warning fill is >= 4.5:1",
    (id, success, warning) => {
    expect(contrast(ink(id, "fg-on-success"), success)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink(id, "fg-on-warning"), warning)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("the old --bg-primary text failed in the light theme (documents the bug)", () => {
    expect(contrast("#fafafa", "#16a34a")).toBeLessThan(4.5);
    expect(contrast("#fafafa", "#ca8a04")).toBeLessThan(4.5);
  });
});
