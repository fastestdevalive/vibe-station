import { useEffect, useId, useRef } from "react";
import mermaid from "mermaid";

interface MermaidViewProps {
  chart: string;
  theme: "dark" | "light";
}

export function MermaidView({ chart, theme }: MermaidViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "neutral",
      securityLevel: "strict",
    });
    const el = hostRef.current;
    if (!el) return;
    el.innerHTML = "";
    const run = async () => {
      const { svg } = await mermaid.render(`mmd-${uid}`, chart);
      el.innerHTML = svg;
    };
    void run();
  }, [chart, theme, uid]);

  return <div ref={hostRef} />;
}
