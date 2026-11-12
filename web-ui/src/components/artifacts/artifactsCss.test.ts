import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "artifacts.css"), "utf8");
const rule = (sel: string) => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? "";
};

// The list is 120-240px wide on a phone (right of the preview); its chrome must wrap/ellipsize, not clip.
describe("artifacts.css narrow list", () => {
  it("the tools row wraps and the meta text ellipsizes instead of clipping", () => {
    expect(rule(".artifacts-tools")).toContain("flex-wrap: wrap");
    const meta = rule(".artifacts-tools__meta");
    expect(meta).toContain("flex-shrink: 1");
    expect(meta).toContain("text-overflow: ellipsis");
  });

  it("the head is an .actions-row with a 10px gutter and the title ellipsizes", () => {
    // Padding itself comes from `.actions-row` (workspace.css; asserted in styles/anchorCss.test.ts): the head only
    // overrides the gutter variable.
    expect(rule(".artifacts-head")).toContain("--actions-row-pad: 10px");
    expect(rule(".artifacts-head")).not.toMatch(/(^|[\s;])padding(-right)?:/);
    const title = rule(".artifacts-head__title");
    expect(title).toContain("min-width: 0");
    expect(title).toContain("text-overflow: ellipsis");
  });

  it("the agent picker never grows past the tools row", () => {
    const picker = rule(".artifacts-agent-picker");
    expect(picker).toContain("max-width: 100%");
    expect(picker).toContain("min-width: 0");
  });

  it("the row sub line wraps its path and chips", () => {
    expect(rule(".artifacts-row__sub")).toContain("flex-wrap: wrap");
  });
});
