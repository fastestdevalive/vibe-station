import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "workspace.css"), "utf8");

describe("workspace.css tree header (R1F-03)", () => {
  it("the header is a query container that trims itself when narrow", () => {
    expect(css).toContain("container: file-tree-header / inline-size");
    // Phones trim up to 260px and drop the scope chips at <=200px (the header also carries the pane controls).
    expect(css).toMatch(/@media \(max-width: 768px\) \{\s*@container file-tree-header \(max-width: 200px\) \{\s*\.file-tree-scope-slot \{ display: none; \}/);
    expect(css).toMatch(/@container file-tree-header \(max-width: 260px\) \{[\s\S]*\.file-tree-scope-delta \{ display: none; \}/);
  });
  it("the trims come AFTER the base slot/tail rules, or those win the cascade (the phone trim silently did nothing once)", () => {
    const base = css.indexOf(".file-tree-scope-slot {\n  display: flex;");
    expect(base).toBeGreaterThan(0);
    expect(css.indexOf("@container file-tree-header (max-width: 260px)")).toBeGreaterThan(base);
    expect(css.indexOf("@container file-tree-header (max-width: 320px)")).toBeGreaterThan(base);
  });
});

describe("workspace.css tools-pane tap targets (R1F-05)", () => {
  it("phones get 44x35 layout/fullscreen buttons scoped to the tools pane", () => {
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{\s*\.tool-panel \.tab\.tab--icon\.tool-bar-btn \{\s*width: 44px;[\s\S]*?height: 35px;/,
    );
  });
});
