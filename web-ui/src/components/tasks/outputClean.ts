/** Max characters kept per output line (display and Copy output). */
export const MAX_LINE_CHARS = 2000;

// CSI sequences (ESC [ params intermediates final) — covers SGR colours, cursor moves and erase codes.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// Other ESC-introduced sequences: OSC (ESC ] ... BEL|ST) and lone two-char escapes.
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\u001b[@-Z\\-_]/g;

/**
 * Clean one raw output line for display: strip ANSI escapes, keep only the last `\r` segment (a progress
 * bar rewrites its own line), cap at {@link MAX_LINE_CHARS} with `…`. Lossy-decoded `�` passes through.
 */
export function cleanLine(raw: string): string {
  let s = raw.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "");
  const cr = s.lastIndexOf("\r");
  if (cr !== -1) {
    // A trailing `\r` (CRLF remnant) must not blank the line: take the last NON-empty segment.
    const segs = s.split("\r").filter((p) => p.length > 0);
    s = segs.length ? segs[segs.length - 1]! : "";
  }
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s;
}

export function cleanLines(lines: readonly string[]): string[] {
  return lines.map(cleanLine);
}

/** The text Copy output writes: exactly the cleaned lines shown. */
export function cleanedText(lines: readonly string[]): string {
  return cleanLines(lines).join("\n");
}
