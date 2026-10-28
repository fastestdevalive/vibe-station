import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** 8.T6 — `useScheduledSends` is the only reader of the scheduled rows. */
describe("scheduled-send single source", () => {
  const allowed = new Set([
    "api/types.ts",
    "api/mock.ts",
    "api/client.ts",
    // Mirrors the fields into chat meta to keep its shape whole; nothing renders them.
    "hooks/useChat.ts",
    "components/schedule/useScheduledSends.ts",
    // Canned dev-simulator snapshots (writes, never reads).
    "components/schedule/scheduleDevOverride.ts",
  ]);

  it("no component reads meta.scheduledSends / meta.scheduledFailed outside the hook", () => {
    const offenders = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
      .map((f) => relative(SRC, f))
      .filter((f) => !allowed.has(f))
      .filter((f) => /\bscheduled(Sends|Failed)\b/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
