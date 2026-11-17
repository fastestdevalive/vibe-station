import { useSyncExternalStore } from "react";
import type { WallpaperEntry } from "@/api/types";
import { useThemeStore } from "@/hooks/useThemeStore";
import { lookFromPrefs } from "./backgroundLook";
import { getBackgroundStore, type ScopeKey } from "./backgroundStore";
import { scopeDefault, scopeFallbackId } from "./resolveWallpaper";
import { useReduceTransparency } from "./useReduceTransparency";
import { useWallpaperCatalog } from "./useWallpaperCatalog";
import { CollapsibleSection } from "./CollapsibleSection";
import { CreditLine } from "./CreditLine";
import { GradientTiles } from "./GradientTiles";
import { gradientById } from "./gradient";
import { ModeSegmented, ScopeHeader, SelectionRow } from "./PickerParts";
import { TextureTiles } from "./TextureTiles";
import { WallpaperGrid } from "./WallpaperGrid";
import { WallpaperPreview } from "./WallpaperPreview";
import { usePickerSections } from "./usePickerSections";
import "./picker.css";

export interface PickerProps {
  mode: "app" | "scope";
  /** Onboarding opens Wallpaper; when set, sections are NOT persisted. */
  initialOpen?: { wallpaper?: boolean; texture?: boolean; gradient?: boolean };
  /** Mode "scope" only. */
  scope?: { key: ScopeKey; label: string };
  /** Chip copy for a system pick; Settings says "Picked at first run". */
  pickLabel?: string;
  onClose?: () => void;
}

/** Solid keeps the plain theme window; agents may still keep their own wallpaper. */
const SOLID_NOTE =
  "No wallpaper anywhere. Agent drafts keep their own wallpaper while 'Own wallpaper per agent' is on.";
const REDUCED_NOTE = "Solid while the system's Reduce transparency setting is on.";
const UNAVAILABLE_NOTE = "Wallpapers unavailable";
const WALLPAPER_NOTE = "One wallpaper behind the whole window.";
const SOLID_CAPTION = "The window keeps the plain theme colours.";
/** Scope mode's Default tile says why it shows what it shows (mobile parity). */
const APP_CAPTION = "follows app background";
const SEEDED_CAPTION = "given when this agent was created";
const WORKTREE_PICK_CAPTION = "picked for this worktree";
const PROJECT_PICK_CAPTION = "picked for this project";

/**
 * The one background picker (design `Picker.dc.html`), in two modes:
 *
 * - `app`: Solid │ Wallpaper, a live 16:9 preview, Shuffle, then collapsible
 *   Wallpaper and Texture sections. Every choice applies immediately.
 * - `scope`: "Wallpaper · <label>" with Default / None / the catalog grid for one
 *   worktree or project (no texture: texture is global).
 *
 * The store is the only owner of every value here; the picker just reads it and
 * writes through its API.
 */
