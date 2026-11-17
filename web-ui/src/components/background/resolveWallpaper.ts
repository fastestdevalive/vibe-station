import type { ScopeKey, ScopeOverride } from "./backgroundStore";
import { stableWallpaperIndex } from "./hash";

/**
 * Pure port of mobile `WallpaperResolver.kt` (Daily dropped): what a screen shows behind its
 * content. No hooks, no storage access — the caller feeds the store's values in.
 */

export type ScreenWallpaper =
  | { t: "solid" }
  | { t: "opaqueHere" }
  | { t: "image"; id: string }
  | { t: "draftOwn"; id: string | null };

export type ScreenKind =
  | { t: "app" }
  | { t: "draft"; ownId: string | null; tabScope?: ScopeKey }
  | { t: "scope"; scope: ScopeKey };

export interface WallpaperInputs {
  mode: "solid" | "wallpaper";
  appWallpaperId: string | null;
  agentWallpapers: boolean;
  reduceTransparency: boolean;
  catalogIds: string[];
  /** Scope seed for `kind.scope` / `kind.tabScope`. */
  seed: string | undefined;
  /** Scope override for the same scope. */
  override: ScopeOverride | undefined;
}

/** Stable hash pick for a seedless scope; null when the catalog is empty. */
export function scopeFallbackId(hashKey: string, catalogIds: string[]): string | null {
  if (catalogIds.length === 0) return null;
  return catalogIds[stableWallpaperIndex(hashKey, catalogIds.length)] ?? null;
}

/**
 * Mobile parity (`PaneScope.kt`): a worktree hashes its raw id, a project hashes
 * `project-<id>`, the app hashes `app`. Never hash the `worktree:`/`project:` storage key.
 */
export function scopeHashKey(scope: ScopeKey): string {
  if (scope.startsWith("worktree:")) return scope.slice("worktree:".length);
  return `project-${scope.slice("project:".length)}`;
}

/** `id` when it is a real catalog id, else null (unknown / removed ids never render). */
function pickValid(id: string | null | undefined, catalogIds: string[]): string | null {
  return typeof id === "string" && id !== "" && catalogIds.includes(id) ? id : null;
}

export interface ScopeDefaultInputs {
  agentWallpapers: boolean;
  appWallpaperId: string | null;
  seed: string | undefined;
  catalogIds: string[];
}

export interface ScopeDefault {
  id: string | null;
  source: "app" | "seed" | "pick";
}

/**
 * The one rule for what a scope shows with no override: agents share
 * the app background when agentWallpapers is false, else a valid seed, else the scope's hash pick. The
 * `source` names that branch so captions/menu copy describe what is actually drawn.
 */
export function scopeDefault(scope: ScopeKey, i: ScopeDefaultInputs): ScopeDefault {
  if (!i.agentWallpapers) {
    const id = pickValid(i.appWallpaperId, i.catalogIds) ?? scopeFallbackId("app", i.catalogIds);
    return { id, source: "app" };
  }
  const seed = pickValid(i.seed, i.catalogIds);
  if (seed !== null) return { id: seed, source: "seed" };
  return { id: scopeFallbackId(scopeHashKey(scope), i.catalogIds), source: "pick" };
}

function appBackground(i: WallpaperInputs): ScreenWallpaper {
  if (i.mode === "solid") return { t: "solid" };
  const id = pickValid(i.appWallpaperId, i.catalogIds) ?? scopeFallbackId("app", i.catalogIds);
  return id === null ? { t: "solid" } : { t: "image", id };
}

/** override id (valid) ?? seed (valid) ?? hash(hashKey). */
function scopeImage(hashKey: string, i: WallpaperInputs): string | null {
  const overrideId = i.override?.kind === "id" ? pickValid(i.override.id, i.catalogIds) : null;
  return overrideId ?? pickValid(i.seed, i.catalogIds) ?? scopeFallbackId(hashKey, i.catalogIds);
}

function resolveDraft(kind: Extract<ScreenKind, { t: "draft" }>, i: WallpaperInputs): ScreenWallpaper {
  const tab = kind.tabScope;
  if (!i.agentWallpapers) {
    // When agentWallpapers is off, a tab draft follows the same rule as its worktree: Solid gate,
    // then the worktree's override, else the app background.
    if (tab === undefined || i.mode === "solid") return appBackground(i);
    const override = i.override;
    if (override?.kind === "none") return { t: "opaqueHere" };
    const overrideId = override?.kind === "id" ? pickValid(override.id, i.catalogIds) : null;
    if (overrideId !== null) return { t: "image", id: overrideId };
    return appBackground(i);
  }
  if (tab === undefined) return { t: "draftOwn", id: kind.ownId };
  if (i.override?.kind === "none") return { t: "opaqueHere" };
  return { t: "draftOwn", id: scopeImage(scopeHashKey(tab), i) };
}

function resolveScope(kind: Extract<ScreenKind, { t: "scope" }>, i: WallpaperInputs): ScreenWallpaper {
  if (i.mode === "solid") return { t: "solid" };
  const override = i.override;
  if (override?.kind === "none") return { t: "opaqueHere" };
  const overrideId = override?.kind === "id" ? pickValid(override.id, i.catalogIds) : null;
  if (overrideId !== null) return { t: "image", id: overrideId };
  const def = scopeDefault(kind.scope, i);
  return def.id === null ? { t: "solid" } : { t: "image", id: def.id };
}

/** The one resolution function (mobile parity: vibe-station-mobile WallpaperResolver.kt). */
export function resolveWallpaper(kind: ScreenKind, i: WallpaperInputs): ScreenWallpaper {
  if (i.reduceTransparency) return { t: "solid" };
  switch (kind.t) {
    case "app":
      return appBackground(i);
    case "draft":
      return resolveDraft(kind, i);
    case "scope":
      return resolveScope(kind, i);
  }
}
