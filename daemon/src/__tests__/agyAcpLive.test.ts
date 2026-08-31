/**
 * Phase 4 (4.T1) live integration test — drives the REAL `agy` CLI through
 * the THIRD-PARTY `antigravity-acp` adapter (via `bunx`). Opt-in, same
 * convention as claudeAcpLive.test.ts. Requires `bun`/`bunx` on PATH in
 * addition to an authenticated `agy`.
 *
 *   VST_ACP_LIVE_TESTS=1 pnpm --filter @vibestation/cli test -- agyAcpLive
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createAgyPlugin } from "../agent-plugins/agy.js";
import type { AgentPlugin, TurnContext } from "../services/spawn.js";
import { AcpConnection } from "../services/acp/acpTransport.js";
import type { NormalizedEvent } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.VST_ACP_LIVE_TESTS === "1";
const maybe = LIVE ? describe : describe.skip;

// 4.3/4.T2 does NOT require a live agy binary — runs unconditionally.
describe("agy plugin — 4.3/4.T2: connect timeout surfaces as a readable error, not a hang", () => {
  it("getAcpConnection failure is wrapped as 'Antigravity ACP unavailable: …'", async () => {
    const FAKE_AGENT = join(__dirname, "fixtures", "fakeAcpAgent.mjs");
    const plugin = createAgyPlugin();
    const ctx: TurnContext = {
      cwd: "/tmp",
      project: {} as TurnContext["project"],
      worktree: null,
      session: { id: "agy-timeout-test" } as TurnContext["session"],
      systemPromptFile: "/tmp/nonexistent-system-prompt.md",
      daemonPort: 0,
      // Simulate jsonAgent.ts's getOrCreateConnection wiring a short-timeout
      // connection against a permanently-hung fake adapter (mirrors the real
      // 20s agy timeout, just shortened for the test).
      getAcpConnection: async (_spec, enrich) => {
        const conn = new AcpConnection(
          { command: process.execPath, args: [FAKE_AGENT], cwd: "/tmp", env: { FAKE_ACP_MODE: "hang" }, initializeTimeoutMs: 300 },
          "agy",
          enrich,
        );
        await conn.initialize(); // throws InitializeFailed after 300ms
        return conn;
      },
    };

    let caught: unknown;
    try {
      for await (const _ev of plugin.runTurn!({ message: "hi", isFirstTurn: true }, ctx, new AbortController().signal)) {
        // no-op
      }
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("Antigravity ACP unavailable");
  });
});

maybe("agy ACP plugin — live CLI, third-party adapter (4.T1)", () => {
  let cwd: string;
  let plugin: AgentPlugin;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agy-acp-live-"));
    execSync("git init -q", { cwd });
    execSync('git config user.email a@a.com && git config user.name a', { cwd });
    plugin = createAgyPlugin();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("4.T1 — background-survival assertion: turn completes, second turn on same connection succeeds", async () => {
    let conn: AcpConnection | undefined;
    const ctx: TurnContext = {
      cwd,
      project: {} as TurnContext["project"],
      worktree: null,
      session: { id: "live-agy-1" } as TurnContext["session"],
      systemPromptFile: join(cwd, "system-prompt.md"),
      daemonPort: 0,
      onSpawn: () => {},
      getAcpConnection: async (spec, enrich) => {
        if (conn) return conn;
        conn = new AcpConnection(spec, "agy", enrich);
        await conn.initialize();
        await conn.newSession(spec.cwd);
        return conn;
      },
    };

    const events1: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "say the word AGYACPTEST and nothing else", isFirstTurn: true },
      ctx,
      new AbortController().signal,
    )) {
      events1.push(ev);
    }
    expect(events1.some((e) => e.kind === "result")).toBe(true);
    const joined1 = events1.filter((e) => e.kind === "text").map((e) => e.text ?? "").join("");
    expect(joined1).toContain("AGYACPTEST");

    const events2: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "what word did I just ask you to say? reply with just that word", isFirstTurn: false },
      ctx,
      new AbortController().signal,
    )) {
      events2.push(ev);
    }
    expect(events2.some((e) => e.kind === "result")).toBe(true);
  }, 90_000);
});
