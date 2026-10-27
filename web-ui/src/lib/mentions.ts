import type { Mention, MentionKind } from "@/api/types";
import { isKnownMentionKind, MENTION_KINDS, mentionKindDef } from "@/components/mentions/kinds";
import {
  escapeSkillArgs,
  escapeSkillText,
  parseSkillSegments,
  serializeSkillSegments,
  type SkillSegment,
} from "./skillInvocation";

export const MAX_MENTIONS = 50;

/**
 * Sanitize mention label: replace control characters with space, trim, and cap at 80 characters.
 */
export function sanitizeMentionLabel(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Quote plain form if it contains whitespace, quotes, or backslashes.
 */
export function quotePlain(x: string): string {
  if (/^[^\s"\\]+$/.test(x)) {
    return x;
  }
  return `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Plain text representation of a mention.
 */
export function mentionPlainText(m: Mention): string {
  const def = mentionKindDef(m.kind);
  return `${def.plainPrefix}${quotePlain(def.plainValue === "id" ? m.id : m.label)}`;
}

/**
 * Chip label that is never empty: sanitized label, else the file basename /
 * id, else the kind. An empty label makes the daemon reject the whole send.
 */
export function safeMentionLabel(m: Mention): string {
  const label = sanitizeMentionLabel(m.label);
  if (label) return label;
  const base = m.kind === "file" ? (m.id.split("/").pop() ?? m.id) : m.id;
  return sanitizeMentionLabel(base) || sanitizeMentionLabel(m.id) || String(m.kind) || "mention";
}

/**
 * Shared boundary rules.
 */
export function isLeftBoundary(s: string): boolean {
  if (s.length === 0) return true;
  const last = s[s.length - 1];
  if (!last) return true;
  return (
    /\s/.test(last) ||
    last === "(" ||
    last === "[" ||
    last === "{" ||
    last === '"' ||
    last === "'"
  );
}

export function isRightBoundary(t: string, i: number): boolean {
  if (i >= t.length) return true;
  const c = t[i];
  if (!c) return true;
  if (
    /\s/.test(c) ||
    c === "," ||
    c === ";" ||
    c === ":" ||
    c === "!" ||
    c === "?" ||
    c === ")" ||
    c === "]" ||
    c === "}"
  ) {
    return true;
  }
  const nextChar = t[i + 1];
  if (c === "." && (i + 1 >= t.length || (nextChar !== undefined && /\s/.test(nextChar)))) {
    return true;
  }
  return false;
}

export type DraftSegment =
  | SkillSegment
  | { type: "mention"; mention: Mention };

export function serializeMentionToken(m: Mention): string {
  return `{@${m.kind} ${escapeSkillArgs(JSON.stringify([m.id, m.label]))}}`;
}


/**
 * Parse draft segments (supporting both skill tokens and {@kind [id,label]} mention tokens).
 */
export function parseDraftSegments(input: string): DraftSegment[] {
  const result: DraftSegment[] = [];
  let rawBuf = "";
  let i = 0;
  const n = input.length;

  const flushRaw = () => {
    if (rawBuf.length > 0) {
      const parsed = parseSkillSegments(rawBuf);
      result.push(...parsed);
      rawBuf = "";
    }
  };

  while (i < n) {
    const c = input[i];

    // Skip escaped backslash or escaped brace
    if (c === "\\" && i + 1 < n && (input[i + 1] === "\\" || input[i + 1] === "{")) {
      rawBuf += (input[i] ?? "") + (input[i + 1] ?? "");
      i += 2;
      continue;
    }

    if (c === "{" && input[i + 1] === "@") {
      // Potential mention token `{@kind [id,label]}`
      let j = i + 2;
      let kind = "";
      while (j < n && input[j] !== " " && input[j] !== "}") {
        kind += input[j];
        j += 1;
      }
      if (j < n && input[j] === " " && isKnownMentionKind(kind)) {
        j += 1; // skip space
        let args = "";
        let closed = false;
        let end = -1;
        while (j < n) {
          const ch = input[j];
          if (
            ch === "\\" &&
            j + 1 < n &&
            (input[j + 1] === "\\" || input[j + 1] === "{" || input[j + 1] === "}")
          ) {
            args += input[j + 1];
            j += 2;
            continue;
          }
          if (ch === "}") {
            closed = true;
            end = j;
            break;
          }
          args += ch;
          j += 1;
        }

        if (closed) {
          let parsedTuple: unknown;
          try {
            parsedTuple = JSON.parse(args);
          } catch {
            parsedTuple = null;
          }

          if (
            Array.isArray(parsedTuple) &&
            parsedTuple.length === 2 &&
            typeof parsedTuple[0] === "string" &&
            typeof parsedTuple[1] === "string"
          ) {
            flushRaw();
            result.push({
              type: "mention",
              mention: {
                kind: kind as MentionKind,
                id: parsedTuple[0],
                label: parsedTuple[1],
              },
            });
            i = end + 1;
            continue;
          }
        }
      }
      // If we reach here, not a valid token: '{' is literal
    }

    rawBuf += c;
    i += 1;
  }

  flushRaw();
  return result;
}

export function serializeDraftSegments(segments: DraftSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === "mention") {
        return serializeMentionToken(seg.mention);
      }
      if (seg.type === "text") {
        return escapeSkillText(seg.text);
      }
      const argsPart = seg.args.length > 0 ? ` ${escapeSkillArgs(seg.args)}` : "";
      return `{/${seg.name}${argsPart}}`;
    })
    .join("");
}

/**
 * Ids are untrusted strings. Only a conservative charset of bounded length is
 * ever written inline as `(id=...)`; anything else is omitted from the text
 * (the `mentions[]` sidecar and the daemon's `[Mentions:]` block still carry
 * it) rather than escaped, so the inline form never needs unescaping.
 */
const SAFE_INLINE_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_ID_BODY = "[A-Za-z0-9._:/-]{1,128}";

export function isSafeInlineId(id: string): boolean {
  return SAFE_INLINE_ID_RE.test(id);
}

/**
 * THE serializer for a mention in sent text (used by `toWire` and
 * `toPlainText`): `@path` for files (the path is the identity), otherwise
 * `plain(m) (id=<id>)` when the id is safe to inline.
 */
export function mentionWireText(m: Mention): string {
  const base = mentionPlainText(m);
  return m.kind !== "file" && isSafeInlineId(m.id) ? `${base} (id=${m.id})` : base;
}

export function toWire(draft: string): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  let out = "";
  let padNext = false;

  for (const seg of parseDraftSegments(draft)) {
    let piece: string;
    if (seg.type === "mention") {
      piece = escapeSkillText(mentionWireText(seg.mention));
    } else if (seg.type === "text") {
      piece = escapeSkillText(seg.text);
    } else {
      piece = serializeSkillSegments([seg]);
    }

    if (padNext && piece.length > 0 && !isRightBoundary(piece, 0)) {
      out += " ";
    }
    if (seg.type === "mention") {
      if (!isLeftBoundary(out)) {
        out += " ";
      }
      mentions.push(seg.mention);
    }
    out += piece;
    padNext = seg.type === "mention";
  }

  return { text: out, mentions: mentions.slice(0, MAX_MENTIONS) };
}

/** Sidecar-less text (schedule, fork): identical text to `toWire(draft).text`. */
export function toPlainText(draft: string): string {
  return toWire(draft).text;
}

const QUOTED_OR_BARE = '"(?:[^"\\\\]|\\\\.)*"|[^\\s"\\\\]+';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquotePlain(tok: string): string {
  if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
    return tok.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return tok;
}

/** Replace `[start,end)` of text segment `sIdx` with a mention chip. */
function spliceMention(
  segments: DraftSegment[],
  sIdx: number,
  start: number,
  end: number,
  mention: Mention,
): void {
  const seg = segments[sIdx];
  if (!seg || seg.type !== "text") return;
  const replacements: DraftSegment[] = [];
  if (start > 0) replacements.push({ type: "text", text: seg.text.slice(0, start) });
  replacements.push({ type: "mention", mention });
  if (end < seg.text.length) replacements.push({ type: "text", text: seg.text.slice(end) });
  segments.splice(sIdx, 1, ...replacements);
}

/** Boundary-checked regex hits for `re` (global) in a text segment. */
function* boundedMatches(text: string, re: RegExp): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (isLeftBoundary(text.slice(0, m.index)) && isRightBoundary(text, m.index + m[0].length)) {
      yield m;
    }
  }
}

const ID_SUFFIX_AFTER_RE = new RegExp(`^ \\(id=(${SAFE_ID_BODY})\\)`);

/**
 * Rebuild draft form from wire text + sidecar. Pairing is by ID first:
 * a span `<plain> (id=X)` binds to the sidecar entry whose id is X, whatever
 * its label says (duplicate or renamed labels). Only mentions with no
 * id-bearing span (old messages, files, unsafe ids) fall back to matching the
 * plain text. A span whose id is not in the sidecar becomes a chip from the
 * inline id+label; no text is ever dropped. Only plain-text segments are
 * searched, so skill-token args are never touched.
 */
export function fromWire(wire: string, mentions?: Mention[]): string {
  if (!mentions || mentions.length === 0) {
    return wire;
  }

  const segments: DraftSegment[] = parseSkillSegments(wire);
  const done: boolean[] = mentions.map(() => false);

  // Pass 1: by id.
  mentions.forEach((m, i) => {
    if (m.kind === "file" || !isSafeInlineId(m.id)) return;
    const re = new RegExp(
      `${escapeRegExp(mentionKindDef(m.kind).plainPrefix)}(?:${QUOTED_OR_BARE}) \\(id=${escapeRegExp(m.id)}\\)`,
      "g",
    );
    for (let sIdx = 0; sIdx < segments.length && !done[i]; sIdx++) {
      const seg = segments[sIdx];
      if (!seg || seg.type !== "text") continue;
      for (const hit of boundedMatches(seg.text, re)) {
        spliceMention(segments, sIdx, hit.index, hit.index + hit[0].length, m);
        done[i] = true;
        break;
      }
    }
  });

  // Pass 2: legacy plain-text matching for the rest.
  mentions.forEach((m, i) => {
    if (done[i]) return;
    const needle = mentionPlainText(m);
    for (let sIdx = 0; sIdx < segments.length && !done[i]; sIdx++) {
      const seg = segments[sIdx];
      if (!seg || seg.type !== "text") continue;
      let from = 0;
      for (;;) {
        const hit = seg.text.indexOf(needle, from);
        if (hit === -1) break;
        const end = hit + needle.length;
        from = hit + 1;
        if (!isLeftBoundary(seg.text.slice(0, hit)) || !isRightBoundary(seg.text, end)) continue;
        // A span carrying someone else's id belongs to that mention.
        if (m.kind !== "file" && ID_SUFFIX_AFTER_RE.test(seg.text.slice(end))) continue;
        spliceMention(segments, sIdx, hit, end, m);
        done[i] = true;
        break;
      }
    }
  });

  // Pass 3: id-bearing spans whose id is not in the sidecar.
  const known = MENTION_KINDS.filter((d) => d.kind !== "file");
  const orphanRe = new RegExp(
    `(${known.map((d) => escapeRegExp(d.plainPrefix)).join("|")})(${QUOTED_OR_BARE}) \\(id=(${SAFE_ID_BODY})\\)`,
    "g",
  );
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    if (!seg || seg.type !== "text") continue;
    for (const hit of boundedMatches(seg.text, orphanRe)) {
      const def = known.find((d) => d.plainPrefix === hit[1]);
      if (!def) continue;
      const id = hit[3] ?? "";
      spliceMention(segments, sIdx, hit.index, hit.index + hit[0].length, {
        kind: def.kind,
        id,
        label: safeMentionLabel({ kind: def.kind, id, label: unquotePlain(hit[2] ?? "") }),
      });
      sIdx -= 1; // re-scan the remainder (now a later text segment)
      break;
    }
  }

  return serializeDraftSegments(segments);
}

export function renderDraftText(raw: string): string {
  const segments = parseDraftSegments(raw);
  return segments
    .map((seg) => {
      if (seg.type === "mention") {
        return mentionPlainText(seg.mention);
      }
      if (seg.type === "text") {
        return seg.text;
      }
      return seg.args.length > 0 ? `/${seg.name} ${seg.args}` : `/${seg.name}`;
    })
    .join("");
}
