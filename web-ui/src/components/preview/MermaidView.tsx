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
function sanitizeMermaidSource(src: string): string {
  return src.replace(/\{([^}\n]*\|[^}\n]*)\}/g, (_, label: string) =>
    `{${label.replace(/\|/g, " or ")}}`
  );
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
