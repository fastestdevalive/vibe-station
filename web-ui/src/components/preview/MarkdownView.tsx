import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { MermaidView } from "./MermaidView";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";
import { useTheme } from "@/hooks/useTheme";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";

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
  scope?: FileScope;
  /** Absolute-style path of the file being previewed (e.g. "docs/README.md"). */
  filePath?: string | null;
}

export function MarkdownView({ source, api = null, worktreeId = null, scope = "worktree", filePath = null }: MarkdownViewProps) {
  const fileDir = filePath ? filePath.split("/").slice(0, -1).join("/") || null : null;
  const { theme } = useTheme();

  const segments = useMemo(() => segmentMarkdownWithMermaid(source), [source]);

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
      {segments.map((seg, i) =>
        seg.type === "mermaid" ? (
          <MermaidView key={i} chart={seg.content} theme={theme} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {seg.content}
          </ReactMarkdown>
        )
      )}
    </div>
  );
}
