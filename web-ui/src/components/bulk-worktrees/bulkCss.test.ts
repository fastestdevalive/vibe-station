import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom cannot evaluate container queries, so assert on the CSS text instead.
const css = readFileSync(resolve(__dirname, "bulk-worktrees.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(query: string): string {
  const start = css.indexOf(query);
  expect(start, `missing ${query}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${query}`);
}

describe("bulk-worktrees.css narrow-width adaptations", () => {
  it("R1F-01: the worktree row is a size container and hides the chip below 270px", () => {
    expect(css).toMatch(/\.tree-row--worktree:has\(> \.bulk-row__trail\)\s*\{[^}]*container:\s*bulk-row \/ inline-size/);
    expect(block("@container bulk-row (max-width: 269px)")).toMatch(/\.bulk-row__chip\s*\{\s*display:\s*none/);
  });

  it("R1F-02: the action bar drops its count below 260px", () => {
    expect(css).toMatch(/\.bulk-action-bar\s*\{[^}]*container:\s*bulk-bar \/ inline-size/);
    expect(block("@container bulk-bar (max-width: 259px)")).toMatch(
      /\.bulk-action-bar__count\s*\{\s*display:\s*none/,
    );
  });

  it("R1F-03: the heading drops the redundant noun below 165px", () => {
    expect(css).toMatch(/\.bulk-heading__title\s*\{[^}]*container:\s*bulk-heading \/ inline-size/);
    expect(block("@container bulk-heading (max-width: 164px)")).toMatch(
      /\.bulk-heading__extra\s*\{\s*display:\s*none/,
    );
  });

  it("R1F-05: the tray card keeps text on one line and moves links below when narrow", () => {
    expect(css).toMatch(/\.bulk-tray__card\s*\{[^}]*container:\s*bulk-tray \/ inline-size/);
    expect(css).toMatch(/\.bulk-tray__text\s*\{[^}]*white-space:\s*nowrap/);
    const narrow = block("@container bulk-tray (max-width: 249px)");
    expect(narrow).toMatch(/\.bulk-tray__verb-extra\s*\{\s*display:\s*none/);
    expect(narrow).toMatch(/\.bulk-tray__row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("R1F-06: text-only select controls keep the height of the buttons they replace", () => {
    expect(css).toMatch(/\.bulk-heading__esc\s*\{[^}]*min-height:\s*36px/);
    expect(css).toMatch(/\.bulk-select-all\s*\{[^}]*min-height:\s*var\(--row-action-w\)/);
  });

  it("R1F-07: light-theme unchecked boxes use --fg-muted and no token is redefined", () => {
    expect(css).toMatch(
      /\[data-appearance="light"\] \.bulk-row__checkbox:not\(\[data-checked="true"\]\)\s*\{[^}]*border-color:\s*var\(--fg-muted\)/,
    );
    expect(css).not.toMatch(/--border-strong\s*:/);
  });

  it("R1F-08: a failed row's status label is tinted destructive", () => {
    expect(css).toMatch(
      /\.tree-row\[data-bulk-state="failed"\] \.bulk-row__status\s*\{[^}]*color:\s*var\(--destructive-soft\)/,
    );
  });
});
