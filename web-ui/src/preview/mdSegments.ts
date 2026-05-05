/** Split markdown into alternating prose (GFM) and mermaid fenced blocks. */
export type MdSegment =
  | { type: "markdown"; content: string }
  | { type: "mermaid"; content: string };

export function segmentMarkdownWithMermaid(source: string): MdSegment[] {
  const segments: MdSegment[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const start = m.index;
    if (start > last) {
      segments.push({ type: "markdown", content: source.slice(last, start) });
    }
    const chart = m[1]?.trim() ?? "";
    segments.push({ type: "mermaid", content: chart });
    last = start + m[0].length;
    m = re.exec(source);
  }
  if (last < source.length) {
    segments.push({ type: "markdown", content: source.slice(last) });
  }
  if (segments.length === 0) {
    segments.push({ type: "markdown", content: source });
  }
  return segments;
}
