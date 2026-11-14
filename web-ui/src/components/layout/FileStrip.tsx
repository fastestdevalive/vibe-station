import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "@/lib/copyText";
import { FileMenu, type FileMenuProps } from "@/components/layout/FileMenu";

export interface FileStripNav {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

export interface FileStripProps {
  variant: FileMenuProps["variant"];
  /** Full path (its basename is the name). */
  path: string;
  /** Muted directory text; truncates from the START. */
  displayDir: string;
  /** What the name and the directory copy on click (absolute for artifacts, repo-relative otherwise). */
  copyValue: string;
  stats?: { additions: number; deletions: number } | null;
  /** Tooltip of the counts (what they are measured against). */
  statsTitle?: string;
  /** Back / forward. Null hides them (commit variant). */
  nav?: FileStripNav | null;
  /** The view switch (HTML Rendered/Source, or diff Inline/Side-by-side). */
  view?: ReactNode;
  menu: FileMenuProps;
}

const NOTE_MS = 4000;

/** basename of a path, `/` or `\` separated. */
export function baseNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * The file subheader (board 2): back / forward, file name (never truncated), line counts, the directory (muted,
 * truncated from the start, click copies), then the view switch and the ONE menu, pinned outside the scrolling row.
 */
export function FileStrip({ variant, path, displayDir, copyValue, stats, statsTitle, nav, view, menu }: FileStripProps) {
  const name = baseNameOf(path);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // A pin note (or any strip note) is a 4 s status line; a newer one replaces the older.
  const flash = (text: string | null) => {
    if (!text) return;
    setNote(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const copy = () => {
    // Synchronous: no await before the clipboard write (keeps the user gesture).
    void copyText(copyValue);
  };

  const pinSource = menu.pin;
  const menuProps: FileMenuProps = {
    ...menu,
    pin: pinSource
      ? {
          pinned: pinSource.pinned,
          onToggle: async () => {
            const note = await pinSource.onToggle();
            flash(note);
            return note;
          },
        }
      : null,
  };

  return (
    <div className={`preview-diffinfo file-strip file-strip--${variant}`}>
      <div className="file-strip__main">
        {nav ? (
          <div className="file-strip__nav" role="navigation" aria-label="Preview navigation">
            <button
              type="button"
              className="file-strip__btn"
              aria-label="Back"
              title="Back (Alt+Shift+←)"
              disabled={!nav.canGoBack}
              onClick={nav.onBack}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="file-strip__btn"
              aria-label="Forward"
              title="Forward (Alt+Shift+→)"
              disabled={!nav.canGoForward}
              onClick={nav.onForward}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <span className="file-strip__namewrap">
          <button type="button" className="file-strip__name" title={path} onClick={copy}>
            {name}
          </button>
        </span>
        {stats ? (
          <span className="file-strip__stats" aria-label="Diff line counts" title={statsTitle}>
            <span className="preview-diffinfo__stats-plus">+{stats.additions}</span>{" "}
            <span className="preview-diffinfo__stats-minus">−{stats.deletions}</span>
          </span>
        ) : null}
        {displayDir ? (
          <button type="button" className="file-strip__dir" title={displayDir} onClick={copy}>
            <bdi>{displayDir}</bdi>
          </button>
        ) : null}
      </div>
      {note ? (
        <span className="file-strip__note" role="status">
          {note}
        </span>
      ) : null}
      {view}
      <FileMenu {...menuProps} />
    </div>
  );
}
