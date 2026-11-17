import { describe, expect, it } from "vitest";
import type { ScopeKey } from "./backgroundStore";
import { stableWallpaperIndex } from "./hash";
import {
  resolveWallpaper,
  scopeDefault,
  scopeFallbackId,
  scopeHashKey,
  type ScreenKind,
  type WallpaperInputs,
} from "./resolveWallpaper";

const IDS = Array.from({ length: 31 }, (_, i) => `wp-${String(i + 1).padStart(3, "0")}`);
const APP_HASH = scopeFallbackId("app", IDS);
const W1_HASH = scopeFallbackId("w1", IDS);

function inputs(over: Partial<WallpaperInputs> = {}): WallpaperInputs {
  return {
    mode: "wallpaper",
    appWallpaperId: "wp-002",
    agentWallpapers: true,
    reduceTransparency: false,
    catalogIds: IDS,
    seed: undefined,
    override: undefined,
    ...over,
  };
}

const app: ScreenKind = { t: "app" };
const draft = (ownId: string | null, tabScope?: `worktree:${string}`): ScreenKind =>
  tabScope === undefined ? { t: "draft", ownId } : { t: "draft", ownId, tabScope };

describe("resolveWallpaper (mobile screen × mode matrix)", () => {
  it("app solid", () => {
    expect(resolveWallpaper(app, inputs({ mode: "solid" }))).toEqual({ t: "solid" });
  });

  it("app wallpaper X", () => {
    expect(resolveWallpaper(app, inputs())).toEqual({ t: "image", id: "wp-002" });
  });

  it("app invalid id falls back to hash", () => {
    expect(resolveWallpaper(app, inputs({ appWallpaperId: "wp-999" }))).toEqual({
      t: "image",
      id: APP_HASH,
    });
    expect(APP_HASH).toBe(IDS[stableWallpaperIndex("app", IDS.length)]);
  });

  it("draft B on own in every mode", () => {
    expect(resolveWallpaper(draft("wp-005"), inputs({ mode: "solid" }))).toEqual({
      t: "draftOwn",
      id: "wp-005",
    });
    expect(resolveWallpaper(draft("wp-005"), inputs({ mode: "wallpaper" }))).toEqual({
      t: "draftOwn",
      id: "wp-005",
    });
  });

  it("draft B off solid", () => {
    expect(
      resolveWallpaper(draft("wp-005"), inputs({ mode: "solid", agentWallpapers: false })),
    ).toEqual({ t: "solid" });
  });

  it("draft B off wallpaper X", () => {
    expect(
      resolveWallpaper(draft("wp-005"), inputs({ agentWallpapers: false })),
    ).toEqual({ t: "image", id: "wp-002" });
  });

  it("tab draft follows worktree override none", () => {
    expect(
      resolveWallpaper(draft("wp-005", "worktree:w1"), inputs({ override: { kind: "none" } })),
    ).toEqual({ t: "opaqueHere" });
  });

  it("tab draft B on uses seed", () => {
    expect(
      resolveWallpaper(draft("wp-005", "worktree:w1"), inputs({ seed: "wp-004" })),
    ).toEqual({ t: "draftOwn", id: "wp-004" });
  });

  it("tab draft B on with no seed falls back to the worktree hash", () => {
    expect(resolveWallpaper(draft("wp-005", "worktree:w1"), inputs())).toEqual({
      t: "draftOwn",
      id: W1_HASH,
    });
  });

  it("worktree no override B on seed", () => {
    expect(resolveWallpaper({ t: "scope", scope: "worktree:w1" }, inputs({ seed: "wp-007" }))).toEqual({
      t: "image",
      id: "wp-007",
    });
  });

  it("worktree B off app", () => {
    expect(
      resolveWallpaper({ t: "scope", scope: "worktree:w1" }, inputs({ agentWallpapers: false })),
    ).toEqual({ t: "image", id: "wp-002" });
  });

  it("worktree override Y", () => {
    expect(
      resolveWallpaper(
        { t: "scope", scope: "worktree:w1" },
        inputs({ override: { kind: "id", id: "wp-009" } }),
      ),
    ).toEqual({ t: "image", id: "wp-009" });
  });

  it("worktree override none opaqueHere", () => {
    expect(
      resolveWallpaper({ t: "scope", scope: "worktree:w1" }, inputs({ override: { kind: "none" } })),
    ).toEqual({ t: "opaqueHere" });
  });

  it("worktree solid gate", () => {
    expect(
      resolveWallpaper(
        { t: "scope", scope: "worktree:w1" },
        inputs({ mode: "solid", override: { kind: "id", id: "wp-009" } }),
      ),
    ).toEqual({ t: "solid" });
  });

  it("worktree seed missing from catalog uses hash", () => {
    expect(
      resolveWallpaper({ t: "scope", scope: "worktree:w1" }, inputs({ seed: "wp-999" })),
    ).toEqual({ t: "image", id: W1_HASH });
  });

  it("project scope same rules", () => {
    const project: ScreenKind = { t: "scope", scope: "project:p1" };
    expect(resolveWallpaper(project, inputs({ seed: "wp-003" }))).toEqual({ t: "image", id: "wp-003" });
    expect(resolveWallpaper(project, inputs({ override: { kind: "none" } }))).toEqual({ t: "opaqueHere" });
    expect(resolveWallpaper(project, inputs({ mode: "solid" }))).toEqual({ t: "solid" });
    expect(resolveWallpaper(project, inputs({ agentWallpapers: false }))).toEqual({
      t: "image",
      id: "wp-002",
    });
  });

  it("reduce transparency forces solid", () => {
    const reduce = { reduceTransparency: true };
    expect(resolveWallpaper(app, inputs(reduce))).toEqual({ t: "solid" });
    expect(resolveWallpaper(draft("wp-005"), inputs(reduce))).toEqual({ t: "solid" });
    expect(resolveWallpaper(draft("wp-005", "worktree:w1"), inputs(reduce))).toEqual({ t: "solid" });
    expect(resolveWallpaper({ t: "scope", scope: "worktree:w1" }, inputs(reduce))).toEqual({ t: "solid" });
  });

  it("empty catalog solid", () => {
    expect(resolveWallpaper(app, inputs({ catalogIds: [] }))).toEqual({ t: "solid" });
    expect(resolveWallpaper({ t: "scope", scope: "worktree:w1" }, inputs({ catalogIds: [] }))).toEqual({
      t: "solid",
    });
    // A draft still shows its own pick; the catalog is only needed to draw it.
    expect(resolveWallpaper(draft("wp-005"), inputs({ catalogIds: [] }))).toEqual({
      t: "draftOwn",
      id: "wp-005",
    });
  });

  it("tab draft B off solid gate", () => {
    expect(
      resolveWallpaper(
        draft("wp-005", "worktree:w1"),
        inputs({ mode: "solid", agentWallpapers: false }),
      ),
    ).toEqual({ t: "solid" });
  });

  it("tab draft B off follows the worktree override", () => {
    expect(
      resolveWallpaper(
        draft("wp-005", "worktree:w1"),
        inputs({ agentWallpapers: false, override: { kind: "id", id: "wp-009" } }),
      ),
    ).toEqual({ t: "image", id: "wp-009" });
    expect(
      resolveWallpaper(
        draft("wp-005", "worktree:w1"),
        inputs({ agentWallpapers: false, override: { kind: "none" } }),
      ),
    ).toEqual({ t: "opaqueHere" });
  });

  it("scope hash key matches mobile", () => {
    expect(scopeHashKey("worktree:w1")).toBe("w1");
    expect(scopeHashKey("project:p1")).toBe("project-p1");
    expect(scopeFallbackId("w1", IDS)).toBe(IDS[stableWallpaperIndex("w1", 31)]);
    expect(scopeFallbackId("x", [])).toBeNull();
  });
});

