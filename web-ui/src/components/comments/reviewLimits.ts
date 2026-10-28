import type { ReviewComment } from "@/api/types";

/** Mirrors `rust/vst-types/src/review.rs` limits (R53-R55, R66). */
export const MAX_COMMENTS = 500;
export const MAX_TEXT_BYTES = 8192;
export const MAX_QUOTE_BYTES = 2048;
export const RICH_SEND_MAX_COMMENTS = 200;
export const RICH_SEND_MAX_BYTES = 131_072;
export const TERMINAL_SEND_MAX_BYTES = 32_768;

/** Bytes of the `Review comments (N) · <name>` header plus its trailing blank line (a client-side estimate). */
const HEADER_OVERHEAD = 32;

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Cut `s` to at most `max` UTF-8 bytes on a code-point boundary (the daemon rejects a quote over 2 KB, so the
 * client truncates instead of failing the add).
 */
export function truncateUtf8(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

export type SendTarget = "rich" | "terminal";

/** Estimated size of the rendered review block for these comments (sum of per-comment `blockBytes` + header). */
export function blockBytes(comments: readonly Pick<ReviewComment, "blockBytes">[], name = ""): number {
  if (comments.length === 0) return 0;
  return HEADER_OVERHEAD + utf8Bytes(name) + comments.reduce((n, c) => n + c.blockBytes, 0);
}

export interface SendLimitCheck {
  over: boolean;
  /** How far over: `unit` says which limit tripped first. */
  excess?: number;
  unit?: "comments" | "bytes";
}

/** Is this selection too large to send? Copy as text is never limited (R66); only Send / Attach / Schedule. */
export function checkSendLimit(
  comments: readonly Pick<ReviewComment, "blockBytes">[],
  target: SendTarget,
  name = "",
): SendLimitCheck {
  if (target === "rich" && comments.length > RICH_SEND_MAX_COMMENTS) {
    return { over: true, excess: comments.length - RICH_SEND_MAX_COMMENTS, unit: "comments" };
  }
  const limit = target === "rich" ? RICH_SEND_MAX_BYTES : TERMINAL_SEND_MAX_BYTES;
  const bytes = blockBytes(comments, name);
  return bytes > limit ? { over: true, excess: bytes - limit, unit: "bytes" } : { over: false };
}
