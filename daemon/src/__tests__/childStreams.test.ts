/**
 * Regression: an unhandled `'error'` on a child process's stdio pipe used to
 * take the WHOLE DAEMON down.
 *
 * Observed in production as:
 *
 *     Error: read ECONNRESET
 *         at Pipe.onStreamRead (node:internal/stream_base_commons:216:20)
 *     Emitted 'error' event on Socket instance
 *
 * Which the user experiences as "the web terminal accepts no input at all" —
 * not keyboard, not touch, not scroll — because every one of those is a
 * WebSocket round-trip to a daemon that is no longer running.
 *
 * The trap is that `child.on("error")` does NOT cover errors emitted on
 * `child.stdin`/`stdout`/`stderr`; those are separate streams with their own
 * `'error'` events, and Node's default for an unhandled one is to throw out of
 * the event loop.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { guardChildStdio } from "../services/childStreams.js";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as Record<string, unknown>).stdin = new EventEmitter();
  (child as unknown as Record<string, unknown>).stdout = new EventEmitter();
  (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
  return child;
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`read ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("guardChildStdio", () => {
  it("swallows ECONNRESET/EPIPE on every stdio stream instead of letting it kill the process", () => {
    const child = fakeChild();
    guardChildStdio(child, "test");

    // Without a listener, EventEmitter rethrows an 'error' emit — which is
    // exactly the crash. With the guard installed these must be inert.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      expect(() => stream!.emit("error", errno("ECONNRESET"))).not.toThrow();
      expect(() => stream!.emit("error", errno("EPIPE"))).not.toThrow();
    }
  });

  it("does not throw on an unexpected stream error either (it is logged, not fatal)", () => {
    const child = fakeChild();
    guardChildStdio(child, "test");
    expect(() => child.stdout!.emit("error", errno("EACCES"))).not.toThrow();
  });

  it("tolerates a child with no piped stdio", () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    expect(() => guardChildStdio(child, "test")).not.toThrow();
  });

  it("demonstrates the unguarded behaviour it protects against", () => {
    // Sanity check that the hazard is real and this guard is what prevents it.
    const unguarded = new EventEmitter();
    expect(() => unguarded.emit("error", errno("ECONNRESET"))).toThrow(/ECONNRESET/);
  });
});
