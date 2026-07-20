import { useMemo } from "react";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { MermaidView } from "@/components/preview/MermaidView";
import { segmentMarkdownWithMermaid } from "@/preview/mdSegments";
import { useTheme } from "@/hooks/useTheme";

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
 * ```mermaid fences to `MermaidView` (Decision 9 — reuse, don't rebuild).
 *
 * Streaming order matters: segment the RAW source first (the segmenter only
 * matches genuinely CLOSED mermaid fences), THEN close unterminated fences per
 * markdown segment. An in-progress mermaid block stays in the trailing markdown
 * segment and renders as a synthetic-closed code block until its real ``` lands,
 * at which point it flips to a diagram — no streaming flags needed.
 */
export function StreamingMarkdown({ source }: { source: string }) {
  const { theme } = useTheme();
  const segments = useMemo(() => segmentMarkdownWithMermaid(source), [source]);
  return (
    <div className="chat-md-segments">
      {segments.map((seg, i) =>
        seg.type === "markdown" ? (
          <MarkdownView key={i} source={closeUnterminatedFences(seg.content)} />
        ) : (
          <MermaidView key={i} chart={seg.content} theme={theme} />
        ),
      )}
    </div>
  );
}
