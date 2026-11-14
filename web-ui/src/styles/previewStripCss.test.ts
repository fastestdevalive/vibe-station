import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "workspace.css"), "utf8");

describe("workspace.css preview strip (R1F-01)", () => {
  it("the absolute font overlay is gone (text size lives in the one File menu) and the strip name never truncates", () => {
    expect(css).not.toContain("--preview-font-overlay-w");
    expect(css).not.toContain(".preview-font-overlay");
    expect(css).toMatch(/\.file-strip__name \{\s*flex: none;/);
  });
  it("phones scroll leftover strip items instead of overlapping them", () => {
    expect(css).toMatch(/@media \(max-width: 768px\) \{\s*\.preview-diffinfo \{ overflow-x: auto/);
  });
  it("the strip's main row scrolls sideways; the spacer is gone (R1F-02)", () => {
    expect(css).toMatch(/\.file-strip > \.file-strip__main \{[^}]*overflow-x: auto;/);
    expect(css).not.toContain(".file-strip__sp");
  });
  it("a long name scrolls in its own box with a fade; counts stay pinned (R1F-02b)", () => {
    expect(css).toMatch(/\.file-strip__namewrap \{[^}]*overflow-x: auto;/);
    expect(css).toMatch(/\.file-strip__namewrap \{[^}]*mask-image: linear-gradient\(/);
    expect(css).toMatch(/\.file-strip__dir \{[^}]*flex: 0 1000 auto;/);
  });
  it("the view switch sits in the strip with no rule under it (R1F-13)", () => {
    expect(css).toMatch(/\.file-strip > \.preview-diff-layout-toggle \{[^}]*border-bottom: 0;/);
  });
});

describe("workspace.css rail header (R1F-03, retargeted to the rail header)", () => {
  it("the header is a query container that trims itself when narrow", () => {
    expect(css).toContain("container: rail-header / inline-size");
    // Under 260px the text dropdown drops its label and keeps the chevron; the title truncates last.
    expect(css).toMatch(/@container rail-header \(max-width: 260px\) \{\s*\.rail-header__txt-label \{\s*display: none;/);
  });
  it("the trim comes AFTER the base label rule, or that rule wins the cascade", () => {
    const base = css.indexOf(".rail-header__txt-label {");
    expect(base).toBeGreaterThan(0);
    expect(css.indexOf("@container rail-header (max-width: 260px)")).toBeGreaterThan(base);
  });
  it("the old tree-header scope slot / delta / diff-toggle rules are gone with the triangle and the chips", () => {
    expect(css).not.toContain(".file-tree-scope-delta");
    expect(css).not.toContain(".file-tree-scope-slot");
    expect(css).not.toContain(".file-tree-diff-toggle");
  });
  it("the right zone is flex items of the header, so the text dropdown gives way before the title (R1F-03)", () => {
    expect(css).toMatch(/\.rail-header__right \{\s*display: contents;/);
    expect(css).toMatch(/\.rail-header__txt \{[^}]*flex: 0 1000 auto;/);
  });
});

describe("workspace.css narrow rail header (R1F-04, R1F-05, R1F-07)", () => {
  it("the 200px container block comes after the 260px block", () => {
    const narrow = css.indexOf("@container rail-header (max-width: 200px)");
    expect(narrow).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(css.indexOf("@container rail-header (max-width: 260px)"));
  });
  it("a phone docked commit list keeps its title: the 200px block hides the count and the pane controls (R2F-06)", () => {
    const narrow = css.slice(css.indexOf("@container rail-header (max-width: 200px)"));
    expect(narrow).toContain(".vcs-list__head .rail-header__right");
    expect(narrow).toContain(".vcs-list__head .rail-header__count");
  });
  it("a picked agent keeps its picker in the 200px header; no filter drops it so the title wins (R2F-01)", () => {
    const narrow = css.slice(css.indexOf("@container rail-header (max-width: 200px)"));
    expect(narrow).toContain(".artifacts-head .artifacts-agent-picker:not([data-active])");
  });
});

describe("workspace.css rail menu (R1F-12)", () => {
  it("the menu row, separator and label have rules", () => {
    expect(css).toContain(".rail-menu__row {");
    expect(css).toContain(".rail-menu__sep {");
  });
  it("the phone bottom sheet uses 44px rows and the menu items use the 13px UI size", () => {
    expect(css).toMatch(/\.artifacts-menu--sheet \.rail-menu__item \{\s*min-height: 44px;/);
    expect(css).toMatch(/\.rail-menu__item \{[^}]*font-size: var\(--fs-ui\);/);
  });
  it("the phone sheet's text-size steps are 44px touch targets (R2F-02)", () => {
    expect(css).toMatch(/\.artifacts-menu--sheet \.rail-menu__step \{\s*width: 44px;\s*height: 44px;/);
  });
});

describe("workspace.css tools-pane tap targets (R1F-05)", () => {
  it("phones get 44x35 layout/fullscreen buttons scoped to the tools pane", () => {
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{\s*\.tool-panel \.tab\.tab--icon\.tool-bar-btn \{\s*width: 44px;[\s\S]*?height: 35px;/,
    );
  });
});
