import { EllipsisVertical, Minus, Pin, PinOff, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileStat } from "@/api/types";
import type { EffectiveScrollMap } from "@/components/preview/scrollmap/effectiveScrollMapMode";
import { useFileScrollMap } from "@/hooks/useFileScrollMap";
import { copyText } from "@/lib/copyText";
import { resolveCopyPath } from "@/components/details/copyPath";
import { useDetailsStore, type DetailsTarget } from "@/components/details/detailsStore";
import { RailMenu } from "@/components/layout/ViewOptionsMenu";

export type FileStripVariant = "file" | "commit" | "artifact";

export interface FileMenuProps {
  api: ApiInstance;
  /** What Details / Copy path describe. */
  target: DetailsTarget | null;
  variant: FileStripVariant;
  /** Commit variant only: open the same file as a plain Files tab. */
  onOpenInFiles?: () => void;
  /** Set when the file is an artifact row (any variant). `onToggle` resolves to a note shown in the strip (or null). */
  pin?: { pinned: boolean; onToggle: () => Promise<string | null> } | null;
  font: { scale: number; bump: (delta: number) => void; reset: () => void };
  /** The scroll-map state for this pane; the group is shown only when it is not forced (`forced === null`). */
  scrollMap?: EffectiveScrollMap | null;
}

const ITEM_COUNT = 8;

/** The one strip menu (board 2): Details, Copy path, Open in Files, Pin, Text size, Scroll map. */
export function FileMenu(props: FileMenuProps) {
  return (
    <RailMenu label="File menu" variant="icon" itemCount={ITEM_COUNT} width={220} icon={<EllipsisVertical size={14} aria-hidden="true" />}>
      {(close) => <FileMenuItems {...props} close={close} />}
    </RailMenu>
  );
}

/** Mounted only while the menu is open, so the `statPath` lookup happens on open, not on click. */
function FileMenuItems({ api, target, variant, onOpenInFiles, pin, font, scrollMap, close }: FileMenuProps & { close: (refocus: boolean) => void }) {
  const [stat, setStat] = useState<FileStat | null>(null);
  const [mode, setMode] = useFileScrollMap();
  const scopeId = target?.scopeId;
  const path = target?.path;
  const scope = target?.scope;
  const artifactId = target?.artifact?.id;

  useEffect(() => {
    if (!scopeId || path === undefined || scope === undefined) return;
    let live = true;
    api.statPath(scopeId, path, scope, artifactId).then(
      (s) => {
        if (live) setStat(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, scopeId, path, scope, artifactId]);

  const copyPathItem = () => {
    if (!target) return;
    // Synchronous on purpose: the clipboard write must stay inside the click gesture.
    void copyText(resolveCopyPath(target, stat));
    close(true);
  };

  const showScrollMap = scrollMap != null && scrollMap.display !== "none" && scrollMap.forced === null;
  const percent = Math.round(font.scale * 100);

  return (
    <>
      {target ? (
        <button
          type="button"
          role="menuitem"
          className="rail-menu__item"
          onClick={() => {
            useDetailsStore.getState().open(target);
            close(true);
          }}
        >
          Details
        </button>
      ) : null}
      {target ? (
        <button type="button" role="menuitem" className="rail-menu__item" onClick={copyPathItem}>
          Copy path
        </button>
      ) : null}
      {variant === "commit" && onOpenInFiles ? (
        <button
          type="button"
          role="menuitem"
          className="rail-menu__item"
          onClick={() => {
            onOpenInFiles();
            close(true);
          }}
        >
          Open in Files
        </button>
      ) : null}
      {pin ? (
        <button
          type="button"
          role="menuitem"
          className="rail-menu__item"
          onClick={() => {
            void pin.onToggle();
            close(true);
          }}
        >
          {pin.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
          {pin.pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      <div className="rail-menu__sep" role="separator" />
      <div className="rail-menu__row" role="group" aria-label="Text size">
        <span className="rail-menu__label">Text size</span>
        <span className="rail-menu__sp" />
        <button type="button" className="rail-menu__step" aria-label="Decrease text size" onClick={() => font.bump(-0.05)}>
          <Minus size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rail-menu__pct"
          aria-label="Reset text size"
          title="Reset text size"
          disabled={percent === 100}
          onClick={font.reset}
        >
          {percent}%
        </button>
        <button type="button" className="rail-menu__step" aria-label="Increase text size" onClick={() => font.bump(0.05)}>
          <Plus size={11} aria-hidden="true" />
        </button>
      </div>
      {showScrollMap ? (
        <>
          <div className="rail-menu__sep" role="separator" />
          <div role="group" aria-label="Scroll map">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === "minimap"}
              className="rail-menu__item"
              onClick={() => setMode("minimap")}
            >
              Minimap
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === "marks"}
              className="rail-menu__item"
              onClick={() => setMode("marks")}
            >
              Marks
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
