import { Minus, Plus } from "lucide-react";
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
import { ZoomableMedia } from "@/components/preview/ZoomableMedia";
import { ImageZoomOverlay } from "@/components/preview/ImageZoomOverlay";
import { DiffView } from "@/components/preview/DiffView";
import { isImagePath } from "@/lib/imageFile";
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
  const pendingFileLine = useWorkspaceStore((s) => s.pendingFileLine);
  const clearPendingFileLine = useWorkspaceStore((s) => s.clearPendingFileLine);
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
  const previewFontScaleGlobal = useWorkspaceStore((s) => s.previewFontScale);
  const previewFontScaleByWorktree = useWorkspaceStore((s) => s.previewFontScaleByWorktree);
  const previewFontScale = (worktreeId ? previewFontScaleByWorktree[worktreeId] : undefined) ?? previewFontScaleGlobal;
  const bumpPreviewFontForWorktree = useWorkspaceStore((s) => s.bumpPreviewFontForWorktree);
  const bumpPreviewFont = useWorkspaceStore((s) => s.bumpPreviewFont);

  const { theme } = useTheme();
  const themeMode = theme;

  // Identity of the content this pane is currently asked to show. Fetched
  // bodies are stored together with the key they were fetched for and only
  // rendered while that key still matches — so the previous file's markdown
  // is never rendered under the new `path` while the new fetch is in flight.
  // (That mismatch made `MarkdownView` resolve the old file's relative image
  // srcs against the new file's directory: blob URLs were revoked and
  // refetched from paths that don't exist, so images blinked out or 404'd.)
  // A watcher-triggered refetch keeps the same key, so the old body stays on
  // screen until the fresh one lands — no "Loading…" flash on every save.
  const bodyKey =
    worktreeId && path ? `${fileScope}\0${worktreeId}\0${path}\0${scope}\0${commitSha ?? ""}` : null;
  const [loaded, setLoaded] = useState<{ key: string; fileBody: string | null; diffBody: string | null } | null>(null);
  // Cache the last 10 file bodies so switching back to a tab shows content
  // immediately without a loading flash. Without this, bodyKey mismatches
  // loaded.key while the refetch is in flight, fileBody becomes null, the
  // body div shows "Loading…" (tiny scrollHeight), and any scrollTop restore
  // gets clamped to 0 before the real content arrives.
  const contentCacheRef = useRef<Map<string, { fileBody: string | null; diffBody: string | null }>>(new Map());
  const cached = bodyKey ? contentCacheRef.current.get(bodyKey) : undefined;
  const fileBody = loaded?.key === bodyKey ? loaded.fileBody : (cached?.fileBody ?? null);
  const diffBody = loaded?.key === bodyKey ? loaded.diffBody : (cached?.diffBody ?? null);
  // Blob URL for binary image files — fetched separately since images aren't
  // text; rendered via ZoomableMedia instead of CodeView. Stored together with
  // the key it was fetched for (mirrors `bodyKey` above) so a watcher-triggered
  // refetch keeps the current blob on screen until the fresh one lands.
  const imageKey =
    worktreeId && path && isImagePath(path) ? `${fileScope}\0${worktreeId}\0${path}` : null;
  const [imageBlob, setImageBlob] = useState<{ key: string; url: string } | null>(null);
  const imageBlobUrl = imageBlob && imageBlob.key === imageKey ? imageBlob.url : null;
  const [imageFullscreen, setImageFullscreen] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(false);
  const [gutterMarks, setGutterMarks] = useState<Map<number, "added" | "modified" | "deleted"> | null>(null);
  const { lastChanged } = useFileWatch(api, worktreeId, path, fileScope);
  // Cheap insurance for directory-level rename-replace events (Phase 1's
  // watchFile() watches the parent dir): a tree-level change to this
  // worktree also nudges the fetch effect, even if the per-file watcher
  // missed the exact rename. Additive only — does not change either hook's
  // contract (Phase 7, Requirement 5).
  const { lastChanged: treeLastChanged } = useTreeWatch(api, worktreeId, fileScope);

  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    if (!bodyKey || !worktreeId || !path || isImagePath(path)) {
      setLoaded(null);
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
          if (!cancelled) setLoaded({ key: bodyKey, fileBody: text, diffBody: d });
        } else if (scope === "local") {
          const [text, d] = await Promise.all([
            api.getFile(worktreeId, path),
            api.getDiff(worktreeId, path, "local"),
          ]);
          if (!cancelled) setLoaded({ key: bodyKey, fileBody: text, diffBody: d });
        } else if (scope === "branch") {
          // Decision 7: `git diff <baseSha> -- <path>` already diffs the base
          // SHA against the working tree, i.e. the same content `getFile`
          // serves from disk — so branch scope can fetch file content
          // unconditionally, exactly like local scope, no new endpoint.
          const [text, d] = await Promise.all([
            api.getFile(worktreeId, path),
            api.getDiff(worktreeId, path, "branch"),
          ]);
          if (!cancelled) setLoaded({ key: bodyKey, fileBody: text, diffBody: d });
        } else {
          // scope === "commit" — a single commit's diff against its parent
          // (or the empty tree for a root commit). No plain file content:
          // the commit view is diff-only, same as branch scope used to be.
          const d = await api.getDiff(worktreeId, path, "commit", commitSha);
          if (!cancelled) setLoaded({ key: bodyKey, fileBody: null, diffBody: d });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          if (!cancelled) {
            setTooLarge(true);
            setLoaded(null);
          }
        } else if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, bodyKey, worktreeId, path, scope, fileScope, lastChanged, treeLastChanged, commitSha]);

  // Populate the content cache whenever a fresh load completes.
  useEffect(() => {
    if (!loaded || !bodyKey || loaded.key !== bodyKey) return;
    const cache = contentCacheRef.current;
    // Delete before re-inserting so Map insertion order stays LRU (most-recently
    // used at the end) rather than always FIFO from first-seen.
    cache.delete(bodyKey);
    cache.set(bodyKey, { fileBody: loaded.fileBody, diffBody: loaded.diffBody });
    if (cache.size > 10) {
      const oldest = cache.keys().next().value;
      if (oldest != null) cache.delete(oldest);
    }
  }, [loaded, bodyKey]);

  // Binary image files: fetch as a blob (not text) for ZoomableMedia. Gated on
  // the path being an image + a context id existing. The blob is keyed by
  // (fileScope, worktreeId, path); a watcher-triggered refetch keeps the same
  // key, so the current blob stays on screen and any open fullscreen overlay
  // stays open until the fresh blob lands (mirrors `bodyKey` for text).
  const imageKeyRef = useRef<string | null>(imageKey);
  useEffect(() => {
    if (imageKeyRef.current === imageKey) return;
    // Only when the image identity changes (switching files) do we revoke the
    // old blob and close any open fullscreen overlay.
    setImageFullscreen(false);
    setImageBlob((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    imageKeyRef.current = imageKey;
  }, [imageKey]);

  useEffect(() => {
    if (!worktreeId || !path || !imageKey) return;
    let cancelled = false;
    api
      .getFileBlob(worktreeId, path, fileScope)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setImageBlob((prev) => {
          if (prev && prev.key === imageKey) URL.revokeObjectURL(prev.url);
          return { key: imageKey, url };
        });
      })
      .catch(() => { /* image not found — render the loading/empty state */ });
    return () => {
      cancelled = true;
    };
  }, [api, worktreeId, path, fileScope, imageKey, lastChanged, treeLastChanged]);

  // Fetch gutter marks (git add/modify/delete annotations) when viewing a plain
  // file in working-tree scope. Only scope="none" supports gutter marks; other
  // scopes show a diff view which already has its own add/remove line coloring.
  useEffect(() => {
    if (!worktreeId || !path || scope !== "none") {
      setGutterMarks(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getGutter(worktreeId, path, undefined, fileScope);
        if (cancelled) return;
        const marks = new Map<number, "added" | "modified" | "deleted">();
        // Added lines: directly map each line number
        for (const lineNum of result.added) {
          marks.set(lineNum, "added");
        }
        // Modified lines: directly map each line number
        for (const lineNum of result.modified) {
          marks.set(lineNum, "modified");
        }
        // Deleted lines: map each line number to the "deleted" wedge. `0` is
        // the backend's sentinel for "deletion occurred before line 1" (see
        // Decision 3) — CodeView only ever renders lines 1..N, so a bare `0`
        // would never match any line and the marker would silently vanish.
        // Fold it onto line 1 so the indicator still renders (not pixel-
        // perfect against "top edge of line 1", but never dropped).
        for (const lineNum of result.deleted) {
          marks.set(lineNum === 0 ? 1 : lineNum, "deleted");
        }
        setGutterMarks(marks);
      } catch {
        // Silently ignore errors (e.g., file not tracked, permission denied)
        setGutterMarks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, worktreeId, path, scope, fileScope, lastChanged, treeLastChanged]);

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
  // Skip restore if pendingFileLine is set — that takes precedence.
  const setBodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el;
      if (el && scrollKey && pendingFileLine === null) {
        const saved = useWorkspaceStore.getState().fileScrollByKey[scrollKey];
        if (saved != null) el.scrollTop = saved;
      }
    },
    [scrollKey, pendingFileLine],
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
    if (!bodyRef.current || !scrollKey || pendingFileLine !== null) return;
    const saved = useWorkspaceStore.getState().fileScrollByKey[scrollKey];
    if (saved != null) bodyRef.current.scrollTop = saved;
  }, [fileBody, diffBody, scrollKey, pendingFileLine]);

  // Path the currently-pending scroll-to-line request was made for —
  // captured the moment `pendingFileLine` transitions to a new value, so the
  // effect below can tell "stale, the user moved to a different file" apart
  // from "this file hasn't rendered a matching line yet" (e.g. a Markdown
  // file renders MarkdownView — no `.workspace-code-line` elements — until
  // the user toggles to raw/source view).
  const pendingLineForPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingFileLine !== null) pendingLineForPathRef.current = path;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capture `path` at the moment `pendingFileLine` is (re)set, not on every path change
  }, [pendingFileLine]);

  // Scroll to the pending line once its target line element exists, then
  // clear it. Deliberately does NOT clear on a "not found YET" outcome for
  // the same file/path — only on an actual scroll, or on discovering the
  // active file has moved on to a different path than this request was for
  // (stale — clearing here also prevents it from coincidentally matching an
  // unrelated file's line numbers). `rawMarkdown`/`scope` are dependencies
  // so toggling into a view that DOES render `.workspace-code-line`s (e.g.
  // Markdown → raw/source) gives this effect another chance instead of the
  // jump-to-line intent being silently and permanently dropped.
  useEffect(() => {
    if (pendingFileLine === null || !bodyRef.current) return;
    if (path !== pendingLineForPathRef.current) {
      clearPendingFileLine();
      return;
    }
    if (!fileBody) return; // still loading this file's content
    // Find the line element with the matching line number in the gutter.
    const lineElements = bodyRef.current.querySelectorAll<HTMLElement>(".workspace-code-line");
    let targetElement: HTMLElement | null = null;
    for (const lineEl of lineElements) {
      const gutterText = lineEl.querySelector<HTMLElement>(".workspace-code-gutter")?.textContent?.trim();
      if (gutterText === String(pendingFileLine)) {
        targetElement = lineEl;
        break;
      }
    }
    if (targetElement) {
      targetElement.scrollIntoView({ block: "center" });
      clearPendingFileLine();
    }
    // else: leave pendingFileLine set — no matching line element exists in
    // the CURRENT render (e.g. Markdown pretty-view), but one may appear on
    // a later render of this same file (raw-markdown toggle, etc.).
  }, [pendingFileLine, fileBody, path, rawMarkdown, scope, clearPendingFileLine]);
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
  }, [diffBody, fileBody]);

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
  const isImage = isImagePath(path);

  const body = (() => {
    if (isImage) {
      // Binary image — render the actual image (zoomable), not raw text.
      // Images bypass the diff scope entirely: getDiff returns 422 for binary
      // files, and there is no meaningful text diff to show for an image.
      return imageBlobUrl ? (
        <ZoomableMedia
          src={imageBlobUrl}
          alt={path}
          className="preview-image"
          onOpenFullscreen={() => setImageFullscreen(true)}
        />
      ) : (
        <div className="empty-state">Loading image…</div>
      );
    }
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
    if (isMd && !rawMarkdown) {
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
    return <CodeView code={fileBody} language={languageForFilePath(path)} filePath={path} themeMode={themeMode} gutterMarks={gutterMarks ?? undefined} />;
  })();

  const useCodeChrome = scope === "local" || scope === "branch" || scope === "commit" || ((!isMd || rawMarkdown) && !isImage && scope === "none");

  const bump = (delta: number) => {
    if (worktreeId) bumpPreviewFontForWorktree(worktreeId, delta);
    else bumpPreviewFont(delta);
  };
  const fontOverlay = (
    <div className="preview-font-overlay">
      <button type="button" className="preview-font-overlay__btn" aria-label="Decrease preview font" onClick={() => bump(-0.05)}>
        <Minus size={11} />
      </button>
      <button type="button" className="preview-font-overlay__btn" aria-label="Increase preview font" onClick={() => bump(0.05)}>
        <Plus size={11} />
      </button>
      {isMd && scope === "none" && (
        <button
          type="button"
          className="preview-font-overlay__btn"
          aria-label={rawMarkdown ? "View rendered markdown" : "View source"}
          onClick={() => setRawMarkdown(!rawMarkdown)}
        >
          {rawMarkdown ? "Formatted" : "Source"}
        </button>
      )}
    </div>
  );

  return (
    <div className="pane pane-stack" style={{ position: "relative" }}>
      {diffInfo}
      {fontOverlay}
      <div
        ref={setBodyRef}
        onScroll={handleScroll}
        className={`preview-body${useCodeChrome ? " preview-body--code" : ""}`}
        style={previewScaleStyle}
      >
        {body}
      </div>
      <ImageZoomOverlay
        src={imageFullscreen ? imageBlobUrl : null}
        alt={path}
        onClose={() => setImageFullscreen(false)}
      />
    </div>
  );
}
