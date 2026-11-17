import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCascade } from "@/test/cssCascade";

const css = loadCascade(readFileSync(resolve(__dirname, "OobeFlow.css"), "utf8"));

/**
 * R2F-09: at phone width the onboarding content scrolls and Skip / Continue stay
 * pinned to the bottom edge. Step 3 drops the screen's own bottom padding so no
 * wallpaper tile shows below the pinned bar.
 */
describe("Onboarding phone layout", () => {
  it("step 3 drops the screen's bottom padding on phones", () => {
    expect(css.px(".oobe-screen:has(.oobe-bg)", "padding-bottom", { phone: true })).toBe(0);
    // The rule is phone-only: every step keeps the design's 24px padding on desktop.
    expect(css.px(".oobe-screen:has(.oobe-bg)", "padding-bottom")).toBeNull();
  });

  it("the pinned bar keeps clear of the phone's home indicator", () => {
    expect(css.px(".oobe-bg__foot", "bottom", { phone: true })).toBe(0);
    expect(css.decls(".oobe-bg__foot", { phone: true })["padding-bottom"]).toContain(
      "env(safe-area-inset-bottom)",
    );
  });

  it("Skip / Continue are 44px touch targets on phones only", () => {
    expect(css.px(".oobe-bg__foot .btn", "min-height", { phone: true })).toBe(44);
    // Desktop keeps the design's button height: no such rule outside the phone block.
    expect(css.decls(".oobe-bg__foot .btn")["min-height"]).toBeUndefined();
  });
});
