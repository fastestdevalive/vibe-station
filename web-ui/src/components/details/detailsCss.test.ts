import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "details.css"), "utf8");
const rule = (sel: string) => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? "";
};

describe("details.css (tools-pane-rework board 6)", () => {
  it("the backdrop is a fixed full-viewport layer", () => {
    const backdrop = rule(".file-details-backdrop");
    expect(backdrop).toContain("position: fixed");
    expect(backdrop).toContain("inset: 0");
  });

  it("the popup is capped at 480px and never wider than the viewport", () => {
    expect(rule(".file-details-popup")).toContain("min(480px, 100%)");
  });

  it("the body is a 92px label column beside a value column", () => {
    expect(rule(".file-details__list")).toContain("grid-template-columns: 92px minmax(0, 1fr)");
  });

  it("uses tokens only, no bare hex colours", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
