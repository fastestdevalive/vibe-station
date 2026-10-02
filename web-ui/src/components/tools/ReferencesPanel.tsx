import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, RotateCw, Search, X } from "lucide-react";
import type { FileScope } from "@/api/types";
import {
  getReferences,
  isLspNotReady,
  isLspDisabled,
  isLspUnsupported,
  failureHeadline,
  isDependencyFailure,
  lspFailureFromError,
  type LspFailure,
  type LspFallbackReason,
  type ReferenceEntry,
  type ReferenceGroup,
  type LspFileRef,
} from "@/lib/lspApi";
import { ApiError } from "@/api/errors";
import { useLspStatus } from "@/hooks/useLspStatus";
import { LspInstallCommand, LspRemediationActions, LspServerOutput } from "../layout/LspRemediation";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore, type PendingReferencesQuery } from "@/hooks/useStore";
import { useToolBarInsets } from "@/hooks/useToolBarInsets";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { languageForFilePath } from "../preview/codeHighlight";
import { pickShikiLang } from "../preview/previewLang";
import { highlightLineHtml } from "../preview/shikiHighlighter";
import { markRangeInElement } from "@/lib/markRange";
import { previewWindow, splitGroupPath } from "./referencesPreview";
import {
  chipFor,
  derivePanelState,
  fallbackReasonText,
  headerActionFor,
  type FetchOutcome,
  type PanelState,
} from "./referencesPanelState";

// The cache key must include everything the windowed/highlighted HTML was
// computed from: the window width depends on the symbol length, and the
// map is never cleared between queries — without the symbol and preview
// text in the key, a re-query could reuse HTML windowed for a different
// symbol, or stale preview text for the same `line:char:eIdx`.
function previewKey(
  shikiThemeId: string,
  groupKey: string,
  entry: ReferenceEntry,
  eIdx: number,
  symbol: string | undefined,
): string {
  return `${shikiThemeId}:${groupKey}:${entry.line}-${entry.character}-${entry.endCharacter ?? ""}-${eIdx}:${symbol ?? ""}:${entry.preview ?? ""}`;
}

const MATCH_CLASS = "references-panel__match";

/** Attempts before a 409 LSP_NOT_READY stops auto-retrying — unless the
 *  status poll still says starting/indexing, in which case retrying goes on
 *  (bounded by RETRY_HARD_CAP) instead of "giving up" on a server that is
 *  visibly making progress. */
const RETRY_ATTEMPTS = 5;
const RETRY_HARD_CAP = 40;
const ROW_NOTICE_MS = 4_000;

function groupKeyOf(group: ReferenceGroup, gIdx: number): string {
  return group.path ?? group.token ?? group.displayPath ?? `group-${gIdx}`;
}

interface ReferencesPanelProps {
  api: unknown;
  worktreeId: string | null;
  scope?: FileScope;
}

