import { describe, expect, it } from "vitest";
import { defaultThemeId, themes } from "./registry";

describe("theme registry", () => {
  it("ships exactly the 20 curated themes", () => {
    // 11 dark / 9 light -- revised 2026-09-17 (.vibekit/reports/2026-09-17-theme-catalog-revision.md)
    // to drop Dracula (an outlier border-contrast bug, not a taste call) and fix the
    // original 12-dark/2-light imbalance with 7 new light themes.
    expect(themes).toHaveLength(20);
    expect(new Set(themes.map((t) => t.id)).size).toBe(20);
    expect(themes.filter((t) => t.appearance === "dark")).toHaveLength(11);
    expect(themes.filter((t) => t.appearance === "light")).toHaveLength(9);
    expect(themes.some((t) => t.id === "dracula")).toBe(false);
  });

  it("defaults to vibestation-dark", () => {
    expect(defaultThemeId).toBe("vibestation-dark");
    expect(themes.some((t) => t.id === defaultThemeId)).toBe(true);
  });

  it("every registry entry exposes the full token set matching vibestation-dark", () => {
    const reference = themes.find((t) => t.id === defaultThemeId);
    expect(reference).toBeDefined();
    const referenceProps = Object.keys(reference!.cssVars).sort();

    for (const theme of themes) {
      const props = Object.keys(theme.cssVars).sort();
      expect(props, `theme "${theme.id}" token set`).toEqual(referenceProps);
    }
  });

  it("every theme's token set includes the status/pr/md groups", () => {
    const requiredGroups = ["--status-working", "--status-waiting", "--pr-open", "--pr-merged", "--pr-draft", "--pr-closed"];
    const mdProps = ["--md-h1-size", "--md-h1-color", "--md-h1-weight", "--md-h6-color", "--md-code-block-border", "--md-link-color"];

    for (const theme of themes) {
      for (const prop of [...requiredGroups, ...mdProps]) {
        expect(theme.cssVars, `theme "${theme.id}" missing ${prop}`).toHaveProperty(prop);
      }
    }
  });
});
