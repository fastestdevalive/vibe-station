import { describe, it, expect } from "vitest";
import { daemonPatch, daemonGet, daemonPost, daemonPut, daemonDelete } from "../lib/daemon-client.js";

describe("daemonPatch", () => {
  it("is exported as a function", () => {
    expect(typeof daemonPatch).toBe("function");
  });

  it("has the same signature pattern as daemonPut", () => {
    // daemonPatch<T>(path: string, body?: unknown): Promise<DaemonResult<T>>
    // This is a compile-time check via TypeScript, but we can verify the function exists
    expect(daemonPatch).toBeDefined();
    expect(daemonPut).toBeDefined();
    // Both should be async functions that accept path and optional body
    expect(daemonPatch.length).toBe(daemonPut.length);
  });
});