export function ReferencesPanel({
  api,
  worktreeId,
  scope = "worktree",
}: ReferencesPanelProps) {
  const pendingQuery = useWorkspaceStore((s) => s.pendingReferencesQuery);
  const setPendingReferencesQuery = useWorkspaceStore(
    (s) => s.setPendingReferencesQuery
  );
  const pushJump = useWorkspaceStore((s) => s.pushJump);
  const revealTextSearch = useWorkspaceStore((s) => s.revealTextSearch);
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeDirectContextId = useWorkspaceStore((s) => s.activeDirectContextId);

  const layoutKey =
    worktreeId ?? activeWorktreeId ?? activeDirectContextId ?? "";

  // Stacked (vertical) orientation spans the full tools-pane width at top: 0,
  // so this panel's header reaches the top-right corner where the fullscreen +
  // orientation-toggle buttons float. In left-side orientation it is a narrow
  // left column that never reaches that corner, so the right inset only
  // applies while stacked.
  const masterDetailVertical = useWorkspaceStore(
    (s) => !!(s.layoutByWorktree[layoutKey] ?? DEFAULT_WORKTREE_LAYOUT).masterDetailVertical,
  );
  const barInsets = useToolBarInsets(masterDetailVertical);

  const [activeQuery, setActiveQuery] = useState<PendingReferencesQuery | null>(
    null
  );
  const [outcome, setOutcome] = useState<FetchOutcome>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [groups, setGroups] = useState<ReferenceGroup[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fallback, setFallback] = useState<LspFallbackReason | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>(
    {}
  );
  // S14: an external row without a token can't be opened — say so inline on
  // that row for a few seconds rather than with a panel-wide banner.
  const [rowNotice, setRowNotice] = useState<string | null>(null);
  const rowNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Preview line → highlighted HTML, keyed the same way each row already is
  // (`${groupKey}:${line}-${character}-${eIdx}`) so a reference's preview
  // reads with the same syntax colors the code viewer itself uses for that
  // file's language + the active theme, instead of flat plain text.
  const [highlightedPreviews, setHighlightedPreviews] = useState<Map<string, string>>(new Map());

  const lspStatus = useLspStatus(api, worktreeId, scope, activeQuery?.path);
  // The retry loop reads the LATEST polled status (not the one captured when
  // the fetch started) to decide whether to keep retrying.
  const lspStatusRef = useRef(lspStatus.status);
  lspStatusRef.current = lspStatus.status;
  const refreshStatusRef = useRef(lspStatus.refresh);
  refreshStatusRef.current = lspStatus.refresh;
  // Request-generation guard: starting a query (or a retry superseded by a
  // fresh one, or a Cancel) bumps the generation so a slow in-flight response
  // can never overwrite the current query's state.
  const reqGenRef = useRef(0);
  useEffect(
    () => () => {
      reqGenRef.current++;
      if (rowNoticeTimerRef.current) clearTimeout(rowNoticeTimerRef.current);
    },
    [],
  );

  const { theme, themeId } = useTheme();
  const shikiThemeId = themeById[themeId]?.shikiThemeId ?? (theme === "light" ? "light-plus" : "dark-plus");

  const fetchReferences = useCallback(
    async (
      query: PendingReferencesQuery,
      nextCursor: string | null = null,
      append = false
    ) => {
      if (!api || !query.worktreeId) return;
      const gen = ++reqGenRef.current;
      const stale = () => reqGenRef.current !== gen;
      if (append) {
        setLoadingMore(true);
      } else {
        setOutcome({ kind: "loading" });
        setGroups([]);
        setHasMore(false);
        setCursor(null);
        setFallback(null);
      }

      const fileRef: LspFileRef = query.external
        ? { kind: "external", token: query.external.token }
        : { kind: "workspace", path: query.path };

      try {
        let attempt = 0;
        for (;;) {
          try {
            const res = await getReferences(
              api,
              scope,
              query.worktreeId,
              fileRef,
              query.line,
              query.character,
              nextCursor
            );
            if (stale()) return;

            setHasMore(res.hasMore ?? false);
            setCursor(res.cursor ?? null);
            // A "Show more" page keeps the first page's reason unless it
            // adds one — the list is mostly first-page rows.
            if (append) {
              const pageReason = res.fallback?.reason ?? null;
              if (pageReason) setFallback((prev) => prev ?? pageReason);
            } else {
              setFallback(res.fallback?.reason ?? null);
            }
            if (append) {
              setGroups((prev) => {
                const merged = [...prev];
                for (const newGroup of res.references) {
                  const existingIdx = merged.findIndex(
                    (g) =>
                      (g.path && g.path === newGroup.path) ||
                      (g.token && g.token === newGroup.token) ||
                      (g.displayPath && g.displayPath === newGroup.displayPath)
                  );
                  if (existingIdx >= 0) {
                    merged[existingIdx] = {
                      ...merged[existingIdx]!,
                      entries: [
                        ...merged[existingIdx]!.entries,
                        ...newGroup.entries,
                      ],
                    };
                  } else {
                    merged.push(newGroup);
                  }
                }
                return merged;
              });
            } else {
              setGroups(res.references ?? []);
            }
            setOutcome({ kind: "done" });
            return;
          } catch (err: unknown) {
            if (stale()) return;
            // A failed "Show more" keeps the list on screen; the button
            // stays so the user can try again.
            if (append) return;
            if (isLspNotReady(err)) {
              attempt++;
              const progressing =
                lspStatusRef.current === "starting" || lspStatusRef.current === "indexing";
              const keepRetrying =
                attempt < RETRY_ATTEMPTS || (progressing && attempt < RETRY_HARD_CAP);
              setOutcome({ kind: "starting", attempt, retrying: keepRetrying });
              if (!keepRetrying) return;
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(2000, 500 * (2 ** (attempt - 1))))
              );
              if (stale()) return;
              continue;
            }
            // 503 LSP_SERVER_FAILED: the server is latched failed and no
            // text fallback was possible — S17, never "process died".
            const failure = lspFailureFromError(err);
            if (failure) {
              setOutcome({ kind: "server_failed", failure });
              return;
            }
            if (isLspDisabled(err)) {
              setOutcome({ kind: "disabled" });
              return;
            }
            if (isLspUnsupported(err)) {
              setOutcome({ kind: "unsupported" });
              return;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            if (
              (err instanceof ApiError && err.status === 404) ||
              errMsg.includes("NOT_FOUND")
            ) {
              // The daemon's 404s are NOT_FOUND (file or worktree missing) and
              // LSP_EXTERNAL_TOKEN_EXPIRED — a missing language-server binary
              // is reported through the polled `not_found` status, never a 404.
              setOutcome({
                kind: "error",
                message: errMsg.includes("LSP_EXTERNAL_TOKEN_EXPIRED")
                  ? "External token expired — reconnect the editor to refresh it"
                  : "File or workspace not found",
              });
              return;
            }
            setOutcome({ kind: "error", message: errMsg || "Failed to fetch references" });
            return;
          }
        }
      } finally {
        // Only the newest generation touches the shared flags — a superseded
        // fetch must not end its replacement's "Loading more…".
        if (!stale()) {
          setLoadingMore(false);
          // L11: the chip must reflect the server's state as of THIS result,
          // not the last 5s poll.
          void refreshStatusRef.current();
        }
      }
    },
    [api, scope]
  );

  // 5.8: effect keyed on pendingReferencesQuery changing (read-once)
  useEffect(() => {
    if (
      pendingQuery &&
      (!worktreeId || pendingQuery.worktreeId === worktreeId)
    ) {
      const q = { ...pendingQuery };
      setPendingReferencesQuery(null);
      setActiveQuery(q);
      if (q.intent === "no-definition") {
        // Nothing to fetch: references of a symbol the server couldn't
        // resolve are empty too, and would be reported as "no references".
        reqGenRef.current++;
        setGroups([]);
        setHasMore(false);
        setFallback(null);
        setLoadingMore(false);
        setOutcome({ kind: "idle" });
        void refreshStatusRef.current();
      } else {
        void fetchReferences(q, null, false);
      }
    }
  }, [pendingQuery, worktreeId, setPendingReferencesQuery, fetchReferences]);

  // Syntax-highlight each reference's preview line with the SAME Shiki
  // theme/language the code viewer uses — incremental: only tokenizes
  // entries not already cached for the CURRENT theme, so "Show more"
  // pagination doesn't redo work for rows already highlighted. `shikiThemeId`,
  // the symbol, and the preview text are baked into the cache key (via
  // `previewKey`) rather than clearing the map on theme switch or query
  // change — a separate "clear" effect would race this one (it'd still
  // filter against the pre-clear map from the same render pass, silently
  // dropping already-cached rows from the recompute); keying by theme
  // instead sidesteps that ordering hazard entirely. The window width
  // depends on the symbol length, so the symbol must be part of the key
  // or a re-query could reuse HTML windowed for a different symbol.
  //
  // Known trade-off: Shiki tokenizes the mid-line window slice, so a window
  // that starts inside a string or comment is highlighted as code.
  useEffect(() => {
    if (groups.length === 0) return;

    let cancelled = false;
    void (async () => {
      const toHighlight: { key: string; text: string; lang: string }[] = [];
      const symLen = activeQuery?.symbol ? activeQuery.symbol.length : 0;
      groups.forEach((group, gIdx) => {
        const groupKey = groupKeyOf(group, gIdx);
        const filePathForLang = group.path ?? group.displayPath ?? undefined;
        const language = filePathForLang ? languageForFilePath(filePathForLang) : undefined;
        const lang = language ? pickShikiLang(filePathForLang, language) : "plaintext";
        group.entries.forEach((entry, eIdx) => {
          const key = previewKey(shikiThemeId, groupKey, entry, eIdx, activeQuery?.symbol);
          if (!highlightedPreviews.has(key) && entry.preview) {
            const windowed = previewWindow(entry.preview, entry.character, entry.endCharacter, symLen).text;
            toHighlight.push({ key, text: windowed, lang });
          }
        });
      });
      if (toHighlight.length === 0) return;

      const results = await Promise.all(
        toHighlight.map(async ({ key, text, lang }) => {
          try {
            return [key, await highlightLineHtml(text, lang, shikiThemeId)] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;

      setHighlightedPreviews((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result) next.set(result[0], result[1]);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `highlightedPreviews` intentionally excluded: it's this effect's own output, including it would re-run on every write it makes
  }, [groups, shikiThemeId, activeQuery?.symbol]);

  const handleToggleCollapse = (key: string) => {
    setCollapsedPaths((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const showRowNotice = (rowKey: string) => {
    if (rowNoticeTimerRef.current) clearTimeout(rowNoticeTimerRef.current);
    setRowNotice(rowKey);
    rowNoticeTimerRef.current = setTimeout(() => setRowNotice(null), ROW_NOTICE_MS);
  };

  const handleRowClick = (
    group: ReferenceGroup,
    entry: ReferenceEntry,
    rowKey: string,
  ) => {
    // Column range of the reference itself (not the queried symbol's
    // length — a `Self`/alias reference spells something else).
    const column = entry.character;
    const endColumn = entry.endCharacter ?? null;
    if (group.external) {
      if (group.token) {
        pushJump({
          worktreeId: layoutKey,
          path: group.displayPath ?? "",
          line: entry.line + 1,
          matchText: null,
          column,
          endColumn,
          source: "references",
          external: {
            token: group.token,
            displayPath: group.displayPath ?? "external",
          },
        });
      } else {
        showRowNotice(rowKey);
      }
      return;
    }

    if (group.path) {
      pushJump({
        worktreeId: layoutKey,
        path: group.path,
        line: entry.line + 1,
        matchText: null,
        column,
        endColumn,
        source: "references",
      });
    }
  };

  const totalCount = groups.reduce((acc, g) => acc + g.entries.length, 0);
  const allText =
    totalCount > 0 && groups.every((g) => g.entries.every((e) => e.confidence === "text"));

  const panelState: PanelState = useMemo(
    () =>
      derivePanelState({
        query: activeQuery
          ? { symbol: activeQuery.symbol, intent: activeQuery.intent ?? "references" }
          : null,
        outcome,
        loadingMore,
        totalCount,
        hasMore,
        allText,
        fallback,
        lspStatus: lspStatus.status,
        degraded: lspStatus.degraded,
        // The polled failure, else the one go-to-definition handed over
        // (it arrives before the first poll does).
        failure: lspStatus.failure ?? activeQuery?.failure ?? null,
      }),
    [
      activeQuery,
      outcome,
      loadingMore,
      totalCount,
      hasMore,
      allText,
      fallback,
      lspStatus.status,
      lspStatus.degraded,
      lspStatus.failure,
    ],
  );
  const serverName = lspStatus.displayName ?? lspStatus.language ?? "Language server";
  const chip = chipFor(panelState, { serverName, lspStatus: lspStatus.status });
  const headerAction = headerActionFor(panelState);

  // Any explicit (re-)run is a references query — including "Find
  // references" from the no-definition state.
  const rerun = () => {
    if (!activeQuery) return;
    const q: PendingReferencesQuery = { ...activeQuery, intent: "references", failure: null };
    setActiveQuery(q);
    void fetchReferences(q);
  };
  const cancel = () => {
    // Bump the generation so the in-flight fetch/retry loop bails out
    // instead of overwriting state after the user cancelled.
    reqGenRef.current++;
    if (loadingMore) {
      setLoadingMore(false);
    } else {
      setOutcome({ kind: "cancelled" });
    }
  };
  // Enable (disabled) / Resume (stopped, idle) via the shared status-row
  // dispatch, then re-run the query against the now-available server.
  const runStatusAction = async () => {
    await lspStatus.onClick();
    rerun();
  };
  const statusActionLabel =
    lspStatus.status === "disabled" || lspStatus.action === "enable"
      ? "Enable"
      : lspStatus.action === "resume" || lspStatus.status === "stopped" || lspStatus.status === "idle"
        ? "Resume"
        : null;
  const chipClickable =
    !!statusActionLabel &&
    (panelState.kind === "disabled" ||
      (panelState.kind === "results" && panelState.textOnly) ||
      (panelState.kind === "no_results" && panelState.fallback != null));

  // Retry respawns the failed server (Refresh only re-runs the query), then
  // re-runs the query against it.
  const retryServer = async () => {
    await lspStatus.retry();
    rerun();
  };
  const remediationActions = (failure: LspFailure, compact = false) => (
    <LspRemediationActions
      failure={failure}
      onRetry={retryServer}
      buttonClassName={compact ? "references-panel__hint-btn" : "references-panel__btn"}
      primaryClassName={compact ? undefined : "references-panel__btn--primary"}
    />
  );
  const failureHint = (failure: LspFailure) => <span title={failure.summary}>{failure.summary}</span>;
  // Outside the hint's 3-line clamp, so a narrow panel never hides it.
  const failureCommand = (failure: LspFailure) => (
    <LspInstallCommand failure={failure} className="references-panel__code references-panel__command" />
  );

  const symbol = activeQuery?.symbol ?? "";
  const textSearch = () => {
    if (symbol && layoutKey) revealTextSearch(layoutKey, symbol);
  };

  const renderChip = () => {
    if (!chip) return null;
    const content = (
      <>
        {chip.spinner ? (
          <span className="references-panel__spinner references-panel__spinner--chip" aria-hidden="true" />
        ) : (
          <span className="references-panel__chip-dot" aria-hidden="true" />
        )}
        <span className="references-panel__chip-word">{chip.word}</span>
      </>
    );
    const className = `references-panel__chip references-panel__chip--${chip.tone}`;
    return chipClickable ? (
      <button
        type="button"
        className={`${className} references-panel__chip--action`}
        title={`${chip.tooltip} — click to ${statusActionLabel!.toLowerCase()}`}
        onClick={() => void runStatusAction()}
        data-testid="references-status-chip"
      >
        {content}
      </button>
    ) : (
      <span className={className} title={chip.tooltip} role="status" data-testid="references-status-chip">
        {content}
      </span>
    );
  };

  const renderStateBlock = (
    title: React.ReactNode,
    opts: {
      hint?: React.ReactNode;
      /** Between the hint and the actions, unclamped (e.g. an install command). */
      afterHint?: React.ReactNode;
      actions?: React.ReactNode;
      /** Below the actions, outside the hint's line clamp (e.g. a disclosure). */
      details?: React.ReactNode;
      tone?: "error" | "warn";
      spinner?: boolean;
    } = {},
  ) => (
    <div
      className={`references-panel__state${opts.tone ? ` references-panel__state--${opts.tone}` : ""}`}
      role={opts.tone === "error" ? "alert" : "status"}
    >
      <div className="references-panel__state-title">
        {opts.spinner && <span className="references-panel__spinner" aria-hidden="true" />}
        {/* One inline run, so the flex gap never splits "`sym`" from its "." */}
        <span>{title}</span>
      </div>
      {opts.hint && <div className="references-panel__state-hint">{opts.hint}</div>}
      {opts.afterHint}
      {opts.actions && <div className="references-panel__state-actions">{opts.actions}</div>}
      {opts.details}
    </div>
  );

  const code = (text: string) => <code className="references-panel__code">{text}</code>;

  const renderBody = () => {
    switch (panelState.kind) {
      case "empty":
        return renderStateBlock("No symbol selected", {
          hint: "Cmd+click a symbol, or use Find references from hover.",
        });
      case "searching":
        return (
          <div className="references-panel__skeleton" role="status" aria-label="Searching references">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="references-panel__skeleton-row" />
            ))}
          </div>
        );
      case "cancelled":
        return renderStateBlock("Search cancelled.");
      case "starting":
        return renderStateBlock(
          lspStatus.status === "indexing" ? "Language server indexing…" : "Language server starting…",
          {
            spinner: panelState.retrying,
            hint: panelState.retrying ? "Retrying automatically." : "Still not ready — refresh to try again.",
          },
        );
      case "disabled":
        return renderStateBlock("Code navigation is off.", {
          actions: (
            <button type="button" className="references-panel__btn references-panel__btn--primary" onClick={() => void runStatusAction()}>
              Enable
            </button>
          ),
        });
      case "not_found":
        return renderStateBlock(
          lspStatus.displayName || lspStatus.language
            ? `No ${lspStatus.displayName ?? lspStatus.language} language server on this host.`
            : "No language server on this host.",
          { hint: lspStatus.text ?? "Install a language server to enable code navigation." },
        );
      case "unsupported":
        return renderStateBlock("No code navigation for this file type.");
      case "error":
        return renderStateBlock("Language server error.", {
          tone: "error",
          hint: (
            <details className="references-panel__details">
              <summary>Details</summary>
              <pre>{panelState.message}</pre>
            </details>
          ),
        });
      case "server_failed": {
        const { failure } = panelState;
        const dependency = isDependencyFailure(failure);
        const title = lspStatus.displayName
          ? `${lspStatus.displayName} code navigation is unavailable.`
          : "Code navigation is unavailable.";
        return renderStateBlock(title, {
          tone: dependency ? "warn" : "error",
          hint: failureHint(failure),
          afterHint: failureCommand(failure),
          actions: failure.remediation.length > 0 ? remediationActions(failure) : undefined,
          details: <LspServerOutput failure={failure} className="references-panel__details" />,
        });
      }
      case "no_results":
        if (panelState.failure) {
          const { failure } = panelState;
          return renderStateBlock(<>No text matches for {code(symbol)}.</>, {
            hint: failureHint(failure),
            afterHint: failureCommand(failure),
            actions: failure.remediation.length > 0 ? remediationActions(failure) : undefined,
          });
        }
        return panelState.fallback
          ? renderStateBlock(<>No text matches for {code(symbol)}.</>, {
              hint: fallbackReasonText(panelState.fallback),
            })
          : renderStateBlock(<>No references to {code(symbol)}.</>);
      case "no_definition":
        return renderStateBlock(<>Couldn&rsquo;t resolve {code(symbol)}.</>, {
          tone: panelState.degraded ? "warn" : undefined,
          hint: panelState.degraded ? (
            <span title={panelState.degraded}>
              {serverName} reports a problem — dependencies may not be indexed: {panelState.degraded}
            </span>
          ) : (
            `${serverName} found no definition for this symbol.`
          ),
          actions: (
            <>
              <button type="button" className="references-panel__btn references-panel__btn--primary" onClick={textSearch}>
                Text search
              </button>
              <button type="button" className="references-panel__btn" onClick={rerun}>
                Find references
              </button>
            </>
          ),
        });
      case "results":
        return null;
    }
  };

  const resultsHint = (() => {
    if (panelState.kind !== "results") return null;
    if (panelState.textOnly && panelState.failure) {
      const { failure } = panelState;
      return (
        <div
          className="references-panel__hint references-panel__hint--warn references-panel__hint--failure"
          role="status"
          title={failure.summary}
        >
          <span className="references-panel__hint-text">Text matches only — {failureHeadline(failure)}.</span>
          {remediationActions(failure, true)}
        </div>
      );
    }
    if (panelState.textOnly) {
      return (
        <div className="references-panel__hint references-panel__hint--warn" role="status">
          <span className="references-panel__hint-text">
            Text matches · {fallbackReasonText(panelState.fallback, lspStatus.status)}
          </span>
          {statusActionLabel && (
            <button type="button" className="references-panel__hint-btn" onClick={() => void runStatusAction()}>
              {statusActionLabel}
            </button>
          )}
        </div>
      );
    }
    if (panelState.degraded) {
      return (
        <div className="references-panel__hint references-panel__hint--warn" role="status" title={panelState.degraded}>
          <span className="references-panel__hint-text">Results may be incomplete</span>
        </div>
      );
    }
    return null;
  })();

  return (
    <div
      className="references-panel"
      tabIndex={0}
      role="region"
      aria-label="References panel"
    >
      <div
        className="references-panel__header"
        style={{
          ...barInsets,
        }}
      >
        <Search size={12} className="references-panel__header-icon" aria-hidden />
        {activeQuery ? (
          <span className="references-panel__title" title={symbol}>
            {symbol}
          </span>
        ) : (
          <span className="references-panel__title references-panel__title--muted">References</span>
        )}
        {panelState.kind === "results" && (
          <span className="references-panel__count-pill" title={`${panelState.count} references`}>
            {panelState.count}
            {panelState.hasMore ? "+" : ""}
          </span>
        )}
        {panelState.kind === "no_results" && (
          <span className="references-panel__count-pill" title="0 references">0</span>
        )}
        {renderChip()}
        {headerAction === "cancel" && (
          <button
            type="button"
            className="references-panel__icon-btn"
            aria-label="Cancel"
            title="Cancel"
            onClick={cancel}
          >
            <X size={13} />
          </button>
        )}
        {headerAction === "refresh" && (
          <button
            type="button"
            className="references-panel__icon-btn"
            aria-label="Refresh"
            title="Run again"
            onClick={rerun}
          >
            <RotateCw size={12} />
          </button>
        )}
      </div>

      {renderBody()}
      {resultsHint}

      {panelState.kind === "results" && (
        <div className="references-panel__list" role="tree">
          {groups.map((group, gIdx) => {
            const groupKey = groupKeyOf(group, gIdx);
            const isCollapsed = !!collapsedPaths[groupKey];
            const displayName =
              group.path ?? group.displayPath ?? "unknown file";
            const { name: fileName, dir: fileDir } = splitGroupPath(displayName, group.external);

            return (
              <div key={groupKey} className="references-panel__group">
                <div
                  className="references-panel__file-header"
                  onClick={() => handleToggleCollapse(groupKey)}
                  role="treeitem"
                  aria-expanded={!isCollapsed}
                >
                  <span className="references-panel__file-toggle">
                    {isCollapsed ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </span>
                  <span
                    className="references-panel__file-path"
                    title={displayName}
                  >
                    <span className="references-panel__file-name">{fileName}</span>
                    {fileDir && (
                      <span className="references-panel__file-dir">
                        {/* <bdi> isolates the path's own LTR order from the
                            RTL left-truncation trick, so "/" and "~" stay put. */}
                        <bdi>{fileDir}</bdi>
                      </span>
                    )}
                  </span>
                  {group.external && (
                    <span
                      className="references-panel__external-badge"
                      title="outside workspace"
                    >
                      <ExternalLink size={11} /> external
                    </span>
                  )}
                  <span className="references-panel__count">
                    {group.entries.length}
                  </span>
                </div>

                {!isCollapsed && (
                  <div className="references-panel__entries" role="group">
                    {group.entries.map((entry, eIdx) => {
                      const rowKey = `${groupKey}:${entry.line}-${entry.character}-${eIdx}`;
                      const highlightedHtml = highlightedPreviews.get(
                        previewKey(shikiThemeId, groupKey, entry, eIdx, activeQuery?.symbol)
                      );
                      // The match is the range at [character, endCharacter)
                      // of the RAW line, located positionally — never by
                      // searching for the symbol text.
                      const win = previewWindow(
                        entry.preview,
                        entry.character,
                        entry.endCharacter,
                        activeQuery?.symbol ? activeQuery.symbol.length : 0,
                      );
                      return (
                      <div
                        key={`${entry.line}-${entry.character}-${eIdx}`}
                        className="references-panel__row"
                        role="treeitem"
                        onClick={() => handleRowClick(group, entry, rowKey)}
                      >
                        <span className="references-panel__line-num">
                          {entry.line + 1}
                        </span>
                        {highlightedHtml ? (
                          <span
                            className="references-panel__preview"
                            ref={(el) => {
                              // Safe only because the children are a single
                              // text string (React sets textContent) or
                              // dangerouslySetInnerHTML — never a mix of
                              // element children React owns.
                              if (el) markRangeInElement(el, win.matchStart, win.matchLength, MATCH_CLASS);
                            }}
                            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                          />
                        ) : (
                          <span
                            className="references-panel__preview"
                            ref={(el) => {
                              // See the dangerouslySetInnerHTML branch above.
                              if (el) markRangeInElement(el, win.matchStart, win.matchLength, MATCH_CLASS);
                            }}
                          >
                            {win.text}
                          </span>
                        )}
                        {rowNotice === rowKey && (
                          <span className="references-panel__row-notice" role="alert">
                            Outside workspace — can&rsquo;t open
                          </span>
                        )}
                        {entry.isDeclaration && (
                          <span
                            className="references-panel__def-badge"
                            title="Declaration"
                          >
                            def
                          </span>
                        )}
                        {/* Per-row badge only distinguishes a MIXED list —
                            when every row is a text hit the hint row and
                            chip already say so. */}
                        {entry.confidence === "text" && !allText && (
                          <span
                            className="references-panel__text-badge"
                            title="Text match (not confirmed by the language server)"
                          >
                            text
                          </span>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {panelState.loadingMore ? (
            <div className="references-panel__more" role="status">
              <span className="references-panel__spinner" aria-hidden="true" />
              <span className="references-panel__more-text">Loading more…</span>
            </div>
          ) : panelState.hasMore ? (
            <div className="references-panel__more">
              <button
                type="button"
                className="references-panel__more-btn"
                onClick={() => {
                  if (activeQuery) {
                    void fetchReferences(activeQuery, cursor, true);
                  }
                }}
              >
                Show more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
