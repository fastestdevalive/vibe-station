/**
 * Random id generator that works outside secure contexts.
 *
 * `crypto.randomUUID` is only exposed on secure origins (https:// and
 * localhost). Vibe Station's web UI is routinely opened over plain HTTP on a
 * LAN IP or hostname (phone/tablet/other machine on the network — see the PWA
 * support), where `crypto.randomUUID` is `undefined` and calling it throws
 * `TypeError: crypto.randomUUID is not a function`. There is no React error
 * boundary above the workspace tree, so such a throw blanks the entire app.
 *
 * `crypto.getRandomValues` IS available in insecure contexts, so use it when
 * `randomUUID` is missing and only fall back to `Math.random` if even that is
 * gone. Output is always a v4-shaped UUID string; these ids are local layout
 * identifiers, not security tokens.
 */
export function randomId(): string {
  const c: Crypto | undefined = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 v4 bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
