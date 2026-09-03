/**
 * skill-invocation-in-chat REPLAN Phase 7 (D2/D3) — tokenizer, serializer,
 * and escaper for the flat inline-chip grammar:
 *
 *   segments := (text | token)*
 *   token    := "{/" name (" " args)? "}"
 *   name     := longest catalog match, opaque non-whitespace (may contain : and /)
 *   args     := everything to the token's closing "}"
 *
 * Escaping is CONTEXT-FREE (D3): in plain text, `\` -> `\\` and `{` -> `\{`;
 * inside a token's args, additionally `}` -> `\}`. This makes tokenization
 * catalog-INDEPENDENT — parsing never needs to know a name to decide where a
 * token starts or ends — and guarantees
 * `parseSkillSegments(serializeSkillSegments(x)) === x` for ANY segment
 * list, including prose that itself contains literal braces or backslashes.
 *
 * This grammar is implemented TWICE — here, and independently in web-ui's
 * `skillInvocation.ts` (separate package, no shared lib; see the plan's
 * Phase 7 Risk #1). Any change to tokenization or escaping rules must land
 * in BOTH, validated against the identical test-vector table that appears
 * in both suites (`daemon/src/__tests__/skillTokens.test.ts`).
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
