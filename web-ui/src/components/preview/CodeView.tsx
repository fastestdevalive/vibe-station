import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useEventTargets } from "@/context/DemoEnv";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { useWorkspaceStore } from "@/hooks/useStore";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { highlightDocumentLines } from "./shikiHighlighter";
import { CodeLine } from "./CodeLine";
import { useCodeVirtualizer } from "./useCodeVirtualizer";
import { useChunkedHighlight } from "./useChunkedHighlight";
import {
  getDefinition,
  getHover,
  getLspStatus,
  isLspNotReady,
  lspFailureFromError,
  type Location,
  type LspDefinitionResponse,
  type LspFailure,
  type LspFallbackReason,
  type LspFileRef,
  type LspHoverResponse,
} from "@/lib/lspApi";
import { resolveClickPosition, resolveOffsetInLine } from "@/lib/lspPosition";
import { markRangeInElement } from "@/lib/markRange";
import { fallbackReasonText } from "../tools/referencesPanelState";
import type { FileScope } from "@/api/types";

/** Minimum line count above which `CodeView` windows its rows through the
 *  virtualizer (Decision 6). Below it, every line renders in normal flow. */
const VIRTUALIZE_MIN_LINES = 2000;

/**
 * Creates a DOM Range covering character offsets [start, end) within the
 * child text nodes of contentEl without splitting or mutating any nodes.
 */
function createRangeForOffsets(contentEl: HTMLElement, start: number, end: number): Range | null {
  const range = document.createRange();
  let currentOffset = 0;
  let startSet = false;
  let endSet = false;

  function traverse(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? "").length;
      if (!startSet && currentOffset + len >= start) {
        range.setStart(node, Math.max(0, start - currentOffset));
        startSet = true;
      }
      if (!endSet && currentOffset + len >= end) {
        range.setEnd(node, Math.min(len, end - currentOffset));
        endSet = true;
        return true;
      }
      currentOffset += len;
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child && traverse(child)) return true;
      }
    }
    return false;
  }

  traverse(contentEl);
  return startSet && endSet ? range : null;
}

/** Identifier word boundaries at `character` within `lineText`, or null if
 *  the position doesn't land on/next to a word character. Shared by
 *  `extractSymbolAtPosition` (hover) and the go-to-def "clicked exactly on
 *  the definition itself" check below — both need the SAME word-boundary
 *  logic so their answers agree about what token was actually clicked. */
function wordRangeAtPosition(lineText: string, character: number): { start: number; end: number } | null {
  if (!lineText) return null;
  const clamped = Math.max(0, Math.min(character, lineText.length));
  let start = clamped;
  if (
    start > 0 &&
    !/[a-zA-Z0-9_$]/.test(lineText[start] ?? "") &&
    /[a-zA-Z0-9_$]/.test(lineText[start - 1]!)
  ) {
    start--;
  }
  if (!/[a-zA-Z0-9_$]/.test(lineText[start] ?? "")) {
    return null;
  }
  let end = start;
  while (start > 0 && /[a-zA-Z0-9_$]/.test(lineText[start - 1]!)) {
    start--;
  }
  while (end < lineText.length && /[a-zA-Z0-9_$]/.test(lineText[end]!)) {
    end++;
  }
  return start < end ? { start, end } : null;
}

function extractSymbolAtPosition(lineText: string, character: number): string {
  const range = wordRangeAtPosition(lineText, character);
  return range ? lineText.slice(range.start, range.end) : "";
}

/**
 * True when a go-to-definition response's single result points back at the
 * SAME identifier the user just clicked — i.e. the click landed on the
 * declaration itself, not a usage. `textDocument/definition` on a
 * declaration commonly echoes that declaration's own location back (rather
 * than erroring or returning nothing), so without this check a cmd-click on
 * a definition "navigates" to exactly where you already are — a confusing
 * no-op. The natural IDE behavior this restores: usage → jump to
 * definition; definition → show references (see `triggerGoToDef` below).
 */
function isSelfDefinitionClick(
  loc: Location,
  clickLine: number,
  clickedRange: { start: number; end: number } | null,
  currentPath: string | undefined,
  currentExternalToken: string | undefined
): boolean {
  if (!clickedRange) return false;
  if (loc.line !== clickLine) return false;
  const sameFile = loc.external
    ? !!currentExternalToken && !!loc.token && loc.token === currentExternalToken
    : !!currentPath && !loc.external && loc.path === currentPath;
  if (!sameFile) return false;
  return loc.character >= clickedRange.start && loc.character < clickedRange.end;
}

/** A single line's gutter annotation kind. */
export type GutterMarkKind = "added" | "modified" | "deleted" | "deleted-top";

interface CodeViewProps {
  code: string;
  language?: string;
  /** Used to pick TSX vs TS etc. for Shiki */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** When true, renders without gutter (e.g. inside a markdown code block) */
  noGutter?: boolean;
  /** Git gutter marks: added/modified/deleted line annotations. No-op when noGutter is true. */
  gutterMarks?: Map<number, ReadonlySet<GutterMarkKind>>;
  /** 1-based line number to highlight (search jump-to-line / peek target). */
  highlightLine?: number | null;
  /** Matched substring within `highlightLine` to additionally mark, if found. */
  highlightMatchText?: string | null;
  /** 0-based UTF-16 column range on `highlightLine` to mark — wins over
   *  `highlightMatchText` (which can only find the FIRST occurrence). */
  highlightColumn?: number | null;
  highlightEndColumn?: number | null;

  // LSP props (Phase 3)
  api?: unknown;
  worktreeId?: string | null;
  scope?: FileScope;
  lspFileRef?: LspFileRef;
  etag?: string;
  retryDelayMs?: number;

  /** Optional scroller element (the file preview body). When provided, large
   *  files window their rows against it. Resolved in a layout effect as
   *  `scrollElRef?.current ?? containerRef.current?.parentElement`. */
  scrollElRef?: RefObject<HTMLElement | null>;
  /** Called once `highlightLine`'s row is in the DOM and scrolled to (virtual
   *  mode) — lets the owner re-run its highlight effect against a mounted row. */
  onRevealReady?: () => void;
}

/**
 * The `[start, end)` span to mark on the jump-target line. A column-pinned
 * target (definition/references/outline jumps) marks exactly the range the
 * language server pointed at — `endColumn` when known, else the identifier
 * starting at `column`. Only a column-less target (search) falls back to the
 * first `indexOf` of `matchText`.
 */
