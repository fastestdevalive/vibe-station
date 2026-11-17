import { baseUrl } from "@/api/client";
import { DEFAULT_GRADIENT, isGradientId, type GradientId } from "./gradient";
import { stableWallpaperIndex } from "./hash";
import { TEXTURES } from "./textureCatalog";

/**
 * The ONLY owner of wallpaper preferences in localStorage (mobile parity: per-client storage,
 * keyed per daemon origin). Every other module reads/writes through this API — nothing else
 * touches localStorage. A corrupt, unknown-version or unreadable entry degrades per field to
 * defaults and is never rewritten until the next real write.
 *
 * v2 adds `gradient`; v1 is read as v2 with the default gradient. A downgraded client
 * (v1 reader) sees v2 as unknown and uses defaults in memory until its own next write.
 */

export const BG_SCHEMA_VERSION = 2;

export type TextureId =
  | "none"
  | "dither"
  | "ascii"
  | "halftone"
  | "scanlines"
  | "haze"
  | "grain"
  | "mosaic"
  | "glitch"
  | "hex"
  | "frost";

/** `none` = solid on this screen only; `id` = that catalog wallpaper. Absent = Default. */
export type ScopeOverride = { kind: "none" } | { kind: "id"; id: string };

/**
 * A = app background (mode + wallpaperId), B = `agentWallpapers` (own wallpaper per agent),
 * C = `seeds` (a scope's first wallpaper, write-once), D = `overrides` (the user's per-scope choice);
 * the letters follow vibe-station-mobile's settings model.
 */
export interface BackgroundPrefs {
  v: 2;
  mode: "solid" | "wallpaper";
  wallpaperId: string | null;
  agentWallpapers: boolean;
  texture: TextureId;
  /** `null` = the texture's own default intensity. */
  intensity: number | null;
  /** Preset id, never an ordinal; unknown ids read as `DEFAULT_GRADIENT` (Soft fade). */
  gradient: GradientId;
  emptyVisibility: number;
  sessionVisibility: number;
  /** Panel OPACITY 0.4-1 (1 = opaque). The Settings slider shows it as transparency via chromeTransparency.ts. */
  chromeOpacity: number;
  /** A random default (wallpaper + texture) has already been rolled once. */
  rolled: boolean;
  /** The current choice is a system pick (first-run roll or Shuffle), not a user pick. */
  picked: boolean;
  /** Scope seed: written once, never re-rolled. */
  seeds: Record<string, string>;
  /** Scope override: user-owned manual choice. */
  overrides: Record<string, ScopeOverride>;
  /** Each draft's own wallpaper id (claimed once, dropped after Start). */
  drafts: Record<string, string>;
  /** Picker disclosure state, remembered per device. */
  sections: { wallpaper: boolean; texture: boolean; visibility: boolean; gradient: boolean };
}

export type ScopeKey = `worktree:${string}` | `project:${string}`;

/** Draft key of the Tier-2 `/draft/new` composer (no session id yet). */
export const NEW_DRAFT_KEY = "new";

export interface BackgroundStore {
  /** Always valid; the SAME object reference until the next write / cross-tab storage event. */
  getState(): BackgroundPrefs;
  subscribe(fn: () => void): () => void;
  patch(
    p: Partial<
      Pick<
        BackgroundPrefs,
        | "mode"
        | "wallpaperId"
        | "agentWallpapers"
        | "texture"
        | "intensity"
        | "gradient"
        | "emptyVisibility"
        | "sessionVisibility"
        | "chromeOpacity"
        | "picked"
      >
    >,
  ): void;
  /** The three Visibility sliders back to their defaults in ONE write; nothing else changes. */
  resetVisibility(): void;
  /** Once: picks a wallpaper + a texture (none included) and stores them. */
  ensureRolled(catalogIds: string[], rng?: () => number): void;
  /** Scope seed, write-once. */
  writeSeedIfAbsent(scope: ScopeKey, wallpaperId: string): void;
  /** Scope override; `null` = Default / reset. */
  setOverride(scope: ScopeKey, o: ScopeOverride | null): void;
  /** Write-once per draft, a stable hash pick (same key ⇒ same wallpaper on every device); empty `catalogIds` writes nothing and returns null. */
  draftWallpaperFor(draftId: string, catalogIds: string[]): string | null;
  /**
   * Re-key a draft's claimed wallpaper when the draft gets a new id (choosing a
   * project). Moves in one write; no-op when the source is missing or the target
   * already has its own id.
   */
  moveDraft(fromKey: string, toKey: string): void;
  /** After a successful Start (the seed has been copied). */
  forgetDraft(draftId: string): void;
  /** Drop seeds/overrides of deleted worktrees/projects (one write, only if something changed). */
  pruneScopes(live: ReadonlySet<ScopeKey>): void;
  setSection(name: keyof BackgroundPrefs["sections"], open: boolean): void;
}

