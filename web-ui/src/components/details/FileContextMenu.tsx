import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileStat } from "@/api/types";
import { copyText } from "@/lib/copyText";
import { resolveCopyPath, resolveRelativePath } from "./copyPath";
import { useDetailsStore, type DetailsTarget } from "./detailsStore";

interface FileContextItemsProps {
  api: Pick<ApiInstance, "statPath">;
  target: DetailsTarget;
  /** Dismisses the menu; `refocus` returns focus to the row. */
  close: (refocus: boolean) => void;
}

/**
 * The row menu's items (tools-pane-rework B7.2): Copy path, Copy relative path (not for outside-repo artifacts),
 * Details. Mounted only while the menu is open, so the stat behind "Copy path" is fetched on open, never on click.
 */
export function FileContextItems({ api, target, close }: FileContextItemsProps) {
  const [stat, setStat] = useState<FileStat | null>(null);
  const artifactId = target.artifact?.id;

  useEffect(() => {
    let live = true;
    api.statPath(target.scopeId, target.path, target.scope, artifactId).then(
      (s) => {
        if (live) setStat(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, target.scopeId, target.path, target.scope, artifactId]);

  const relativeAllowed = !(target.artifact && !target.artifact.inRepo);

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="rail-menu__item"
        onClick={() => {
          // Synchronous: the clipboard write stays inside the click gesture.
          void copyText(resolveCopyPath(target, stat));
          close(true);
        }}
      >
        Copy path
      </button>
      {relativeAllowed ? (
        <button
          type="button"
          role="menuitem"
          className="rail-menu__item"
          onClick={() => {
            void copyText(resolveRelativePath(target));
            close(true);
          }}
        >
          Copy relative path
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className="rail-menu__item"
        onClick={() => {
          useDetailsStore.getState().open(target);
          // The popup takes focus; the row must not pull it back.
          close(false);
        }}
      >
        Details
      </button>
    </>
  );
}
