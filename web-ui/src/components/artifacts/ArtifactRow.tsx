import { memo } from "react";
import { FileText, Image as ImageIcon, MoreHorizontal } from "lucide-react";
import type { ArtifactRow as Row } from "@/api/types";
import { RelativeTime } from "@/components/layout/RelativeTime";
import { baseName } from "./artifactSessions";

interface ArtifactRowProps {
  row: Row;
  /** Nearest differing folder, shown only to tell apart same-named files (`README.md` in two folders). */
  folderHint?: string;
  selected: boolean;
  tabbable: boolean;
  /** ≤768 px: the 44px row. */
  mobile: boolean;
  menuOpen: boolean;
  onOpen: (row: Row) => void;
  onFocusRow: (row: Row) => void;
  /** Opens the row menu, anchored to `anchor` (the trigger) or to a pointer point. */
  onMenu: (row: Row, anchor: { el?: HTMLElement; x?: number; y?: number }) => void;
  setRef: (id: string, el: HTMLElement | null) => void;
}

/**
 * One artifact, one line (tools-pane-rework B6): type icon, name, short age. Writers, path, edits and the outside-repo
 * state live in Details. Hover or focus swaps the age for the row's more button. A missing file is dimmed and struck
 * through, its age reads "missing".
 */
export const ArtifactRow = memo(function ArtifactRow({ row, folderHint, selected, tabbable, mobile, menuOpen, onOpen, onFocusRow, onMenu, setRef }: ArtifactRowProps) {
  const missing = row.state === "missing";
  const Icon = row.kind === "image" ? ImageIcon : FileText;

  const classes = [
    "artifacts-row",
    mobile ? "artifacts-row--mobile" : null,
    selected ? "artifacts-row--selected" : null,
    missing ? "artifacts-row--missing" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="artifacts-row-wrap" role="presentation">
      <div
        ref={(el) => setRef(row.id, el)}
        role="option"
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        className={classes}
        data-artifact-id={row.id}
        onClick={() => onOpen(row)}
        onFocus={() => onFocusRow(row)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(row, { x: e.clientX, y: e.clientY });
        }}
      >
        <Icon size={16} className="artifacts-row__icon" aria-hidden="true" />
        <span className="artifacts-row__name" title={row.displayPath}>
          {baseName(row.displayPath)}
          {folderHint ? <span className="artifacts-row__hint"> {folderHint}</span> : null}
        </span>
        {missing ? (
          <span className="artifacts-row__time artifacts-row__missing">missing</span>
        ) : (
          <RelativeTime at={row.lastWrittenAt} className="artifacts-row__time" />
        )}
      </div>
      <button
        type="button"
        className="artifacts-row__more"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(row, { el: e.currentTarget });
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
    </div>
  );
});
