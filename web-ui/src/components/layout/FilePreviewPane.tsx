import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ApiInstance } from "@/api";
import type { DiffScope, FileScope } from "@/api/types";
import { ApiError } from "@/api/errors";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";
import { useTheme } from "@/hooks/useTheme";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useFileWatch, useTreeWatch } from "@/hooks/useSubscription";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { MermaidView } from "@/components/preview/MermaidView";
import { CodeView } from "@/components/preview/CodeView";
import { DiffView } from "@/components/preview/DiffView";
import { languageForFilePath } from "@/components/preview/codeHighlight";
import { parseUnifiedDiff, summarizeDiffLines, syntheticUntrackedHunks } from "@/preview/diffParser";

/** Decision 6 — bypasses the global store's `activeFilePath`/`diffScopeByWorktree`
 *  slices so a caller outside the Files tab (the VCS commit view) doesn't steal
 *  focus from / clobber whatever the Files tab has open. */
export interface FilePreviewControlled {
  path: string | null;
  scope: DiffScope;
  /** Required when `scope === "commit"` — the commit sha to diff against its parent. */
  commitSha?: string;
}

interface FilePreviewPaneProps {
  api: ApiInstance;
  /** Context id: worktree id (scope="worktree") or project id (scope="project"). */
  worktreeId: string | null;
  scope?: FileScope;
  /** When set, `path`/`scope` come from here instead of the global store
   *  (Decision 6) — used by `VcsCommitView`. */
  controlled?: FilePreviewControlled;
}

