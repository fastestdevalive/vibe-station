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
  it("the list has no tools row: the agent dropdown lives in the header and ellipsizes", () => {
    expect(rule(".artifacts-tools")).toBe("");
    const picker = rule(".artifacts-agent-picker");
    expect(picker).toContain("min-width: 0");
    expect(picker).toContain("text-overflow: ellipsis");
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

  it("the agent picker is a borderless text dropdown in the rail header (R1F-03)", () => {
    expect(rule(".artifacts-agent-picker")).not.toContain("border:");
  });

  it("the row is one line: a fixed height and the name ellipsizes (no sub line)", () => {
    expect(rule(".artifacts-row")).toContain("height: 28px");
    expect(rule(".artifacts-row__sub")).toBe("");
    const name = rule(".artifacts-row__name");
    expect(name).toContain("text-overflow: ellipsis");
  });
});
