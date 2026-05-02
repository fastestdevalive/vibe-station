import { Minus, Plus } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { ApiInstance } from "@/api";
import type { DiffScope } from "@/api/types";
import { ApiError } from "@/api/errors";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";
import { useTheme } from "@/hooks/useTheme";
import { useWorkspaceStore } from "@/hooks/useStore";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { MermaidView } from "@/components/preview/MermaidView";
import { CodeView } from "@/components/preview/CodeView";
import { DiffView } from "@/components/preview/DiffView";
import { DashboardPanel } from "@/components/layout/DashboardPanel";

function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    go: "go",
  };
  return map[ext ?? ""] ?? "typescript";
}

interface FilePreviewPaneProps {
  api: ApiInstance;
  sessionId: string | null;
  worktreeId: string | null;
}

export function FilePreviewPane({ api, sessionId, worktreeId }: FilePreviewPaneProps) {
  const path = useWorkspaceStore((s) => s.activeFilePath);
  const scopeFromStore = useWorkspaceStore((s) =>
    worktreeId ? s.diffScopeByWorktree[worktreeId] : undefined,
  );
  const scope: DiffScope = scopeFromStore ?? "none";
  const previewFontScale = useWorkspaceStore((s) => s.previewFontScale);
  const bumpPreviewFont = useWorkspaceStore((s) => s.bumpPreviewFont);

  const { theme } = useTheme();
  const themeMode = theme;

  const [fileBody, setFileBody] = useState<string | null>(null);
  const [diffBody, setDiffBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    if (!sessionId || !path) {
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
          const text = await api.getFile(sessionId, path);
          if (!cancelled) {
            setFileBody(text);
            setDiffBody(null);
          }
        } else if (scope === "local") {
          const [text, d] = await Promise.all([
            api.getFile(sessionId, path),
            api.getDiff(sessionId, path, "local"),
          ]);
          if (!cancelled) {
            setFileBody(text);
            setDiffBody(d);
          }
        } else {
          const d = await api.getDiff(sessionId, path, "branch");
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
  }, [api, sessionId, path, scope]);

  if (!worktreeId) {
    return (
      <div className="pane pane-stack">
        <div className="preview-header"><span className="preview-header__title">Overview</span></div>
        <div className="preview-body" style={{ padding: 0 }}>
          <DashboardPanel api={api} />
        </div>
      </div>
    );
  }

  const previewScaleStyle: CSSProperties = {
    fontSize: `calc(var(--font-size-base) * ${previewFontScale})`,
  };

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
        </div>
        <div className="empty-state">Select a file from the tree</div>
      </div>
    );
  }

  const header = (
    <div className="preview-header">
      <span className="preview-header__path">{path}</span>
      {zoomControls}
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
      return <DiffView diffText={diffText} fileContentFallback={fallback} />;
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
    return <CodeView code={fileBody} language={langFromPath(path)} themeMode={themeMode} />;
  })();

  return (
    <div className="pane pane-stack">
      {header}
      <div className="preview-body" style={previewScaleStyle}>
        {body}
      </div>
    </div>
  );
}
