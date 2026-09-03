import type { Command } from "@/api/types";

/**
 * skill-invocation-in-chat REPLAN Phase 7B.2 — tokenizer, serializer, and
 * escaper for the flat inline-chip grammar (D2/D3):
 *
 *   segments := (text | token)*
 *   token    := "{/" name (" " args)? "}"
 *   name     := longest catalog match, opaque non-whitespace (may contain : and /)
 *   args     := everything to the token's closing "}"
 *
 * Escaping is CONTEXT-FREE: in plain text, `\` -> `\\` and `{` -> `\{`;
 * inside a token's args, additionally `}` -> `\}`. This makes tokenization
 * catalog-INDEPENDENT and guarantees `parseSkillSegments(serializeSkillSegments(x))`
 * is a fixpoint for ANY segment list.
 *
 * The brace grammar is purely an internal serialization (localStorage draft +
 * POST /chat body + what the daemon parses) — the user never types or sees a
 * brace; the editor renders chips, not the token syntax.
 *
 * This grammar is implemented TWICE — here, and independently in the
 * daemon's `skillTokens.ts` (separate package, no shared lib; see the plan's
 * Phase 7 Risk #1). Any change to tokenization or escaping rules must land
 * in BOTH, validated against the identical test-vector table that appears
 * in both suites (`daemon/src/__tests__/skillTokens.test.ts` /
 * `web-ui/src/lib/skillInvocation.test.ts`).
 */

/** One literal-text run between (or around) tokens. */
export interface SkillTextSegment {
  type: "text";
  text: string;
}

/** One `{/name[ args]}` token, already unescaped. */
export interface SkillTokenSegment {
  type: "token";
  name: string;
  args: string;
}

export type SkillSegment = SkillTextSegment | SkillTokenSegment;

/** Escape a plain-text run for serialization: `\` -> `\\`, `{` -> `\{`. */
export function escapeSkillText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{");
}

/** Escape a token's args for serialization: text escaping PLUS `}` -> `\}`. */
export function escapeSkillArgs(args: string): string {
  return escapeSkillText(args).replace(/\}/g, "\\}");
}

/**
 * Parse one `{/name[ args]}` token starting at `input[start] === "{"` (with
 * `input[start + 1] === "/"` already confirmed by the caller). Returns
 * `undefined` when unterminated (no unescaped closing `}` before the end of
 * the string) — the caller then treats the leading `{` as ordinary literal
 * text, exactly like any other stray `{`.
 */
function tryParseToken(
  input: string,
  start: number,
): { name: string; args: string; end: number } | undefined {
  const n = input.length;
  let j = start + 2; // skip "{/"
  let name = "";
  while (j < n && input[j] !== " " && input[j] !== "}") {
    name += input[j];
    j += 1;
  }
  if (j >= n) return undefined; // unterminated — no closing '}' or ' ' found
  if (input[j] === "}") return { name, args: "", end: j };

  // input[j] === " " — the single separator between name and args.
  j += 1;
  let args = "";
  while (j < n) {
    const c = input[j];
    if (c === "\\" && j + 1 < n && (input[j + 1] === "\\" || input[j + 1] === "{" || input[j + 1] === "}")) {
      args += input[j + 1];
      j += 2;
      continue;
    }
    if (c === "}") return { name, args, end: j };
    args += c;
    j += 1;
  }
  return undefined; // unterminated — no closing '}' found
}

/**
 * Parse a flat message string into a `(text | token)*` segment list. Never
 * throws: an unterminated `{/...` degrades to literal text, and a `\`
 * escape that doesn't match one of the two/three defined targets is left as
 * a literal backslash (arbitrary user prose — e.g. a Windows path — must
 * round-trip untouched, not be mangled by an escape rule it never invoked).
 */
