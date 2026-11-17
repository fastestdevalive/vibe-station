import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCascade } from "@/test/cssCascade";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

/**
 * CUJ7: at phone width (≤768px) every control in Settings › Background has a
 * 44px-tall hit area, while the drawn track keeps the design's size. jsdom has
 * no layout engine, so these assert the resolved declarations of the mobile
 * media block (desktop must stay unchanged).
 */
describe("Settings › Background phone touch targets", () => {
  it("the visibility and intensity sliders are ≥44px tall on phones", () => {
    const visibility = loadCascade(read("visibilitySection.css"));
    const picker = loadCascade(read("picker.css"));

    expect(visibility.px(".bg-vis__range", "min-height", { phone: true })).toBeGreaterThanOrEqual(44);
    expect(picker.px(".wp-intensity__range", "min-height", { phone: true })).toBeGreaterThanOrEqual(44);

    // Desktop keeps the slim input box.
    expect(visibility.px(".bg-vis__range", "min-height")).toBeNull();
    expect(picker.px(".wp-intensity__range", "min-height")).toBeNull();
  });

  it("the per-agent switch hit area is ≥44px tall on phones, track unchanged", () => {
    const settings = loadCascade(read("../settings/backgroundSetting.css"));

    expect(settings.px(".bg-own-switch", "min-height", { phone: true })).toBeGreaterThanOrEqual(44);
    expect(settings.px(".bg-own-switch", "min-height")).toBeNull();

    // The drawn track stays the design's 36×20 (BackgroundDialog.dc.html `st-switch`).
    expect(settings.px(".bg-own-switch__track", "width")).toBe(36);
    expect(settings.px(".bg-own-switch__track", "height")).toBe(20);
  });

  it("the Solid/Wallpaper control and Shuffle are ≥44px tall on phones", () => {
    const picker = loadCascade(read("picker.css"));

    expect(picker.px(".wp-seg__btn", "min-height", { phone: true })).toBeGreaterThanOrEqual(44);
    expect(picker.px(".wp-btn", "min-height", { phone: true })).toBeGreaterThanOrEqual(44);
    // Shuffle's fixed height becomes a floor, so the button can grow with its text.
    expect(picker.decls(".wp-btn", { phone: true }).height).toBe("auto");

    // Desktop keeps the design's sizes unchanged.
    expect(picker.decls(".wp-seg__btn")["min-height"]).toBe("var(--h-sm)");
    expect(picker.decls(".wp-btn").height).toBe("var(--h-md)");
    expect(picker.px(".wp-btn", "min-height")).toBeNull();
  });

  it("every collapsible header is ≥44px tall on phones, Gradient included", () => {
    const picker = loadCascade([read("../../styles/tokens.css"), read("picker.css")]);

    // Wallpaper, Texture and Gradient are all the same `CollapsibleSection` head.
    expect(picker.px(".wp-section__head", "min-height", { phone: true })).toBeGreaterThanOrEqual(44);
  });

  it("the selection row truncates a long title with an ellipsis", () => {
    const picker = loadCascade(read("picker.css"));

    // `text-overflow` does not apply to a flex item, so the name itself must clip
    // (the row's own `overflow: hidden` would otherwise cut it mid-word, no "…").
    const name = picker.decls(".wp-sel__name");
    expect(name["min-width"]).toBe("0");
    expect(name.overflow).toBe("hidden");
    expect(name["text-overflow"]).toBe("ellipsis");
    expect(name["white-space"]).toBe("nowrap");

    // The chip keeps its full size while the name shrinks; the row still bounds it.
    expect(picker.decls(".wp-picked")["flex-shrink"]).toBe("0");
    expect(picker.decls(".wp-sel__text").overflow).toBe("hidden");

    // The texture suffix gives way before the name (R5F-01): it clips and shrinks
    // far harder, so the primary text keeps its characters instead of "Refl…".
    const rest = picker.decls(".wp-sel__rest");
    expect(rest["min-width"]).toBe("0");
    expect(rest["text-overflow"]).toBe("ellipsis");
    expect(Number(rest["flex-shrink"])).toBeGreaterThan(Number(name["flex-shrink"]));
  });
});
