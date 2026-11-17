import { useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { ImageIcon, RotateCcw } from "lucide-react";
import { getBackgroundStore, type ScopeKey } from "./backgroundStore";
import { scopeDefault } from "./resolveWallpaper";
import { useScopePickerStore } from "./scopePickerStore";
import { useWallpaperCatalog } from "./useWallpaperCatalog";
import "./scopeRow.css";

export interface WallpaperMenuRowProps {
  scope: ScopeKey;
  label: string;
  kind: "worktree" | "project";
  /** Close the menu this row lives in. */
  onDone: () => void;
}

const SOLID_CAPTION = "Background is Solid · Turn on";

/**
 * The "Wallpaper" row of a worktree/project options menu. It never writes the
 * store itself: it shows what this scope currently resolves to and opens the
 * scope picker (or Settings › Background when the app background is Solid).
 */
export function WallpaperMenuRow({ scope, label, kind, onDone }: WallpaperMenuRowProps) {
  const navigate = useNavigate();
  const store = getBackgroundStore();
  const prefs = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const catalog = useWallpaperCatalog();
  const showPicker = useScopePickerStore((s) => s.show);

  const nameOf = (id: string | null | undefined): string | null => {
    if (typeof id !== "string" || id === "") return null;
    return catalog.wallpapers.find((w) => w.id === id)?.name ?? null;
  };

  const override = prefs.overrides[scope];

  // The row names exactly what `resolveWallpaper` draws for this scope with no
  // override — the same `scopeDefault` rule the picker and the screen use.
  const def = scopeDefault(scope, {
    agentWallpapers: prefs.agentWallpapers,
    appWallpaperId: prefs.wallpaperId,
    seed: prefs.seeds[scope],
    catalogIds: catalog.ids,
  });

  // A name needs the catalog; while it is still loading (or unavailable) the
  // row degrades to the bare "Default" rather than showing an id.
  let value = "Default";
  if (prefs.mode === "solid") {
    value = "Off";
  } else if (override?.kind === "none") {
    value = "None";
  } else if (override?.kind === "id") {
    value = nameOf(override.id) ?? "Default";
  } else {
    const name = nameOf(def.id);
    if (name !== null) value = `Default · ${name}`;
  }

  // The reset row's sub-line explains what Default means for THIS scope, from
  // the same source (a seedless scope with agents on resets to its hash pick,
  // not the app background).
  const resetSub =
    def.source === "seed"
      ? `Use the wallpaper this ${kind} started with`
      : def.source === "pick"
        ? `Use the wallpaper picked for this ${kind}`
        : "Follow the app background";

  const openRow = () => {
    if (prefs.mode === "solid") {
      onDone();
      navigate("/settings/background");
      return;
    }
    showPicker({ scope, label, kind });
    onDone();
  };

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="menu-pop__item menu-pop__item--icon wp-menu-row"
        onClick={(e) => {
          e.stopPropagation();
          openRow();
        }}
      >
        <ImageIcon size={13} aria-hidden />
        <span className="wp-menu-row__label">Wallpaper</span>
        <span
          className={
            prefs.mode === "solid"
              ? "wp-menu-row__value wp-menu-row__value--muted"
              : "wp-menu-row__value"
          }
        >
          {value}
        </span>
      </button>
      {prefs.mode === "solid" ? <div className="wp-menu-row__caption">{SOLID_CAPTION}</div> : null}
      {override !== undefined ? (
        <button
          type="button"
          role="menuitem"
          className="menu-pop__item menu-pop__item--icon wp-menu-row wp-menu-row--reset"
          onClick={(e) => {
            e.stopPropagation();
            store.setOverride(scope, null);
          }}
        >
          <RotateCcw size={13} aria-hidden />
          <span className="wp-menu-row__stack">
            <span className="wp-menu-row__label">Reset to default</span>
            <span className="wp-menu-row__sub">{resetSub}</span>
          </span>
        </button>
      ) : null}
    </>
  );
}