export function parseSkillSegments(input: string): SkillSegment[] {
  const segments: SkillSegment[] = [];
  let buf = "";
  let i = 0;
  const n = input.length;

  const flush = () => {
    if (buf.length > 0) {
      segments.push({ type: "text", text: buf });
      buf = "";
    }
  };

  while (i < n) {
    const c = input[i];
    if (c === "\\" && i + 1 < n && (input[i + 1] === "\\" || input[i + 1] === "{")) {
      buf += input[i + 1];
      i += 2;
      continue;
    }
    if (c === "{" && input[i + 1] === "/") {
      const token = tryParseToken(input, i);
      if (token) {
        flush();
        segments.push({ type: "token", name: token.name, args: token.args });
        i = token.end + 1;
        continue;
      }
      // No matching unescaped '}' — not a token; fall through, '{' is literal.
    }
    buf += c;
    i += 1;
  }
  flush();
  return segments;
}

/** Serialize a segment list back to the flat string form — the inverse of `parseSkillSegments`. */
export function serializeSkillSegments(segments: SkillSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === "text") return escapeSkillText(seg.text);
      const argsPart = seg.args.length > 0 ? ` ${escapeSkillArgs(seg.args)}` : "";
      return `{/${seg.name}${argsPart}}`;
    })
    .join("");
}

/** Substring, case-insensitive filter over the catalog. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * Render a raw brace-token message string as PLAIN display text — tokens
 * become `/name args`, and escaped literal braces/backslashes are unescaped.
 * The brace grammar is an internal wire format only; nobody outside the
 * editor/daemon should ever see a `\{` or a `{/...}` token (Phase 7B.10 /
 * Phase 7 Risk 5).
 *
 * Used by surfaces that render a message as a single string — the queued-turn
 * tray row, its `title` and its `aria-label`. The transcript bubble does NOT
 * use this: `TextMessage` walks `parseSkillSegments` itself so it can style
 * the name and args separately.
 */
export function renderSkillMessageText(raw: string): string {
  const segments = parseSkillSegments(raw);
  return segments
    .map((seg) => {
      if (seg.type === "text") return seg.text;
      return seg.args.length > 0 ? `/${seg.name} ${seg.args}` : `/${seg.name}`;
    })
    .join("");
}

/** Longest catalog name matching literally at `text[start..]`, followed by a
 *  word boundary (end-of-string or whitespace) — used by the typeahead
 *  popover to decide whether a `/token` the user just finished typing is a
 *  real, resolvable command name. */
function matchLongestNameAt(text: string, start: number, catalogNames: string[]): string | null {
  let best: string | null = null;
  for (const name of catalogNames) {
    if (!name) continue;
    if (text.startsWith(name, start) && (!best || name.length > best.length)) {
      const after = text[start + name.length];
      if (after === undefined || /\s/.test(after)) best = name;
    }
  }
  return best;
}

/**
 * One-shot migration for a v1 draft (Phase 3/5/6's `/<name>[ <args>]\n<prose>`
 * canonical form) into the new brace-token flat string. A v1 draft has NO
 * `{/...}` tokens and its first line matches `/name[ args]` against the
 * catalog. Anything else (already-migrated, plain prose, unrecognized
 * leading slash) is returned unchanged. Pure, never throws.
 */
export function migrateV1Draft(raw: string, catalogNames: string[]): string {
  if (!raw.startsWith("/")) return raw;
  if (parseSkillSegments(raw).some((s) => s.type === "token")) return raw; // already v2+
  const nl = raw.indexOf("\n");
  const line1 = nl === -1 ? raw : raw.slice(0, nl);
  const rest = nl === -1 ? "" : raw.slice(nl + 1);
  const name = matchLongestNameAt(line1, 1, catalogNames);
  if (!name) return raw;
  const afterName = line1.slice(1 + name.length);
  const args = afterName.startsWith(" ") ? afterName.slice(1) : afterName;
  const token: SkillTokenSegment = { type: "token", name, args };
  const segments: SkillSegment[] = [token];
  if (rest.length > 0) segments.push({ type: "text", text: rest });
  return serializeSkillSegments(segments);
}
