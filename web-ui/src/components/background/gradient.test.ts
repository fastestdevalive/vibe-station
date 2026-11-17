import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRADIENT,
  GRADIENT_IDS,
  GRADIENTS,
  MOBILE_FADE_STOPS,
  gradientById,
  gradientCss,
  isGradientId,
} from "./gradient";

describe("gradient", () => {
  it("mobile stops are exactly mobile's WALLPAPER_FADE_STOPS", () => {
    expect(MOBILE_FADE_STOPS).toEqual([
      { offset: 0, alpha: 0 },
      { offset: 0.47, alpha: 0 },
      { offset: 0.7, alpha: 0.6 },
      { offset: 0.86, alpha: 1 },
      { offset: 1, alpha: 1 },
    ]);
    expect(DEFAULT_GRADIENT).toBe("fade_to_theme");
    expect(GRADIENTS.map((p) => p.id)).toEqual([...GRADIENT_IDS]);
  });

  it("unknown ids read as the default; only exact ids are valid", () => {
    expect(gradientById("bogus").id).toBe(DEFAULT_GRADIENT);
    expect(isGradientId("classic")).toBe(true);
    expect(isGradientId("CLASSIC")).toBe(false);
    expect(isGradientId(undefined)).toBe(false);
  });

  it("mobile's CSS is its stops, top to bottom, over the theme background", () => {
    expect(gradientCss("mobile")).toBe(
      "linear-gradient(180deg, " +
        "color-mix(in srgb, var(--bg-primary) 0%, transparent) 0%, " +
        "color-mix(in srgb, var(--bg-primary) 0%, transparent) 47%, " +
        "color-mix(in srgb, var(--bg-primary) 60%, transparent) 70%, " +
        "color-mix(in srgb, var(--bg-primary) 100%, transparent) 86%, " +
        "color-mix(in srgb, var(--bg-primary) 100%, transparent) 100%)",
    );
  });

  it("none draws nothing, and the angle follows hundredgb's direction", () => {
    expect(gradientCss("none")).toBe("none");
    expect(gradientCss("top_fade").startsWith("linear-gradient(0deg,")).toBe(true);
    expect(gradientCss("side_fade").startsWith("linear-gradient(270deg,")).toBe(true);
    expect(gradientCss("classic").startsWith("linear-gradient(180deg,")).toBe(true);
  });

  it("classic: smootherstep curve from 0.25 to the bottom", () => {
    const stops = gradientById("classic").stops;
    expect(stops[0]).toEqual({ offset: 0, alpha: 0 });

    const offsets = stops.map((s) => s.offset);
    const alphas = stops.map((s) => s.alpha);
    for (let i = 1; i < stops.length; i += 1) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
      expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]!);
    }

    expect(stops[stops.length - 1]).toEqual({ offset: 1, alpha: 1 });
    // smootherstep(0.5) = 0.5 at the range's midpoint (0.25..1).
    expect(stops.find((s) => s.offset === 0.625)?.alpha).toBe(0.5);
  });
});
