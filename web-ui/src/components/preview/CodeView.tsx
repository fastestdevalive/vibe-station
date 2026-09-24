import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { useWorkspaceStore } from "@/hooks/useStore";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { escapeHtml, highlightDocumentLines } from "./shikiHighlighter";
import {
  getDefinition,
  getHover,
  isLspNotReady,
  type Location,
  type LspDefinitionResponse,
  type LspFileRef,
  type LspHoverResponse,
} from "@/lib/lspApi";
import { resolveClickPosition, resolveOffsetInLine } from "@/lib/lspPosition";
import type { FileScope } from "@/api/types";

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

interface CodeViewProps {
  code: string;
  language?: string;
  /** Used to pick TSX vs TS etc. for Shiki */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** When true, renders without gutter (e.g. inside a markdown code block) */
  noGutter?: boolean;
  /** Git gutter marks: added/modified/deleted line annotations. No-op when noGutter is true. */
  gutterMarks?: Map<number, "added" | "modified" | "deleted">;
  /** 1-based line number to highlight (search jump-to-line / peek target). */
  highlightLine?: number | null;
  /** Matched substring within `highlightLine` to additionally mark, if found. */
  highlightMatchText?: string | null;

  // LSP props (Phase 3)
  api?: unknown;
  worktreeId?: string | null;
  scope?: FileScope;
  lspFileRef?: LspFileRef;
  etag?: string;
  retryDelayMs?: number;
}

/** Wrap the first occurrence of `matchText` inside `el` with one or more
 *  `<mark class="workspace-code-match">` elements, preserving Shiki's
 *  syntax-highlighting spans instead of dropping them. */
function markMatchInElement(el: HTMLElement, matchText: string): void {
  if (!matchText) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let concatenated = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    textNodes.push(t);
    concatenated += t.data;
  }
  const startIdx = concatenated.indexOf(matchText);
  if (startIdx < 0) return;
  const endIdx = startIdx + matchText.length;

  let pos = 0;
  for (const t of textNodes) {
    const len = t.data.length;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    pos += len;
    const overlapStart = Math.max(startIdx, nodeStart);
    const overlapEnd = Math.min(endIdx, nodeEnd);
    if (overlapStart >= overlapEnd) continue;

    const localStart = overlapStart - nodeStart;
    const localEnd = overlapEnd - nodeStart;
    let target: Text = t;
    if (localStart > 0) target = target.splitText(localStart);
    if (localEnd - localStart < target.data.length) target.splitText(localEnd - localStart);

    const mark = document.createElement("mark");
    mark.className = "workspace-code-match";
    target.replaceWith(mark);
    mark.appendChild(target);
  }
}

