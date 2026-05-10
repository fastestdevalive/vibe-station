import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ApiInstance } from "@/api";
import type { DiffScope, Project, Session, Worktree } from "@/api/types";
import { ApiError } from "@/api/errors";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";
import { useTheme } from "@/hooks/useTheme";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useFileWatch } from "@/hooks/useSubscription";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { MermaidView } from "@/components/preview/MermaidView";
import { CodeView } from "@/components/preview/CodeView";
import { DiffView } from "@/components/preview/DiffView";
import { DashboardPanel } from "@/components/layout/DashboardPanel";
import { languageForFilePath } from "@/components/preview/codeHighlight";
import { parseUnifiedDiff, summarizeDiffLines, syntheticUntrackedHunks } from "@/preview/diffParser";

interface FilePreviewPaneProps {
  api: ApiInstance;
  sessionId: string | null;
  worktreeId: string | null;
  bundle?: { projects: Project[]; worktrees: Worktree[]; sessions: Session[] };
}

export function FilePreviewPane({ api, sessionId, worktreeId, bundle }: FilePreviewPaneProps) {
  const path = useWorkspaceStore((s) => s.activeFilePath);
  const scopeFromStore = useWorkspaceStore((s) =>
    worktreeId ? s.diffScopeByWorktree[worktreeId] : undefined,
  );
  const scope: DiffScope = scopeFromStore ?? "none";
  const previewFontScale = useWorkspaceStore((s) => s.previewFontScale);
  const bumpPreviewFont = useWorkspaceStore((s) => s.bumpPreviewFont);
  const togglePaneCollapsed = useWorkspaceStore((s) => s.togglePaneCollapsed);
  const workspacePaneFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setWorkspacePaneFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);

  const { theme } = useTheme();
  const themeMode = theme;

  const [fileBody, setFileBody] = useState<string | null>(null);
  const { lastChanged } = useFileWatch(api, worktreeId, path);

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
          const text = await api.getFile(worktreeId, path);
          if (!cancelled) {
            setFileBody(text);
            setDiffBody(null);
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
        } else {
          const d = await api.getDiff(worktreeId, path, "branch");
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
  }, [api, worktreeId, path, scope, lastChanged]);

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
    if (scope !== "local" && scope !== "branch") return null;
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

  const previewFullscreenBtn = (
    <div className="preview-header__fs">
      <button
        type="button"
        className={`tab tab--icon${workspacePaneFullscreen === "preview" ? " tab--fs-active" : ""}`}
        aria-label={workspacePaneFullscreen === "preview" ? "Exit fullscreen preview" : "Fullscreen preview"}
        aria-pressed={workspacePaneFullscreen === "preview"}
        title={workspacePaneFullscreen === "preview" ? "Exit fullscreen preview" : "Fullscreen preview"}
        onClick={() =>
          setWorkspacePaneFullscreen(workspacePaneFullscreen === "preview" ? null : "preview")
        }
      >
        {workspacePaneFullscreen === "preview" ? (
          <Minimize2 size={13} strokeWidth={2} aria-hidden />
        ) : (
          <Maximize2 size={13} strokeWidth={2} aria-hidden />
        )}
      </button>
    </div>
  );

  if (!worktreeId) {
    return (
      <div className="pane pane-stack">
        <div className="preview-header">
          <span className="preview-header__title">Overview</span>
          {previewFullscreenBtn}
        </div>
        <div className="preview-body" style={{ padding: 0 }}>
          <DashboardPanel
              api={api}
              initialProjects={bundle?.projects}
              initialWorktrees={bundle?.worktrees}
              initialSessions={bundle?.sessions}
            />
        </div>
      </div>
    );
  }

  const previewScaleStyle: CSSProperties = {
    fontSize: `calc(var(--font-size-base) * ${previewFontScale})`,
  };

  const closeBtn = (
    <button
      type="button"
      className="tab tab--icon"
      aria-label="Close preview"
      title="Close preview (⌘⇧P)"
      onClick={() => togglePaneCollapsed(1)}
    >
      <X size={13} />
    </button>
  );

  const zoomControls = (
    <div className="preview-header__zoom">
      <span className="preview-header__zoom-label">Aa</span>
      <button type="button" className="tab tab--icon" aria-label="Decrease preview font" onClick={() => bumpPreviewFont(-0.05)}>
        <Minus size={11} />
      </button>
      <button type="button" className="tab tab--icon" aria-label="Increase preview font" onClick={() => bumpPreviewFont(0.05)}>
        <Plus size={11} />
      </button>
    </div>
  );

  if (!path) {
    return (
      <div className="pane pane-stack">
        <div className="preview-header">
          <span className="preview-header__title">Preview</span>
          {zoomControls}
          <div className="preview-header__tail">
            {previewFullscreenBtn}
            {closeBtn}
          </div>
        </div>
        <div className="empty-state">Select a file from the tree</div>
      </div>
    );
  }

  const header = (
    <div className="preview-header">
      <div className="preview-header__main">
        <span className="preview-header__path">{path}</span>
        {(scope === "local" || scope === "branch") && diffStats ? (
          <span className="preview-header__diff-stats" aria-label="Diff line counts">
            <span className="preview-header__diff-stats-plus">+{diffStats.additions}</span>{" "}
            <span className="preview-header__diff-stats-minus">−{diffStats.deletions}</span>
          </span>
        ) : null}
        {scope === "local" || scope === "branch" ? (
          <span className="preview-header__diff-scope">
            {scope === "branch" ? "Compared to fork base" : "Compared to HEAD"}
          </span>
        ) : null}
      </div>
      {zoomControls}
      <div className="preview-header__tail">
        {previewFullscreenBtn}
        {closeBtn}
      </div>
    </div>
  );

  if (tooLarge) {
    return (
      <div className="pane pane-stack">
        {header}
        <div className="empty-state">File too large to preview</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pane pane-stack">
        {header}
        <div className="empty-state">{error}</div>
      </div>
    );
  }

  const isMd = path.endsWith(".md");

  const body = (() => {
    if (scope === "local" || scope === "branch") {
      const diffText = diffBody ?? "";
      const fallback = fileBody ?? undefined;
      return (
        <DiffView diffText={diffText} fileContentFallback={fallback} filePath={path} themeMode={themeMode} />
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
              <MarkdownView key={i} source={seg.content} />
            ) : (
              <MermaidView key={i} chart={seg.content} theme={themeMode} />
            ),
          )}
        </div>
      );
    }
    return <CodeView code={fileBody} language={languageForFilePath(path)} filePath={path} themeMode={themeMode} />;
  })();

  const useCodeChrome = scope === "local" || scope === "branch" || (!isMd && scope === "none");

  return (
    <div className="pane pane-stack">
      {header}
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