export function FilePreviewPane({ api, worktreeId, scope: fileScope = "worktree", controlled }: FilePreviewPaneProps) {
  const storePath = useWorkspaceStore((s) => s.activeFilePath);
  const scopeFromStore = useWorkspaceStore((s) =>
    worktreeId ? s.diffScopeByWorktree[worktreeId] : undefined,
  );
  const path = controlled ? controlled.path : storePath;
  // Project scope (direct sessions) has no git/diff — always plain file view.
  const scope: DiffScope = controlled
    ? controlled.scope
    : fileScope === "project"
      ? "none"
      : (scopeFromStore ?? "none");
  const commitSha = controlled?.commitSha;
  const previewFontScale = useWorkspaceStore((s) => s.previewFontScale);

  const { theme } = useTheme();
  const themeMode = theme;

  const [fileBody, setFileBody] = useState<string | null>(null);
  const { lastChanged } = useFileWatch(api, worktreeId, path, fileScope);
  // Cheap insurance for directory-level rename-replace events (Phase 1's
  // watchFile() watches the parent dir): a tree-level change to this
  // worktree also nudges the fetch effect, even if the per-file watcher
  // missed the exact rename. Additive only — does not change either hook's
  // contract (Phase 7, Requirement 5).
  const { lastChanged: treeLastChanged } = useTreeWatch(api, worktreeId, fileScope);

  const [diffBody, setDiffBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    if (!worktreeId || !path) {
      setFileBody(null);
      setDiffBody(null);
      setError(null);
      setTooLarge(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setTooLarge(false);
    void (async () => {
      try {
        if (scope === "none") {
          // Decision 4: plain preview also fetches the local diff (best-effort
          // — an untracked/non-git file must not block the plain preview) so
          // it can show the same diff-stat + scope toggle diff mode has.
          // Project scope has no notion of a git diff against a worktree
          // (`worktreeId` here is actually a *project* id in that case) — a
          // diff fetch there is a guaranteed 404, so skip it entirely rather
          // than firing a call that can only fail.
          const [text, d] = await Promise.all([
            api.getFile(worktreeId, path, fileScope),
            fileScope === "project" ? Promise.resolve(null) : api.getDiff(worktreeId, path, "local").catch(() => null),
          ]);
          if (!cancelled) {
            setFileBody(text);
            setDiffBody(d);
          }
        } else if (scope === "local") {
          const [text, d] = await Promise.all([
            api.getFile(worktreeId, path),
            api.getDiff(worktreeId, path, "local"),
          ]);
          if (!cancelled) {
            setFileBody(text);
            setDiffBody(d);
          }
        } else if (scope === "branch") {
          // Decision 7: `git diff <baseSha> -- <path>` already diffs the base
          // SHA against the working tree, i.e. the same content `getFile`
          // serves from disk — so branch scope can fetch file content
          // unconditionally, exactly like local scope, no new endpoint.
          const [text, d] = await Promise.all([
            api.getFile(worktreeId, path),
            api.getDiff(worktreeId, path, "branch"),
          ]);
          if (!cancelled) {
            setFileBody(text);
            setDiffBody(d);
          }
        } else {
          // scope === "commit" — a single commit's diff against its parent
          // (or the empty tree for a root commit). No plain file content:
          // the commit view is diff-only, same as branch scope used to be.
          const d = await api.getDiff(worktreeId, path, "commit", commitSha);
          if (!cancelled) {
            setFileBody(null);
            setDiffBody(d);
          }
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          if (!cancelled) {
            setTooLarge(true);
            setFileBody(null);
            setDiffBody(null);
          }
        } else if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, worktreeId, path, scope, fileScope, lastChanged, treeLastChanged, commitSha]);

  // ── Scroll persistence ────────────────────────────────────────────────
  // Why a callback ref instead of useEffect: fullscreen toggling moves the
  // pane between two parents in the layout tree (Panel ↔ fullscreenOverlay),
  // which remounts FilePreviewPane. We need to restore the scrollTop the
  // moment the new body element attaches, before the user perceives a jump.
  // Effect-based restore relied on RAF + content load timing and was racy.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = worktreeId && path ? `${worktreeId}:${path}` : null;

  // Restore scroll the instant the body element mounts. Stored value comes
  // from the global store, kept fresh by the rAF-throttled onScroll handler.
  const setBodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el;
      if (el && scrollKey) {
        const saved = useWorkspaceStore.getState().fileScrollByKey[scrollKey];
        if (saved != null) el.scrollTop = saved;
      }
    },
    [scrollKey],
  );

  // rAF-throttle persistence so a fast scroll doesn't fire setFileScroll
  // (and the persist middleware's localStorage write) hundreds of times.
  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (worktreeId && path && bodyRef.current) {
        useWorkspaceStore
          .getState()
          .setFileScroll(worktreeId, path, bodyRef.current.scrollTop);
      }
    });
  }, [worktreeId, path]);

  useEffect(
    () => () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    },
    [],
  );

  // Re-apply scroll when content loads on the same body node (switching files
  // doesn't remount the div; only the children change). Without this, the
  // pre-content-load scrollTop assignment in setBodyRef gets clamped against
  // the OLD content's scrollHeight.
  useEffect(() => {
    if (!bodyRef.current || !scrollKey) return;
    const saved = useWorkspaceStore.getState().fileScrollByKey[scrollKey];
    if (saved != null) bodyRef.current.scrollTop = saved;
  }, [fileBody, diffBody, scrollKey]);
  // ─────────────────────────────────────────────────────────────────────

  const diffStats = useMemo(() => {
    // Decision 4 (9.4): plain mode (`"none"`) also computes a diff-stat from
    // the same local-diff fetch diff/branch mode already use. `DiffScope` is
    // `"local" | "branch" | "none" | "commit"` — every value is handled here,
    // so there is no scope left to early-return `null` for.
    const diffText = diffBody ?? "";
    const trimmed = diffText.trim();
    const hunks =
      trimmed.length > 0
        ? parseUnifiedDiff(diffText)
        : fileBody
          ? syntheticUntrackedHunks(fileBody)
          : [];
    if (hunks.length === 0) return null;
    return summarizeDiffLines(hunks);
  }, [scope, diffBody, fileBody]);

  // No worktree context (e.g. nothing selected yet). The dashboard has its own
  // route now, so this is a plain empty state — never dashboard/kanban content.
  if (!worktreeId) {
    return (
      <div className="pane pane-stack">
        <div className="empty-state">No worktree selected</div>
      </div>
    );
  }

  const previewScaleStyle: CSSProperties = {
    fontSize: `calc(var(--font-size-base) * ${previewFontScale})`,
  };

  if (!path) {
    return (
      <div className="pane pane-stack">
        <div className="empty-state">Select a file from the tree</div>
      </div>
    );
  }

  // Slim, content-scoped strip — line counts + which baseline. The
  // local/branch scope toggle itself lives only in the Files header
  // (`FileTreeSidebar`) now — one control, not one per surface — and both
  // panes read the same `diffScopeByWorktree` store slice, so a change made
  // there is reflected here automatically without this pane owning any UI
  // for it. File name + panel controls live on the Files bar above.
  const diffInfo = (
    <div className="preview-diffinfo">
      {diffStats ? (
        <span className="preview-diffinfo__stats" aria-label="Diff line counts">
          <span className="preview-diffinfo__stats-plus">+{diffStats.additions}</span>{" "}
          <span className="preview-diffinfo__stats-minus">−{diffStats.deletions}</span>
        </span>
      ) : null}
      <span className="preview-diffinfo__scope">
        {scope === "branch"
          ? "Compared to fork base"
          : scope === "commit"
            ? "Commit diff"
            : "Compared to HEAD"}
      </span>
    </div>
  );

  if (tooLarge) {
    return (
      <div className="pane pane-stack">
        {diffInfo}
        <div className="empty-state">File too large to preview</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pane pane-stack">
        {diffInfo}
        <div className="empty-state">{error}</div>
      </div>
    );
  }

  const isMd = path.endsWith(".md");

  const body = (() => {
    if (scope === "local" || scope === "branch" || scope === "commit") {
      const diffText = diffBody ?? "";
      const fallback = fileBody ?? undefined;
      return (
        <DiffView
          diffText={diffText}
          fileContentFallback={fallback}
          filePath={path}
          themeMode={themeMode}
          api={api}
          worktreeId={worktreeId}
          scope={fileScope}
        />
      );
    }
    if (!fileBody) {
      return <div className="empty-state">Loading…</div>;
    }
    if (isMd) {
      const segments = segmentMarkdownWithMermaid(fileBody);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {segments.map((seg, i) =>
            seg.type === "markdown" ? (
              <MarkdownView key={i} source={seg.content} api={api} worktreeId={worktreeId} scope={fileScope} filePath={path} />
            ) : (
              <MermaidView key={i} chart={seg.content} theme={themeMode} />
            ),
          )}
        </div>
      );
    }
    return <CodeView code={fileBody} language={languageForFilePath(path)} filePath={path} themeMode={themeMode} />;
  })();

  const useCodeChrome = scope === "local" || scope === "branch" || scope === "commit" || (!isMd && scope === "none");

  return (
    <div className="pane pane-stack">
      {diffInfo}
      <div
        ref={setBodyRef}
        onScroll={handleScroll}
        className={`preview-body${useCodeChrome ? " preview-body--code" : ""}`}
        style={previewScaleStyle}
      >
        {body}
      </div>
    </div>
  );
}
