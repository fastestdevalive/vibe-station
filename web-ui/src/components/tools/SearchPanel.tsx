import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { FileScope, SearchResult } from "@/api/types";
import { ApiError } from "@/api/errors";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useRovingListNav, type RovingRow } from "@/hooks/useRovingListNav";

interface SearchPanelProps {
  api: ApiInstance;
  worktreeId: string | null;
  scope?: FileScope;
}

/** One flattened, navigable row — a file-group header (expandable) or a match.
 *  `path` is a composite key: header `${file}#header`, match `${file}#${line}#${idx}`
 *  (match lines can repeat within a file for multi-column matches). */
interface SearchRow extends RovingRow {
  kind: "header" | "match";
  filePath: string;
  line?: number;
  /** Index of the match within its file group, for rendering the match text. */
  matchIdx?: number;
  /** The matched substring itself (`SearchMatch.mid`) — carried on the row so
   *  callers don't need a separate `results.files.find(...)` lookup to pass
   *  it into the peek/commit actions for the opened-file highlight. */
  matchText?: string;
}

/** Flatten `results.files[].matches[]` into one ordered roving row list, interleaving
 *  each file-group header with its match rows (Decision 2). A collapsed file's match
 *  rows are simply omitted, so arrow-nav skips them automatically. */
function flattenSearchRows(results: SearchResult | null, expandedFiles: Set<string>): SearchRow[] {
  if (!results) return [];
  const out: SearchRow[] = [];
  for (const fileGroup of results.files) {
    out.push({
      path: `${fileGroup.path}#header`,
      kind: "header",
      filePath: fileGroup.path,
      expandable: true,
    });
    if (!expandedFiles.has(fileGroup.path)) continue;
    fileGroup.matches.forEach((m, idx) => {
      out.push({
        path: `${fileGroup.path}#${m.line}#${idx}`,
        kind: "match",
        filePath: fileGroup.path,
        line: m.line,
        matchIdx: idx,
        matchText: m.mid,
      });
    });
  }
  return out;
}

