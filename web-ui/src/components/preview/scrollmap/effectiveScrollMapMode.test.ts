import { describe, expect, it } from "vitest";
import type { FileScrollMap } from "@/api/types";
import {
  effectiveScrollMapMode,
  MINIMAP_MIN_PANE_WIDTH,
  type ScrollMapFallback,
} from "./effectiveScrollMapMode";
import { MINIMAP_MAX_BYTES, MINIMAP_MAX_LINES } from "./minimapSummary";

interface TestCase {
  desc: string;
  setting: FileScrollMap;
  ctx: {
    view: "code" | "diff";
    scrollable: boolean;
    isPhone: boolean;
    paneWidth: number;
    lineCount: number;
    byteLength: number;
    minimapAvailable: boolean;
  };
  expectedDisplay: "none" | "marks" | "minimap";
  expectedForced: ScrollMapFallback | null;
}

const basePassCtx = {
  view: "code" as const,
  scrollable: true,
  isPhone: false,
  paneWidth: 600,
  lineCount: 100,
  byteLength: 2000,
  minimapAvailable: true,
};

const tableCases: TestCase[] = [
  // 1. !scrollable -> none, "fits"
  {
    desc: "!scrollable with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, scrollable: false },
    expectedDisplay: "none",
    expectedForced: "fits",
  },
  {
    desc: "!scrollable with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, scrollable: false },
    expectedDisplay: "none",
    expectedForced: "fits",
  },
  // 2. isPhone -> marks, "phone"
  {
    desc: "isPhone with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, isPhone: true },
    expectedDisplay: "marks",
    expectedForced: "phone",
  },
  {
    desc: "isPhone with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, isPhone: true },
    expectedDisplay: "marks",
    expectedForced: "phone",
  },
  // 3. view === 'diff' -> marks, "diff"
  {
    desc: "view === 'diff' with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, view: "diff" },
    expectedDisplay: "marks",
    expectedForced: "diff",
  },
  {
    desc: "view === 'diff' with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, view: "diff" },
    expectedDisplay: "marks",
    expectedForced: "diff",
  },
  // 4. overMinimapCap -> marks, "overCap"
  {
    desc: "overMinimapCap by lineCount with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, lineCount: MINIMAP_MAX_LINES + 1 },
    expectedDisplay: "marks",
    expectedForced: "overCap",
  },
  {
    desc: "overMinimapCap by lineCount with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, lineCount: MINIMAP_MAX_LINES + 1 },
    expectedDisplay: "marks",
    expectedForced: "overCap",
  },
  {
    desc: "overMinimapCap by byteLength with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, byteLength: MINIMAP_MAX_BYTES + 1 },
    expectedDisplay: "marks",
    expectedForced: "overCap",
  },
  {
    desc: "overMinimapCap by byteLength with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, byteLength: MINIMAP_MAX_BYTES + 1 },
    expectedDisplay: "marks",
    expectedForced: "overCap",
  },
  // 5. paneWidth < MINIMAP_MIN_PANE_WIDTH -> marks, "narrow"
  {
    desc: "narrow pane (width 479) with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, paneWidth: MINIMAP_MIN_PANE_WIDTH - 1 },
    expectedDisplay: "marks",
    expectedForced: "narrow",
  },
  {
    desc: "narrow pane (width 479) with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, paneWidth: MINIMAP_MIN_PANE_WIDTH - 1 },
    expectedDisplay: "marks",
    expectedForced: "narrow",
  },
  // 6. !minimapAvailable -> marks, "unavailable"
  {
    desc: "!minimapAvailable with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, minimapAvailable: false },
    expectedDisplay: "marks",
    expectedForced: "unavailable",
  },
  {
    desc: "!minimapAvailable with setting=marks",
    setting: "marks",
    ctx: { ...basePassCtx, minimapAvailable: false },
    expectedDisplay: "marks",
    expectedForced: "unavailable",
  },
  // 7. Normal passes
  {
    desc: "all conditions pass with setting=minimap",
    setting: "minimap",
    ctx: { ...basePassCtx, paneWidth: MINIMAP_MIN_PANE_WIDTH },
    expectedDisplay: "minimap",
    expectedForced: null,
  },
  {
    desc: "all conditions pass with setting=marks (stays marks with forced: null)",
    setting: "marks",
    ctx: { ...basePassCtx, paneWidth: MINIMAP_MIN_PANE_WIDTH },
    expectedDisplay: "marks",
    expectedForced: null,
  },
];

