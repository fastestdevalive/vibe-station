/**
 * Phase 2 (2.T1/2.T2) live integration tests — drive the REAL `claude` CLI
 * through the ACP adapter, exactly as Phase 1.8/2.0's spike did manually.
 *
 * These are opt-in (skipped by default, like the rest of `pnpm -r test`'s
 * fast/offline suite) because they need a real, already-authenticated
 * `claude` binary on PATH and make live model calls. Run explicitly with:
 *
 *   VST_ACP_LIVE_TESTS=1 pnpm --filter @vibestation/cli test -- claudeAcpLive
 *
 * (used inside the Docker dev sandbox for this plan's end-to-end scenarios).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createClaudePlugin } from "../agent-plugins/claude.js";
import type { AgentPlugin, TurnContext } from "../services/spawn.js";
import { AcpConnection } from "../services/acp/acpTransport.js";
import type { NormalizedEvent } from "../types.js";

const LIVE = process.env.VST_ACP_LIVE_TESTS === "1";
const maybe = LIVE ? describe : describe.skip;

maybe("claude ACP plugin — live CLI (2.T1/2.T2)", () => {
  let cwd: string;
  let plugin: AgentPlugin;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "claude-acp-live-"));
    execSync("git init -q", { cwd });
    execSync('git config user.email a@a.com && git config user.name a', { cwd });
    await mkdir(join(cwd, ".vibe-station"), { recursive: true });
    plugin = createClaudePlugin();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function makeCtx(sessionId: string): { ctx: TurnContext; getConn: () => AcpConnection | undefined } {
    let conn: AcpConnection | undefined;
    const ctx: TurnContext = {
      cwd,
      project: {} as TurnContext["project"],
      worktree: null,
      session: { id: sessionId } as TurnContext["session"],
      systemPromptFile: join(cwd, "system-prompt.md"),
      daemonPort: 0,
      onSpawn: () => {},
      getAcpConnection: async (spec, enrich) => {
        if (conn) return conn;
        conn = new AcpConnection(spec, "claude", enrich);
        await conn.initialize();
        await conn.newSession(spec.cwd);
        return conn;
      },
    };
    return { ctx, getConn: () => conn };
  }

  it("2.T1 — background work survives past its turn's result, on the SAME connection/agentChatId", async () => {
    const { ctx } = makeCtx("live-2t1");
    const signal1 = new AbortController().signal;
    const events1: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "run `sleep 3 &` in the background, then tell me you're done", isFirstTurn: true },
      ctx,
      signal1,
    )) {
      events1.push(ev);
    }
    const chatId1 = events1.find((e) => e.kind === "session_init")?.agentChatId;
    expect(chatId1).toBeTruthy();
    expect(events1.some((e) => e.kind === "result")).toBe(true);

    // Second turn on the SAME connection must reuse the SAME ACP session —
    // no new session_init/agentChatId.
    const signal2 = new AbortController().signal;
    const events2: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "are you still there?", isFirstTurn: false },
      ctx,
      signal2,
    )) {
      events2.push(ev);
    }
    expect(events2.some((e) => e.kind === "session_init")).toBe(false);
    expect(events2.some((e) => e.kind === "result")).toBe(true);
  }, 90_000);

  it("2.T2 — Stop mid-turn then a follow-up turn succeeds without a fresh session/new", async () => {
    const { ctx, getConn } = makeCtx("live-2t2");
    const controller = new AbortController();
    const runPromise = (async () => {
      const events: NormalizedEvent[] = [];
      for await (const ev of plugin.runTurn!(
        { message: "count slowly from 1 to 20, one number per line", isFirstTurn: true },
        ctx,
        controller.signal,
      )) {
        events.push(ev);
        if (events.length === 1) {
          // Stop shortly after the turn starts streaming.
          getConn()?.cancelActivePrompt();
          controller.abort();
        }
      }
      return events;
    })();
    await runPromise;

    const signal2 = new AbortController().signal;
    const events2: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "say OK and nothing else", isFirstTurn: false },
      ctx,
      signal2,
    )) {
      events2.push(ev);
    }
    expect(events2.some((e) => e.kind === "result")).toBe(true);
  }, 90_000);

  it("2.T5 — Option A: getRestoreCommand's resume argv id === the captured ACP session id, and the raw CLI actually resumes it", async () => {
    const { ctx } = makeCtx("live-2t5");
    const events: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "say the word ACPLIVETEST5 and nothing else", isFirstTurn: true },
      ctx,
      new AbortController().signal,
    )) {
      events.push(ev);
    }
    const acpSessionId = events.find((e) => e.kind === "session_init")?.agentChatId;
    expect(acpSessionId).toBeTruthy();

    const session = { agentChatId: acpSessionId } as unknown as Parameters<
      NonNullable<AgentPlugin["getRestoreCommand"]>
    >[0]["session"];
    const argv = await plugin.getRestoreCommand!({ session, project: {} as never, cwd });
    expect(argv).toBeTruthy();
    // Option A invariant (Decision 6): the resume argv's id is BYTE-IDENTICAL
    // to the ACP session id — no separate acpSessionId column for claude.
    expect(argv!).toContain(acpSessionId);

    // Smoke: the raw `claude` binary actually resumes THIS conversation.
    const out = execSync(
      `claude --resume ${acpSessionId} --dangerously-skip-permissions -p "what word did I just ask you to say? reply with just that word"`,
      { cwd, encoding: "utf8" },
    );
    expect(out).toContain("ACPLIVETEST5");
  }, 90_000);
});
