/**
 * Diagnostic input log (mobile double-text investigation).
 *
 * Append-only NDJSON sink for terminal input + client IME/composition events.
 * Used to capture a live repro of the mobile "double text" bug on a real device
 * — the phone's browser console is unreachable, so the client ships events over
 * the WS (`debug:log`) and the daemon writes them here, interleaved with the
 * raw bytes each `session:input` delivered.
 *
 * Privacy/footprint: nothing is written unless a client opts in by enabling
 * input debugging (?debugInput=1), which is what triggers the `debug:log`
 * messages in the first place. Default operation writes nothing. Override the
 * directory with VST_DEBUG_LOG_DIR (defaults to <HOME>/.vibe-station).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedDir: string | null = null;
let ensured = false;
let chain: Promise<void> = Promise.resolve();

function logDir(): string {
  if (cachedDir) return cachedDir;
  cachedDir = process.env.VST_DEBUG_LOG_DIR || join(homedir(), ".vibe-station");
  return cachedDir;
}

/** Append one record. Best-effort and serialized so concurrent writers (the
 *  batched client events + per-keystroke server log) don't interleave bytes. */
export function appendDebug(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  chain = chain
    .then(async () => {
      const dir = logDir();
      if (!ensured) {
        await mkdir(dir, { recursive: true });
        ensured = true;
      }
      await appendFile(join(dir, "input-debug.log"), line);
    })
    .catch(() => {
      /* never let logging crash input handling */
    });
}
