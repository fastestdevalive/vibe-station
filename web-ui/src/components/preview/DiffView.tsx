import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiffLine } from "@/preview/diffParser";
import { parseUnifiedDiff, syntheticUntrackedHunks } from "@/preview/diffParser";
import { diffLinesToHunks } from "@/preview/diffFromTexts";
import { computeGaps, type DiffGap } from "@/preview/diffGaps";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";
import { registerActiveDiffView, type DiffViewController } from "@/preview/diffViewRegistry";
import { useTheme } from "@/hooks/useTheme";
import { useWorkspaceStore } from "@/hooks/useStore";
import { themeById } from "@/theme/registry";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { MarkdownView } from "./MarkdownView";
import { MermaidView } from "./MermaidView";
import { DiffSideBySide } from "./DiffSideBySide";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { escapeHtml, highlightLineHtml } from "./shikiHighlighter";

interface DiffViewProps {
  /** Unified-diff text. Optional when `oldText`/`newText` are supplied instead
   *  (acp-normalize-superset Decision 3). */
  diffText?: string;
  /** Raw file text when diff empty / untracked */
  fileContentFallback?: string;
  /** Structured before/after text — takes precedence over `diffText` when
   *  either is defined (a new file has `oldText` absent, `newText` required). */
  oldText?: string;
  newText?: string;
  /** Used for syntax highlighting (extension → language) */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** Optional — enables the Source/Rendered toggle for `.md` files (Phase 9,
   *  item 8) by threading through to the same `MarkdownView` path the plain
   *  (non-diff) preview uses. Omitted by call sites with no worktree context
   *  (e.g. chat tool-result cards), which simply don't get the toggle. */
  api?: ApiInstance | null;
  worktreeId?: string | null;
  scope?: FileScope;
  /** diff-view-shortcuts Decision 2 (revised): opt-in flag. Only
   *  `FilePreviewPane`'s usage passes this — chat-transcript cards and the
   *  settings preview fixture never do, so they stay inert: no layout
   *  toggle, no hunk-collapse UI, no registry participation. Default
   *  `false`. */
  interactive?: boolean;
  /** Target new-side line number to reveal (jump-to-line). Auto-expands the
   *  hunk containing it if currently collapsed, then calls `onRevealReady`
   *  once that expansion has committed (see CUJ 1, plan-review addition). */
  revealLine?: number;
  onRevealReady?: () => void;
}

interface FlatDiffRow {
  key: string;
  content: string;
  line: DiffLine;
}

function flattenHunks(hunks: ReturnType<typeof parseUnifiedDiff>): FlatDiffRow[] {
  const rows: FlatDiffRow[] = [];
  let hi = 0;
  for (const hunk of hunks) {
    let li = 0;
    for (const line of hunk.lines) {
      rows.push({ key: `${hi}-${li}`, content: line.content, line });
      li += 1;
    }
    hi += 1;
  }
  return rows;
}

