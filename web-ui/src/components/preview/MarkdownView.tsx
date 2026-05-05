import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";

const markdownComponents = {
  pre({ children }: { children?: ReactNode }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
  code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
    return <code className={className} {...props}>{children}</code>;
  },
};

interface MarkdownViewProps {
  source: string;
}

export function MarkdownView({ source }: MarkdownViewProps) {
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
