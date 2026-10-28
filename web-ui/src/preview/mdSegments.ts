/** Split markdown into alternating prose (GFM) and fenced blocks (mermaid and,
 *  optionally, html). Only CLOSED fences match — streaming-safe. */
export type MdSegment =
  | { type: "markdown"; content: string }
  | { type: "mermaid"; content: string }
  | { type: "html"; content: string };

type OpenFence = { ch: string; len: number } | null;

/**
 * Forward-only CommonMark-ish fence tracker. Lets `segmentMarkdown` ask "is
 * this html fence nested inside a longer outer fence?" in one pass over the
 * source (it runs on every streaming token), instead of re-splitting the
 * prefix per match. `pos` only ever advances, so total work is linear.
 */
function makeFenceScanner(source: string) {
  let pos = 0;
  let open: OpenFence = null;
  const lineStart = (idx: number) => source.lastIndexOf("\n", idx - 1) + 1;
  const afterLine = (end: number) => {
    const nl = source.indexOf("\n", end);
    return nl < 0 ? source.length : nl + 1;
  };
  /** Scan whole lines in [pos, idx) (idx a line start); true if a fence is still open. */
  function scanTo(idx: number): boolean {
    if (idx > pos) {
      for (const line of source.slice(pos, idx).split("\n")) {
        if (open) {
          const c = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line);
          const marker = c?.[1] ?? "";
          if (marker && marker[0] === open.ch && marker.length >= open.len) open = null;
        } else {
          const o = /^ {0,3}(`{3,})[^`]*$|^ {0,3}(~{3,})/.exec(line);
          const marker = o?.[1] ?? o?.[2] ?? "";
          if (marker) open = { ch: marker[0] ?? "`", len: marker.length };
        }
      }
      pos = idx;
    }
    return open !== null;
  }
  return {
    /** Is the line containing `idx` inside an enclosing fence? (Scans up to that line.) */
    insideFenceAt: (idx: number): boolean => scanTo(lineStart(idx)),
    /** An html match [start,end) was accepted at top level: no fence is open past it. */
    consumeHtml(end: number): void {
      open = null;
      pos = afterLine(end);
    },
    /** A mermaid match was accepted (legacy: allowed anywhere): keep fence state, skip its lines. */
    consumeMermaid(start: number, end: number): void {
      scanTo(lineStart(start));
      pos = Math.max(pos, afterLine(end));
    },
  };
}

interface Match {
  start: number;
  end: number;
  lang: "mermaid" | "html";
  content: string;
}

/** Legacy matcher (html off): first closed ```mermaid fence, anywhere in a line. */
function mermaidOnlyMatcher(source: string) {
  const re = /```(mermaid)\n([\s\S]*?)```/g;
  return (): Match | null => {
    const m = re.exec(source);
    return m ? { start: m.index, end: m.index + m[0].length, lang: "mermaid", content: m[2] ?? "" } : null;
  };
}

/**
 * html-aware matcher. mermaid keeps the legacy rule (first ``` after the opener
 * closes it). html is stricter: the opener must start a line outside any
 * enclosing fence, and it closes only at a ``` run that ENDS its line (so
 * ``<pre>```js</pre>`` inside the html does not truncate the block). One linear
 * pass: every search resumes after the previous match, and once an html closer
 * search fails no later opener can succeed, so it is not retried.
 */
function htmlAwareMatcher(source: string, scanner: ReturnType<typeof makeFenceScanner>) {
  const opener = /```(mermaid\n|html\r?\n)/g;
  // (?<!`): a match may only start at the beginning of a run, or long runs go quadratic.
  const closer = /(?<!`)`{3,}[ \t]*\r?$/gm;
  let htmlClosable = true;
  return (): Match | null => {
    let o: RegExpExecArray | null;
    while ((o = opener.exec(source)) !== null) {
      const start = o.index;
      const bodyStart = start + o[0].length;
      if (o[1]?.startsWith("mermaid")) {
        const c = source.indexOf("```", bodyStart);
        if (c < 0) continue;
        opener.lastIndex = c + 3;
        return { start, end: c + 3, lang: "mermaid", content: source.slice(bodyStart, c) };
      }
      if (!htmlClosable) continue;
      if ((start > 0 && source[start - 1] !== "\n") || scanner.insideFenceAt(start)) continue;
      closer.lastIndex = bodyStart;
      const c = closer.exec(source);
      if (!c) {
        htmlClosable = false;
        continue;
      }
      opener.lastIndex = c.index + c[0].length;
      return {
        start,
        end: c.index + c[0].length,
        lang: "html",
        // The fence's own newline is not content.
        content: source.slice(bodyStart, c.index).replace(/\r?\n$/, ""),
      };
    }
    return null;
  };
}

/** A segment plus the raw-source offset it starts at (fence and all for mermaid / html). */
function scanSegments(source: string, opts?: { html?: boolean }): Array<{ seg: MdSegment; start: number }> {
  const scanner = opts?.html === true ? makeFenceScanner(source) : null;
  const next = scanner ? htmlAwareMatcher(source, scanner) : mermaidOnlyMatcher(source);
  const out: Array<{ seg: MdSegment; start: number }> = [];
  let last = 0;
  for (let m = next(); m !== null; m = next()) {
    if (scanner) {
      if (m.lang === "html") scanner.consumeHtml(m.end);
      else scanner.consumeMermaid(m.start, m.end);
    }
    if (m.start > last) {
      out.push({ seg: { type: "markdown", content: source.slice(last, m.start) }, start: last });
    }
    out.push({
      seg:
        m.lang === "mermaid"
          ? { type: "mermaid", content: m.content.trim() }
          : { type: "html", content: m.content },
      start: m.start,
    });
    last = m.end;
  }
  if (last < source.length) {
    out.push({ seg: { type: "markdown", content: source.slice(last) }, start: last });
  }
  if (out.length === 0) {
    out.push({ seg: { type: "markdown", content: source }, start: 0 });
  }
  return out;
}

export function segmentMarkdown(
  source: string,
  opts?: { html?: boolean },
): MdSegment[] {
  return scanSegments(source, opts).map((x) => x.seg);
}

/** `MdSegment` plus the 1-based line of the ORIGINAL source its first line sits on. */
export type MdSegmentWithLine = MdSegment & { startLine: number };

/**
 * Same split as `segmentMarkdown`, each segment tagged with its absolute `startLine`, counted from RAW source
 * offsets (newlines before the segment start). Never derive it by summing segment `content` lines: mermaid
 * segments are trimmed with their fences dropped, and a segment may start mid-line (a fence matched
 * anywhere in a line), so the following segment's first line is the line the fence closed on. Comments on
 * rendered markdown need it because react-markdown positions are relative to the segment it is given.
 */
export function segmentMarkdownWithLines(source: string, opts?: { html?: boolean }): MdSegmentWithLine[] {
  const scanned = scanSegments(source, opts);
  const out: MdSegmentWithLine[] = [];
  let pos = 0;
  let line = 1;
  for (const { seg, start } of scanned) {
    for (let i = source.indexOf("\n", pos); i !== -1 && i < start; i = source.indexOf("\n", i + 1)) line += 1;
    pos = Math.max(pos, start);
    out.push({ ...seg, startLine: line });
  }
  return out;
}