export function targetMatchSpan(
  lineText: string,
  column: number | null | undefined,
  endColumn: number | null | undefined,
  matchText: string | null | undefined,
): { start: number; end: number } | null {
  if (column != null && column >= 0 && column < lineText.length) {
    if (endColumn != null && endColumn > column && endColumn <= lineText.length) {
      return { start: column, end: endColumn };
    }
    const word = wordRangeAtPosition(lineText, column);
    if (word && word.start === column) return word;
    return { start: column, end: column + 1 };
  }
  if (matchText) {
    const idx = lineText.indexOf(matchText);
    if (idx >= 0) return { start: idx, end: idx + matchText.length };
  }
  return null;
}

interface ActiveCue {
  line: number;
  start: number;
  end: number;
  word: string;
  rects: DOMRect[];
}

/** True when the browser supports the CSS Custom Highlight API (the preferred
 *  hover-cue mechanism — it doesn't mutate the DOM). */
function supportsCustomHighlight(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (globalThis as unknown as { Highlight?: unknown }).Highlight === "function"
  );
}

/** Imperative handle for the code viewer, letting the owner (FilePreviewPane)
 *  save/restore scroll position by line index in virtual mode, where pixel
 *  scrollTop is meaningless before rows are measured. */
export interface CodeViewHandle {
  isVirtualized: () => boolean;
  /** 0-indexed first visible virtual row, or null when not virtualized. */
  getFirstVisibleLine: () => { lineIndex: number; offsetInRow: number } | null;
  /** Scroll so the given 0-indexed line sits `offsetInRow` px from the top. */
  scrollToLine: (lineIndex: number, offsetInRow?: number) => void;
}

