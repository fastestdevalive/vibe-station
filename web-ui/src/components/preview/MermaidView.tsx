import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

let idCounter = 0;

interface MermaidViewProps {
  chart: string;
  theme: "dark" | "light";
}

export function MermaidView({ chart, theme }: MermaidViewProps) {
  const idRef = useRef<string>("");
  if (!idRef.current) idRef.current = `mmd-${idCounter++}`;

  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "neutral",
      securityLevel: "loose",
    });
    let cancelled = false;
    mermaid
      .render(idRef.current, chart)
      .then(({ svg: rendered }) => {
        if (!cancelled) { setSvg(rendered); setError(null); }
      })
      .catch((err: unknown) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setSvg(""); }
      });
    return () => { cancelled = true; };
  }, [chart, theme]);

  if (error) return <pre style={{ color: "var(--color-error, red)", fontSize: "0.8em" }}>{error}</pre>;
  if (!svg) return null;
  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}
