import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import { ImageZoomOverlay } from "./ImageZoomOverlay";

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

/**
 * Renders a mermaid diagram. The inline SVG stays interactive and is wrapped
 * in a clickable wrapper; clicking opens the shared `ImageZoomOverlay`
 * fullscreen from a blob URL of the SVG string — reusing `ZoomableMedia`
 * (mouse + touch zoom/pan). The wrapper only presents as a button once the
 * SVG has rendered, so a screen reader / cursor never advertises an action
 * while the async render is still in flight. A failed render falls back to a
 * raw `<pre>` that is NOT clickable.
 */
export function MermaidView({ chart, theme }: MermaidViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const [failed, setFailed] = useState(false);
  const [svgString, setSvgString] = useState<string | null>(null);
  const [fullscreenSrc, setFullscreenSrc] = useState<string | null>(null);

  useEffect(() => {
    // Skip the mermaid.parse() pre-check — render() is the sole gate, already
    // wrapped in try/catch; fall back to the raw source block on failure.
    setFailed(false);
    setSvgString(null);
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
        setSvgString(svg);
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

  // Revoke the fullscreen blob URL whenever it is replaced or the component
  // unmounts while a diagram is open (close just sets it back to null).
  useEffect(() => {
    return () => {
      if (fullscreenSrc) URL.revokeObjectURL(fullscreenSrc);
    };
  }, [fullscreenSrc]);

  const openFullscreen = () => {
    if (!svgString) return;
    setFullscreenSrc(URL.createObjectURL(new Blob([svgString], { type: "image/svg+xml" })));
  };
  const closeFullscreen = () => setFullscreenSrc(null);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{chart}</code>
      </pre>
    );
  }

  // Only interactive once the SVG has rendered (svgString != null); before
  // that the async render is in flight and clicking is a no-op.
  const interactive = svgString !== null;

  return (
    <>
      <div
        ref={hostRef}
        className={`mermaid-view${interactive ? " mermaid-view--clickable" : ""}`}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? "Open diagram fullscreen" : undefined}
        title={interactive ? "Open fullscreen" : undefined}
        onClick={interactive ? openFullscreen : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openFullscreen();
                }
              }
            : undefined
        }
      />
      <ImageZoomOverlay src={fullscreenSrc} alt="Mermaid diagram" onClose={closeFullscreen} />
    </>
  );
}
