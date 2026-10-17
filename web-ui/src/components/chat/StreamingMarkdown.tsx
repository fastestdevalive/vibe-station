import { memo, useMemo } from "react";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { MermaidView } from "@/components/preview/MermaidView";
import { HtmlBlock } from "./HtmlBlock";
import { segmentMarkdown } from "@/preview/mdSegments";
import { useTheme } from "@/hooks/useTheme";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";

/**
 * Close an unterminated ``` fence so a mid-stream delta doesn't swallow the rest
 * of the layout into an open code block (Decision 9 — streaming-tolerant).
 *
 * Counts fence lines (```lang or ```). An odd count means the last block is
 * still open, so we append a synthetic closing fence for this render only. The
 * real closing fence arrives in a later delta and the synthetic one is dropped.
 */
export function closeUnterminatedFences(src: string): string {
  const fenceLines = src.match(/^[ \t]*```/gm);
  if (fenceLines && fenceLines.length % 2 === 1) {
    return `${src}\n\`\`\``;
  }
  return src;
}

/**
 * Assistant / thinking markdown renderer. Reuses the existing `MarkdownView`
 * (GFM, syntax-highlighted code + copy, raw-HTML off, URLs sanitized) and routes
 * ```mermaid fences to `MermaidView` (Decision 9 — reuse, don't rebuild). When
 * `renderHtml` is true (assistant text only — Decision 9), closed ```html fences
 * render as a sandboxed `HtmlBlock` card.
 *
 * Streaming order matters: segment the RAW source first (the segmenter only
 * matches genuinely CLOSED mermaid/html fences), THEN close unterminated fences
 * per markdown segment. An in-progress block stays in the trailing markdown
 * segment and renders as a synthetic-closed code block until its real ``` lands,
 * at which point it flips to its host — no streaming flags needed.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  source,
  api = null,
  worktreeId = null,
  scope = "worktree",
  renderHtml = false,
  rowKey,
}: {
  source: string;
  /** When provided, repo-relative image paths resolve via `getFileBlob`. */
  api?: ApiInstance | null;
  worktreeId?: string | null;
  scope?: FileScope;
  /** Render closed ```html fences as sandboxed cards (assistant text only). */
  renderHtml?: boolean;
  /** Message-row key (from MessageList) — persists html card UI state across virtualized remounts. */
  rowKey?: string;
}) {
  const { theme } = useTheme();
  const segments = useMemo(() => segmentMarkdown(source, { html: renderHtml }), [source, renderHtml]);
  return (
    <div className="chat-md-segments">
      {segments.map((seg, i) =>
        seg.type === "markdown" ? (
          <MarkdownView key={i} source={closeUnterminatedFences(seg.content)} api={api} worktreeId={worktreeId} scope={scope} />
        ) : seg.type === "html" ? (
          <HtmlBlock key={i} source={seg.content} stateKey={rowKey != null ? `html:${rowKey}:${i}` : undefined} />
        ) : (
          <MermaidView key={i} chart={seg.content} theme={theme} />
        ),
      )}
    </div>
  );
});
