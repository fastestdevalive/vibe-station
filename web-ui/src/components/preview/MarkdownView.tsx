import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { ImageZoomOverlay } from "./ImageZoomOverlay";
import { resolveImagePath } from "@/lib/imageFile";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  api: ApiInstance | null;
  worktreeId: string | null;
  scope: FileScope;
  /** Directory of the file being previewed, used to resolve relative image paths. */
  fileDir: string | null;
}

function MarkdownImage({ src, alt, api, worktreeId, scope, fileDir }: MarkdownImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const isRemote =
    !src ||
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("//") ||
    src.startsWith("data:");

  useEffect(() => {
    if (isRemote || !src || !worktreeId || !api) return;
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
  }, [src, api, worktreeId, scope, fileDir, isRemote]);

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
}

export function MarkdownView({ source, api = null, worktreeId = null, scope = "worktree", filePath = null }: MarkdownViewProps) {
  const fileDir = filePath ? filePath.split("/").slice(0, -1).join("/") || null : null;

  const markdownComponents = useMemo(() => ({
    pre({ children }: { children?: ReactNode }) {
      return <CodeBlock>{children}</CodeBlock>;
    },
    code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
      return <code className={className} {...props}>{children}</code>;
    },
    img({ src, alt }: ComponentPropsWithoutRef<"img">) {
      return <MarkdownImage src={src} alt={alt} api={api} worktreeId={worktreeId} scope={scope} fileDir={fileDir} />;
    },
  }), [api, worktreeId, scope, fileDir]);

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
