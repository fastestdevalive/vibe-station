import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDemoEnv } from "@/context/DemoEnv";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  FILES_LEFT_PANE_DEFAULT_HEIGHT,
  FILES_LEFT_PANE_DEFAULT_WIDTH,
  FILES_LEFT_PANE_MAX_HEIGHT,
  FILES_LEFT_PANE_MAX_WIDTH,
  FILES_LEFT_PANE_MIN_HEIGHT,
  FILES_LEFT_PANE_MIN_WIDTH,
  FILES_LEFT_PANE_MIN_WIDTH_DESKTOP,
  LIST_PANE_H,
  LIST_PANE_W,
  PANE_ROW_H,
} from "@/lib/layoutSizes";

/** Height of the content column's top bar; the stacked list clamp leaves it room. */
const TOPBAR_H = PANE_ROW_H;
/** Phone sizing: the list never takes more than the pane minus the content's minimum. */
const MOBILE_MIN_PREVIEW_W = 144;
const MOBILE_MIN_LIST_W = 120;
const MOBILE_MIN_PREVIEW_H = 96;
const MOBILE_MIN_LIST_H = 80;
/** Desktop: a narrow tools pane gives the list at most (pane - this) so the content column (and the pane controls
 *  in its top bar) stay reachable; the list never goes below DESKTOP_MIN_LIST_W. */
const DESKTOP_MIN_CONTENT_W = 120;
const DESKTOP_MIN_LIST_W = 120;

/** Desktop list width: the wanted (>=224) width, capped to leave the content its minimum, never below a usable list. */
export function desktopListWidth(wanted: number, paneW: number): number {
  return Math.max(DESKTOP_MIN_LIST_W, Math.min(wanted, paneW - DESKTOP_MIN_CONTENT_W));
}

/** Phone list size along one axis: half the room by default, otherwise the desired size, always leaving the preview its minimum. */
export function mobileListSize(
  desired: number,
  isDefault: boolean,
  room: number,
  o: { min: number; floor: number; minPreview: number; def: number },
): number {
  const want = isDefault ? Math.min(o.def, Math.round(room / 2)) : desired;
  return Math.max(o.floor, Math.min(room - o.minPreview, Math.max(o.min, want)));
}

interface DockedListLayoutProps {
  /** Context id (worktree/project id): keys the persisted list size and the stacked/side-by-side setting. */
  wt: string;
  /** Whether the list panel is open (it stays mounted, hidden, when closed). */
  open: boolean;
  /** Content of the content column's top bar (tabs / breadcrumb, then the actions host). */
  topbar: ReactNode;
  /** Extra class on the top bar (`vcs-topbar`). */
  topbarClassName?: string;
  /** The content column's body (a file / diff preview). */
  children: ReactNode;
  /** The list panel's content. */
  list: ReactNode;
  /** Accessible noun for the resize handle ("files" -> "Resize files side panel"). */
  handleLabel: string;
}

/**
 * The tools pane's docked list layout, shared by the Files tab and the VCS commit view: the content column is
 * full width underneath, and the list is an overlay docked on the RIGHT of it (left of the window rail), padded
 * for by the content. Its resize handle is on the list's LEFT edge (dragging left grows it); stacked
 * (`masterDetailVertical`) keeps a top overlay. On phones the size is clamped to the measured pane so the content
 * keeps >=144px wide / >=96px tall. The size persists per context in `filesLeftPane{Width,Height}ByWorktree`.
 */