export const CodeView = forwardRef<CodeViewHandle, CodeViewProps>(function CodeView(
  {
    code,
    language: languageProp,
    filePath,
    themeMode,
    noGutter,
    gutterMarks,
    highlightLine,
    highlightMatchText,
    highlightColumn,
    highlightEndColumn,
    api,
    worktreeId,
    scope = "worktree",
    lspFileRef,
    etag,
    retryDelayMs,
    scrollElRef,
    onRevealReady,
  }: CodeViewProps,
  ref,
) {
  const { win } = useEventTargets();
  const { theme, themeId } = useTheme();
  const mode = themeMode ?? theme;
  const overridden = themeMode !== undefined && themeMode !== theme;
  const shikiThemeId = overridden
    ? mode === "light"
      ? "light-plus"
      : "dark-plus"
    : themeById[themeId]?.shikiThemeId ?? (mode === "light" ? "light-plus" : "dark-plus");

  const language = languageProp ?? (filePath ? languageForFilePath(filePath) : undefined);
  const shikiLang = language ? pickShikiLang(filePath, language) : "plaintext";

  const lines = useMemo(() => code.split("\n"), [code]);
  const targetSpanFor = (lineText: string) =>
    targetMatchSpan(lineText, highlightColumn, highlightEndColumn, highlightMatchText);
  const gutterWidth = String(lines.length).length;

  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);

  // Declared before the virtualization block below, which reads
  // `containerRef.current?.parentElement` as the scroller fallback.
  const containerRef = useRef<HTMLPreElement | null>(null);

  // ── Virtualization (Phase 3, Decisions 6–9) ─────────────────────────────
  // Virtual mode is decided by line count ONLY — never by whether a scroller
  // ref is attached. Below `VIRTUALIZE_MIN_LINES` today's whole-document
  // highlight + full row render is used unchanged.
  const virtualized = lines.length >= VIRTUALIZE_MIN_LINES;

  // Resolve the scroller synchronously. `FilePreviewPane` passes a ref object
  // whose identity changes whenever the underlying element changes (state-
  // backed, Decision 9), so this re-renders with a non-null scroller
  // immediately and the virtualizer initialises with a non-zero size on the
  // same commit — avoiding the first-mount range-null race.
  const scroller = scrollElRef?.current ?? containerRef.current?.parentElement ?? null;

  const { virtualizer, scrollMargin, sizerRef, measureRef } = useCodeVirtualizer({
    lines,
    scrollEl: scroller,
    enabled: virtualized,
    highlightLine: highlightLine ?? null,
    tabSize: 4,
  });

  // Chunked highlight for virtualized files (Decision 12); whole-document
  // highlight for small files via the existing effect below.
  const visibleRange: [number, number] | null = useMemo(() => {
    if (!virtualized) return null;
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return null;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return null;
    return [first.index, last.index];
    // Recompute each render: getVirtualItems() reflects the live scroll range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, virtualizer.getVirtualItems()]);
  const chunkedLines = useChunkedHighlight({
    code,
    lang: shikiLang,
    themeId: shikiThemeId,
    enabled: virtualized && !!language,
    visibleRange,
  });

  // LSP hover reset (Risk 5): when the first visible virtual row changes, only
  // clear the hovered-symbol wrapper — NEVER the file-switch reset (which
  // bumps `requestGenRef` and cancels in-flight go-to-def requests).
  const firstVisibleIndexRef = useRef(-1);
  useLayoutEffect(() => {
    if (!virtualized) return;
    const first = virtualizer.getVirtualItems()[0];
    const idx = first ? first.index : -1;
    if (firstVisibleIndexRef.current !== idx) {
      firstVisibleIndexRef.current = idx;
      clearHoveredSymbol();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, virtualizer.getVirtualItems()]);

  // Jump-to-line (Decision 9): once `highlightLine`'s index is in the rendered
  // range (the `rangeExtractor` in useCodeVirtualizer unions it in), scroll it
  // to center and signal the owner, which then applies the highlight class and
  // persists the scroll position. Fires once per `highlightLine`.
  const revealedLineRef = useRef<number | null>(null);
  const revealedPathRef = useRef(filePath);
  useLayoutEffect(() => {
    if (!virtualized) return;
    // Switching to a different file re-arms the reveal. A reload of the SAME
    // file (watcher refetch) must not: the owner never clears `highlightLine`,
    // so re-firing would yank the user back to the target on every save.
    if (revealedPathRef.current !== filePath) {
      revealedPathRef.current = filePath;
      revealedLineRef.current = null;
    }
    // Clearing the target (or switching files) re-arms the reveal so a repeat
    // jump to the same line isn't silently dropped.
    if (highlightLine == null) {
      revealedLineRef.current = null;
      return;
    }
    const target = highlightLine - 1;
    const inRange = virtualizer.getVirtualItems().some((v) => v.index === target);
    if (inRange && revealedLineRef.current !== highlightLine) {
      revealedLineRef.current = highlightLine;
      virtualizer.scrollToIndex(target, { align: "center" });
      onRevealReady?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualized, highlightLine, virtualizer.getVirtualItems()]);

  // Select-all in virtual mode (Risk 3): native Ctrl+A only sees mounted rows.
  // Intercept it, select the full `<pre>` contents, and make `onCopy` emit the
  // complete source.
  const selectAllRef = useRef(false);
  const scrollGenRef = useRef(0);
  // Invalidate any pending scrollToLine re-apply when the file changes.
  useEffect(() => {
    scrollGenRef.current++;
  }, [filePath, code]);
  const selectNodeContents = useCallback((pre: HTMLPreElement) => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);
  useEffect(() => {
    const onSelectionChange = () => {
      // selectNodeContents fires an (async) non-collapsed selectionchange;
      // only a collapse means the select-all was dropped.
      if (selectAllRef.current && window.getSelection()?.isCollapsed) selectAllRef.current = false;
    };
    // Shift+Arrow etc. shrink the selection without collapsing it; any key other
    // than the Ctrl/Cmd chords (A to select, C to copy) disarms select-all.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!selectAllRef.current) return;
      if (e.key === "Control" || e.key === "Meta") return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A" || e.key === "c" || e.key === "C")) return;
      selectAllRef.current = false;
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  const handleCopy = useCallback(
    (e: React.ClipboardEvent) => {
      if (selectAllRef.current) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", code);
        selectAllRef.current = false;
      }
    },
    [code],
  );

  useImperativeHandle(
    ref,
    () => ({
      isVirtualized: () => virtualized,
      getFirstVisibleLine: () => {
        if (!virtualized || !scroller) return null;
        // getVirtualItems() includes overscan rows; pick the first row that
        // actually ends below the scroll offset.
        const top = scroller.scrollTop;
        const first = virtualizer.getVirtualItems().find((it) => it.end > top);
        if (!first) return null;
        return { lineIndex: first.index, offsetInRow: top - first.start };
      },
      scrollToLine: (lineIndex: number, offsetInRow = 0) => {
        if (!virtualized || !scroller) return;
        const apply = () => {
          const [off] = virtualizer.getOffsetForIndex(lineIndex, "start") ?? [scroller.scrollTop];
          scroller.scrollTop = off + offsetInRow;
        };
        apply();
        // Row heights/metrics refine after the first paint (measureElement,
        // font metrics); re-apply once so a restore lands on the same line —
        // unless the file changed or another scroll request superseded this one.
        const gen = ++scrollGenRef.current;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (gen === scrollGenRef.current) apply();
          }),
        );
      },
    }),
    [virtualized, virtualizer, scroller],
  );

  // LSP interactive state
  const [isArmed, setIsArmed] = useState(false);
  const pointerOverRef = useRef(false);
  const mousedownCoordsRef = useRef<{ x: number; y: number } | null>(null);
  const dragDetectedRef = useRef(false);
  const requestGenRef = useRef(0);
  const codeRef = useRef(code);
  codeRef.current = code;
  const etagRef = useRef(etag);
  etagRef.current = etag;

  const [pendingCue, setPendingCue] = useState<{ x: number; y: number; text: string } | null>(null);
  const [messageCue, setMessageCue] = useState<{ x: number; y: number; text: string } | null>(null);
  const [pickerState, setPickerState] = useState<{
    x: number;
    y: number;
    locations: Location[];
    selectedIndex: number;
    /** Set when the daemon answered from its text-search fallback. */
    fallback: LspFallbackReason | null;
    /** The server's latched failure, for a `server_failed` fallback. */
    failure: LspFailure | null;
  } | null>(null);

  // 5.4, 5.5, 5.7: Hover tooltip state
  const [hoverTooltip, setHoverTooltip] = useState<{
    x: number;
    y: number;
    line: number;
    character: number;
    symbol: string;
    signature: string;
    doc: string | null;
  } | null>(null);
  const [hoverPendingCue, setHoverPendingCue] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  const hoverRestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTooltipRef = useRef<HTMLDivElement | null>(null);

  const activeCueRef = useRef<ActiveCue | null>(null);
  const pinnedRef = useRef<boolean>(false);
  const isArmedRef = useRef<boolean>(false);
  const overlayRef = useRef<HTMLSpanElement | null>(null);

  const applyCue = useCallback((range: Range, line: number, start: number, end: number, word: string) => {
    const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
    activeCueRef.current = { line, start, end, word, rects };

    // The CSS Custom Highlight API is the preferred cue (no DOM mutation).
    // The absolute overlay is only a fallback for browsers without it —
    // drawing it on top of a Highlight-API cue would render the word twice.
    let highlightApplied = false;
    if (supportsCustomHighlight()) {
      try {
        const HighlightClass = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
        const highlight = new HighlightClass(range);
        (CSS.highlights as unknown as { set: (name: string, hl: unknown) => void }).set("lsp-cue", highlight);
        highlightApplied = true;
      } catch {
        // Fallback to overlay
      }
    }

    const overlay = overlayRef.current;
    if (overlay && !highlightApplied) {
      overlay.textContent = word;
      overlay.style.display = "inline";
      const bRect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
      const cRect = containerRef.current?.getBoundingClientRect();
      if (bRect && cRect) {
        overlay.style.position = "absolute";
        overlay.style.left = `${bRect.left - cRect.left + (containerRef.current?.scrollLeft ?? 0)}px`;
        overlay.style.top = `${bRect.top - cRect.top + (containerRef.current?.scrollTop ?? 0)}px`;
        overlay.style.width = `${bRect.width}px`;
        overlay.style.height = `${bRect.height}px`;
        overlay.style.pointerEvents = "none";
      }
    }
  }, []);

  const clearHoveredSymbol = useCallback(() => {
    if (pinnedRef.current) return;

    if (supportsCustomHighlight()) {
      try {
        (CSS.highlights as unknown as { delete: (name: string) => void }).delete("lsp-cue");
      } catch {
        // Ignore
      }
    }

    if (overlayRef.current) {
      overlayRef.current.style.display = "none";
      overlayRef.current.textContent = "";
    }
    activeCueRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (activeCueRef.current && containerRef.current) {
      const { line, start, end, word } = activeCueRef.current;
      const contentEl = containerRef.current.querySelector<HTMLElement>(
        `[data-line="${line + 1}"] .workspace-code-content`
      );
      if (contentEl) {
        const range = createRangeForOffsets(contentEl, start, end);
        if (range) {
          applyCue(range, line, start, end, word);
        }
      }
    }
  });

  // Bump generation on file navigation/switch
  useEffect(() => {
    requestGenRef.current++;
    setPendingCue(null);
    setMessageCue(null);
    setPickerState(null);
    setHoverTooltip(null);
    setHoverPendingCue(null);
    if (hoverRestTimerRef.current) {
      clearTimeout(hoverRestTimerRef.current);
      hoverRestTimerRef.current = null;
    }
    if (hoverPendingTimerRef.current) {
      clearTimeout(hoverPendingTimerRef.current);
      hoverPendingTimerRef.current = null;
    }
    pinnedRef.current = false;
    clearHoveredSymbol();
  }, [filePath, lspFileRef, clearHoveredSymbol]);

  // Whole-document highlight for small files. Virtualized files use
  // `useChunkedHighlight` above instead (Decision 12); they never reach this.
  useEffect(() => {
    if (virtualized) return;
    if (!language) {
      setHighlightedLines(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const out = await highlightDocumentLines(code, shikiLang, shikiThemeId);
        if (!cancelled) setHighlightedLines(out);
      } catch {
        if (!cancelled) setHighlightedLines(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language, shikiLang, shikiThemeId, virtualized]);

  // Shared by the hover tooltip's "Find references" button AND a cmd/ctrl
  // click that lands on a symbol's own definition (see `isSelfDefinitionClick`
  // below, used inside `triggerGoToDef`) — both open the same references
  // view for the same reason: there's nowhere more "definition-y" left to
  // navigate to.
  const triggerFindReferences = useCallback(
    (
      line: number,
      character: number,
      symbol: string,
      intent: "references" | "no-definition" = "references",
      failure: LspFailure | null = null,
    ) => {
      const store = useWorkspaceStore.getState();
      const layoutKey =
        worktreeId ?? store.activeWorktreeId ?? store.activeDirectContextId ?? "";
      store.revealReferences(layoutKey, {
        worktreeId: layoutKey,
        path: lspFileRef && lspFileRef.kind === "workspace" ? lspFileRef.path : (filePath ?? ""),
        line,
        character,
        symbol,
        external:
          lspFileRef && lspFileRef.kind === "external"
            ? { token: lspFileRef.token, displayPath: filePath ?? "" }
            : undefined,
        intent,
        ...(failure ? { failure } : {}),
      });
    },
    [worktreeId, lspFileRef, filePath],
  );

  // A `server_failed` text fallback doesn't repeat the failure (the polled
  // status carries it) — read it once so the picker/panel can name the
  // missing thing. Best-effort: null leaves the generic reason text.
  const fetchLatchedFailure = useCallback(async (): Promise<LspFailure | null> => {
    if (!api || !worktreeId || !lspFileRef || lspFileRef.kind !== "workspace") return null;
    try {
      return (await getLspStatus(api, scope, worktreeId, lspFileRef.path)).failure ?? null;
    } catch {
      return null;
    }
  }, [api, worktreeId, scope, lspFileRef]);

  // Go-to-definition request failed outright. A 503 LSP_SERVER_FAILED means
  // the server never ran → the panel's S17 directly (no references fetch,
  // which would fail the same way); anything else → a references query.
  const openReferencesAfterError = useCallback(
    (err: unknown, line: number, character: number, symbol: string) => {
      if (!symbol) return;
      const failure = lspFailureFromError(err);
      if (failure) {
        triggerFindReferences(line, character, symbol, "no-definition", failure);
      } else {
        triggerFindReferences(line, character, symbol);
      }
    },
    [triggerFindReferences],
  );

  const triggerGoToDef = useCallback(
    async (line: number, character: number, anchorPos: { x: number; y: number }) => {
      const clickedRange = wordRangeAtPosition(lines[line] ?? "", character);
      const symbol = clickedRange
        ? (lines[line] ?? "").slice(clickedRange.start, clickedRange.end)
        : "";

      if (!api || !worktreeId || !lspFileRef) {
        pinnedRef.current = false;
        if (!isArmedRef.current) clearHoveredSymbol();
        if (symbol) {
          triggerFindReferences(line, character, symbol);
        }
        return;
      }

      const gen = ++requestGenRef.current;
      const capturedCode = code;
      const capturedEtag = etag;

      setMessageCue(null);
      setPickerState(null);

      // >300ms unanswered shows a pending cue
      const pendingTimer = setTimeout(() => {
        if (requestGenRef.current === gen) {
          setPendingCue({ ...anchorPos, text: "waiting for language server…" });
        }
      }, 300);

      try {
        let res: LspDefinitionResponse;
        try {
          res = await getDefinition(api, scope, worktreeId, lspFileRef, line, character);
        } catch (err: unknown) {
          const is409 = isLspNotReady(err);

          if (is409) {
            setPendingCue({ ...anchorPos, text: "waiting for language server…" });

            await new Promise((r) => setTimeout(r, retryDelayMs ?? 1000));

            if (
              requestGenRef.current !== gen ||
              codeRef.current !== capturedCode ||
              (etag != null && etagRef.current !== capturedEtag)
            ) {
              clearTimeout(pendingTimer);
              setPendingCue(null);
              return;
            }

            try {
              res = await getDefinition(api, scope, worktreeId, lspFileRef, line, character);
            } catch (retryErr: unknown) {
              clearTimeout(pendingTimer);
              // Superseded (newer click / file switch): its cue and panel win.
              if (requestGenRef.current !== gen) return;
              setPendingCue(null);
              openReferencesAfterError(retryErr, line, character, symbol);
              return;
            }
          } else {
            clearTimeout(pendingTimer);
            if (requestGenRef.current !== gen) return;
            setPendingCue(null);
            openReferencesAfterError(err, line, character, symbol);
            return;
          }
        }

        clearTimeout(pendingTimer);
        setPendingCue(null);

        // 3.4 Superseded-request guard:
        // Discard any response whose generation is stale, or if file's content/etag changed
        if (requestGenRef.current !== gen) return;
        if (codeRef.current !== capturedCode || (etag != null && etagRef.current !== capturedEtag)) return;

        const fallback = res.fallback?.reason ?? null;
        const currentPath = lspFileRef.kind === "workspace" ? lspFileRef.path : undefined;
        const currentExternalToken = lspFileRef.kind === "external" ? lspFileRef.token : undefined;
        // A text-search fallback can include the clicked occurrence itself —
        // never offer "jump to where you already are".
        const locations = (res.locations ?? []).filter(
          (loc) =>
            !fallback ||
            !isSelfDefinitionClick(loc, line, clickedRange, currentPath, currentExternalToken),
        );

        // 3.8 Zero results (server answered, nothing resolved) -> the panel's
        // "Couldn't resolve" state (with the server's degraded reason when it
        // has one, plus Text search). NOT a references query: references of
        // an unresolved symbol are empty too, which used to surface as a
        // misleading "No references found" (round-2 Bug 1). Only the
        // self-definition case below turns into references.
        // The failed server's own summary names the missing thing — for the
        // picker header and, with zero hits, the panel's S17 (the server never
        // ran, so "found no definition" would be false).
        const failure = fallback === "server_failed" ? await fetchLatchedFailure() : null;
        if (requestGenRef.current !== gen) return;

        if (locations.length === 0) {
          if (!symbol) return;
          if (fallback && fallback !== "server_failed") {
            // The server was never asked (starting / disabled / not_found /
            // unsupported) — "{server} found no definition" would be false.
            // A references query reports the same fallback reason honestly.
            triggerFindReferences(line, character, symbol);
          } else {
            triggerFindReferences(line, character, symbol, "no-definition", failure);
          }
          return;
        }

        // Clicked-on-the-declaration-itself: `textDocument/definition` on a
        // declaration commonly echoes that same location back rather than
        // erroring, which would otherwise "navigate" you to exactly where
        // you already are. Natural editor behavior: usage → jump to
        // definition, definition → show references instead.
        // Text-search fallback (Bug 6): grep hits aren't trustworthy enough
        // for a silent jump — always show the picker, with the reason in its
        // header, even for a single hit.
        if (fallback) {
          setPickerState({ ...anchorPos, locations, selectedIndex: 0, fallback, failure });
          return;
        }

        if (locations.length === 1) {
          const loc = locations[0]!;
          if (isSelfDefinitionClick(loc, line, clickedRange, currentPath, currentExternalToken)) {
            if (symbol) {
              triggerFindReferences(line, character, symbol);
            }
            return;
          }
        }

        // 3.5 Single in-workspace Location result (external: false)
        if (locations.length === 1 && !locations[0]!.external) {
          const loc = locations[0]!;
          const store = useWorkspaceStore.getState();
          const layoutKey =
            worktreeId ?? store.activeWorktreeId ?? store.activeDirectContextId ?? "";
          store.pushJump({
            worktreeId: layoutKey,
            path: loc.path!,
            line: loc.line + 1,
            matchText: null,
            column: loc.character,
            endColumn: loc.endCharacter ?? null,
            source: "definition",
          });
          return;
        }

        // 3.6 / 4.8 Single external: true result
        if (locations.length === 1 && locations[0]!.external) {
          const loc = locations[0]!;
          if (loc.token) {
            const store = useWorkspaceStore.getState();
            const layoutKey =
              worktreeId ?? store.activeWorktreeId ?? store.activeDirectContextId ?? "";
            store.pushJump({
              worktreeId: layoutKey,
              path: loc.displayPath ?? "",
              line: loc.line + 1,
              matchText: null,
              source: "definition",
              external: {
                token: loc.token,
                displayPath: loc.displayPath ?? "external",
              },
            });
            return;
          }
          setMessageCue({
            ...anchorPos,
            text: "Definition is outside this workspace — external file viewing not yet available",
          });
          return;
        }

        // 3.7 Multiple Location results (any mix of external)
        setPickerState({
          ...anchorPos,
          locations,
          selectedIndex: 0,
          fallback: null,
          failure: null,
        });
      } catch {
        // Unexpected failure while handling the answer — we know nothing
        // resolved, so say that rather than claiming "no references".
        clearTimeout(pendingTimer);
        setPendingCue(null);
        if (symbol) {
          triggerFindReferences(line, character, symbol, "no-definition");
        }
      } finally {
        pinnedRef.current = false;
        if (!isArmedRef.current) {
          clearHoveredSymbol();
        }
      }
    },
    [
      api,
      worktreeId,
      scope,
      lspFileRef,
      code,
      etag,
      retryDelayMs,
      lines,
      triggerFindReferences,
      clearHoveredSymbol,
      fetchLatchedFailure,
      openReferencesAfterError,
    ],
  );

  const handleSelectPickerLocation = useCallback(
    (loc: Location) => {
      const currentAnchor = pickerState
        ? { x: pickerState.x, y: pickerState.y }
        : { x: 0, y: 0 };
      setPickerState(null);
      if (loc.external) {
        if (loc.token) {
          const store = useWorkspaceStore.getState();
          const layoutKey =
            worktreeId ?? store.activeWorktreeId ?? store.activeDirectContextId ?? "";
          store.pushJump({
            worktreeId: layoutKey,
            path: loc.displayPath ?? "",
            line: loc.line + 1,
            matchText: null,
            column: loc.character,
            endColumn: loc.endCharacter ?? null,
            source: "definition",
            external: {
              token: loc.token,
              displayPath: loc.displayPath ?? "external",
            },
          });
          return;
        }
        setMessageCue({
          ...currentAnchor,
          text: "Definition is outside this workspace — external file viewing not yet available",
        });
      } else {
        const store = useWorkspaceStore.getState();
        const layoutKey =
          worktreeId ?? store.activeWorktreeId ?? store.activeDirectContextId ?? "";
        store.pushJump({
          worktreeId: layoutKey,
          path: loc.path!,
          line: loc.line + 1,
          matchText: null,
          column: loc.character,
          endColumn: loc.endCharacter ?? null,
          source: "definition",
        });
      }
    },
    [pickerState, worktreeId],
  );

  // 5.4: Hover trigger on pointer rest
  const triggerHover = useCallback(
    async (clientX: number, clientY: number, targetNode?: EventTarget | null) => {
      if (!api || !worktreeId || !lspFileRef) return;
      const container = containerRef.current;
      if (!container) return;

      let pos = resolveClickPosition(clientX, clientY, container);
      if (!pos && targetNode instanceof Node && container.contains(targetNode)) {
        pos = resolveOffsetInLine(targetNode, 0);
      }
      if (!pos && typeof document.elementFromPoint === "function") {
        const el = document.elementFromPoint(clientX, clientY);
        if (el instanceof Node && container.contains(el)) {
          pos = resolveOffsetInLine(el, 0);
        }
      }
      if (!pos) {
        const firstContent = container.querySelector(".workspace-code-content");
        if (firstContent) {
          pos = resolveOffsetInLine(firstContent, 0);
        }
      }
      if (!pos) return;

      const lineText = lines[pos.line] ?? "";
      const symbol = extractSymbolAtPosition(lineText, pos.character);
      if (!symbol) return;

      const gen = ++requestGenRef.current;
      const capturedCode = code;
      const capturedEtag = etag;

      if (hoverPendingTimerRef.current) {
        clearTimeout(hoverPendingTimerRef.current);
      }

      // >300ms unanswered shows a pending cue
      hoverPendingTimerRef.current = setTimeout(() => {
        if (requestGenRef.current === gen) {
          setHoverPendingCue({
            x: clientX,
            y: clientY + 12,
            text: "waiting for language server…",
          });
        }
      }, 300);

      try {
        const res = await getHover(
          api,
          scope,
          worktreeId,
          lspFileRef,
          pos.line,
          pos.character,
        );

        if (hoverPendingTimerRef.current) {
          clearTimeout(hoverPendingTimerRef.current);
          hoverPendingTimerRef.current = null;
        }
        setHoverPendingCue(null);

        if (requestGenRef.current !== gen) return;
        if (
          codeRef.current !== capturedCode ||
          (etag != null && etagRef.current !== capturedEtag)
        ) {
          return;
        }

        if ("empty" in res && res.empty) {
          return;
        }
        if ("signature" in res) {
          if (!res.signature && !res.doc) return;
          setHoverTooltip({
            x: clientX,
            y: clientY + 12,
            line: pos.line,
            character: pos.character,
            symbol,
            signature: res.signature,
            doc: res.doc,
          });
        }
      } catch {
        if (hoverPendingTimerRef.current) {
          clearTimeout(hoverPendingTimerRef.current);
          hoverPendingTimerRef.current = null;
        }
        setHoverPendingCue(null);
      }
    },
    [api, worktreeId, scope, lspFileRef, code, etag, lines],
  );

  // 5.7: "Find references" button handler
  const handleFindReferences = useCallback(() => {
    if (!hoverTooltip) return;
    triggerFindReferences(hoverTooltip.line, hoverTooltip.character, hoverTooltip.symbol);
    setHoverTooltip(null);
  }, [hoverTooltip, triggerFindReferences]);

  // 5.5: Click-away dismisses hover tooltip
  useEffect(() => {
    if (!hoverTooltip) return;
    const handlePointerDown = (e: MouseEvent | PointerEvent) => {
      if (hoverTooltipRef.current && hoverTooltipRef.current.contains(e.target as Node)) {
        return;
      }
      setHoverTooltip(null);
    };
    win.addEventListener("pointerdown", handlePointerDown);
    return () => {
      win.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [hoverTooltip]);

  // 5.5: Scroll of the CODE underneath dismisses hover tooltip and pending cue
  // Scoped to code container only so scrolling inside tooltip's doc text does not dismiss
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      setHoverTooltip(null);
      setHoverPendingCue(null);
      if (hoverRestTimerRef.current) {
        clearTimeout(hoverRestTimerRef.current);
        hoverRestTimerRef.current = null;
      }
    };
    container.addEventListener("scroll", handleScroll);
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const scheduleHoverRest = useCallback(
    (
      clientX: number,
      clientY: number,
      ctrlKey: boolean,
      metaKey: boolean,
      target?: EventTarget | null,
    ) => {
      pointerOverRef.current = true;
      if (ctrlKey || metaKey || dragDetectedRef.current) {
        if (hoverRestTimerRef.current) {
          clearTimeout(hoverRestTimerRef.current);
          hoverRestTimerRef.current = null;
        }
        return;
      }
      if (hoverRestTimerRef.current) {
        clearTimeout(hoverRestTimerRef.current);
        hoverRestTimerRef.current = null;
      }
      hoverRestTimerRef.current = setTimeout(() => {
        if (!pointerOverRef.current || isArmed) return;
        void triggerHover(clientX, clientY, target);
      }, 500);
    },
    [isArmed, triggerHover],
  );

  // Keyboard events for armed state, Alt+G shortcut, Escape dismissal, and picker navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 3.1: on Ctrl/Cmd keydown while pointer is over code container, set data-lsp-armed="true"
      if ((e.key === "Control" || e.key === "Meta" || e.ctrlKey || e.metaKey) && pointerOverRef.current) {
        setIsArmed(true);
      }

      // 3.6: Ctrl/Cmd+A select-all in virtual mode. Native Ctrl+A only selects
      // mounted rows, so in virtual mode select the whole `<pre>` and let
      // `onCopy` emit the complete source. Intercepted only when focus/pointer
      // is inside the viewer.
      if (
        virtualized &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "a" || e.key === "A")
      ) {
        const pre = containerRef.current;
        const activeInViewer =
          pre &&
          (pointerOverRef.current ||
            (document.activeElement && pre.contains(document.activeElement)) ||
            (() => {
              const sel = window.getSelection();
              return !!sel?.anchorNode && pre.contains(sel.anchorNode);
            })());
        if (activeInViewer) {
          e.preventDefault();
          e.stopPropagation();
          selectAllRef.current = true;
          selectNodeContents(pre);
          return;
        }
      }

      // Escape dismisses cues, picker, and hover tooltip
      if (e.key === "Escape") {
        setPickerState(null);
        setMessageCue(null);
        setPendingCue(null);
        setHoverTooltip(null);
        setHoverPendingCue(null);
      }

      // Picker arrow navigation / Enter selection
      if (pickerState) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          setPickerState((prev) =>
            prev
              ? {
                  ...prev,
                  selectedIndex: (prev.selectedIndex + 1) % prev.locations.length,
                }
              : null,
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setPickerState((prev) =>
            prev
              ? {
                  ...prev,
                  selectedIndex: (prev.selectedIndex - 1 + prev.locations.length) % prev.locations.length,
                }
              : null,
          );
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const loc = pickerState.locations[pickerState.selectedIndex];
          if (loc) {
            handleSelectPickerLocation(loc);
          }
          return;
        }
      }

      // 3.9: Alt+G shortcut for go-to-def-on-selection
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        (e.code === "KeyG" || e.key.toLowerCase() === "g")
      ) {
        const sel = window.getSelection();
        if (sel && sel.anchorNode && containerRef.current?.contains(sel.anchorNode)) {
          const pos = resolveOffsetInLine(sel.anchorNode, sel.anchorOffset);
          if (pos) {
            e.preventDefault();
            e.stopPropagation();
            let anchor = { x: 100, y: 100 };
            if (sel.rangeCount > 0) {
              const rect = sel.getRangeAt(0).getBoundingClientRect();
              if (rect.width > 0 || rect.height > 0) {
                anchor = { x: rect.left, y: rect.bottom + 4 };
              }
            }
            void triggerGoToDef(pos.line, pos.character, anchor);
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        pinnedRef.current = false;
        isArmedRef.current = false;
        setIsArmed(false);
        clearHoveredSymbol();
      }
    };

    const onBlur = () => {
      pinnedRef.current = false;
      isArmedRef.current = false;
      setIsArmed(false);
      clearHoveredSymbol();
    };

    win.addEventListener("keydown", onKeyDown);
    win.addEventListener("keyup", onKeyUp);
    win.addEventListener("blur", onBlur);
    return () => {
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
      win.removeEventListener("blur", onBlur);
    };
  }, [pickerState, triggerGoToDef, handleSelectPickerLocation, virtualized, selectNodeContents, clearHoveredSymbol]);

  const handlePointerEnter = (e: React.PointerEvent) => {
    pointerOverRef.current = true;
    if (e.ctrlKey || e.metaKey) {
      isArmedRef.current = true;
      setIsArmed(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    pointerOverRef.current = true;
    const shouldArm = e.ctrlKey || e.metaKey;
    if (shouldArm !== isArmedRef.current) {
      isArmedRef.current = shouldArm;
      setIsArmed(shouldArm);
    }
    scheduleHoverRest(e.clientX, e.clientY, e.ctrlKey, e.metaKey, e.target);
  };

  const handlePointerLeave = () => {
    pointerOverRef.current = false;
    if (!pinnedRef.current) {
      isArmedRef.current = false;
      setIsArmed(false);
      clearHoveredSymbol();
    }
    if (hoverRestTimerRef.current) {
      clearTimeout(hoverRestTimerRef.current);
      hoverRestTimerRef.current = null;
    }
  };

  const updateHoveredSymbolAt = useCallback((clientX: number, clientY: number) => {
    if (pinnedRef.current) return;

    // Hysteresis: keep cue while pointer stays inside the word's client rects (+2px margin for jitter)
    if (activeCueRef.current && activeCueRef.current.rects.length > 0) {
      const isInside = activeCueRef.current.rects.some(
        (r) =>
          clientX >= r.left - 2 &&
          clientX <= r.right + 2 &&
          clientY >= r.top - 2 &&
          clientY <= r.bottom + 2
      );
      if (isInside) {
        return;
      }
    }

    const container = containerRef.current;
    if (!container) {
      clearHoveredSymbol();
      return;
    }

    let pos = resolveClickPosition(clientX, clientY, container);
    if (!pos && typeof document.elementFromPoint === "function") {
      const el = document.elementFromPoint(clientX, clientY);
      if (el instanceof Node && container.contains(el)) {
        pos = resolveOffsetInLine(el, 0);
      }
    }

    if (!pos || pos.line < 0 || pos.line >= lines.length) {
      clearHoveredSymbol();
      return;
    }

    const lineText = lines[pos.line] ?? "";
    const rangeInfo = wordRangeAtPosition(lineText, pos.character);
    if (!rangeInfo) {
      clearHoveredSymbol();
      return;
    }

    const { start, end } = rangeInfo;
    // Compare ranges by line + column, not by node identity
    if (
      activeCueRef.current &&
      activeCueRef.current.line === pos.line &&
      activeCueRef.current.start === start &&
      activeCueRef.current.end === end
    ) {
      return; // Same word as last move
    }

    const contentEl = container.querySelector<HTMLElement>(
      `[data-line="${pos.line + 1}"] .workspace-code-content`
    );
    if (!contentEl) {
      clearHoveredSymbol();
      return;
    }

    const range = createRangeForOffsets(contentEl, start, end);
    if (!range) {
      clearHoveredSymbol();
      return;
    }

    const word = lineText.slice(start, end);
    applyCue(range, pos.line, start, end, word);
  }, [lines, applyCue, clearHoveredSymbol]);

  const handleMouseDown = (e: React.MouseEvent) => {
    mousedownCoordsRef.current = { x: e.clientX, y: e.clientY };
    dragDetectedRef.current = false;
    selectAllRef.current = false;
    if (hoverRestTimerRef.current) {
      clearTimeout(hoverRestTimerRef.current);
      hoverRestTimerRef.current = null;
    }
    if ((e.ctrlKey || e.metaKey || isArmedRef.current) && activeCueRef.current) {
      pinnedRef.current = true;
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (mousedownCoordsRef.current && (e.buttons & 1)) {
      const dx = e.clientX - mousedownCoordsRef.current.x;
      const dy = e.clientY - mousedownCoordsRef.current.y;
      if (Math.hypot(dx, dy) > 5) {
        dragDetectedRef.current = true;
      }
    }
    // Do not clear on transient metaKey=false moves if already armed or pinned
    const isModifierActive = e.ctrlKey || e.metaKey || isArmedRef.current;
    if (isModifierActive && !dragDetectedRef.current) {
      updateHoveredSymbolAt(e.clientX, e.clientY);
    } else if (!pinnedRef.current && !isArmedRef.current) {
      clearHoveredSymbol();
    }
    scheduleHoverRest(e.clientX, e.clientY, e.ctrlKey, e.metaKey, e.target);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (mousedownCoordsRef.current) {
      const dx = e.clientX - mousedownCoordsRef.current.x;
      const dy = e.clientY - mousedownCoordsRef.current.y;
      if (Math.hypot(dx, dy) > 5) {
        dragDetectedRef.current = true;
        // A drag is a selection, not a click — drop the pin so the cue
        // doesn't freeze on the old word while the modifier is still held.
        pinnedRef.current = false;
      }
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLPreElement>) => {
    // Plain click (no modifier): native text selection occurs unaffected (3.T6)
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }

    // Drag/selection guard (3.T1): coordinates moved >5px
    if (dragDetectedRef.current) {
      pinnedRef.current = false;
      return;
    }
    if (mousedownCoordsRef.current) {
      const dx = e.clientX - mousedownCoordsRef.current.x;
      const dy = e.clientY - mousedownCoordsRef.current.y;
      if (Math.hypot(dx, dy) > 5) {
        pinnedRef.current = false;
        return;
      }
    }

    e.preventDefault();
    e.stopPropagation();
    if (activeCueRef.current) {
      pinnedRef.current = true;
    }

    let pos = resolveClickPosition(e.clientX, e.clientY, containerRef.current);
    if (!pos && e.target instanceof Node && containerRef.current?.contains(e.target)) {
      pos = resolveOffsetInLine(e.target, 0);
    }
    if (!pos) {
      // Unpin so a pinned cue can't get stuck when the click never reaches
      // `triggerGoToDef`'s `finally` (which is what normally clears the pin).
      pinnedRef.current = false;
      return;
    }

    void triggerGoToDef(pos.line, pos.character, { x: e.clientX, y: e.clientY + 4 });
  };

  return (
    <>
      <pre
        ref={containerRef}
        className={`workspace-code-viewer workspace-code-viewer--shiki${
          virtualized ? " workspace-code-viewer--virtual" : ""
        }`}
        data-lsp-armed={isArmed ? "true" : undefined}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onCopy={handleCopy}
      >
        {/* Hidden one-line measure span (observes LH + char width) — virtual mode
         *  only, so it never lands inside the `<pre>` of a normal file's copy /
         *  click-position surface. */}
        {virtualized ? (
          <span ref={measureRef} aria-hidden="true" className="workspace-code-measure">0</span>
        ) : null}
        {virtualized ? (
          <div
            ref={sizerRef}
            className="workspace-code-sizer"
            style={{ position: "relative", height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const lineNum = v.index + 1;
              const gutterMark = !noGutter ? gutterMarks?.get(lineNum) : undefined;
              const isTarget = highlightLine === lineNum;
              const span = isTarget ? targetSpanFor(lines[v.index] ?? "") : null;
              return (
                <div
                  key={v.key}
                  ref={virtualizer.measureElement}
                  data-index={v.index}
                  className="workspace-code-vrow"
                  style={{ transform: `translateY(${v.start - scrollMargin}px)` }}
                >
                  <CodeLine
                    line={lines[v.index] ?? ""}
                    lineNum={lineNum}
                    html={chunkedLines[v.index]}
                    gutterMark={gutterMark}
                    isTarget={isTarget}
                    markStart={span?.start}
                    markEnd={span?.end}
                    noGutter={noGutter}
                    gutterWidth={gutterWidth}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          lines.map((line, i) => {
            const lineNum = i + 1;
            const gutterMark = !noGutter ? gutterMarks?.get(lineNum) : undefined;
            const isTarget = highlightLine === lineNum;
            const span = isTarget ? targetSpanFor(line) : null;
            return (
              <CodeLine
                key={i}
                line={line}
                lineNum={lineNum}
                html={highlightedLines?.[i]}
                gutterMark={gutterMark}
                isTarget={isTarget}
                markStart={span?.start}
                markEnd={span?.end}
                noGutter={noGutter}
                gutterWidth={gutterWidth}
              />
            );
          })
        )}
        <span ref={overlayRef} className="workspace-code-symbol-hover" style={{ display: "none" }} />
      </pre>

      {pendingCue && (
        <div
          className="lsp-cue-tooltip"
          style={{ left: pendingCue.x, top: pendingCue.y }}
          role="status"
        >
          {pendingCue.text}
        </div>
      )}

      {messageCue && (
        <>
          <div
            className="lsp-popover-backdrop"
            onClick={() => setMessageCue(null)}
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
          />
          <div
            className="lsp-cue-tooltip lsp-cue-tooltip--message"
            style={{ left: messageCue.x, top: messageCue.y }}
            role="alert"
          >
            {messageCue.text}
          </div>
        </>
      )}

      {pickerState && (
        <>
          <div
            className="lsp-popover-backdrop"
            onClick={() => setPickerState(null)}
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
          />
          <div
            className="lsp-definition-picker"
            style={{ left: pickerState.x, top: pickerState.y }}
            role="dialog"
            aria-label="Go to definition"
          >
            <div className="lsp-definition-picker__header">
              <div className="lsp-definition-picker__title">
                Go to definition · {pickerState.locations.length}
              </div>
              {pickerState.fallback && (
                <div className="lsp-definition-picker__reason" data-testid="lsp-picker-reason">
                  {fallbackReasonText(pickerState.fallback, null, pickerState.failure)} — text matches
                </div>
              )}
            </div>
            <div className="lsp-definition-picker__list" role="listbox">
              {pickerState.locations.map((loc, idx) => {
                const isSelected = pickerState.selectedIndex === idx;
                const display = loc.external ? (loc.displayPath ?? "external") : loc.path;
                // The header already says "text matches" when every row is one.
                const showTextBadge =
                  loc.confidence === "text" &&
                  !pickerState.fallback &&
                  !pickerState.locations.every((l) => l.confidence === "text");
                // `preview` is the RAW source line — trim for display only.
                const preview = loc.preview?.trim();
                return (
                  <div
                    key={idx}
                    role="option"
                    aria-selected={isSelected}
                    className={`lsp-definition-picker__item${
                      isSelected ? " lsp-definition-picker__item--selected" : ""
                    }`}
                    onClick={() => handleSelectPickerLocation(loc)}
                  >
                    <div className="lsp-definition-picker__item-header">
                      <span className="lsp-definition-picker__item-target">
                        {display}:{loc.line + 1}
                      </span>
                      {showTextBadge && (
                        <span className="lsp-definition-picker__item-badge">(text match)</span>
                      )}
                    </div>
                    {preview && (
                      <span className="lsp-definition-picker__item-preview">{preview}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {hoverPendingCue && (
        <div
          className="lsp-cue-tooltip"
          style={{ left: hoverPendingCue.x, top: hoverPendingCue.y }}
          role="status"
        >
          {hoverPendingCue.text}
        </div>
      )}

      {hoverTooltip && (
        <div
          ref={hoverTooltipRef}
          className="lsp-hover-tooltip"
          style={{ left: hoverTooltip.x, top: hoverTooltip.y }}
          role="tooltip"
          data-testid="lsp-hover-tooltip"
          onScroll={(e) => e.stopPropagation()}
        >
          <div className="lsp-hover-tooltip__signature">{hoverTooltip.signature}</div>
          {hoverTooltip.doc && (
            <div
              className="lsp-hover-tooltip__doc"
              data-testid="lsp-hover-doc"
              tabIndex={0}
              onScroll={(e) => e.stopPropagation()}
            >
              {hoverTooltip.doc}
            </div>
          )}
          <div className="lsp-hover-tooltip__actions">
            <button
              type="button"
              className="lsp-hover-tooltip__find-references-btn"
              onClick={handleFindReferences}
            >
              Find references
            </button>
          </div>
        </div>
      )}
    </>
  );
});
