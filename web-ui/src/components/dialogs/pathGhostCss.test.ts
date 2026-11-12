import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../styles/workspace.css"), "utf8");

function block(header: string): string {
  const start = css.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("path ghost css", () => {
  it("R1F-04: the real input inherits the font and the ghost matches it", () => {
    expect(block(".path-ghost-field > input {")).toMatch(/font:\s*inherit/);
    const ghost = block("\n.path-ghost {");
    expect(ghost).toMatch(/font:\s*inherit/);
    expect(ghost).toMatch(/white-space:\s*pre/);
    expect(ghost).toMatch(/overflow:\s*hidden/);
    expect(ghost).toMatch(/pointer-events:\s*none/);
    expect(ghost).toContain("var(--fg-muted)");
    expect(ghost).not.toContain("#");
    expect(block(".path-ghost__typed {")).toMatch(/visibility:\s*hidden/);
  });

  it("R1F-06: path row is 44px / 16px on phones and the Up button stretches", () => {
    expect(block(".folder-chooser__nav {")).toMatch(/align-items:\s*stretch/);
    expect(block(".folder-chooser__input-wrap {")).toMatch(/font-size:\s*var\(--fs-input\)/);
    const phone = css.slice(css.indexOf("Phones: every tappable part of the folder chooser"));
    expect(phone.slice(0, phone.indexOf("min-height: var(--h-touch)"))).toContain(".folder-chooser__path-input");
  });

  it("typed-path fields: wrapper owns the font and is 44px / 16px on phones", () => {
    expect(block(".path-ghost-field--field {")).toMatch(/font-size:\s*var\(--font-size-sm\)/);
    const phone = css.slice(css.indexOf("@media (max-width: 640px) {\n  .path-ghost-field--field"));
    expect(phone.slice(0, 200)).toMatch(/--fs-input[\s\S]*--h-touch/);
    expect(block("\n.path-ghost {")).toContain("--path-ghost-left");
  });
});
