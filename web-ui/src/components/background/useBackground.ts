import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { layerVars, lookFromPrefs } from "./backgroundLook";
import { getBackgroundStore } from "./backgroundStore";
import type { GradientId } from "./gradient";
import {
  resolveWallpaper,
  scopeFallbackId,
  scopeHashKey,
  type ScreenKind,
  type ScreenWallpaper,
} from "./resolveWallpaper";
import type { TextureSpec } from "./textureCatalog";
import { useReduceTransparency } from "./useReduceTransparency";
import { useWallpaperCatalog } from "./useWallpaperCatalog";
import { useWallpaperScope } from "./useWallpaperScope";

/**
 * Everything `WindowBackground` needs to draw the current screen, plus the
 * writes that belong to a route (roll once, seed a scope, claim a draft's own
 * wallpaper) and the root attributes the CSS keys off.
 *
 * Only `WindowBackground` calls this: it is the single owner of
 * `documentElement`'s `data-wallpaper` / `--wp-*` attributes.
 */
export interface BackgroundView {
  resolved: ScreenWallpaper;
  /** Catalog id of the image to draw, or null when this screen has none. */
  imageId: string | null;
  texture: TextureSpec;
  intensity: number;
  view: "empty" | "session";
  gradient: GradientId;
}

export function useBackground(kindOverride?: ScreenKind): BackgroundView {
  // Hooks stay unconditional: an override only replaces the route-derived kind.
  const scope = useWallpaperScope();
  const kind = kindOverride ?? scope.kind;
  const catalog = useWallpaperCatalog();
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const reduceTransparency = useReduceTransparency();

  const ids = catalog.ids;
  const ready = catalog.status === "ready";

  // The scope whose seed/override feeds the resolver: a scope screen itself, or
  // the worktree a tab draft lives in.
  const relatedScope =
    kind.t === "scope"
      ? kind.scope
      : kind.t === "draft"
        ? kind.tabScope
        : undefined;

  const resolved = resolveWallpaper(kind, {
    mode: prefs.mode,
    appWallpaperId: prefs.wallpaperId,
    agentWallpapers: prefs.agentWallpapers,
    reduceTransparency,
    catalogIds: ids,
    seed: relatedScope === undefined ? undefined : prefs.seeds[relatedScope],
    override:
      relatedScope === undefined ? undefined : prefs.overrides[relatedScope],
  });

  let imageId: string | null = null;
  if (resolved.t === "image") {
    imageId = resolved.id;
  } else if (resolved.t === "draftOwn") {
    // Mobile `resolveWallpaperId`: an unclaimed draft falls back to its hash pick.
    const draftId = scope.draftId;
    imageId =
      resolved.id ??
      (draftId !== undefined && ids.length > 0
        ? scopeFallbackId(draftId, ids)
        : null);
  }

  // First run: until the roll has written a wallpaper, draw nothing at all, so
  // the hash fallback is never fetched or painted and the first image a new user
  // sees is the rolled pick (the roll commits in the layout effect below, before
  // the browser paints).
  if (!prefs.rolled && prefs.mode === "wallpaper") imageId = null;

  const look = lookFromPrefs(prefs);
  const texture = look.texture;
  const intensity = look.intensity;
  const wallpaperOn = imageId !== null;
  const vars = layerVars(look, scope.view, wallpaperOn);
  const wpVis = vars["--wp-vis"];
  const wpChromeAlpha = vars["--wp-chrome-alpha"];

  // 1 — roll the first-run default once the catalog can supply ids. A LAYOUT
  // effect, not a passive one: the roll must commit before the browser paints
  // the first frame with a ready catalog, or the hash pick flashes for one frame and the window crossfades to the rolled one.
  useLayoutEffect(() => {
    if (!ready) return;
    store.ensureRolled(ids);
  }, [ready, ids, store]);

  // 2 — the root attributes every `[data-wallpaper="on"]` rule keys off. With no
  // wallpaper the alpha stays 100%, so every surface is byte-identical to today. A LAYOUT
  // effect: the variables must be on <html> before the browser first paints a new `.window-bg`,
  // or its scrim would paint once at the CSS default (fully clear) and then animate.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.wallpaper = wallpaperOn ? "on" : "off";
    const applied = { "--wp-vis": wpVis, "--wp-chrome-alpha": wpChromeAlpha };
    for (const [name, value] of Object.entries(applied))
      root.style.setProperty(name, value);
    return () => {
      delete root.dataset.wallpaper;
      for (const name of Object.keys(applied)) root.style.removeProperty(name);
    };
  }, [wallpaperOn, wpVis, wpChromeAlpha]);

  // 3 — a scope opened for the first time gets its hash pick as a seed, so the
  // wallpaper a worktree "started with" survives later catalog changes. Only
  // when agents have their own wallpapers and the app background is on.
  const seedScope = kind.t === "scope" ? kind.scope : undefined;
  useEffect(() => {
    if (!ready || seedScope === undefined) return;
    if (!prefs.agentWallpapers || prefs.mode !== "wallpaper") return;
    if (prefs.seeds[seedScope] !== undefined) return;
    const id = scopeFallbackId(scopeHashKey(seedScope), ids);
    if (id === null) return;
    store.writeSeedIfAbsent(seedScope, id);
  }, [
    ready,
    seedScope,
    prefs.agentWallpapers,
    prefs.mode,
    prefs.seeds,
    ids,
    store,
  ]);

  // 4 — a brand-new draft claims its own wallpaper (write-once). Tab drafts
  // belong to their worktree and claim nothing (mobile parity: tabs inherit their worktree wallpaper).
  const draftId = scope.draftId;
  const isTabDraft = kind.t === "draft" && kind.tabScope !== undefined;
  useEffect(() => {
    if (!ready || draftId === undefined || isTabDraft) return;
    if (!prefs.agentWallpapers) return;
    if (prefs.drafts[draftId] !== undefined) return;
    store.draftWallpaperFor(draftId, ids);
  }, [
    ready,
    draftId,
    isTabDraft,
    prefs.agentWallpapers,
    prefs.drafts,
    ids,
    store,
  ]);

  return {
    resolved,
    imageId,
    texture,
    intensity,
    view: scope.view,
    gradient: look.gradient,
  };
}