/**
 * R2F-06: the menu row, the picker's Default tile and the screen all name what
 * `scopeDefault` resolves — one rule, one answer. Each case is checked against
 * `resolveWallpaper({t:"scope"})` with no override.
 */
describe("scopeDefault (the one no-override rule)", () => {
  const SCOPE: ScopeKey = "worktree:w1";
  const base = { appWallpaperId: "wp-002", catalogIds: IDS };
  const drawn = (over: Partial<WallpaperInputs>) =>
    resolveWallpaper({ t: "scope", scope: SCOPE }, inputs(over));

  it("B off: the app background, whatever the seed says", () => {
    expect(
      scopeDefault(SCOPE, { ...base, agentWallpapers: false, seed: "wp-007" }),
    ).toEqual({ id: "wp-002", source: "app" });
    expect(drawn({ agentWallpapers: false, seed: "wp-007" })).toEqual({ t: "image", id: "wp-002" });
  });

  it("B on + valid seed: the seed", () => {
    expect(scopeDefault(SCOPE, { ...base, agentWallpapers: true, seed: "wp-007" })).toEqual({
      id: "wp-007",
      source: "seed",
    });
    expect(drawn({ seed: "wp-007" })).toEqual({ t: "image", id: "wp-007" });
  });

  it("B on + removed seed: the hash pick", () => {
    expect(scopeDefault(SCOPE, { ...base, agentWallpapers: true, seed: "wp-999" })).toEqual({
      id: W1_HASH,
      source: "pick",
    });
    expect(drawn({ seed: "wp-999" })).toEqual({ t: "image", id: W1_HASH });
  });

  it("B on + no seed: the hash pick", () => {
    expect(scopeDefault(SCOPE, { ...base, agentWallpapers: true, seed: undefined })).toEqual({
      id: W1_HASH,
      source: "pick",
    });
    expect(drawn({ seed: undefined })).toEqual({ t: "image", id: W1_HASH });
  });

  it("empty catalog has no id (the screen is solid)", () => {
    expect(
      scopeDefault(SCOPE, { agentWallpapers: true, appWallpaperId: "wp-002", seed: "wp-007", catalogIds: [] }),
    ).toEqual({ id: null, source: "pick" });
    expect(
      scopeDefault(SCOPE, { agentWallpapers: false, appWallpaperId: "wp-002", seed: undefined, catalogIds: [] }),
    ).toEqual({ id: null, source: "app" });
  });
});