export function DockedListLayout({
  wt,
  open,
  topbar,
  topbarClassName,
  children,
  list,
  handleLabel,
}: DockedListLayoutProps) {
  const env = useDemoEnv();
  const isMobile = useIsMobile();
  const masterDetailVertical = useWorkspaceStore(
    (s) => !!(s.layoutByWorktree[wt] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical,
  );
  const rawStoredWidth = useWorkspaceStore((s) => s.filesLeftPaneWidthByWorktree[wt]);
  const rawStoredHeight = useWorkspaceStore((s) => s.filesLeftPaneHeightByWorktree[wt]);
  const storedWidth = rawStoredWidth ?? FILES_LEFT_PANE_DEFAULT_WIDTH;
  const storedHeight = rawStoredHeight ?? FILES_LEFT_PANE_DEFAULT_HEIGHT;
  const [localDragWidth, setLocalDragWidth] = useState<number | null>(null);
  const [localDragHeight, setLocalDragHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Padding transition only for an explicit toggle (toggleFileTree / setMasterDetailVertical raise this hint for
  // ~300ms) — never derived from open/orientation/width changing, which a worktree switch also does.
  const animatePadding = useWorkspaceStore((s) => s.layoutTransitionHint === "files");
  // Desktop floor keeps the open list's header clear of the actions chip (see FILES_LEFT_PANE_MIN_WIDTH_DESKTOP); phones have no chip.
  const minWidth = isMobile ? FILES_LEFT_PANE_MIN_WIDTH : FILES_LEFT_PANE_MIN_WIDTH_DESKTOP;
  const activeWidth = isMobile ? (localDragWidth ?? storedWidth) : Math.max(minWidth, localDragWidth ?? storedWidth);
  const activeHeight = localDragHeight ?? storedHeight;

  // The list is an overlay on this pane; clamp its size to the pane's OWN measured size (not the window's), so
  // dragging can never push the content off-screen or leave a persisted size unreachable when the pane narrows.
  const paneRef = useRef<HTMLDivElement>(null);
  // The pane's measured size drives the list clamps (null without layout, e.g. jsdom).
  const [paneSize, setPaneSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // Demo stage: rects are scaled, CSS px are not (same as Layout/TopBar).
      const k = env.demo && env.scale > 0 ? env.scale : 1;
      const w = Math.round(r.width / k);
      const h = Math.round(r.height / k);
      setPaneSize((p) => (w > 0 && h > 0 ? (p && p.w === w && p.h === h ? p : { w, h }) : null));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [env.demo, env.scale]);
  const clampDim = useCallback(
    (px: number) => {
      const rect = paneRef.current?.getBoundingClientRect();
      if (masterDetailVertical) {
        const paneH = rect?.height ?? window.innerHeight;
        const room = isMobile ? paneH - TOPBAR_H - MOBILE_MIN_PREVIEW_H : paneH - 80;
        const max = Math.min(FILES_LEFT_PANE_MAX_HEIGHT, room);
        return Math.min(max, Math.max(FILES_LEFT_PANE_MIN_HEIGHT, px));
      }
      const paneW = rect?.width ?? window.innerWidth;
      const room = isMobile ? paneW - MOBILE_MIN_PREVIEW_W : paneW - DESKTOP_MIN_CONTENT_W;
      const max = Math.min(FILES_LEFT_PANE_MAX_WIDTH, room);
      const next = Math.min(max, Math.max(minWidth, px));
      return isMobile ? next : Math.max(DESKTOP_MIN_LIST_W, next);
    },
    [masterDetailVertical, isMobile, minWidth],
  );

  // Effective phone list size (nothing stored -> half the pane, otherwise the stored/dragged size, always leaving
  // the content its minimum). Null without a measured pane (jsdom, a hidden tile): the unclamped size is used.
  const draggingW = localDragWidth != null;
  const draggingH = localDragHeight != null;
  const mobileListW =
    isMobile && paneSize && !masterDetailVertical
      ? mobileListSize(activeWidth, rawStoredWidth == null && !draggingW, paneSize.w, {
          min: FILES_LEFT_PANE_MIN_WIDTH,
          floor: MOBILE_MIN_LIST_W,
          minPreview: MOBILE_MIN_PREVIEW_W,
          def: FILES_LEFT_PANE_DEFAULT_WIDTH,
        })
      : null;
  // Desktop: cap the (>=224) list to the measured pane so a narrow tools pane keeps its content column.
  const desktopListW =
    !isMobile && paneSize && !masterDetailVertical ? desktopListWidth(activeWidth, paneSize.w) : null;
  const mobileListH =
    isMobile && paneSize && masterDetailVertical
      ? mobileListSize(activeHeight, rawStoredHeight == null && !draggingH, paneSize.h - TOPBAR_H, {
          min: FILES_LEFT_PANE_MIN_HEIGHT,
          floor: MOBILE_MIN_LIST_H,
          minPreview: MOBILE_MIN_PREVIEW_H,
          def: FILES_LEFT_PANE_DEFAULT_HEIGHT,
        })
      : null;

  // What the panel actually shows (phone clamps applied): drags and arrow keys start from it.
  const shownWidth = mobileListW ?? desktopListW ?? activeWidth;
  const shownHeight = mobileListH ?? activeHeight;

  const cleanupDragRef = useRef<(() => void) | null>(null);
  // Run the drag cleanup only on unmount.
  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
    };
  }, []);

  // Pointer Events resize (mouse + touch + pen unified via setPointerCapture) — same mechanism the
  // terminal/agent PanelResizeHandle divider uses.
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startPos = masterDetailVertical ? e.clientY : e.clientX;
      // Side-by-side handle is on the panel's LEFT edge: dragging left grows it.
      const sign = masterDetailVertical ? 1 : -1;
      const startDim = masterDetailVertical ? shownHeight : shownWidth;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      if (!env.demo) {
        document.body.style.userSelect = "none";
        document.body.style.cursor = masterDetailVertical ? "row-resize" : "col-resize";
      }
      setIsDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      function onMove(ev: PointerEvent) {
        const currentPos = masterDetailVertical ? ev.clientY : ev.clientX;
        const nextDim = clampDim(startDim + sign * (currentPos - startPos));
        if (masterDetailVertical) setLocalDragHeight(nextDim);
        else setLocalDragWidth(nextDim);
      }

      function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (!env.demo) {
          document.body.style.userSelect = prevUserSelect;
          document.body.style.cursor = prevCursor;
        }
        cleanupDragRef.current = null;
      }

      function onUp(ev: PointerEvent) {
        cleanup();
        const currentPos = masterDetailVertical ? ev.clientY : ev.clientX;
        const finalDim = clampDim(startDim + sign * (currentPos - startPos));
        if (masterDetailVertical) {
          useWorkspaceStore.getState().setFilesLeftPaneHeight(wt, finalDim);
          setIsDragging(false);
          setLocalDragHeight(null);
        } else {
          useWorkspaceStore.getState().setFilesLeftPaneWidth(wt, finalDim);
          setIsDragging(false);
          setLocalDragWidth(null);
        }
      }

      cleanupDragRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [masterDetailVertical, shownHeight, shownWidth, wt, clampDim, env.demo],
  );

  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    if (masterDetailVertical) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const next = clampDim(shownHeight + (e.key === "ArrowUp" ? -10 : 10));
      useWorkspaceStore.getState().setFilesLeftPaneHeight(wt, next);
      return;
    }
    // Handle is on the left edge: ArrowLeft grows, ArrowRight shrinks.
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampDim(shownWidth + (e.key === "ArrowLeft" ? 10 : -10));
    useWorkspaceStore.getState().setFilesLeftPaneWidth(wt, next);
  };

  return (
    <div
      ref={paneRef}
      className="files-panel"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        // The one owner of the list size: LIST_PANE_W/H (content padding, list overlay) read these.
        ["--list-pane-w" as string]: `${shownWidth}px`,
        ["--list-pane-h" as string]: `${shownHeight}px`,
      }}
    >
      {/* Content column (R4, R5, §4b): full width underneath, padded right/top to clear the overlay only when open */}
      <div
        className="files-panel__content"
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          paddingRight: !masterDetailVertical && open ? LIST_PANE_W : "0px",
          paddingTop: masterDetailVertical && open ? LIST_PANE_H : "0px",
          transition: isDragging || !animatePadding
            ? "none"
            : masterDetailVertical
              ? "padding-top 0.15s ease"
              : "padding-right 0.15s ease",
        }}
      >
        {/* Top bar, height matching the desktop TopBar (35px); hosts the pane controls and the global actions group. */}
        <div
          className={`files-topbar${topbarClassName ? ` ${topbarClassName}` : ""}`}
          data-tauri-drag-region="deep"
          style={{
            height: "var(--pane-row-h)",
            minHeight: "var(--pane-row-h)",
            maxHeight: "var(--pane-row-h)",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "stretch",
          }}
        >
          {topbar}
        </div>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{children}</div>
      </div>
      {/* List overlay docked right of the content (R4, R10; rendered AFTER the content for R12 DOM order). Always mounted (R16), display:none when closed */}
      <div
        className={`files-left-pane-overlay${open ? " files-left-pane-overlay--open" : ""}`}
        style={{
          position: "absolute",
          top: 0,
          bottom: masterDetailVertical ? undefined : 0,
          // Stacked: top overlay across the pane. Side-by-side: docked on the right edge.
          left: masterDetailVertical ? 0 : undefined,
          right: 0,
          width: masterDetailVertical ? undefined : LIST_PANE_W,
          height: masterDetailVertical ? LIST_PANE_H : undefined,
          zIndex: 20,
          background: "var(--bg-sidebar-secondary)",
          borderLeft: masterDetailVertical ? undefined : "var(--border-width) solid var(--border-default)",
          borderBottom: masterDetailVertical ? "var(--border-width) solid var(--border-default)" : undefined,
          display: open ? "flex" : "none",
          flexDirection: "column",
          overflow: "visible",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {list}
        </div>
        <div
          className={`files-left-pane-resize-handle${masterDetailVertical ? " files-left-pane-resize-handle--horizontal" : ""}`}
          role="separator"
          aria-orientation={masterDetailVertical ? "horizontal" : "vertical"}
          aria-label={masterDetailVertical ? `Resize ${handleLabel} top panel` : `Resize ${handleLabel} side panel`}
          aria-valuenow={masterDetailVertical ? shownHeight : shownWidth}
          aria-valuemin={masterDetailVertical ? FILES_LEFT_PANE_MIN_HEIGHT : isMobile ? minWidth : Math.min(minWidth, shownWidth)}
          aria-valuemax={masterDetailVertical ? FILES_LEFT_PANE_MAX_HEIGHT : FILES_LEFT_PANE_MAX_WIDTH}
          tabIndex={0}
          data-dragging={isDragging || undefined}
          onPointerDown={startResize}
          onKeyDown={onHandleKeyDown}
        />
      </div>
    </div>
  );
}
