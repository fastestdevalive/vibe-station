import type { ReviewCommentSnapshot, ReviewRecord } from "@/api/types";

export interface ParsedReviewText {
  /** The user's own words before the block (blank when there were none). */
  message: string;
  record: ReviewRecord;
}

/** Cheap pre-check before running the parser (the header is defined in `review_format.rs`). */
export const looksLikeReviewText = (text: string): boolean => text.includes("Review comments (");

/** ` · name` is optional: the Rust renderer omits it when the sanitized name is empty. */
const HEADER = /^Review comments \((\d+)\)(?: · (.*))?$/;
const ITEM = /^(\d+)\) File: (.*)$/;
const BODY_PREFIX = "   | ";

/** Labelled value: `   Label: value`, or `   Label:` then `   | ` lines. Returns the next index. */
function readBody(lines: string[], i: number, label: string): { value: string; quoted: boolean; next: number } | null {
  const line = lines[i];
  if (line == null) return null;
  const head = `   ${label}:`;
  if (!line.startsWith(head)) return null;
  const rest = line.slice(head.length);
  if (rest === "") {
    // Multi-line body (or an empty one): every following line carries the fixed prefix.
    const out: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j]!.startsWith(BODY_PREFIX) || lines[j] === BODY_PREFIX.trimEnd())) {
      out.push(lines[j]!.slice(BODY_PREFIX.length));
      j += 1;
    }
    return { value: out.join("\n"), quoted: false, next: j };
  }
  if (!rest.startsWith(" ")) return null;
  const v = rest.slice(1);
  if (label === "Quote" && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return { value: v.slice(1, -1).replace(/\\"/g, '"'), quoted: true, next: i + 1 };
  }
  return { value: v, quoted: false, next: i + 1 };
}

function parseItem(pin: number, fileRest: string, lines: string[]): ReviewCommentSnapshot | null {
  let path = fileRest;
  let anchor: ReviewCommentSnapshot["anchor"] = "anchored";
  if (path.endsWith(" (outdated)")) {
    anchor = "outdated";
    path = path.slice(0, -" (outdated)".length);
  } else if (path.endsWith(" (file no longer exists)")) {
    anchor = "file_missing";
    path = path.slice(0, -" (file no longer exists)".length);
  }
  if (!path) return null;

  let i = 0;
  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  let side: ReviewCommentSnapshot["side"];
  let scope: ReviewCommentSnapshot["diffScope"];
  const meta = lines[i]?.match(/^ {3}Lines: (\d+)(?:–(\d+))?(?: {3}Side: (old|new))?(?: {3}Scope: (local|branch) changes)?$/);
  const metaNoLines = lines[i]?.match(/^ {3}Side: (old|new)(?: {3}Scope: (local|branch) changes)?$/);
  if (meta) {
    lineStart = Number(meta[1]);
    lineEnd = meta[2] ? Number(meta[2]) : lineStart;
    side = meta[3] as typeof side;
    scope = meta[4] as typeof scope;
    i += 1;
  } else if (metaNoLines) {
    side = metaNoLines[1] as typeof side;
    scope = metaNoLines[2] as typeof scope;
    i += 1;
  }
  // The Quote line is omitted for an empty quote (a blank-line gutter comment).
  const quote = readBody(lines, i, "Quote") ?? { value: "", quoted: false, next: i };
  const comment = readBody(lines, quote.next, "Comment");
  if (!comment || comment.next !== lines.length) return null;

  const diff = scope !== undefined || side !== undefined;
  return {
    id: `parsed-${pin}`,
    pin,
    path,
    pathKind: path.startsWith("/") ? "artifact" : "repo",
    surface: diff ? "diff" : "file",
    ...(scope ? { diffScope: scope } : {}),
    ...(side ? { side } : {}),
    ...(lineStart != null ? { lines: { start: lineStart, end: lineEnd ?? lineStart } } : {}),
    quote: quote.value,
    text: comment.value,
    anchor,
  };
}

/**
 * Tolerant parser for imported history (R75): a terminal-era user message that carries the Appendix A block
 * (`Review comments (N) · name` followed by numbered `File:` items, fixed `   | ` body prefix) becomes a
 * `ReviewRecord`, so the card shows its footer instead of the raw text. Anything that does not parse as a
 * whole, or whose item count disagrees with the header, returns `null` and stays plain text.
 */
export function parseReviewText(text: string): ParsedReviewText | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  // The block is the LAST header that parses cleanly to the end of the text.
  for (let h = lines.length - 1; h >= 0; h--) {
    const head = lines[h]!.match(HEADER);
    if (!head) continue;
    const count = Number(head[1]);
    if (lines[h + 1] !== "") continue;
    const items: ReviewCommentSnapshot[] = [];
    let at = h + 2;
    let ok = true;
    while (at < lines.length) {
      const first = lines[at]!.match(ITEM);
      if (!first) {
        ok = false;
        break;
      }
      let end = at + 1;
      while (end < lines.length && lines[end] !== "" ) end += 1;
      // A blank line ends an item only when the next line starts another item; blank body lines carry `   | `.
      const body = lines.slice(at + 1, end);
      const snap = parseItem(Number(first[1]), first[2]!, body);
      if (!snap) {
        ok = false;
        break;
      }
      items.push(snap);
      at = end < lines.length ? end + 1 : end;
    }
    if (!ok || items.length === 0 || items.length !== count) continue;
    const message = lines.slice(0, h).join("\n").replace(/\n+$/, "");
    return { message, record: { name: head[2] ?? "", comments: items } };
  }
  return null;
}
