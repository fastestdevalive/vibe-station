import DOMPurify from "dompurify";
import { marked } from "marked";

marked.use({ gfm: true });

interface MarkdownViewProps {
  source: string;
}

export function MarkdownView({ source }: MarkdownViewProps) {
  const raw = marked.parse(source, { async: false }) as string;
  const html = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
  });
  return (
    <div
      className="workspace-markdown-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
