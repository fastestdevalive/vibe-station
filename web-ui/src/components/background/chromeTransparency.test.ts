import { describe, expect, it } from "vitest";
import {
  CHROME_TRANSPARENCY,
  opacityFromTransparency,
  transparencyFromOpacity,
} from "./chromeTransparency";

describe("chromeTransparency", () => {
  it("exposes the store-derived range", () => {
    expect(CHROME_TRANSPARENCY).toEqual({ min: 0, max: 60, step: 2 });
    expect(CHROME_TRANSPARENCY.max).toBe(60);
  });

  it("turns stored opacity into the slider's transparency", () => {
    expect(transparencyFromOpacity(0.72)).toBe(28); // the default
    expect(transparencyFromOpacity(1)).toBe(0);
    expect(transparencyFromOpacity(0.4)).toBe(60);
    expect(transparencyFromOpacity(0.65)).toBe(35);
    expect(transparencyFromOpacity(0.95)).toBe(5);
  });

  it("clamps out-of-range and non-finite stored opacity without rewriting storage", () => {
    expect(transparencyFromOpacity(0.2)).toBe(60);
    expect(transparencyFromOpacity(1.4)).toBe(0);
    expect(transparencyFromOpacity(NaN)).toBe(28);
  });

  it("turns slider transparency back into exact stored opacity", () => {
    expect(opacityFromTransparency(28)).toBe(0.72);
    expect(opacityFromTransparency(35)).toBe(0.65);
    expect(opacityFromTransparency(0)).toBe(1);
    expect(opacityFromTransparency(60)).toBe(0.4);
    expect(opacityFromTransparency(-5)).toBe(1);
    expect(opacityFromTransparency(75)).toBe(0.4);
  });

  it("round-trips every slider step (the 28% default is one of them)", () => {
    for (let p = CHROME_TRANSPARENCY.min; p <= CHROME_TRANSPARENCY.max; p += CHROME_TRANSPARENCY.step) {
      expect(transparencyFromOpacity(opacityFromTransparency(p))).toBe(p);
    }
  });
});