const DRAFT_CAP = 50;

const VIS_EMPTY = { min: 0.2, max: 1, fallback: 0.9 };
const VIS_SESSION = { min: 0.1, max: 1, fallback: 0.2 };
export const CHROME_OPACITY_RANGE = { min: 0.4, max: 1, fallback: 0.72 } as const;

export const VISIBILITY_RANGES = { empty: VIS_EMPTY, session: VIS_SESSION, chrome: CHROME_OPACITY_RANGE } as const;

const TEXTURE_IDS: ReadonlySet<string> = new Set(TEXTURES.map((t) => t.id));

export function defaultPrefs(): BackgroundPrefs {
  return {
    v: BG_SCHEMA_VERSION,
    mode: "wallpaper",
    wallpaperId: null,
    agentWallpapers: true,
    texture: "none",
    intensity: null,
    gradient: DEFAULT_GRADIENT,
    emptyVisibility: VIS_EMPTY.fallback,
    sessionVisibility: VIS_SESSION.fallback,
    chromeOpacity: CHROME_OPACITY_RANGE.fallback,
    rolled: false,
    picked: false,
    seeds: {},
    overrides: {},
    drafts: {},
    sections: { wallpaper: false, texture: false, visibility: false, gradient: false },
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (nonEmptyString(v)) out[k] = v;
  }
  return out;
}

function overrideRecord(value: unknown): Record<string, ScopeOverride> {
  const out: Record<string, ScopeOverride> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (!isRecord(v)) continue;
    if (v.kind === "none") out[k] = { kind: "none" };
    else if (v.kind === "id" && nonEmptyString(v.id)) out[k] = { kind: "id", id: v.id };
  }
  return out;
}

function sections(value: unknown): BackgroundPrefs["sections"] {
  const src = isRecord(value) ? value : {};
  return {
    wallpaper: src.wallpaper === true,
    texture: src.texture === true,
    visibility: src.visibility === true,
    gradient: src.gradient === true,
  };
}

/** v1 = v2 without `gradient`; reads as the default. A newer, unknown version reads as defaults. */
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([1, BG_SCHEMA_VERSION]);