describe("effectiveScrollMapMode", () => {
  it.each(tableCases)(
    "$desc -> display: $expectedDisplay, forced: $expectedForced",
    ({ setting, ctx, expectedDisplay, expectedForced }) => {
      const res = effectiveScrollMapMode(setting, ctx);
      expect(res.display).toBe(expectedDisplay);
      expect(res.forced).toBe(expectedForced);
    },
  );

  it("order: fits beats phone beats diff beats overCap beats narrow beats unavailable", () => {
    // When scrollable=false and isPhone=true, fits wins
    const res1 = effectiveScrollMapMode("minimap", {
      ...basePassCtx,
      scrollable: false,
      isPhone: true,
      view: "diff",
    });
    expect(res1).toEqual({ display: "none", forced: "fits" });

    // When scrollable=true, isPhone=true and view=diff, phone wins
    const res2 = effectiveScrollMapMode("minimap", {
      ...basePassCtx,
      isPhone: true,
      view: "diff",
    });
    expect(res2).toEqual({ display: "marks", forced: "phone" });

    // When view=diff and overCap, diff wins
    const res3 = effectiveScrollMapMode("minimap", {
      ...basePassCtx,
      view: "diff",
      lineCount: 1_000_001,
    });
    expect(res3).toEqual({ display: "marks", forced: "diff" });

    // When overCap and narrow, overCap wins
    const res4 = effectiveScrollMapMode("minimap", {
      ...basePassCtx,
      lineCount: 1_000_001,
      paneWidth: 400,
    });
    expect(res4).toEqual({ display: "marks", forced: "overCap" });

    // When narrow and unavailable, narrow wins
    const res5 = effectiveScrollMapMode("minimap", {
      ...basePassCtx,
      paneWidth: 400,
      minimapAvailable: false,
    });
    expect(res5).toEqual({ display: "marks", forced: "narrow" });
  });

  it("width boundary: 479 -> narrow, 480 -> minimap", () => {
    expect(
      effectiveScrollMapMode("minimap", { ...basePassCtx, paneWidth: 479 }),
    ).toEqual({ display: "marks", forced: "narrow" });
    expect(
      effectiveScrollMapMode("minimap", { ...basePassCtx, paneWidth: 480 }),
    ).toEqual({ display: "minimap", forced: null });
  });

  it("line cap boundary: 1,000,000 passes, 1,000,001 -> overCap", () => {
    expect(
      effectiveScrollMapMode("minimap", { ...basePassCtx, lineCount: 1_000_000 }),
    ).toEqual({ display: "minimap", forced: null });
    expect(
      effectiveScrollMapMode("minimap", { ...basePassCtx, lineCount: 1_000_001 }),
    ).toEqual({ display: "marks", forced: "overCap" });
  });

  it("byte cap boundary: 25 MB passes, 25 MB + 1 byte -> overCap", () => {
    const maxBytes = 25 * 1024 * 1024;
    expect(
      effectiveScrollMapMode("minimap", { ...basePassCtx, byteLength: maxBytes }),
    ).toEqual({ display: "minimap", forced: null });
    expect(
      effectiveScrollMapMode("minimap", { ...basePassCtx, byteLength: maxBytes + 1 }),
    ).toEqual({ display: "marks", forced: "overCap" });
  });
});