export function SearchPanel({ api, worktreeId, scope = "worktree" }: SearchPanelProps) {
  const setActiveFilePathAtLine = useWorkspaceStore((s) => s.setActiveFilePathAtLine);
  const openFileTabNew = useWorkspaceStore((s) => s.openFileTabNew);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);
  const setPeekFile = useWorkspaceStore((s) => s.setPeekFile);
  const clearPeekFile = useWorkspaceStore((s) => s.clearPeekFile);
  const filesLeftPaneMode = useWorkspaceStore((s) => s.filesLeftPaneMode);
  // Per-context (not global) — a canvas can have multiple mounted
  // SearchPanels (one per tools tile) at once; reading only this panel's
  // own `worktreeId` key means Mod+Shift+F focuses just the intended one.
  const searchFocusSeq = useWorkspaceStore((s) => (worktreeId ? s.searchFocusSeq[worktreeId] : undefined) ?? 0);

  const [query, setQuery] = useState("");
  const [caseCheck, setCaseCheck] = useState(false);
  const [regexCheck, setRegexCheck] = useState(false);
  const [wordCheck, setWordCheck] = useState(false);
  const [globField, setGlobField] = useState("");

  // Sticky toggle prefs: load the user's last-used case/regex/word settings
  // from the daemon once at true mount. Since Phase 3, SearchPanel is
  // always-mounted inside the Files tab (Requirement 9) — it no longer
  // remounts on every rail-mode switch, so these are read exactly once.
  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then((settings) => {
      if (cancelled) return;
      if (settings.searchCaseSensitive) setCaseCheck(true);
      if (settings.searchRegex) setRegexCheck(true);
      if (settings.searchWholeWord) setWordCheck(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only load
  }, []);

  const toggleAndPersist = (
    key: "searchCaseSensitive" | "searchRegex" | "searchWholeWord",
    current: boolean,
    setter: (v: boolean) => void,
  ) => {
    const next = !current;
    setter(next);
    void api.updateSettings({ [key]: next });
  };

  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  // Debounced search
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Debounced PEEK timer (see the effect below for the full contract).
  // Declared up here, not just inside that effect, so `handleMatchClick` can
  // cancel a still-pending peek at commit time — without this, committing
  // (Enter / Ctrl+click) clears `peekFile` synchronously, but a peek timer
  // armed by the cursor move that led up to the commit was still ticking; it
  // would fire ~200ms later and resurrect a peek/dedicated-tab for the file
  // that was just committed, appearing as a stray second tab.
  const peekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One-shot "seed the cursor to row 0 as soon as the next results land" flag
  // (S-2). The query-input Enter handler flushes a pending debounce by calling
  // the async `performSearch` directly, but `matchRows` is still the PREVIOUS
  // query's data synchronously after that call — so instead of seeding from
  // stale rows right there, it sets this flag and a results-arrival effect
  // seeds from the FRESH rows once the flushed search resolves.
  const seedCursorOnNextResultsRef = useRef(false);
  // Guards setState calls below against a request that resolves/rejects
  // after the panel has unmounted (e.g. the user switched Search tabs while
  // a search was still in flight) — ToolPanel mounts one tab at a time, so
  // that unmount doesn't otherwise cancel anything on its own.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Abort any in-flight request on unmount too — this also lets the
      // daemon's `kill_on_drop`-backed rg process die immediately instead of
      // running to completion for a result nobody can see anymore.
      abortControllerRef.current?.abort();
    };
  }, []);

  const performSearch = useCallback(
    async (q: string) => {
      if (!worktreeId || !q.trim()) {
        // Also cancel whatever is still in flight — an empty/cleared query
        // means no result from it should ever land.
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setResults(null);
        setError(null);
        return;
      }

      // Cancel previous search
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const result = await api.search(
          worktreeId,
          {
            q: q.trim(),
            case: caseCheck || undefined,
            re: regexCheck || undefined,
            word: wordCheck || undefined,
            glob: globField || undefined,
          },
          controller.signal,
          scope,
        );
        // Only a request that is STILL the current one (not superseded by a
        // newer keystroke, and not orphaned by an unmount) may touch state —
        // an aborted request's promise can still resolve/reject afterward.
        if (abortControllerRef.current !== controller || !isMountedRef.current) return;
        setResults(result);
        // Reset to all-expanded for this new result set (S3 — a fresh query
        // always resets to all-expanded; collapse is not preserved across
        // query changes). Setting this in the SAME tick as `setResults`
        // (React 18 batches both into one render) instead of via a separate
        // `useEffect` keyed on `results` avoids an intermediate render where
        // the header row is present but its match rows aren't yet (expandedFiles
        // still holds the previous query's paths) — that extra render was
        // harmless to real users (same-tick, imperceptible) but made this
        // component's tests measurably flaky once an additional effect was
        // added elsewhere in this file, since it widened the window in which
        // `waitFor` could observe the header-only intermediate render.
        setExpandedFiles(new Set(result.files.map((f) => f.path)));
      } catch (e) {
        if (abortControllerRef.current !== controller || !isMountedRef.current) {
          // Superseded-by-a-newer-search or unmounted: this request's own
          // AbortError (or any other rejection racing a fresher request) is
          // not a real error to surface, and clearing `results`/`loading`
          // here would incorrectly clobber the newer request's own state
          // (e.g. flashing "No matches found" mid-typing).
          return;
        }
        if (e instanceof ApiError && e.status === 503) {
          setError("ripgrep not found — content search unavailable");
        } else if (e instanceof Error && e.name !== "AbortError") {
          setError(e.message || "Search failed");
        }
        setResults(null);
      } finally {
        if (abortControllerRef.current === controller && isMountedRef.current) {
          setLoading(false);
        }
      }
    },
    [api, worktreeId, scope, caseCheck, regexCheck, wordCheck, globField],
  );

  useEffect(() => {
    // Any query change (not just clearing it to empty) must drop the previous
    // query's peek, so a stale preview never lingers under a new (still-loading)
    // result set (S8 / Requirement 7).
    clearPeekFile();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      // Null the ref when the timer fires naturally (S-2). Without this the
      // ref stays truthy forever after the first debounce, so the query-input
      // Enter handler's "is a debounce pending?" check would always be true and
      // redundantly re-fire performSearch on nearly every Enter.
      debounceTimerRef.current = null;
      void performSearch(query);
    }, 200);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
    // `clearPeekFile` is a stable zustand action reference — listing it
    // doesn't change when this effect re-runs, it just satisfies the lint
    // rule truthfully instead of suppressing it.
  }, [query, performSearch, clearPeekFile]);

  const toggleFileExpanded = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Commit path (Requirement 6 / B7). A match opens a permanent tab:
  // plain Enter replaces the active tab; Ctrl/Cmd-click or Mod+Enter opens a
  // NEW tab. Mirrors FileTreeSidebar's modifier branch. Plain click no
  // longer commits at all (live-review feedback) — it just moves the roving
  // cursor there via the row's native focus event, same as arrow-key nav.
  const handleMatchClick = (path: string, line: number, inNewTab = false, matchText?: string) => {
    if (!worktreeId) return;
    // Cancel a still-pending peek timer armed by the cursor move that led up
    // to this commit — otherwise it fires ~200ms from now regardless and
    // resurrects a peek for the file just committed (see the ref's own
    // comment above for the full failure mode this prevents).
    if (peekDebounceRef.current) {
      clearTimeout(peekDebounceRef.current);
      peekDebounceRef.current = null;
    }
    if (inNewTab) {
      openFileTabNew(worktreeId, path);
      // S-3: `openFileTabNew` takes no line, so a new-tab open would otherwise
      // land at the top of the file. Set the pending scroll-to-line now that the
      // tab exists (idempotent — setActiveFilePathAtLine switches to the tab it
      // just opened and sets the pending line for it).
      setActiveFilePathAtLine(worktreeId, path, line, matchText);
    } else {
      setActiveFilePathAtLine(worktreeId, path, line, matchText);
    }
    setToolPanelTab("files");
  };

  // Flattened roving-nav row list (Decision 2). Memoized on [results, expandedFiles]
  // so a toggle checkbox click / unrelated re-render doesn't re-flatten every time.
  const matchRows = useMemo(
    () => flattenSearchRows(results, expandedFiles),
    [results, expandedFiles],
  );

  const queryInputRef = useRef<HTMLInputElement>(null);
  const resultsHaveFocusRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // Focus the query input when the Files rail transitions TO search mode
  // (B4b/B4c). Replaces the removed `autoFocus`, which was safe only while
  // SearchPanel remounted on each Search-tab open; always-mounted, it would
  // fire once on the Files tab's first render in tree mode and steal focus.
  const prevFilesModeRef = useRef<string | null>(null);
  useEffect(() => {
    const mode = worktreeId ? (filesLeftPaneMode[worktreeId] ?? "tree") : "tree";
    const wasSearch = prevFilesModeRef.current === "search";
    prevFilesModeRef.current = mode;
    if (mode === "search" && !wasSearch) {
      queryInputRef.current?.focus();
    }
  }, [filesLeftPaneMode, worktreeId]);

  // Explicit focus request from Mod+Shift+F (Phase 3.7) — focuses the input
  // even when already in search mode (no mode transition fires then).
  useEffect(() => {
    if (searchFocusSeq > 0) {
      queryInputRef.current?.focus();
    }
  }, [searchFocusSeq]);

  const { cursorPath, setCursorPath, handleKeyDown, isTabbable } = useRovingListNav(matchRows, {
    onOpen: (path) => {
      const row = matchRows.find((r) => r.path === path);
      if (!row) return;
      if (row.kind === "header") {
        toggleFileExpanded(row.filePath);
      } else if (row.line != null) {
        handleMatchClick(row.filePath, row.line, false, row.matchText);
      }
    },
    onToggle: (path) => {
      const row = matchRows.find((r) => r.path === path);
      if (row?.kind === "header") toggleFileExpanded(row.filePath);
    },
    onBoundary: (edge) => {
      // Up-at-first-row returns focus to the query input (Decision 3);
      // Down-at-last-row is a deliberate no-op.
      if (edge === "top") {
        setCursorPath(null);
        queryInputRef.current?.focus();
      }
    },
  });

  // S-2: consume a "seed the cursor on the next results" request set by the
  // query-input Enter handler's debounce-flush path. The flush calls the async
  // `performSearch` directly, so at the moment of the flush `matchRows` is
  // still the PREVIOUS query's rows — this effect seeds from the FRESH rows
  // once the flushed search resolves (and re-renders), not from the stale ones.
  useEffect(() => {
    if (!seedCursorOnNextResultsRef.current) return;
    seedCursorOnNextResultsRef.current = false;
    const firstRow = matchRows[0];
    if (firstRow) {
      setCursorPath(firstRow.path);
      rowRefs.current.get(firstRow.path)?.focus();
    }
  }, [results, matchRows, setCursorPath]);

  // Focus follows the roving cursor (mirrors FileTreeSidebar's pattern), gated
  // on the results list actually having focus so pre-seeding the cursor before
  // the pane is focused doesn't steal it.
  useEffect(() => {
    if (cursorPath && resultsHaveFocusRef.current) {
      rowRefs.current.get(cursorPath)?.focus();
    }
  }, [cursorPath]);

  // Debounced peek (Decision 6): arrowing onto a match row live-updates the
  // shared preview pane WITHOUT committing a tab. A null cursor ONLY auto-
  // clears the peek when it is null BECAUSE the result set emptied (zero rows,
  // e.g. a query that shrank to no matches) — in that case a stale peek must
  // not linger over a file with no row (S-1). A null cursor from a pure focus
  // gesture — Escape, or Up-at-the-first-row boundary (Decision 3) — must NOT
  // blank the preview; the peek stays showing.
  useEffect(() => {
    if (peekDebounceRef.current) {
      clearTimeout(peekDebounceRef.current);
      peekDebounceRef.current = null;
    }
    if (cursorPath === null) {
      if (matchRows.length === 0) clearPeekFile();
      return;
    }
    const row = matchRows.find((r) => r.path === cursorPath);
    if (row?.kind === "match" && row.line != null && worktreeId) {
      const { filePath, line, matchText } = row;
      peekDebounceRef.current = setTimeout(() => {
        setPeekFile({ worktreeId, path: filePath, line, matchText: matchText ?? null });
      }, 200);
    }
    return () => {
      if (peekDebounceRef.current) {
        clearTimeout(peekDebounceRef.current);
        peekDebounceRef.current = null;
      }
    };
  }, [cursorPath, matchRows, worktreeId, setPeekFile, clearPeekFile]);

  // Results-container key handling: Escape returns to the input; Mod+Enter
  // commits the cursored match into a NEW tab (priority over the hook's plain
  // Enter). Everything else delegates to the roving-nav hook.
  const handleResultsKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setCursorPath(null);
      queryInputRef.current?.focus();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      const row = matchRows.find((r) => r.path === cursorPath);
      if (row?.kind === "match" && row.line != null) {
        handleMatchClick(row.filePath, row.line, true, row.matchText);
      }
      return;
    }
    handleKeyDown(e);
  };

  return (
    <div className="search-panel pane pane-stack">
      <div className="search-panel__controls">
        <div className="search-panel__input-wrap">
        <input
          type="text"
          className="search-panel__input"
          placeholder="Search content..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search query"
          ref={queryInputRef}
          onKeyDown={(e) => {
            // Enter OR an arrow key from the query input both seed the cursor
            // into results (live feedback: arrow keys should work right away
            // while typing, not only after first pressing Enter) — same
            // "leave the input, enter the list" seeding action either way.
            if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            // Flush a pending debounce synchronously so this never acts on
            // stale/previous-query results (S2). The flush is async — `matchRows`
            // below is still the PREVIOUS query's rows right after it — so when a
            // flush actually happens we seed the cursor from the FRESH results via
            // the one-shot flag instead (see the seed effect), rather than from the
            // stale rows synchronously.
            const flushed = !!debounceTimerRef.current;
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = null;
              void performSearch(query);
            }
            if (flushed) {
              seedCursorOnNextResultsRef.current = true;
            } else {
              // No pending debounce -> results are already fresh; seed directly
              // (Requirement 1).
              const firstRow = matchRows[0];
              if (firstRow) {
                setCursorPath(firstRow.path);
                rowRefs.current.get(firstRow.path)?.focus();
              }
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="search-panel__clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              setQuery("");
              queryInputRef.current?.focus();
            }}
          >
            <X size={13} />
          </button>
        )}
        </div>
        <div className="search-panel__toggles">
          <button
            className={`search-panel__toggle ${caseCheck ? "active" : ""}`}
            title="Case sensitive"
            onClick={() => toggleAndPersist("searchCaseSensitive", caseCheck, setCaseCheck)}
            aria-label="Case sensitive"
          >
            Aa
          </button>
          <button
            className={`search-panel__toggle ${regexCheck ? "active" : ""}`}
            title="Regular expression"
            onClick={() => toggleAndPersist("searchRegex", regexCheck, setRegexCheck)}
            aria-label="Regular expression"
          >
            .*
          </button>
          <button
            className={`search-panel__toggle ${wordCheck ? "active" : ""}`}
            title="Whole word"
            onClick={() => toggleAndPersist("searchWholeWord", wordCheck, setWordCheck)}
            aria-label="Whole word"
          >
            \b
          </button>
        </div>
      </div>
      <div className="search-panel__glob">
        <input
          type="text"
          className="search-panel__glob-input"
          placeholder="Filter files, e.g. *.ts or src/**"
          title="Optional file filter using glob patterns (shell-style wildcards) — e.g. *.ts matches only TypeScript files, src/** matches everything under src/"
          value={globField}
          onChange={(e) => setGlobField(e.target.value)}
          aria-label="Filter files by glob pattern, e.g. *.ts or src/**"
        />
      </div>

      <div className="search-panel__results">
        {error ? (
          <div className="search-panel__banner search-panel__banner--error">
            {error}
          </div>
        ) : null}

        {loading && !results ? (
          <div className="empty-state">Searching...</div>
        ) : results && results.files.length === 0 ? (
          query.trim() ? (
            <div className="empty-state">No matches found</div>
          ) : (
            <div className="empty-state">Enter a search query</div>
          )
        ) : results ? (
          <div
            className="search-panel__results-list"
            tabIndex={-1}
            onKeyDown={handleResultsKeyDown}
            onFocusCapture={() => {
              resultsHaveFocusRef.current = true;
              if (cursorPath) {
                const el = rowRefs.current.get(cursorPath);
                if (el && el !== document.activeElement) {
                  el.focus({ preventScroll: true });
                }
              }
            }}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                resultsHaveFocusRef.current = false;
              }
            }}
          >
            {matchRows.map((row) => {
              if (row.kind === "header") {
                const fileGroup = results.files.find((f) => f.path === row.filePath);
                const matchCount = fileGroup?.matches.length ?? 0;
                return (
                  <button
                    key={row.path}
                    type="button"
                    ref={(el) => {
                      if (el) rowRefs.current.set(row.path, el);
                      else rowRefs.current.delete(row.path);
                    }}
                    className={`search-panel__file-header${cursorPath === row.path ? " search-panel__file-header--cursor" : ""}`}
                    tabIndex={isTabbable(row.path) ? 0 : -1}
                    aria-expanded={expandedFiles.has(row.filePath)}
                    onClick={() => toggleFileExpanded(row.filePath)}
                    onFocus={() => setCursorPath(row.path)}
                  >
                    <span className="search-panel__file-path">
                      {row.filePath}
                    </span>
                    <span className="search-panel__match-count">
                      {matchCount} {matchCount === 1 ? "match" : "matches"}
                    </span>
                  </button>
                );
              }
              const fileGroup = results.files.find((f) => f.path === row.filePath);
              const match = fileGroup?.matches[row.matchIdx ?? 0];
              return (
                <button
                  key={row.path}
                  type="button"
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.path, el);
                    else rowRefs.current.delete(row.path);
                  }}
                  className={`search-panel__match-row${cursorPath === row.path ? " search-panel__match-row--cursor" : ""}`}
                  tabIndex={isTabbable(row.path) ? 0 : -1}
                  onClick={(e) => {
                    // Plain click: no commit — native focus (below) already
                    // moved the roving cursor here, same as arrow-key nav,
                    // which drives the peek. Ctrl/Cmd-click still commits
                    // straight to a NEW tab (unchanged power-user shortcut).
                    if (row.line != null && (e.ctrlKey || e.metaKey)) {
                      handleMatchClick(row.filePath, row.line, true, row.matchText);
                    }
                  }}
                  onFocus={() => setCursorPath(row.path)}
                >
                  <span className="search-panel__line-number">
                    {row.line}
                  </span>
                  <span className="search-panel__match-text">
                    <span>{match?.pre}</span>
                    <mark>{match?.mid}</mark>
                    <span>{match?.post}</span>
                  </span>
                </button>
              );
            })}
            {results.truncated && (
              <div className="search-panel__notice">
                Results truncated. Refine your search for more specific matches.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
