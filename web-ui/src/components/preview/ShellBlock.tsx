import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "@/lib/copyText";

/**
 * A small code block that renders a raw command string with the same CSS
 * classes as the markdown preview's CodeBlock, so it looks identical by
 * construction. Unlike CodeBlock (which consumes react-markdown `<pre>`
 * children), ShellBlock takes a plain string and can host extra action
 * buttons to the left of Copy.
 */
export function ShellBlock({
  command,
  lang = "bash",
  actions,
}: {
  command: string;
  lang?: string;
  actions?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(command.replace(/\n$/, ""));
    if (!ok) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }, [command]);

  return (
    <div className="workspace-md-code-block workspace-md-code-block--inline">
      <div className="workspace-md-code-block-header">
        <span className="workspace-md-code-block-lang">{lang}</span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {actions}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={`workspace-md-code-block-copy${copied ? " workspace-md-code-block-copy--copied" : ""}`}
            aria-label="Copy code to clipboard"
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre>
        <code>{command}</code>
      </pre>
    </div>
  );
}
