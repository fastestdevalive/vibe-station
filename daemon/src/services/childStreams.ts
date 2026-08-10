/**
 * Guard a spawned child's stdio pipes against unhandled stream errors.
 *
 * `child.on("error")` only covers spawn/kill failures — it does NOT cover
 * errors emitted on `child.stdin`/`stdout`/`stderr`, which are separate
 * streams. An `EPIPE` (writing to a child that already died) or `ECONNRESET`
 * (its end of the pipe torn down mid-read) on one of those streams with no
 * listener is an unhandled `'error'` event, and Node's default for that is to
 * throw out of the event loop and **kill the process**.
 *
 * For this daemon that means every browser terminal, every attached agent and
 * every watcher dies because one `rg` or one agent turn was SIGKILLed at an
 * awkward moment. Observed in production as:
 *
 *     Error: read ECONNRESET
 *         at Pipe.onStreamRead (node:internal/stream_base_commons:216:20)
 *     Emitted 'error' event on Socket instance
 *
 * Call this immediately after every `spawn()` whose stdio the daemon touches.
 * Real read/write failures still surface through the normal paths (the child
 * exits, readline ends, the promise settles) — this only stops the process
 * from dying over a pipe that is already going away.
 */
import type { ChildProcess } from "node:child_process";

export function guardChildStdio(child: ChildProcess, label: string): void {
  for (const [name, stream] of [
    ["stdin", child.stdin],
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    stream?.on("error", (err: NodeJS.ErrnoException) => {
      // EPIPE/ECONNRESET on a dying child is expected and not worth logging at
      // warn level on every abort; anything else is genuinely unusual.
      if (err?.code === "EPIPE" || err?.code === "ECONNRESET") return;
      console.warn(`[child:${label}] ${name} stream error: ${err?.message ?? String(err)}`);
    });
  }
}
