import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

interface MermaidViewProps {
  chart: string;
  theme: "dark" | "light";
}

export function MermaidView({ chart, theme }: MermaidViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Models emit invalid mermaid routinely; a bare render() rejection would be
    // an unhandled promise + blank host. Parse-check first, then guard render,
    // and fall back to the raw source as a code block on any failure.
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
    const run = async () => {
      const ok = await mermaid.parse(chart, { suppressErrors: true });
      if (cancelled) return;
      if (!ok) {
        setFailed(true);
        return;
      }
      try {
        const { svg } = await mermaid.render(`mmd-${uid}`, chart);
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
