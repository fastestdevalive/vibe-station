import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { ImageZoomOverlay } from "./ImageZoomOverlay";
import { resolveImagePath } from "@/lib/imageFile";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useMarkdownStyle } from "@/hooks/useMarkdownStyle";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useArtifactsStore } from "@/components/artifacts/artifactsStore";

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  api: ApiInstance | null;
  worktreeId: string | null;
  scope: FileScope;
  /** Directory of the file being previewed, used to resolve relative image paths. */
  fileDir: string | null;
  /** Previewing a file outside the repo (an artifact): local images are blocked, never fetched. */
  external?: boolean;
}

const REMOTE_HREF = /^(https?:|mailto:)/i;

/** Normalise `dir/../x/./y` lexically; the result is only ever compared with stored canonical artifact paths. */
function joinPath(dir: string | null, rel: string): string {
  const parts = (rel.startsWith("/") || !dir ? rel : `${dir}/${rel}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

interface ExternalLinkProps {
  href?: string;
  children?: ReactNode;
  worktreeId: string | null;
  fileDir: string | null;
}

/**
 * Link inside an outside-repo markdown file (R98, R111): http(s)/mailto behave as usual; a local path is inert
 * unless its resolved absolute path is an artifact row of this scope, in which case it opens that row's tab.
 */
function ExternalLink({ href, children, worktreeId, fileDir }: ExternalLinkProps) {
  const target = href && !REMOTE_HREF.test(href) && !href.startsWith("#") ? joinPath(fileDir, href.split(/[?#]/)[0] ?? "") : null;
  const row = useArtifactsStore((s) =>
    target && worktreeId ? s.byScope[worktreeId]?.rows.find((r) => r.path === target) : undefined,
  );
  const open = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (row && worktreeId) useWorkspaceStore.getState().openFileTabNew(worktreeId, row.inRepo ? row.displayPath : row.path);
    },
    [row, worktreeId],
  );
  if (!href || href.startsWith("#") || REMOTE_HREF.test(href)) return <a href={href}>{children}</a>;
  if (row) {
    return (
      <a href={href} onClick={open} title={row.displayPath}>
        {children}
      </a>
    );
  }
  return (
    <span className="markdown-link-inert" title="Link blocked (outside the repo)">
      {children}
    </span>
  );
}

function MarkdownImage({ src, alt, api, worktreeId, scope, fileDir, external = false }: MarkdownImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const isRemote =
    !src ||
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("//") ||
    src.startsWith("data:");

  useEffect(() => {
    if (isRemote || external || !src || !worktreeId || !api) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    // Root-absolute paths (src="/images/foo.png") resolve from the context
    // root; relative paths resolve against `fileDir` (null in chat → root).
    const imagePath = resolveImagePath(src, fileDir);

    api.getFileBlob(worktreeId, imagePath, scope).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setBlobUrl(objectUrl);
    }).catch(() => { /* image not found — render nothing */ });

    return () => {
      cancelled = true;
      setBlobUrl(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, api, worktreeId, scope, fileDir, isRemote, external]);

  if (external && !isRemote) {
    return (
      <span className="markdown-img-blocked" role="img" aria-label={`Image blocked (outside the repo)${alt ? `: ${alt}` : ""}`}>
        Image blocked (outside the repo)
      </span>
    );
  }
  const imgSrc = isRemote ? src : blobUrl;
  if (!imgSrc) return null;
  return (
    <>
      <img
        src={imgSrc}
        alt={alt ?? ""}
        className="markdown-img"
        draggable={false}
        onClick={() => setFullscreen(true)}
      />
      <ImageZoomOverlay src={fullscreen ? imgSrc : null} alt={alt} onClose={() => setFullscreen(false)} />
    </>
  );
}

interface MarkdownViewProps {
  source: string;
  api?: ApiInstance | null;
  worktreeId?: string | null;
  scope?: FileScope;
  /** Absolute-style path of the file being previewed (e.g. "docs/README.md"). */
  filePath?: string | null;
  /** The file lives outside the repo (an artifact): relative images show "blocked", local links are inert unless they name an artifact. */
  external?: boolean;
}

export function MarkdownView({ source, api = null, worktreeId = null, scope = "worktree", filePath = null, external = false }: MarkdownViewProps) {
  const fileDir = filePath ? filePath.split("/").slice(0, -1).join("/") || null : null;

  // `MarkdownView` is the single real rendering path shared by chat bubbles
  // and the file-preview `.md` pane (requirement 7) — it must be the thing
  // that boots the daemon-synced override sync (GET /settings seed, WS
  // subscription, and the injected `.workspace-markdown-preview` `<style>`
  // block), same as `useTheme()` boots off whichever consumer mounts first.
  // Before this, only `MarkdownStyleSetting.tsx` called `useMarkdownStyle()`,
  // so overrides only ever applied while the Settings → Markdown page itself
  // was open — every other Markdown surface silently rendered theme defaults.
  useMarkdownStyle();

  const markdownComponents = useMemo(() => ({
    pre({ children }: { children?: ReactNode }) {
      return <CodeBlock>{children}</CodeBlock>;
    },
    code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
      return <code className={className} {...props}>{children}</code>;
    },
    img({ src, alt }: ComponentPropsWithoutRef<"img">) {
      return <MarkdownImage src={src} alt={alt} api={api} worktreeId={worktreeId} scope={scope} fileDir={fileDir} external={external} />;
    },
    ...(external
      ? {
          a({ href, children }: ComponentPropsWithoutRef<"a">) {
            return (
              <ExternalLink href={href} worktreeId={worktreeId} fileDir={fileDir}>
                {children}
              </ExternalLink>
            );
          },
        }
      : {}),
  }), [api, worktreeId, scope, fileDir, external]);

  return (
    <div className="workspace-markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
