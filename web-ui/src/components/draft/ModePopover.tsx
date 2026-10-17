import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import type { Mode } from "@/api/types";
import { ModeIcon } from "../agent/ModeIcon";
import { useEventTargets } from "@/context/DemoEnv";

// Gap kept between the popover and its clip edge (the body scroller top).
const POPOVER_EDGE_PX = 8;
// Floor: pinned row + label + about one mode row, so a short pane keeps the
// pinned "New mode…" and "Modes" label reachable even when space is tiny.
const POPOVER_MIN_PX = 120;

interface ModePopoverProps {
  modes: Mode[];
  modeId: string;
  channel: "json" | "pty";
  disabled?: boolean;
  onSelect: (id: string) => void;
  onNewMode: () => void;
}

/** The mode chip in the draft composer toolbar. Opens a popover listing the
 *  available modes plus a pinned "New mode…" action (Decision 3). */
export function ModePopover({ modes, modeId, channel, disabled, onSelect, onNewMode }: ModePopoverProps) {
  const { doc, win } = useEventTargets();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const uid = useId();

  const current = modes.find((m) => m.id === modeId);
  // activeIndex 0 = "New mode…", 1..n = modes.
  const items = [{ kind: "new-mode" as const }, ...modes.map((m) => ({ kind: "mode" as const, mode: m }))];
  const activeItem = items[activeIndex];
  // Where the keyboard cursor should start on open: the currently selected
  // mode (R1F-10, owner #6). +1 skips the pinned "New mode…"; 0 when absent.
  const selectedIndex = modes.findIndex((m) => m.id === modeId) + 1;

  function closeAndRefocus() {
    setOpen(false);
    setActiveIndex(0);
    chipRef.current?.focus();
  }

  function openPopover() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function activate(item: { kind: "new-mode" } | { kind: "mode"; mode: Mode }) {
    if (item.kind === "new-mode") {
      setOpen(false);
      onNewMode();
    } else {
      onSelect(item.mode.id);
      setOpen(false);
      chipRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openPopover();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, items.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (activeItem) activate(activeItem);
        break;
      case "Tab":
        // Let focus move on, but do not leave the popover open behind it.
        setOpen(false);
        break;
      case "Escape":
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        closeAndRefocus();
        break;
      default:
        break;
    }
  }

  // Close on outside click (same pattern as ProjectCombobox).
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    doc.addEventListener("mousedown", onDocMouseDown);
    return () => doc.removeEventListener("mousedown", onDocMouseDown);
  }, [open, doc]);

  // Bound the popover to the space above it in short panes (R4F-01). The --up
  // popover is anchored by its bottom edge, so its bottom does not depend on
  // its height; only the mode list is allowed to shrink/scroll, keeping the
  // pinned "New mode…" and "Modes" label visible.
  useLayoutEffect(() => {
    if (!open) return;
    function measure() {
      const pop = popoverRef.current;
      if (!pop) return;
      const bottom = pop.getBoundingClientRect().bottom;
      const scroller = pop.closest(".draft-composer__body");
      const top = Math.max(0, scroller ? scroller.getBoundingClientRect().top : 0);
      setMaxHeight(Math.max(POPOVER_MIN_PX, Math.floor(bottom - top - POPOVER_EDGE_PX)));
    }
    measure();
    win.addEventListener("resize", measure);
    return () => win.removeEventListener("resize", measure);
  }, [open, win]);

  // Keep the focused item visible when the cursor moves (R1F-10). jsdom has no
  // scrollIntoView, so guard the call. Runs again once maxHeight bounds the
  // popover (R4F-01): the list is then the only scrollable clipping ancestor,
  // so "nearest" scrolls only the list, bringing the selected mode into view.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${uid}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, uid, maxHeight]);

  return (
    <div className="draft-popover-anchor" ref={anchorRef}>
      <button
        type="button"
        ref={chipRef}
        className="draft-mode-chip"
        title={current?.name}
        aria-label="Mode"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && activeItem ? `${uid}-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPopover())}
        onKeyDown={onKeyDown}
      >
        <span data-testid="draft-mode-icon" aria-hidden="true">
          <ModeIcon iconKey={current?.icon} channel={channel} size={14} />
        </span>
        <span className="draft-mode-chip__name">{current?.name ?? "Mode"}</span>
        <ChevronDown size={12} aria-hidden />
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className="draft-popover draft-popover--up"
          role="listbox"
          aria-label="Modes"
          style={maxHeight != null ? { maxHeight } : undefined}
          onKeyDown={onKeyDown}
        >
          <div className="draft-popover__pinned">
            <button
              type="button"
              className={`draft-popover__item${activeIndex === 0 ? " draft-popover__item--active" : ""}`}
              role="option"
              tabIndex={-1}
              aria-selected="false"
              id={`${uid}-0`}
              onClick={() => activate(items[0]!)}
              onMouseEnter={() => setActiveIndex(0)}
            >
              <Plus size={14} aria-hidden />
              <span>New mode…</span>
            </button>
          </div>
          <div className="draft-popover__label">Modes</div>
          <div className="draft-popover__list">
            {modes.map((m, i) => {
              const idx = i + 1;
              const selected = m.id === modeId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`draft-popover__item${activeIndex === idx ? " draft-popover__item--active" : ""}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  id={`${uid}-${idx}`}
                  onClick={() => activate({ kind: "mode", mode: m })}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <span aria-hidden="true">
                    <ModeIcon iconKey={m.icon} channel={channel} size={14} />
                  </span>
                  <span className="draft-popover__text">
                    <span>{m.name}</span>
                    <span className="draft-popover__sub">
                      {m.cli}
                      {m.model ? " · " + m.model : ""}
                    </span>
                  </span>
                  {selected ? <Check size={14} aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