export function CodeView({
  code,
  language: languageProp,
  filePath,
  themeMode,
  noGutter,
  gutterMarks,
  highlightLine,
  highlightMatchText,
  api,
  worktreeId,
  scope = "worktree",
  lspFileRef,
  etag,
  retryDelayMs,
}: CodeViewProps) {
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
  const gutterWidth = String(lines.length).length;

  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);

  // LSP interactive state
  const containerRef = useRef<HTMLPreElement | null>(null);
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

  // Local-only (no LSP round-trip), IntelliJ/Android-Studio-style hover cue: while
  // armed, the specific identifier under the pointer gets wrapped in a real DOM span
  // so it can be underlined + recolored via CSS. Actual navigability is still only
  // confirmed on click (PRD resolved question 7) — this just marks which token a
  // click would target, same principle as the crosshair cursor it replaces, just
  // more precise.
  const hoveredSymbolWrapperRef = useRef<HTMLElement | null>(null);
  const hoveredSymbolRangeRef = useRef<{ node: Text; start: number; end: number } | null>(null);

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
    // The DOM node our hover wrapper pointed at is about to be replaced by a
    // fresh dangerouslySetInnerHTML render — just drop the stale reference,
    // no unwrap needed (there's nothing valid left to unwrap into).
    hoveredSymbolWrapperRef.current = null;
    hoveredSymbolRangeRef.current = null;
  }, [filePath, lspFileRef]);

  useEffect(() => {
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
  }, [code, language, shikiLang, shikiThemeId]);

  // Shared by the hover tooltip's "Find references" button AND a cmd/ctrl
  // click that lands on a symbol's own definition (see `isSelfDefinitionClick`
  // below, used inside `triggerGoToDef`) — both open the same references
  // view for the same reason: there's nowhere more "definition-y" left to
  // navigate to.
  const triggerFindReferences = useCallback(
    (line: number, character: number, symbol: string) => {
      const store = useWorkspaceStore.getState();
      const layoutKey =
        worktreeId ?? store.activeWorktreeId ?? store.activeDirectContextId ?? "";
      store.setFilesLeftPaneMode(layoutKey, "references");
      store.setPendingReferencesQuery({
        worktreeId: layoutKey,
        path: lspFileRef && lspFileRef.kind === "workspace" ? lspFileRef.path : (filePath ?? ""),
        line,
        character,
        symbol,
        external:
          lspFileRef && lspFileRef.kind === "external"
            ? { token: lspFileRef.token, displayPath: filePath ?? "" }
            : undefined,
      });
    },
    [worktreeId, lspFileRef, filePath],
  );

  const triggerGoToDef = useCallback(
    async (line: number, character: number, anchorPos: { x: number; y: number }) => {
      if (!api || !worktreeId || !lspFileRef) return;

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
            } catch {
              clearTimeout(pendingTimer);
              setPendingCue(null);
              if (requestGenRef.current === gen) {
                setMessageCue({ ...anchorPos, text: "still starting — click again" });
              }
              return;
            }
          } else {
            clearTimeout(pendingTimer);
            setPendingCue(null);
            return;
          }
        }

        clearTimeout(pendingTimer);
        setPendingCue(null);

        // 3.4 Superseded-request guard:
        // Discard any response whose generation is stale, or if file's content/etag changed
        if (requestGenRef.current !== gen) return;
        if (codeRef.current !== capturedCode || (etag != null && etagRef.current !== capturedEtag)) return;

        const locations = res.locations ?? [];

        // 3.8 Zero results (server answered, no match) -> silent no-op
        if (locations.length === 0) {
          return;
        }

        // Clicked-on-the-declaration-itself: `textDocument/definition` on a
        // declaration commonly echoes that same location back rather than
        // erroring, which would otherwise "navigate" you to exactly where
        // you already are. Natural editor behavior: usage → jump to
        // definition, definition → show references instead.
        if (locations.length === 1) {
          const loc = locations[0]!;
          const currentPath = lspFileRef.kind === "workspace" ? lspFileRef.path : undefined;
          const currentExternalToken = lspFileRef.kind === "external" ? lspFileRef.token : undefined;
          const clickedRange = wordRangeAtPosition(lines[line] ?? "", character);
          if (isSelfDefinitionClick(loc, line, clickedRange, currentPath, currentExternalToken)) {
            const symbol = clickedRange
              ? (lines[line] ?? "").slice(clickedRange.start, clickedRange.end)
              : "";
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
        });
      } catch {
        clearTimeout(pendingTimer);
        setPendingCue(null);
      }
    },
    [api, worktreeId, scope, lspFileRef, code, etag, retryDelayMs, lines, triggerFindReferences],
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
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
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
        setIsArmed(false);
        clearHoveredSymbol();
      }
    };

    const onBlur = () => {
      setIsArmed(false);
      clearHoveredSymbol();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [pickerState, triggerGoToDef, handleSelectPickerLocation]);

  const handlePointerEnter = (e: React.PointerEvent) => {
    pointerOverRef.current = true;
    if (e.ctrlKey || e.metaKey) setIsArmed(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    pointerOverRef.current = true;
    const shouldArm = e.ctrlKey || e.metaKey;
    if (shouldArm !== isArmed) setIsArmed(shouldArm);
    scheduleHoverRest(e.clientX, e.clientY, e.ctrlKey, e.metaKey, e.target);
  };

  const handlePointerLeave = () => {
    pointerOverRef.current = false;
    setIsArmed(false);
    clearHoveredSymbol();
    if (hoverRestTimerRef.current) {
      clearTimeout(hoverRestTimerRef.current);
      hoverRestTimerRef.current = null;
    }
  };

  // Word-character set for the local hover-highlight (identifiers only —
  // matches every language this feature currently supports well enough for
  // a purely visual cue; the actual click still resolves position via the
  // real DOM hit-test, this only decides what to underline).
  const isWordChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

  const clearHoveredSymbol = () => {
    const wrapper = hoveredSymbolWrapperRef.current;
    if (wrapper && wrapper.parentNode) {
      const parent = wrapper.parentNode;
      while (wrapper.firstChild) {
        parent.insertBefore(wrapper.firstChild, wrapper);
      }
      parent.removeChild(wrapper);
      parent.normalize();
    }
    hoveredSymbolWrapperRef.current = null;
    hoveredSymbolRangeRef.current = null;
  };

  const updateHoveredSymbolAt = (clientX: number, clientY: number) => {
    const doc = document as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === "function") {
      const pos = doc.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    } else if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }

    if (
      !node ||
      node.nodeType !== Node.TEXT_NODE ||
      !containerRef.current?.contains(node) ||
      (node instanceof Element ? node : node.parentElement)?.closest(".workspace-code-gutter")
    ) {
      clearHoveredSymbol();
      return;
    }

    const textNode = node as Text;
    const text = textNode.textContent ?? "";
    // Offset can land exactly on a boundary (e.g. end of text node) — clamp.
    const at = Math.min(offset, Math.max(text.length - 1, 0));
    if (!text[at] || !isWordChar(text[at])) {
      clearHoveredSymbol();
      return;
    }

    let start = at;
    while (start > 0 && isWordChar(text[start - 1] ?? "")) start--;
    let end = at + 1;
    while (end < text.length && isWordChar(text[end] ?? "")) end++;

    const current = hoveredSymbolRangeRef.current;
    if (current && current.node === textNode && current.start === start && current.end === end) {
      return; // Same word as last move — avoid needless DOM churn/flicker.
    }

    clearHoveredSymbol();

    try {
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const span = document.createElement("span");
      span.className = "workspace-code-symbol-hover";
      range.surroundContents(span);
      hoveredSymbolWrapperRef.current = span;
      hoveredSymbolRangeRef.current = { node: textNode, start, end };
    } catch {
      // A word that (rarely) spans a syntax-highlighting span boundary can't
      // be wrapped this way — just skip the visual cue for this move, the
      // cursor + click behavior are unaffected either way.
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    mousedownCoordsRef.current = { x: e.clientX, y: e.clientY };
    dragDetectedRef.current = false;
    if (hoverRestTimerRef.current) {
      clearTimeout(hoverRestTimerRef.current);
      hoverRestTimerRef.current = null;
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
    if ((e.ctrlKey || e.metaKey) && !dragDetectedRef.current) {
      updateHoveredSymbolAt(e.clientX, e.clientY);
    } else {
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
      return;
    }
    if (mousedownCoordsRef.current) {
      const dx = e.clientX - mousedownCoordsRef.current.x;
      const dy = e.clientY - mousedownCoordsRef.current.y;
      if (Math.hypot(dx, dy) > 5) {
        return;
      }
    }

    e.preventDefault();
    e.stopPropagation();
    // Deliberately NOT clearing the hover-cue underline here — it should
    // persist through the click (the async go-to-def/references request is
    // still resolving, or the click is a silent no-op with zero results;
    // either way, yanking the underline the instant you click was jarring).
    // It's cleared naturally when the modifier releases (onKeyUp/onBlur),
    // the pointer leaves the code view (handlePointerLeave), the pointer
    // moves to a different word (handleMouseMove), or the file navigates
    // away (the file-switch effect resets the ref for a fresh DOM anyway).

    let pos = resolveClickPosition(e.clientX, e.clientY, containerRef.current);
    if (!pos && e.target instanceof Node && containerRef.current?.contains(e.target)) {
      pos = resolveOffsetInLine(e.target, 0);
    }
    if (!pos) return;

    void triggerGoToDef(pos.line, pos.character, { x: e.clientX, y: e.clientY + 4 });
  };

  return (
    <>
      <pre
        ref={containerRef}
        className="workspace-code-viewer workspace-code-viewer--shiki"
        data-lsp-armed={isArmed ? "true" : undefined}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      >
        {lines.map((line, i) => {
          const lineNum = i + 1;
          const gutterMark = !noGutter ? gutterMarks?.get(lineNum) : undefined;
          const isTarget = highlightLine === lineNum;
          const modifierClass = `${gutterMark ? ` workspace-code-line--${gutterMark}` : ""}${isTarget ? " workspace-code-line--target" : ""}`;
          const wantsMatchMark = isTarget && !!highlightMatchText;
          let content: ReactNode;
          if (highlightedLines) {
            content = (
              <span
                key={wantsMatchMark ? `shiki-marked-${highlightMatchText}` : "shiki"}
                className="workspace-code-content workspace-code-content--shiki"
                dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? escapeHtml(line) }}
                ref={
                  wantsMatchMark
                    ? (el) => {
                        if (el) markMatchInElement(el, highlightMatchText!);
                      }
                    : undefined
                }
              />
            );
          } else if (wantsMatchMark) {
            const matchIdx = line.indexOf(highlightMatchText!);
            content =
              matchIdx >= 0 ? (
                <span className="workspace-code-content">
                  {line.slice(0, matchIdx)}
                  <mark className="workspace-code-match">{highlightMatchText}</mark>
                  {line.slice(matchIdx + highlightMatchText!.length)}
                </span>
              ) : (
                <span className="workspace-code-content">{line}</span>
              );
          } else {
            content = <span className="workspace-code-content">{line}</span>;
          }
          return (
            <div key={i} className={`workspace-code-line${modifierClass}`} data-line={lineNum}>
              {!noGutter && (
                <span className="workspace-code-gutter" style={{ minWidth: `${gutterWidth + 2}ch` }}>
                  {lineNum}
                </span>
              )}
              {content}
            </div>
          );
        })}
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
              Go to definition ({pickerState.locations.length})
            </div>
            <div className="lsp-definition-picker__list" role="listbox">
              {pickerState.locations.map((loc, idx) => {
                const isSelected = pickerState.selectedIndex === idx;
                const display = loc.external ? (loc.displayPath ?? "external") : loc.path;
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
                      {loc.confidence === "text" && (
                        <span className="lsp-definition-picker__item-badge">(text match)</span>
                      )}
                    </div>
                    {loc.preview && (
                      <span className="lsp-definition-picker__item-preview">{loc.preview}</span>
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
}