export function Picker({
  mode,
  initialOpen,
  scope,
  pickLabel = "Picked for you",
  onClose,
}: PickerProps): React.JSX.Element {
  const catalog = useWallpaperCatalog();
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const sections = usePickerSections(initialOpen);
  const appearance = useThemeStore((s) => s.appearance);
  const reduceTransparency = useReduceTransparency();

  const ids = catalog.ids;

  const entryFor = (id: string | null): WallpaperEntry | undefined =>
    id === null ? undefined : catalog.wallpapers.find((w) => w.id === id);

  const validId = (id: string | null | undefined): string | null =>
    typeof id === "string" && id !== "" && ids.includes(id) ? id : null;

  if (mode === "scope") {
    if (scope === undefined) return <div className="wp-picker" />;

    const override = prefs.overrides[scope.key];
    const overrideId = override?.kind === "id" ? validId(override.id) : null;
    const isWorktree = scope.key.startsWith("worktree:");
    // Default = what this scope shows with no override, from the ONE rule
    // (`scopeDefault`): the app background (agents share the app background), a valid seed, or the hash pick.
    const def = scopeDefault(scope.key, {
      agentWallpapers: prefs.agentWallpapers,
      appWallpaperId: prefs.wallpaperId,
      seed: prefs.seeds[scope.key],
      catalogIds: ids,
    });
    const defaultId = def.id;
    // The Default tile names the wallpaper it stands for, then says why it shows it
    // (design Picker.dc.html `defCaption`); with no catalog there is no name to add.
    const defaultEntry = entryFor(defaultId);
    // The caption sits beside the thumb it explains: only a worktree with a seed
    // got its wallpaper when the agent was created; every other seedless/hashed
    // pick is a hash pick, not the app background.
    const defaultCaption =
      def.source === "app"
        ? APP_CAPTION
        : isWorktree && def.source === "seed"
          ? SEEDED_CAPTION
          : isWorktree
            ? WORKTREE_PICK_CAPTION
            : PROJECT_PICK_CAPTION;
    const selectedEntry = entryFor(overrideId) ?? entryFor(defaultId);
    // An override naming a removed id draws nothing, so Default is what shows.
    const defaultSelected = override === undefined || (override.kind === "id" && overrideId === null);
    const sub = isWorktree ? "Only this worktree" : "Only this project screen";

    return (
      <div className="wp-picker">
        <ScopeHeader label={scope.label} sub={sub} />
        <WallpaperGrid
          wallpapers={catalog.wallpapers}
          selectedId={overrideId}
          onPick={(id) => store.setOverride(scope.key, { kind: "id", id })}
          defaultTile={{
            wallpaperId: defaultId,
            caption:
              defaultEntry !== undefined
                ? `${defaultEntry.name} · ${defaultCaption}`
                : defaultCaption,
            selected: defaultSelected,
            onPick: () => store.setOverride(scope.key, null),
          }}
          noneTile={{
            caption: "Solid on this screen only",
            selected: override?.kind === "none",
            onPick: () => store.setOverride(scope.key, { kind: "none" }),
          }}
        />
        {selectedEntry !== undefined ? <CreditLine entry={selectedEntry} /> : null}
        {onClose !== undefined ? (
          <div className="wp-scope__foot">
            <button type="button" className="wp-btn" onClick={onClose}>
              Done
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const solidSelected = prefs.mode === "solid";
  const unavailable = catalog.status === "unavailable";
  const currentId = validId(prefs.wallpaperId) ?? scopeFallbackId("app", ids);
  const entry = entryFor(currentId);
  const look = lookFromPrefs(prefs);
  const texture = look.texture;
  const intensity = look.intensity;
  const plainPreview = solidSelected || reduceTransparency;
  const caption = unavailable
    ? UNAVAILABLE_NOTE
    : reduceTransparency
      ? REDUCED_NOTE
      : solidSelected
        ? SOLID_CAPTION
        : WALLPAPER_NOTE;

  const shuffle = () => {
    if (ids.length === 0) return;
    const index = currentId === null ? -1 : ids.indexOf(currentId);
    const offset = ids.length > 1 ? 1 + Math.floor(Math.random() * (ids.length - 1)) : 0;
    const next = ids[(index + offset + ids.length) % ids.length];
    if (next === undefined) return;
    // Shuffle is a system pick again: the chip comes back (design `isPick: true`).
    store.patch({ wallpaperId: next, mode: "wallpaper", picked: true });
  };

  return (
    <div className="wp-picker">
      <ModeSegmented
        value={solidSelected ? "solid" : "wallpaper"}
        wallpaperDisabled={unavailable}
        caption={caption}
        onChange={(next) => store.patch({ mode: next })}
      />

      <WallpaperPreview
        id={plainPreview ? null : currentId}
        sha={entry?.fullSizeSha ?? null}
        look={look}
        label={
          plainPreview || entry === undefined
            ? "Preview: plain theme colours"
            : `Preview: ${entry.name} with ${texture.label}`
        }
      />

      {!solidSelected && currentId !== null ? (
        <SelectionRow
          picked={prefs.picked}
          pickLabel={pickLabel}
          name={entry?.name ?? "—"}
          rest={texture.delivery === "none" ? undefined : `· ${texture.label}`}
          onShuffle={ids.length > 0 ? shuffle : undefined}
        />
      ) : null}

      {solidSelected ? (
        <p className="wp-picker__note">{SOLID_NOTE}</p>
      ) : (
        <>
          <CollapsibleSection
            id="wp-wallpaper"
            title="Wallpaper"
            summary={
              <>
                <b>{entry?.name ?? "—"}</b>
                {entry !== undefined ? ` · ${entry.license ?? "CC0"}` : null}
              </>
            }
            open={sections.wallpaper.open}
            onToggle={sections.wallpaper.toggle}
          >
            <WallpaperGrid
              wallpapers={catalog.wallpapers}
              selectedId={currentId}
              onPick={(id) => store.patch({ wallpaperId: id, mode: "wallpaper", picked: false })}
            />
            {entry !== undefined ? <CreditLine entry={entry} /> : null}
          </CollapsibleSection>

          <CollapsibleSection
            id="wp-texture"
            title="Texture"
            summary={
              <>
                <b>{texture.label}</b>
                {texture.delivery === "none" ? null : ` · ${Math.round(intensity * 100)}%`}
              </>
            }
            open={sections.texture.open}
            onToggle={sections.texture.toggle}
          >
            <TextureTiles
              appearance={appearance}
              selected={prefs.texture}
              onPick={(id) => store.patch({ texture: id, intensity: null, picked: false })}
              intensity={intensity}
              onIntensity={(value) => store.patch({ intensity: value })}
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="wp-gradient"
            title="Gradient"
            summary={<b>{gradientById(look.gradient).label}</b>}
            open={sections.gradient.open}
            onToggle={sections.gradient.toggle}
          >
            <GradientTiles
              wallpaperId={currentId}
              selected={look.gradient}
              onPick={(id) => store.patch({ gradient: id })}
            />
          </CollapsibleSection>
        </>
      )}
    </div>
  );
}
