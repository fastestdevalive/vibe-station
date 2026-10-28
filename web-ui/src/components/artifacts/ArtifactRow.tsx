import { memo } from "react";
import { FileText, Image as ImageIcon, MoreHorizontal } from "lucide-react";
import type { ArtifactRow as Row } from "@/api/types";
import { RelativeTime } from "@/components/layout/RelativeTime";
import { Chip } from "@/components/ui/Chip";
import { baseName, dirOf } from "./artifactSessions";

interface ArtifactRowProps {
  row: Row;
  /** Newest writer's label ("deleted agent" for an unknown session), or null when no writer is recorded. */
  writer: string | null;
  selected: boolean;
  tabbable: boolean;
  /** ≤768 px: `.mrow` metrics and a plain-text sub-line (no chip). */
  mobile: boolean;
  menuOpen: boolean;
  onOpen: (row: Row) => void;
  onFocusRow: (row: Row) => void;
  /** Opens the row menu, anchored to `anchor` (the trigger) or to a pointer point. */
  onMenu: (row: Row, anchor: { el?: HTMLElement; x?: number; y?: number }) => void;
  setRef: (id: string, el: HTMLElement | null) => void;
}

/** One artifact row (`Main.dc.html` `.fr`, `Mobile.dc.html` `.mrow`). */
export const ArtifactRow = memo(function ArtifactRow({ row, writer, selected, tabbable, mobile, menuOpen, onOpen, onFocusRow, onMenu, setRef }: ArtifactRowProps) {
  const missing = row.state === "missing";
  const Icon = row.kind === "image" ? ImageIcon : FileText;
  const dir = dirOf(row.displayPath);
  const edits = row.editCount > 1 ? `${row.editCount} edits` : null;

  const classes = [
    "artifacts-row",
    mobile ? "artifacts-row--mobile" : null,
    selected ? "artifacts-row--selected" : null,
    missing ? "artifacts-row--missing" : null,
  ]
    .filter(Boolean)
    .join(" ");

  // Missing rows show the chip and the full path only (no writer or edit count).
  const tail = missing ? [] : [writer, edits].filter((x): x is string => x != null);

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
        <span className="artifacts-row__name" title={row.displayPath}>{baseName(row.displayPath)}</span>
        <RelativeTime at={row.lastWrittenAt} className="artifacts-row__time" />
        <span className="artifacts-row__sub">
          {mobile ? (
            <span className="artifacts-row__path">
              {[!row.inRepo ? "outside repo" : null, missing ? "missing" : null, missing ? row.displayPath : dir || null, ...tail]
                .filter((x): x is string => x != null && x !== "")
                .join(" · ")}
            </span>
          ) : (
            <>
              {!row.inRepo && (
                <Chip size="sm" tone="warn">
                  outside repo
                </Chip>
              )}
              {missing && (
                <Chip size="sm" tone="neutral">
                  missing
                </Chip>
              )}
              {(missing || dir) && <span className="artifacts-row__path" title={missing ? row.displayPath : dir}>
                  {missing ? row.displayPath : dir}
                </span>}
              {tail.length > 0 && <span className="artifacts-row__by">· {tail.join(" · ")}</span>}
            </>
          )}
        </span>
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
