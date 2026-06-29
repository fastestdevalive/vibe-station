import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import type { ApiInstance } from "@/api";

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  api: ApiInstance | null;
  worktreeId: string | null;
  /** Directory of the file being previewed, used to resolve relative image paths. */
  fileDir: string | null;
}

function MarkdownImage({ src, alt, api, worktreeId, fileDir }: MarkdownImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

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

    // Root-absolute paths (src="/images/foo.png") resolve from worktree root,
    // not relative to fileDir — strip the leading slash and skip joining.
    const imagePath = src.startsWith("/")
      ? src.replace(/^\/+/, "")
      : fileDir ? `${fileDir}/${src}` : src;

    api.getFileBlob(worktreeId, imagePath).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setBlobUrl(objectUrl);
    }).catch(() => { /* image not found — render nothing */ });

    return () => {
      cancelled = true;
      setBlobUrl(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, api, worktreeId, fileDir, isRemote]);

  if (isRemote && src) {
    return <img src={src} alt={alt ?? ""} className="markdown-img" />;
  }
  if (!blobUrl) return null;
  return <img src={blobUrl} alt={alt ?? ""} className="markdown-img" />;
}

interface MarkdownViewProps {
  source: string;
  api?: ApiInstance | null;
  worktreeId?: string | null;
  /** Absolute-style path of the file being previewed (e.g. "docs/README.md"). */
  filePath?: string | null;
}

export function MarkdownView({ source, api = null, worktreeId = null, filePath = null }: MarkdownViewProps) {
  const fileDir = filePath ? filePath.split("/").slice(0, -1).join("/") || null : null;

  const markdownComponents = useMemo(() => ({
    pre({ children }: { children?: ReactNode }) {
      return <CodeBlock>{children}</CodeBlock>;
    },
    code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
      return <code className={className} {...props}>{children}</code>;
    },
    img({ src, alt }: ComponentPropsWithoutRef<"img">) {
      return <MarkdownImage src={src} alt={alt} api={api} worktreeId={worktreeId} fileDir={fileDir} />;
    },
  }), [api, worktreeId, fileDir]);

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