export function DiffView({
  diffText,
  fileContentFallback,
  oldText,
  newText,
  filePath,
  themeMode,
  api,
  worktreeId,
  scope,
  interactive = false,
  revealLine,
  onRevealReady,
}: DiffViewProps) {
  // `themeId` (the full 14-way value from the shared store) resolves to the
  // theme's Shiki id via the registry so syntax highlighting follows the theme.
  const { theme, themeId } = useTheme();
  const mode = themeMode ?? theme;
  // An explicit `themeMode` that differs from the active appearance is a
  // deliberate appearance-only override (e.g. the Settings hover-preview),
  // which carries no full themeId — fall back to the classic dark/light pair.
  const overridden = themeMode !== undefined && themeMode !== theme;
  const shikiThemeId: string = overridden
    ? mode === "light"
      ? "light-plus"
      : "dark-plus"
    : themeById[themeId]?.shikiThemeId ?? (mode === "light" ? "light-plus" : "dark-plus");

  // Item 8: `.md` files get a Source/Rendered toggle, anchored to the same
  // base-branch/fork-base concept `scope === "branch"` already uses — the
  // "Rendered" side reuses the exact `MarkdownView`/`mdSegments` path the
  // non-diff preview uses (`FilePreviewPane.tsx`'s `isMd` branch), rendering
  // the current full file content (`fileContentFallback`) rather than the
  // diff hunks themselves.
  const [displayMode, setDisplayMode] = useState<"source" | "rendered">("source");
  const isMd = filePath?.toLowerCase().endsWith(".md") ?? false;
  const canRenderMarkdown = isMd && !!fileContentFallback;
  const mdSegments = useMemo(
    () => (canRenderMarkdown ? segmentMarkdownWithMermaid(fileContentFallback!) : []),
    [canRenderMarkdown, fileContentFallback],
  );

  const hljsLang = filePath ? languageForFilePath(filePath) : undefined;
  const shikiLang = pickShikiLang(filePath, hljsLang);

  const hunks = useMemo(() => {
    if (oldText !== undefined || newText !== undefined) {
      return diffLinesToHunks(oldText ?? "", newText ?? "");
    }
    const trimmed = (diffText ?? "").trim();
    if (trimmed.length > 0) return parseUnifiedDiff(diffText ?? "");
    if (fileContentFallback) return syntheticUntrackedHunks(fileContentFallback);
    return [];
  }, [diffText, fileContentFallback, oldText, newText]);

  const flatRows = useMemo(() => flattenHunks(hunks), [hunks]);

  // Gap computation (diff-view-shortcuts-expand-context): the omitted line
  // ranges git trims between/around hunks. `fileLines` is null on paths with
  // no full file text (e.g. VCS commit diffs), which makes `computeGaps`
  // return `[]` — no gap affordance, by design (Decision 2).
  const fileLines = useMemo(() => {
    if (!fileContentFallback) return null;
    // `.split(/\r?\n/)` on a file ending in a trailing newline (the common
    // case) produces a phantom empty final entry, which isn't a real line —
    // inflating gap-end's `fileLines.length` by one and either fabricating a
    // bogus "1 lines hidden" affordance past the real end of file, or
    // appending one extra blank line to an expanded gap. Strip it.
    const lines = fileContentFallback.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "" && /\r?\n$/.test(fileContentFallback)) {
      lines.pop();
    }
    return lines;
  }, [fileContentFallback]);
  const gaps = useMemo(() => computeGaps(hunks, fileLines), [hunks, fileLines]);

  const lineKeyMap = useMemo(() => {
    const map = new Map<DiffLine, string>();
    for (const row of flatRows) map.set(row.line, row.key);
    return map;
  }, [flatRows]);

  const [highlightedByKey, setHighlightedByKey] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (flatRows.length === 0) {
      setHighlightedByKey(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        flatRows.map(async (row) => {
          const html = await highlightLineHtml(row.content, shikiLang, shikiThemeId);
          return [row.key, html] as const;
        }),
      );
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [k, v] of entries) map[k] = v;
      setHighlightedByKey(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [flatRows, shikiLang, shikiThemeId]);

  // ── interactive-only state: layout mode (global/session), hunk collapse
  // (per-instance, per-file), hover targeting, registry. ──────────────────
  const diffLayoutMode = useWorkspaceStore((s) => s.diffLayoutMode);
  const setDiffLayoutMode = useWorkspaceStore((s) => s.setDiffLayoutMode);

  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(new Set());
  useEffect(() => {
    setCollapsedHunks(new Set());
  }, [filePath]);

  // Expanded context gaps (diff-view-shortcuts-expand-context): keyed by gap
  // id (`"gap-start"` / `"gap-<i>"` / `"gap-end"`), reset on filePath change
  // exactly like `collapsedHunks` (Risk 2).
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpandedGaps(new Set());
  }, [filePath]);

  const toggleGap = useCallback((id: string) => {
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleHunk = useCallback((index: number) => {
    setCollapsedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const hoveredHunkIndexRef = useRef<number | null>(null);
  const onHunkMouseEnter = useCallback((index: number) => {
    hoveredHunkIndexRef.current = index;
  }, []);
  const onHunkMouseLeave = useCallback((index: number) => {
    if (hoveredHunkIndexRef.current === index) hoveredHunkIndexRef.current = null;
  }, []);
  // `mouseleave` never fires when the hovered hunk's wrapper unmounts out from
  // under the pointer (a file switch, or an inline ⟷ side-by-side layout
  // toggle) — without this, Alt+H could keep targeting a hunk index left over
  // from a different file/layout instead of falling back to topmost-visible.
  useEffect(() => {
    hoveredHunkIndexRef.current = null;
  }, [filePath, diffLayoutMode]);

  const headerRefs = useRef<(HTMLElement | null)[]>([]);
  const registerHeaderRef = useCallback((index: number, el: HTMLElement | null) => {
    headerRefs.current[index] = el;
  }, []);

  const rootRef = useRef<HTMLDivElement | null>(null);

  const toggleLayout = useCallback(() => {
    if (displayMode === "rendered") return; // PRD Resolved Q7 — no-op in Rendered mode
    setDiffLayoutMode(diffLayoutMode === "inline" ? "side-by-side" : "inline");
  }, [displayMode, diffLayoutMode, setDiffLayoutMode]);

  const toggleHunkAtFocus = useCallback(() => {
    if (displayMode === "rendered") return; // PRD Resolved Q7 — no-op in Rendered mode
    const hoverIdx = hoveredHunkIndexRef.current;
    if (hoverIdx != null) {
      toggleHunk(hoverIdx);
      return;
    }
    const container = rootRef.current?.closest<HTMLElement>(".preview-body") ?? null;
    if (!container) return; // defense-in-depth — only FilePreviewPane has this ancestor
    const containerTop = container.getBoundingClientRect().top;
    for (let i = 0; i < headerRefs.current.length; i++) {
      const el = headerRefs.current[i];
      if (!el) continue;
      if (el.getBoundingClientRect().bottom >= containerTop) {
        toggleHunk(i);
        return;
      }
    }
  }, [displayMode, toggleHunk]);

  // Registered once per mount via refs so the controller's methods always
  // call the LATEST closures without needing to re-register on every
  // dependency change (rootEl itself never changes across mode switches —
  // Decision 5's single persistent wrapper).
  const toggleLayoutRef = useRef(toggleLayout);
  toggleLayoutRef.current = toggleLayout;
  const toggleHunkAtFocusRef = useRef(toggleHunkAtFocus);
  toggleHunkAtFocusRef.current = toggleHunkAtFocus;

  useEffect(() => {
    if (!interactive || !rootRef.current) return;
    const controller: DiffViewController = {
      rootEl: rootRef.current,
      toggleLayout: () => toggleLayoutRef.current(),
      toggleHunkAtFocus: () => toggleHunkAtFocusRef.current(),
    };
    return registerActiveDiffView(controller);
  }, [interactive]);

  // Jump-to-line into a collapsed hunk (CUJ 1, plan-review addition) or a
  // collapsed context gap (diff-view-shortcuts-expand-context, Decision 4):
  // expand the target if needed, then report readiness AFTER that expansion
  // has actually committed (not just scheduled) so `FilePreviewPane`'s
  // scroll effect never races the DOM.
  const pendingRevealRef = useRef(false);
  useEffect(() => {
    if (revealLine == null) return;
    const hunkIndex = hunks.findIndex((h) => h.lines.some((l) => l.newLineNumber === revealLine));
    if (hunkIndex !== -1) {
      if (collapsedHunks.has(hunkIndex)) {
        pendingRevealRef.current = true;
        setCollapsedHunks((prev) => {
          const next = new Set(prev);
          next.delete(hunkIndex);
          return next;
        });
      } else {
        onRevealReady?.();
      }
      return;
    }
    // Target not inside any hunk — it may fall inside an omitted context gap.
    const gap = gaps.find((g) => revealLine >= g.startLine && revealLine <= g.endLine);
    if (gap) {
      if (!expandedGaps.has(gap.id)) {
        pendingRevealRef.current = true;
        setExpandedGaps((prev) => {
          const next = new Set(prev);
          next.add(gap.id);
          return next;
        });
      } else {
        onRevealReady?.();
      }
      return;
    }
    onRevealReady?.();
    // `collapsedHunks`/`expandedGaps`/`onRevealReady` deliberately excluded —
    // this effect should only re-evaluate when the reveal TARGET changes, not
    // every time some other hunk/gap's expand state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine, hunks, gaps]);

  useEffect(() => {
    if (!pendingRevealRef.current) return;
    pendingRevealRef.current = false;
    onRevealReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsedHunks, expandedGaps]);

  const toggle = canRenderMarkdown ? (
    <div className="preview-diff-mode-toggle" role="group" aria-label="Diff display mode">
      <button
        type="button"
        className={`preview-diff-mode-toggle__btn${displayMode === "source" ? " preview-diff-mode-toggle__btn--active" : ""}`}
        aria-pressed={displayMode === "source"}
        onClick={() => setDisplayMode("source")}
      >
        Source
      </button>
      <button
        type="button"
        className={`preview-diff-mode-toggle__btn${displayMode === "rendered" ? " preview-diff-mode-toggle__btn--active" : ""}`}
        aria-pressed={displayMode === "rendered"}
        onClick={() => setDisplayMode("rendered")}
      >
        Rendered
      </button>
    </div>
  ) : null;

  const layoutToggle =
    interactive && hunks.length > 0 ? (
      <div className="preview-diff-layout-toggle" role="group" aria-label="Diff layout">
        <button
          type="button"
          className={`preview-diff-layout-toggle__btn${diffLayoutMode === "inline" ? " preview-diff-layout-toggle__btn--active" : ""}`}
          aria-pressed={diffLayoutMode === "inline"}
          onClick={() => setDiffLayoutMode("inline")}
        >
          Inline
        </button>
        <button
          type="button"
          className={`preview-diff-layout-toggle__btn${diffLayoutMode === "side-by-side" ? " preview-diff-layout-toggle__btn--active" : ""}`}
          aria-pressed={diffLayoutMode === "side-by-side"}
          onClick={() => setDiffLayoutMode("side-by-side")}
        >
          Side-by-side
        </button>
      </div>
    ) : null;

  let content: ReactNode;

  const gapEnd = gaps.find((g) => g.id === "gap-end");

  // Renders one omitted-context gap affordance (diff-view-shortcuts-
  // expand-context): a "⋯ N lines hidden — click to expand" row that expands
  // in place to the real source lines from `fileLines`, mirroring the
  // hunk-collapse caret's visual/structural language.
  const renderGap = (gap: DiffGap) => {
    const expanded = expandedGaps.has(gap.id);
    return (
      <div key={gap.id} className="preview-diff-gap">
        {interactive ? (
          <button
            type="button"
            className="preview-diff-gap-header"
            aria-expanded={expanded}
            aria-label={
              expanded ? `Collapse ${gap.lineCount} hidden lines` : `Expand ${gap.lineCount} hidden lines`
            }
            onClick={() => toggleGap(gap.id)}
          >
            <span className="preview-diff-gap-caret">{expanded ? "▾" : "⋯"}</span>
            {expanded ? null : (
              <span className="preview-diff-gap-label">{`${gap.lineCount} lines hidden — click to expand`}</span>
            )}
          </button>
        ) : (
          <div className="preview-diff-gap-header">
            {expanded ? null : (
              <span className="preview-diff-gap-label">{`${gap.lineCount} lines hidden`}</span>
            )}
          </div>
        )}
        {expanded
          ? fileLines!.slice(gap.startLine - 1, gap.endLine).map((lineContent, k) => {
              const newLine = gap.startLine + k;
              const oldLine = newLine + gap.oldOffset;
              return (
                <div
                  key={`${gap.id}-${k}`}
                  className="diff-line diff-line--context"
                  data-line={newLine}
                >
                  <span className="diff-gutter">{oldLine}</span>
                  <span className="diff-gutter">{newLine}</span>
                  <span className="diff-marker"> </span>
                  <span
                    className="diff-line-text diff-line-text--context"
                    dangerouslySetInnerHTML={{ __html: escapeHtml(lineContent) }}
                  />
                </div>
              );
            })
          : null}
      </div>
    );
  };

  if (canRenderMarkdown && displayMode === "rendered") {
    content = (
      <>
        {toggle}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {mdSegments.map((seg, i) =>
            seg.type === "markdown" ? (
              <MarkdownView
                key={i}
                source={seg.content}
                api={api ?? null}
                worktreeId={worktreeId ?? null}
                scope={scope ?? "worktree"}
                filePath={filePath ?? null}
              />
            ) : (
              <MermaidView key={i} chart={seg.content} theme={mode} />
            ),
          )}
        </div>
      </>
    );
  } else if (hunks.length === 0) {
    content = (
      <div className="empty-state">
        <p>No changes</p>
      </div>
    );
  } else if (interactive && diffLayoutMode === "side-by-side") {
    content = (
      <>
        {toggle}
        {layoutToggle}
        <DiffSideBySide
          hunks={hunks}
          collapsedHunks={collapsedHunks}
          lineKeyMap={lineKeyMap}
          highlightedByKey={highlightedByKey}
          onToggleHunk={toggleHunk}
          onHunkMouseEnter={onHunkMouseEnter}
          onHunkMouseLeave={onHunkMouseLeave}
          registerHeaderRef={registerHeaderRef}
          gaps={gaps}
          expandedGaps={expandedGaps}
          fileLines={fileLines}
          onToggleGap={toggleGap}
        />
      </>
    );
  } else {
    content = (
      <>
        {toggle}
        {layoutToggle}
        <pre className="preview-diff-root">
          {hunks.map((hunk, i) => {
            const collapsed = collapsedHunks.has(i);
            const gapBefore = gaps.find((g) => (i === 0 ? g.id === "gap-start" : g.id === `gap-${i - 1}`));
            return (
              <Fragment key={i}>
                {gapBefore ? renderGap(gapBefore) : null}
                <div
                  className="preview-diff-hunk"
                  onMouseEnter={interactive ? () => onHunkMouseEnter(i) : undefined}
                  onMouseLeave={interactive ? () => onHunkMouseLeave(i) : undefined}
                >
                  <div
                    className="preview-diff-hunk-header"
                    ref={interactive ? (el) => registerHeaderRef(i, el) : undefined}
                  >
                    {interactive ? (
                      <button
                        type="button"
                        className="preview-diff-hunk-caret"
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? "Expand hunk" : "Collapse hunk"}
                        onClick={() => toggleHunk(i)}
                      >
                        {collapsed ? "▸" : "▾"}
                      </button>
                    ) : null}
                    <span>{hunk.header}</span>
                  </div>
                  {collapsed ? (
                    <div className="preview-diff-hunk-collapsed">{`${hunk.header} — ${hunk.lines.length} lines collapsed`}</div>
                  ) : (
                    hunk.lines.map((line, j) => {
                      const key = `${i}-${j}`;
                      const html = highlightedByKey?.[key];
                      return (
                        <div
                          key={key}
                          className={`diff-line diff-line--${line.type}`}
                          data-line={line.newLineNumber ?? undefined}
                        >
                          <span className="diff-gutter">{line.oldLineNumber ?? ""}</span>
                          <span className="diff-gutter">{line.newLineNumber ?? ""}</span>
                          <span className="diff-marker">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
                          <span
                            className={`diff-line-text diff-line-text--${line.type}${html ? " diff-line-text--shiki" : ""}`}
                            dangerouslySetInnerHTML={{
                              __html: html ?? escapeHtml(line.content),
                            }}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </Fragment>
            );
          })}
          {gapEnd ? renderGap(gapEnd) : null}
        </pre>
      </>
    );
  }

  return (
    <div ref={rootRef} className="preview-diff-view" tabIndex={-1}>
      {content}
    </div>
  );
}
