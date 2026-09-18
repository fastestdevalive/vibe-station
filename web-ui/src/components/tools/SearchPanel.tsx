import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope, SearchResult } from "@/api/types";
import { ApiError } from "@/api/errors";
import { useWorkspaceStore } from "@/hooks/useStore";

interface SearchPanelProps {
  api: ApiInstance;
  worktreeId: string | null;
  scope?: FileScope;
}

export function SearchPanel({ api, worktreeId, scope = "worktree" }: SearchPanelProps) {
  const setActiveFilePathAtLine = useWorkspaceStore((s) => s.setActiveFilePathAtLine);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);

  const [query, setQuery] = useState("");
  const [caseCheck, setCaseCheck] = useState(false);
  const [regexCheck, setRegexCheck] = useState(false);
  const [wordCheck, setWordCheck] = useState(false);
  const [globField, setGlobField] = useState("");

  // Sticky toggle prefs: load the user's last-used case/regex/word settings
  // from the daemon on mount, so they don't reset every time the Search tab
  // is reopened (SearchPanel remounts fresh each time, per ToolPanel's
  // conditional render).
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

  const performSearch = useCallback(
    async (q: string) => {
      if (!worktreeId || !q.trim()) {
        setResults(null);
        setError(null);
        return;
      }

      // Cancel previous search
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

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
          abortControllerRef.current.signal,
          scope,
        );
        setResults(result);
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) {
          setError("ripgrep not found — content search unavailable");
        } else if (e instanceof Error && e.name !== "AbortError") {
          setError(e.message || "Search failed");
        }
        setResults(null);
      } finally {
        setLoading(false);
      }
    },
    [api, worktreeId, scope, caseCheck, regexCheck, wordCheck, globField],
  );

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      void performSearch(query);
    }, 200);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [query, performSearch]);

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

  const handleMatchClick = (path: string, line: number) => {
    if (worktreeId) {
      setActiveFilePathAtLine(worktreeId, path, line);
      setToolPanelTab("files");
    }
  };

  // Initialize expanded state when results change
  useEffect(() => {
    if (results && results.files.length > 0) {
      const allPaths = new Set(results.files.map((f) => f.path));
      setExpandedFiles(allPaths);
    }
  }, [results]);

  return (
    <div className="search-panel pane pane-stack">
      <div className="search-panel__controls">
        <input
          type="text"
          className="search-panel__input"
          placeholder="Search content..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search query"
          autoFocus
        />
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
          <div className="search-panel__file-groups">
            {results.files.map((fileGroup) => {
              const isExpanded = expandedFiles.has(fileGroup.path);
              const matchCount = fileGroup.matches.length;

              return (
                <div key={fileGroup.path} className="search-panel__file-group">
                  <button
                    className="search-panel__file-header"
                    onClick={() => toggleFileExpanded(fileGroup.path)}
                  >
                    <span className="search-panel__file-path">
                      {fileGroup.path}
                    </span>
                    <span className="search-panel__match-count">
                      {matchCount} {matchCount === 1 ? "match" : "matches"}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="search-panel__matches">
                      {fileGroup.matches.map((match, idx) => (
                        <button
                          key={idx}
                          className="search-panel__match-row"
                          onClick={() => handleMatchClick(fileGroup.path, match.line)}
                        >
                          <span className="search-panel__line-number">
                            {match.line}
                          </span>
                          <span className="search-panel__match-text">
                            <span>{match.pre}</span>
                            <mark>{match.mid}</mark>
                            <span>{match.post}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
