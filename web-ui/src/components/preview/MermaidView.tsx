import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

interface MermaidViewProps {
  chart: string;
  theme: "dark" | "light";
}

// Mermaid's lexer tokenizes `|` as PIPE even inside `{diamond}` node labels,
// causing a render failure. Replace `|` with " or " inside curly-brace node
// labels so the diagram renders. The original source is preserved for the
// fallback <pre> block.
//
// Mermaid also treats `;` as a statement terminator, so a `;` inside a
// sequenceDiagram message (e.g. "Set-Cookie: x=y; Path=/") kills the parse.
// Escape it with mermaid's numeric entity #59; which renders as a literal ";".
function sanitizeMermaidSource(src: string): string {
  const pipeFix = src.replace(/\{([^}\n]*\|[^}\n]*)\}/g, (_, label: string) =>
    `{${label.replace(/\|/g, " or ")}}`
  );
  // Escape `;` after the first `:` on any line that has one — covers arrows,
  // Note over, loop/alt/opt/par labels, etc. Lines with no `:` are pure
  // block-open keywords (sequenceDiagram, end, activate …) and never carry
  // free text, so they're left alone.
  return pipeFix.split("\n").map((line) => {
    const colon = line.indexOf(":");
    if (colon < 0) return line;
    return line.slice(0, colon + 1) + line.slice(colon + 1).replace(/;/g, "#59;");
  }).join("\n");
}

export function MermaidView({ chart, theme }: MermaidViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Skip the mermaid.parse() pre-check — render() is the sole gate, already
    // wrapped in try/catch; fall back to the raw source block on failure.
    setFailed(false);
    let cancelled = false;
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "neutral",
      securityLevel: "strict",
    });
    const el = hostRef.current;
    if (!el) return;
    el.innerHTML = "";
    const sanitized = sanitizeMermaidSource(chart);
    const run = async () => {
      try {
        const { svg } = await mermaid.render(`mmd-${uid}`, sanitized);
        if (cancelled) return;
        el.innerHTML = svg;
      } catch {
        if (cancelled) return;
        setFailed(true);
        // mermaid leaves a temporary `d`-prefixed element in <body> on failure.
        document.getElementById(`mmd-${uid}`)?.remove();
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [chart, theme, uid]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{chart}</code>
      </pre>
    );
  }

  return <div ref={hostRef} className="mermaid-view" />;
}
