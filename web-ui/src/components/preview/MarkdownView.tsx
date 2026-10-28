import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { ImageZoomOverlay } from "./ImageZoomOverlay";
import { resolveImagePath } from "@/lib/imageFile";
import type { ApiInstance } from "@/api";
import type { ArtifactRow, FileScope } from "@/api/types";
import { useMarkdownStyle } from "@/hooks/useMarkdownStyle";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useArtifactsStore } from "@/components/artifacts/artifactsStore";
import "@/components/artifacts/artifacts.css";
import { useCommentSurface } from "@/components/comments/CommentSurfaceContext";
import { rehypeCommentMarks, type MarkComment } from "@/components/comments/rehypeCommentMarks";
import { PinGutter } from "@/components/comments/CommentPins";
import type { PinTarget } from "@/components/comments/pinMeasurer";
import { usePinHost } from "@/components/comments/usePinHost";
import { asRehypePlugin, rehypeSourceLines } from "@/components/comments/rehypeSourceLines";

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
  /** One path -> row lookup per artifacts-store change (shared by every link). */
  rowsByPath: ReadonlyMap<string, ArtifactRow>;
}

/** `normalizeUri` percent-encodes spaces / non-ASCII in link targets; compare the decoded segments. */
function decodeSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

const NO_ROW_MAP: ReadonlyMap<string, ArtifactRow> = new Map();

/** The scope's artifact rows keyed by canonical path, rebuilt only when the rows change. */
function useRowsByPath(worktreeId: string | null, enabled: boolean): ReadonlyMap<string, ArtifactRow> {
  const rows = useArtifactsStore((s) => (enabled && worktreeId ? s.byScope[worktreeId]?.rows : undefined));
  return useMemo(() => (rows ? new Map(rows.map((r) => [r.path, r])) : NO_ROW_MAP), [rows]);
}

/**
 * Link inside an outside-repo markdown file (R98, R111): http(s)/mailto behave as usual; a local path is inert
 * unless its resolved absolute path is an artifact row of this scope, in which case it opens that row's tab.
 */
function ExternalLink({ href, children, worktreeId, fileDir, rowsByPath }: ExternalLinkProps) {
  const target =
    href && !REMOTE_HREF.test(href) && !href.startsWith("#") ? joinPath(fileDir, decodeSegments(href.split(/[?#]/)[0] ?? "")) : null;
  const row = target ? rowsByPath.get(target) : undefined;
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
  /**
   * Opt-in review-comment support (default OFF: chat bubbles share this component and stay clean): block
   * elements get `data-sl` / `data-el` source lines, and the surrounding comment surface's comments are
   * highlighted with pins. `startLine` is the 1-based line of the ORIGINAL file this `source` starts on
   * (`segmentMarkdownWithLines`), since react-markdown positions are relative to the segment it renders.
   */
  commentSource?: { startLine: number };
}

export function MarkdownView({ source, api = null, worktreeId = null, scope = "worktree", filePath = null, external = false, commentSource }: MarkdownViewProps) {
  const cs = useCommentSurface();
  const startLine = commentSource?.startLine;
  const commentsOn = startLine != null && !!cs && cs.enabled && (filePath === cs.path || filePath?.endsWith(`/${cs.path}`) === true);
  const markList = commentsOn ? cs.forSurface("markdown").list : null;
  const pinLabel = cs?.pinLabel;
  const draft = commentsOn && cs.draft?.surface === "markdown" ? cs.draft : null;
  const activeId = commentsOn ? cs.activeId : null;
  const rehypePlugins = useMemo(() => {
    if (startLine == null) return [rehypeHighlight];
    const marks: MarkComment[] = [...(markList ?? []), ...(draft ? [draft] : [])].map((comment) => ({ comment }));
    return [
      rehypeHighlight,
      asRehypePlugin(rehypeSourceLines({ startLine })),
      ...(marks.length ? [asRehypePlugin(rehypeCommentMarks({ comments: marks, startLine }))] : []),
    ];
  }, [startLine, markList, draft]);
  // Pins live OUTSIDE the rendered hast, in a right gutter of the container, lined up with each comment's last mark.
  const hostRef = useRef<HTMLDivElement>(null);
  const targets = useMemo<PinTarget[]>(() => {
    if (!commentsOn) return [];
    const out: PinTarget[] = (markList ?? []).map((c) => ({
      id: c.id,
      pin: c.pin,
      outdated: c.anchor === "outdated",
      active: c.id === activeId,
      label: pinLabel ? pinLabel(c) : `Comment ${c.pin}`,
    }));
    if (draft) out.push({ id: draft.id, pin: 0, draft: true });
    return out;
  }, [commentsOn, markList, draft, activeId, pinLabel]);
  const placements = usePinHost(commentsOn ? cs.pinMeasurer : null, hostRef, null, targets, rehypePlugins);
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

  const rowsByPath = useRowsByPath(worktreeId, external);

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
              <ExternalLink href={href} worktreeId={worktreeId} fileDir={fileDir} rowsByPath={rowsByPath}>
                {children}
              </ExternalLink>
            );
          },
        }
      : {}),
  }), [api, worktreeId, scope, fileDir, external, rowsByPath]);

  return (
    <div className="workspace-markdown-preview" ref={hostRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {source}
      </ReactMarkdown>
      <PinGutter placements={placements} targets={targets} />
    </div>
  );
}
