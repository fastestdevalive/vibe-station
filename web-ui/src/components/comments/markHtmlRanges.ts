export interface HtmlMarkRange {
  /** Text offset (UTF-16, entities count as one unit) of the first marked character. */
  start: number;
  /** Exclusive end. */
  end: number;
  id: string;
  outdated?: boolean;
  /** The open (unsaved) box's span: dashed instead of solid. */
  draft?: boolean;
}

const TOKEN = /<[^>]*>|&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);|[^<&]+|&/g;

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function open(r: HtmlMarkRange): string {
  return `<mark class="comment-hl${r.outdated ? " comment-hl--outdated" : ""}${r.draft ? " comment-hl--draft" : ""}" data-comment-id="${escAttr(r.id)}">`;
}

/**
 * Wrap text ranges of a Shiki line's HTML in `<mark data-comment-id>`, keeping the markup well nested:
 * marks are closed before every tag and reopened on the next text, so a range crossing token spans becomes one
 * mark per run. Offsets count the DECODED text (an entity such as `&lt;` is one unit). Returns the input
 * untouched when there is nothing to mark. Overlapping ranges nest, earlier ranges outermost.
 */
export function markHtmlRanges(html: string, ranges: readonly HtmlMarkRange[]): string {
  const rs = ranges.filter((r) => r.end > r.start && r.start >= 0).sort((a, b) => a.start - b.start || a.end - b.end);
  if (rs.length === 0) return html;
  let out = "";
  let pos = 0;
  let openIds: HtmlMarkRange[] = [];

  const closeAll = () => {
    out += "</mark>".repeat(openIds.length);
    openIds = [];
  };
  const emitUnit = (raw: string, width: number) => {
    const active = rs.filter((r) => r.start <= pos && pos < r.end);
    const same = active.length === openIds.length && active.every((r, i) => r === openIds[i]);
    if (!same) {
      closeAll();
      for (const r of active) out += open(r);
      openIds = active;
    }
    out += raw;
    pos += width;
  };

  for (const m of html.matchAll(TOKEN)) {
    const tok = m[0];
    if (tok.startsWith("<")) {
      closeAll();
      out += tok;
    } else if (tok.startsWith("&") && tok.length > 1) {
      emitUnit(tok, 1);
    } else {
      // Plain text: one unit per code point (never split a surrogate pair).
      for (const ch of tok) emitUnit(ch, ch.length);
    }
  }
  closeAll();
  return out;
}

/** Plain-text variant for a line without Shiki HTML (escaped, then marked). */
export function markPlainRanges(text: string, ranges: readonly HtmlMarkRange[]): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return markHtmlRanges(escaped, ranges);
}