/** Per-field validation; an unknown texture string reads as `none` without rewriting the stored value. */
function parsePrefs(raw: unknown): BackgroundPrefs {
  const d = defaultPrefs();
  if (!isRecord(raw) || !READABLE_VERSIONS.has(raw.v)) return d;
  return {
    v: BG_SCHEMA_VERSION,
    mode: raw.mode === "solid" ? "solid" : "wallpaper",
    wallpaperId: nonEmptyString(raw.wallpaperId) ? raw.wallpaperId : null,
    agentWallpapers: raw.agentWallpapers !== false,
    texture: typeof raw.texture === "string" && TEXTURE_IDS.has(raw.texture) ? (raw.texture as TextureId) : "none",
    intensity:
      typeof raw.intensity === "number" && Number.isFinite(raw.intensity)
        ? Math.min(1, Math.max(0, raw.intensity))
        : null,
    gradient: isGradientId(raw.gradient) ? raw.gradient : DEFAULT_GRADIENT,
    emptyVisibility: clamp(raw.emptyVisibility, VIS_EMPTY.min, VIS_EMPTY.max, d.emptyVisibility),
    sessionVisibility: clamp(raw.sessionVisibility, VIS_SESSION.min, VIS_SESSION.max, d.sessionVisibility),
    chromeOpacity: clamp(raw.chromeOpacity, CHROME_OPACITY_RANGE.min, CHROME_OPACITY_RANGE.max, d.chromeOpacity),
    rolled: raw.rolled === true,
    picked: raw.picked === true,
    seeds: stringRecord(raw.seeds),
    overrides: overrideRecord(raw.overrides),
    drafts: stringRecord(raw.drafts),
    sections: sections(raw.sections),
  };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageKeyFor(serverKey: string): string {
  // `v1` names the KEY format, not the schema: `BackgroundPrefs.v` is the schema,
  // and renaming this key would silently drop every existing user's preferences.
  return `vst.background.v1:${serverKey}`;
}

function sameOverride(a: ScopeOverride | undefined, b: ScopeOverride): boolean {
  if (a === undefined) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === "none" || (b.kind === "id" && a.id === b.id);
}

export function createBackgroundStore(storage: StorageLike | null, serverKey: string): BackgroundStore {
  const storageKey = storageKeyFor(serverKey);

  const load = (): BackgroundPrefs => {
    if (storage === null) return defaultPrefs();
    try {
      const text = storage.getItem(storageKey);
      if (text === null) return defaultPrefs();
      return parsePrefs(JSON.parse(text));
    } catch {
      return defaultPrefs();
    }
  };

  let state = load();
  const listeners = new Set<() => void>();
  let onStorage: ((e: StorageEvent) => void) | null = null;

  const notify = () => {
    for (const fn of listeners) fn();
  };

  const persist = (next: BackgroundPrefs) => {
    if (storage === null) return;
    try {
      storage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Quota / blocked storage: keep the in-memory value for this page, never throw.
    }
  };

  const commit = (next: BackgroundPrefs) => {
    state = next;
    persist(next);
    notify();
  };

  const attachStorageListener = () => {
    if (onStorage !== null || storage === null || typeof window === "undefined") return;
    state = load();
    onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== storageKey) return;
      state = load();
      notify();
    };
    window.addEventListener("storage", onStorage);
  };

  const detachStorageListener = () => {
    if (onStorage === null || typeof window === "undefined") return;
    window.removeEventListener("storage", onStorage);
    onStorage = null;
  };

  return {
    getState: () => state,

    subscribe(fn) {
      listeners.add(fn);
      if (listeners.size === 1) attachStorageListener();
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) detachStorageListener();
      };
    },

    patch(p) {
      const next: BackgroundPrefs = { ...state };
      if (p.mode !== undefined) next.mode = p.mode === "solid" ? "solid" : "wallpaper";
      if (p.wallpaperId !== undefined) {
        next.wallpaperId = nonEmptyString(p.wallpaperId) ? p.wallpaperId : null;
      }
      if (p.agentWallpapers !== undefined) next.agentWallpapers = p.agentWallpapers === true;
      if (p.texture !== undefined) {
        next.texture = TEXTURE_IDS.has(p.texture) ? p.texture : "none";
      }
      if (p.intensity !== undefined) {
        next.intensity =
          typeof p.intensity === "number" && Number.isFinite(p.intensity)
            ? Math.min(1, Math.max(0, p.intensity))
            : null;
      }
      if (p.gradient !== undefined) {
        next.gradient = isGradientId(p.gradient) ? p.gradient : state.gradient;
      }
      if (p.emptyVisibility !== undefined) {
        next.emptyVisibility = clamp(p.emptyVisibility, VIS_EMPTY.min, VIS_EMPTY.max, state.emptyVisibility);
      }
      if (p.sessionVisibility !== undefined) {
        next.sessionVisibility = clamp(
          p.sessionVisibility,
          VIS_SESSION.min,
          VIS_SESSION.max,
          state.sessionVisibility,
        );
      }
      if (p.chromeOpacity !== undefined) {
        next.chromeOpacity = clamp(
          p.chromeOpacity,
          CHROME_OPACITY_RANGE.min,
          CHROME_OPACITY_RANGE.max,
          state.chromeOpacity,
        );
      }
      if (p.picked !== undefined) next.picked = p.picked === true;
      commit(next);
    },

    resetVisibility() {
      const d = defaultPrefs();
      commit({
        ...state,
        emptyVisibility: d.emptyVisibility,
        sessionVisibility: d.sessionVisibility,
        chromeOpacity: d.chromeOpacity,
      });
    },

    ensureRolled(catalogIds, rng = Math.random) {
      if (state.rolled || catalogIds.length === 0) return;
      const wpIndex = Math.min(catalogIds.length - 1, Math.floor(rng() * catalogIds.length));
      const texIndex = Math.min(TEXTURES.length - 1, Math.floor(rng() * TEXTURES.length));
      const wallpaperId = catalogIds[wpIndex] ?? null;
      const texture = TEXTURES[texIndex]?.id ?? "none";
      commit({ ...state, rolled: true, picked: true, wallpaperId, texture });
    },

    writeSeedIfAbsent(scope, wallpaperId) {
      if (!nonEmptyString(wallpaperId)) return;
      if (state.seeds[scope] !== undefined) return;
      commit({ ...state, seeds: { ...state.seeds, [scope]: wallpaperId } });
    },

    setOverride(scope, o) {
      if (o === null) {
        if (state.overrides[scope] === undefined) return;
        const overrides = { ...state.overrides };
        delete overrides[scope];
        commit({ ...state, overrides });
        return;
      }
      if (sameOverride(state.overrides[scope], o)) return;
      commit({ ...state, overrides: { ...state.overrides, [scope]: o } });
    },

    draftWallpaperFor(draftId, catalogIds) {
      if (catalogIds.length === 0) return null;
      const existing = state.drafts[draftId];
      if (existing !== undefined) return existing;
      const id = catalogIds[stableWallpaperIndex(draftId, catalogIds.length)] ?? null;
      if (id === null) return null;
      const drafts = { ...state.drafts };
      const keys = Object.keys(drafts);
      for (const stale of keys.slice(0, Math.max(0, keys.length - (DRAFT_CAP - 1)))) delete drafts[stale];
      drafts[draftId] = id;
      commit({ ...state, drafts });
      return id;
    },

    forgetDraft(draftId) {
      if (state.drafts[draftId] === undefined) return;
      const drafts = { ...state.drafts };
      delete drafts[draftId];
      commit({ ...state, drafts });
    },

    moveDraft(fromKey, toKey) {
      const from = state.drafts[fromKey];
      if (from === undefined || state.drafts[toKey] !== undefined) return;
      const drafts = { ...state.drafts };
      delete drafts[fromKey];
      drafts[toKey] = from;
      commit({ ...state, drafts });
    },

    pruneScopes(live) {
      let changed = false;
      const seeds = { ...state.seeds };
      for (const key of Object.keys(seeds)) {
        if (!live.has(key as ScopeKey)) {
          delete seeds[key];
          changed = true;
        }
      }
      const overrides = { ...state.overrides };
      for (const key of Object.keys(overrides)) {
        if (!live.has(key as ScopeKey)) {
          delete overrides[key];
          changed = true;
        }
      }
      if (!changed) return;
      commit({ ...state, seeds, overrides });
    },

    setSection(name, open) {
      if (state.sections[name] === open) return;
      commit({ ...state, sections: { ...state.sections, [name]: open } });
    },
  };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Some browsers throw on `localStorage` access (blocked cookies/storage).
    return null;
  }
}

function currentServerKey(): string {
  try {
    const href = typeof location !== "undefined" ? location.href : "http://localhost/";
    return new URL(baseUrl(), href).origin;
  } catch {
    return "unknown";
  }
}

let singleton: BackgroundStore | null = null;

/** The app-wide store: `window.localStorage`, keyed per daemon origin. */
export function getBackgroundStore(): BackgroundStore {
  if (singleton === null) singleton = createBackgroundStore(browserStorage(), currentServerKey());
  return singleton;
}

/** Test-only: forget the singleton so a test starts from a fresh store. */
export function __resetBackgroundStoreForTests(): void {
  singleton = null;
}
