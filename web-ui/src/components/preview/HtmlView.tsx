import { useMemo, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { defaultThemeId, themeById } from "@/theme/registry";
import {
  HTML_CHAT_MAX_BYTES,
  HTML_FILE_MAX_BYTES,
  HTML_IFRAME_SANDBOX,
  buildHtmlSrcdoc,
  byteLength,
} from "./htmlDocument";

export interface HtmlViewProps {
  source: string;
  /** file: fills parent (flex:1); chat: 320px, Expand/Collapse, resizable wrapper */
  variant: "file" | "chat";
  /** iframe title (a11y) */
  title?: string;
  /** Optional externally-held UI state (chat keeps it in its row store so it
   *  survives the virtualized list unmounting the card). Local state otherwise. */
  ui?: HtmlViewUi;
}

export interface HtmlViewUi {
  expanded: boolean;
  setExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  lightCanvas: boolean;
  setLightCanvas: (v: boolean | ((prev: boolean) => boolean)) => void;
}

const CHAT_MAX = HTML_CHAT_MAX_BYTES;
const FILE_MAX = HTML_FILE_MAX_BYTES;

/** Last gray-zone answer, so re-renders of the same large body skip re-encoding. */
let gray = { source: "", max: 0, over: false };

/** Single owner of the size caps — callers pick Source vs Rendered off this. */
export function isOverHtmlCap(source: string, variant: "file" | "chat"): boolean {
  const max = variant === "chat" ? CHAT_MAX : FILE_MAX;
  // UTF-16 length bounds the UTF-8 size (1x..3x per unit), so only encode in the gray zone.
  if (source.length > max) return true;
  if (source.length * 3 <= max) return false;
  if (gray.source === source && gray.max === max) return gray.over;
  const over = byteLength(source) > max;
  gray = { source, max, over };
  return over;
}

function formatKb(bytes: number): string {
  return String(Math.ceil(bytes / 1024));
}

export function HtmlView({ source, variant, title, ui }: HtmlViewProps) {
  const { themeId } = useTheme();
  const [localLight, setLocalLight] = useState(false);
  const [localExpanded, setLocalExpanded] = useState(false);
  const lightCanvas = ui?.lightCanvas ?? localLight;
  const setLightCanvas = ui?.setLightCanvas ?? setLocalLight;
  const expanded = ui?.expanded ?? localExpanded;
  const setExpanded = ui?.setExpanded ?? setLocalExpanded;
  const bodyRef = useRef<HTMLDivElement>(null);

  const overCap = useMemo(() => isOverHtmlCap(source, variant), [source, variant]);

  const srcdoc = useMemo(() => {
    if (overCap) return ""; // never sanitize content we are not going to show
    const entry = themeById[themeId] ?? themeById[defaultThemeId];
    const opts = lightCanvas
      ? { colorScheme: "light" as const }
      : {
          colorScheme: (entry?.appearance ?? "dark") as "dark" | "light",
          bg: entry?.cssVars["--bg-primary"],
          fg: entry?.cssVars["--fg-primary"],
        };
    return buildHtmlSrcdoc(source, opts);
  }, [source, themeId, lightCanvas, overCap]);

  if (overCap) {
    const limit = variant === "chat" ? formatKb(CHAT_MAX) : formatKb(FILE_MAX);
    return (
      <div className="html-view html-view__notice" role="status">
        Too large to render ({formatKb(byteLength(source))} KB &gt; {limit} KB)
      </div>
    );
  }

  return (
    <div
      className={`html-view html-view--${variant}`}
      data-expanded={variant === "chat" && expanded ? "true" : undefined}
    >
      <div className="html-view__toolbar">
        <button
          type="button"
          className="html-view__light-btn"
          aria-pressed={lightCanvas}
          onClick={() => setLightCanvas((v) => !v)}
        >
          Light canvas
        </button>
        {variant === "chat" && (
          <button
            type="button"
            className="html-view__expand-btn"
            aria-expanded={expanded}
            onClick={() => {
              // A manual drag-resize writes an inline height that would beat the
              // [data-expanded] rule — drop it so Expand/Collapse always works.
              if (bodyRef.current) bodyRef.current.style.height = "";
              setExpanded((v) => !v);
            }}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <div className="html-view__body" ref={bodyRef}>
        <iframe
          className="html-view__frame"
          title={title ?? "HTML preview"}
          sandbox={HTML_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          srcDoc={srcdoc}
        />
      </div>
    </div>
  );
}
