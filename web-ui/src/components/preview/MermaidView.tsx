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
    // Skip the mermaid.parse() pre-check — it is more conservative than
    // render() (e.g. it rejects `|` inside `{diamond}` nodes even though
    // render() recovers and produces valid SVG). render() is already wrapped in
    // try/catch, so it is the sole gate; falling back to the raw source block
    // on any render failure is enough.
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
