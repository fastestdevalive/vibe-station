import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useThemeStore } from "@/hooks/useThemeStore";
import { themes, themeById } from "@/theme/registry";

/**
 * Compact theme picker for the left sidebar's status bar: a small swatch dot
 * + name button that opens an upward popover (list style: icon + name rows,
 * grouped by appearance). Hovering a row live-previews it across the WHOLE
 * app (not just inside the popover) by writing straight to `useThemeStore`
 * -- the same store every `useTheme()` consumer (chrome CSS vars, Shiki
 * highlighting) already subscribes to -- without ever calling `PATCH
 * /settings`. The popover only closes on an outside click, Escape, or an
 * actual row click; moving the pointer between rows (or off a row while
 * still inside the popover) never closes it. Closing without a click
 * reverts the live preview back to whatever was actually committed when the
 * popover opened.
 *
 * Icon-only trigger (no `collapsed` prop -- LeftSidebar only mounts this
 * inside its footer, which is itself hidden entirely on the collapsed rail).
 */
export function ThemeQuickPicker() {
  const { themeId, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  // Tracks the real committed themeId while the popover is closed; frozen
  // (stops following live store updates) while open, so the list's checkmark
  // keeps pointing at the actually-saved theme even while a different row is
  // being hover-previewed live.
  const [committedId, setCommittedId] = useState(themeId);
  useEffect(() => {
    if (!open) setCommittedId(themeId);
  }, [themeId, open]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const revertAndClose = () => {
      useThemeStore.getState().setThemeId(committedId);
      setOpen(false);
    };
    const onDocPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) revertAndClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") revertAndClose();
    };
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, committedId]);

  const darkThemes = themes.filter((t) => t.appearance === "dark");
  const lightThemes = themes.filter((t) => t.appearance === "light");
  const liveEntry = themeById[themeId];

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="icon-btn left-sidebar__theme-btn"
        aria-label={`Theme: ${liveEntry?.name ?? themeId}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Theme (${liveEntry?.name ?? themeId})`}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="left-sidebar__theme-dot"
          style={{ background: liveEntry?.cssVars["--bg-primary"], borderColor: liveEntry?.cssVars["--accent"] }}
          aria-hidden
        />
        <Palette size={11} aria-hidden />
      </button>
      {open ? (
        <div className="theme-quick-popover" role="listbox" aria-label="Themes">
          <div className="theme-quick-popover__group-label">Dark</div>
          {darkThemes.map((t) => (
            <ThemeQuickRow key={t.id} entry={t} committed={t.id === committedId} onCommit={() => {
              setTheme(t.id);
              setCommittedId(t.id);
              setOpen(false);
            }} />
          ))}
          <div className="theme-quick-popover__group-label">Light</div>
          {lightThemes.map((t) => (
            <ThemeQuickRow key={t.id} entry={t} committed={t.id === committedId} onCommit={() => {
              setTheme(t.id);
              setCommittedId(t.id);
              setOpen(false);
            }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThemeQuickRow({
  entry,
  committed,
  onCommit,
}: {
  entry: (typeof themes)[number];
  committed: boolean;
  onCommit: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={committed}
      className="theme-quick-popover__row"
      onMouseEnter={() => useThemeStore.getState().setThemeId(entry.id)}
      onFocus={() => useThemeStore.getState().setThemeId(entry.id)}
      onClick={onCommit}
    >
      <span
        className="theme-quick-popover__dot"
        style={{ background: entry.cssVars["--bg-primary"], borderColor: entry.cssVars["--accent"] }}
        aria-hidden
      />
      <span className="theme-quick-popover__name">{entry.name}</span>
      {committed ? <Check size={12} className="theme-quick-popover__check" aria-hidden /> : null}
    </button>
  );
}
