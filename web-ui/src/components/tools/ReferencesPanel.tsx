import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type { FileScope } from "@/api/types";
import {
  getReferences,
  type ReferenceEntry,
  type ReferenceGroup,
  type LspFileRef,
} from "@/lib/lspApi";
import {
  useWorkspaceStore,
  type PendingReferencesQuery,
} from "@/hooks/useStore";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { languageForFilePath } from "../preview/codeHighlight";
import { pickShikiLang } from "../preview/previewLang";
import { highlightLineHtml } from "../preview/shikiHighlighter";

function previewKey(shikiThemeId: string, groupKey: string, entry: ReferenceEntry, eIdx: number): string {
  return `${shikiThemeId}:${groupKey}:${entry.line}-${entry.character}-${eIdx}`;
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
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeDirectContextId = useWorkspaceStore((s) => s.activeDirectContextId);

  const layoutKey =
    worktreeId ?? activeWorktreeId ?? activeDirectContextId ?? "";

  const [activeQuery, setActiveQuery] = useState<PendingReferencesQuery | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ReferenceGroup[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>(
    {}
  );
  const [externalError, setExternalError] = useState<string | null>(null);
  // Preview line → highlighted HTML, keyed the same way each row already is
  // (`${groupKey}:${line}-${character}-${eIdx}`) so a reference's preview
  // reads with the same syntax colors the code viewer itself uses for that
  // file's language + the active theme, instead of flat plain text.
  const [highlightedPreviews, setHighlightedPreviews] = useState<Map<string, string>>(new Map());

  const { theme, themeId } = useTheme();
  const shikiThemeId = themeById[themeId]?.shikiThemeId ?? (theme === "light" ? "light-plus" : "dark-plus");

  const fetchReferences = useCallback(
    async (
      query: PendingReferencesQuery,
      nextCursor: string | null = null,
      append = false
    ) => {
      if (!api || !query.worktreeId) return;
      setLoading(true);
      setExternalError(null);

      const fileRef: LspFileRef = query.external
        ? { kind: "external", token: query.external.token }
        : { kind: "workspace", path: query.path };

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

        setHasMore(res.hasMore ?? false);
        setCursor(res.cursor ?? null);

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
      } catch (err: unknown) {
        console.error("Failed to fetch references", err);
      } finally {
        setLoading(false);
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
      void fetchReferences(q, null, false);
    }
  }, [pendingQuery, worktreeId, setPendingReferencesQuery, fetchReferences]);

  // Syntax-highlight each reference's preview line with the SAME Shiki
  // theme/language the code viewer uses — incremental: only tokenizes
  // entries not already cached for the CURRENT theme, so "Show more"
  // pagination doesn't redo work for rows already highlighted. `shikiThemeId`
  // is baked into the cache key (via `previewKey`) rather than clearing the
  // map on theme switch — a separate "clear" effect would race this one
  // (it'd still filter against the pre-clear map from the same render pass,
  // silently dropping already-cached rows from the recompute); keying by
  // theme instead sidesteps that ordering hazard entirely.
  useEffect(() => {
    if (groups.length === 0) return;

    let cancelled = false;
    void (async () => {
      const toHighlight: { key: string; text: string; lang: string }[] = [];
      groups.forEach((group, gIdx) => {
        const groupKey = group.path ?? group.token ?? group.displayPath ?? `group-${gIdx}`;
        const filePathForLang = group.path ?? group.displayPath ?? undefined;
        const language = filePathForLang ? languageForFilePath(filePathForLang) : undefined;
        const lang = language ? pickShikiLang(filePathForLang, language) : "plaintext";
        group.entries.forEach((entry, eIdx) => {
          const key = previewKey(shikiThemeId, groupKey, entry, eIdx);
          if (!highlightedPreviews.has(key) && entry.preview) {
            toHighlight.push({ key, text: entry.preview, lang });
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
  }, [groups, shikiThemeId]);

  const handleToggleCollapse = (key: string) => {
    setCollapsedPaths((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleRowClick = (
    group: ReferenceGroup,
    entry: { line: number; character: number }
  ) => {
    if (group.external) {
      if (group.token) {
        pushJump({
          worktreeId: layoutKey,
          path: group.displayPath ?? "",
          line: entry.line + 1,
          matchText: null,
          source: "references",
          external: {
            token: group.token,
            displayPath: group.displayPath ?? "external",
          },
        });
      } else {
        setExternalError(
          "Definition is outside this workspace — external file viewing not yet available"
        );
      }
      return;
    }

    if (group.path) {
      pushJump({
        worktreeId: layoutKey,
        path: group.path,
        line: entry.line + 1,
        matchText: null,
        source: "references",
      });
    }
  };

  const totalCount = groups.reduce((acc, g) => acc + g.entries.length, 0);

  return (
    <div
      className="references-panel"
      tabIndex={0}
      role="region"
      aria-label="References panel"
    >
      <div className="references-panel__header">
        {loading && groups.length === 0 ? (
          <div className="references-panel__title">LSP: indexing…</div>
        ) : activeQuery ? (
          totalCount === 0 && !loading ? (
            <div className="references-panel__title">
              No references found for `{activeQuery.symbol}`
            </div>
          ) : (
            <div className="references-panel__title-bar">
              <span className="references-panel__title">
                References: {activeQuery.symbol} ({totalCount})
              </span>
              <span className="references-panel__status">
                {loading ? "LSP: indexing…" : "LSP: ready"}
              </span>
            </div>
          )
        ) : (
          <div className="references-panel__title">No symbol selected</div>
        )}
      </div>

      {externalError && (
        <div className="references-panel__notice" role="alert">
          {externalError}
        </div>
      )}

      {groups.length > 0 && (
        <div className="references-panel__list" role="tree">
          {groups.map((group, gIdx) => {
            const groupKey =
              group.path ??
              group.token ??
              group.displayPath ??
              `group-${gIdx}`;
            const isCollapsed = !!collapsedPaths[groupKey];
            const displayName =
              group.path ?? group.displayPath ?? "unknown file";

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
                    {displayName}
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
                    ({group.entries.length})
                  </span>
                </div>

                {!isCollapsed && (
                  <div className="references-panel__entries" role="group">
                    {group.entries.map((entry, eIdx) => {
                      const highlightedHtml = highlightedPreviews.get(
                        previewKey(shikiThemeId, groupKey, entry, eIdx)
                      );
                      return (
                      <div
                        key={`${entry.line}-${entry.character}-${eIdx}`}
                        className="references-panel__row"
                        role="treeitem"
                        onClick={() => handleRowClick(group, entry)}
                      >
                        <span className="references-panel__line-num">
                          {entry.line + 1}
                        </span>
                        {highlightedHtml ? (
                          <span
                            className="references-panel__preview"
                            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                          />
                        ) : (
                          <span className="references-panel__preview">
                            {entry.preview}
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
                        {entry.confidence === "text" && (
                          <span
                            className="references-panel__text-badge"
                            title="Text match (LSP not available)"
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

          {hasMore && (
            <div className="references-panel__more">
              <button
                type="button"
                className="references-panel__more-btn"
                disabled={loading}
                onClick={() => {
                  if (activeQuery) {
                    void fetchReferences(activeQuery, cursor, true);
                  }
                }}
              >
                {loading ? "Loading more…" : "Show more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
