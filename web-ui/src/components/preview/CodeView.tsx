import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { themeById } from "@/theme/registry";
import { languageForFilePath } from "./codeHighlight";
import { pickShikiLang } from "./previewLang";
import { escapeHtml, highlightDocumentLines } from "./shikiHighlighter";

interface CodeViewProps {
  code: string;
  language?: string;
  /** Used to pick TSX vs TS etc. for Shiki */
  filePath?: string;
  themeMode?: "dark" | "light";
  /** When true, renders without gutter (e.g. inside a markdown code block) */
  noGutter?: boolean;
  /** Git gutter marks: added/modified/deleted line annotations. No-op when noGutter is true. */
  gutterMarks?: Map<number, "added" | "modified" | "deleted">;
  /** 1-based line number to highlight (search jump-to-line / peek target). */
  highlightLine?: number | null;
  /** Matched substring within `highlightLine` to additionally mark, if found. */
  highlightMatchText?: string | null;
}

/** Wrap the first occurrence of `matchText` inside `el` with one or more
 *  `<mark class="workspace-code-match">` elements, preserving Shiki's
 *  syntax-highlighting spans instead of dropping them.
 *
 *  Deliberately does NOT use `Range.surroundContents()` — a match spanning
 *  more than one of Shiki's colored `<span>`s (i.e. crossing a token
 *  boundary, the common case for anything longer than one identifier)
 *  requires surrounding a range that only partially selects several sibling
 *  elements, which has inconsistent support (confirmed failing in jsdom;
 *  real-browser behavior not independently verified, so treated as
 *  unreliable rather than relied upon). Instead, this isolates exactly the
 *  matched substring within EACH contributing text node via the far more
 *  basic, universally-supported `Text.splitText()`, then wraps each isolated
 *  piece in its own `<mark>` — a multi-token match gets one mark per token
 *  it touches rather than one mark spanning all of them, which is visually
 *  identical (adjacent marks with no gap between them read as one) but
 *  doesn't depend on Range's more failure-prone cross-node surround
 *  behavior. */
function markMatchInElement(el: HTMLElement, matchText: string): void {
  if (!matchText) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let concatenated = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    textNodes.push(t);
    concatenated += t.data;
  }
  const startIdx = concatenated.indexOf(matchText);
  if (startIdx < 0) return;
  const endIdx = startIdx + matchText.length;

  let pos = 0;
  for (const t of textNodes) {
    const len = t.data.length;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    pos += len;
    const overlapStart = Math.max(startIdx, nodeStart);
    const overlapEnd = Math.min(endIdx, nodeEnd);
    if (overlapStart >= overlapEnd) continue; // this node isn't part of the match

    const localStart = overlapStart - nodeStart;
    const localEnd = overlapEnd - nodeStart;
    // `splitText(n)` keeps [0,n) on the original node and returns a NEW
    // node holding [n,end) — chaining two splits isolates exactly
    // [localStart, localEnd) as its own node, still in place in the tree.
    let target: Text = t;
    if (localStart > 0) target = target.splitText(localStart);
    if (localEnd - localStart < target.data.length) target.splitText(localEnd - localStart);

    const mark = document.createElement("mark");
    mark.className = "workspace-code-match";
    target.replaceWith(mark);
    mark.appendChild(target);
  }
}

export function CodeView({ code, language: languageProp, filePath, themeMode, noGutter, gutterMarks, highlightLine, highlightMatchText }: CodeViewProps) {
  // `themeId` (the full 14-way value from the shared store) resolves to the
  // theme's Shiki id via the registry so syntax highlighting follows the theme.
  const { theme, themeId } = useTheme();
  const mode = themeMode ?? theme;
  // An explicit `themeMode` that differs from the active appearance is a
  // deliberate appearance-only override (e.g. the Settings hover-preview),
  // which carries no full themeId — fall back to the classic dark/light pair.
  const overridden = themeMode !== undefined && themeMode !== theme;
  const shikiThemeId = overridden
    ? mode === "light"
      ? "light-plus"
      : "dark-plus"
    : themeById[themeId]?.shikiThemeId ?? (mode === "light" ? "light-plus" : "dark-plus");

  const language = languageProp ?? (filePath ? languageForFilePath(filePath) : undefined);
  const shikiLang = language ? pickShikiLang(filePath, language) : "plaintext";

  const lines = useMemo(() => code.split("\n"), [code]);
  const gutterWidth = String(lines.length).length;

  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);

  useEffect(() => {
    if (!language) {
      setHighlightedLines(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const out = await highlightDocumentLines(code, shikiLang, shikiThemeId);
        if (!cancelled) setHighlightedLines(out);
      } catch {
        if (!cancelled) setHighlightedLines(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, language, shikiLang, shikiThemeId]);

  return (
    <pre className="workspace-code-viewer workspace-code-viewer--shiki">
      {lines.map((line, i) => {
        const lineNum = i + 1;
        const gutterMark = !noGutter ? gutterMarks?.get(lineNum) : undefined;
        const isTarget = highlightLine === lineNum;
        const modifierClass = `${gutterMark ? ` workspace-code-line--${gutterMark}` : ""}${isTarget ? " workspace-code-line--target" : ""}`;
        const wantsMatchMark = isTarget && !!highlightMatchText;
        let content: ReactNode;
        if (highlightedLines) {
          // Syntax-highlighted path: render Shiki's HTML normally, then (if
          // this is the target line with a match) inject the <mark> via DOM
          // surgery in a ref callback, preserving syntax color. `key` forces
          // a clean remount — starting fresh from the untouched Shiki HTML —
          // whenever `wantsMatchMark`/`highlightMatchText` changes for this
          // line, so a stale mark never lingers after the target moves on.
          content = (
            <span
              key={wantsMatchMark ? `shiki-marked-${highlightMatchText}` : "shiki"}
              className="workspace-code-content workspace-code-content--shiki"
              dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? escapeHtml(line) }}
              ref={
                wantsMatchMark
                  ? (el) => {
                      if (el) markMatchInElement(el, highlightMatchText!);
                    }
                  : undefined
              }
            />
          );
        } else if (wantsMatchMark) {
          // Shiki hasn't resolved yet — no syntax HTML exists to preserve,
          // so the plain-text split is a fine fallback (nothing to lose).
          const matchIdx = line.indexOf(highlightMatchText!);
          content =
            matchIdx >= 0 ? (
              <span className="workspace-code-content">
                {line.slice(0, matchIdx)}
                <mark className="workspace-code-match">{highlightMatchText}</mark>
                {line.slice(matchIdx + highlightMatchText!.length)}
              </span>
            ) : (
              <span className="workspace-code-content">{line}</span>
            );
        } else {
          content = <span className="workspace-code-content">{line}</span>;
        }
        return (
          <div key={i} className={`workspace-code-line${modifierClass}`} data-line={lineNum}>
            {!noGutter && (
              <span className="workspace-code-gutter" style={{ minWidth: `${gutterWidth + 2}ch` }}>
                {lineNum}
              </span>
            )}
            {content}
          </div>
        );
      })}
    </pre>
  );
}
