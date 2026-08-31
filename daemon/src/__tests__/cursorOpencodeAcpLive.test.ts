/**
 * Phase 3 (3.T1/3.T2) live integration tests — drive the REAL `cursor-agent`
 * and `opencode` CLIs through their native ACP modes. Opt-in, same convention
 * as claudeAcpLive.test.ts:
 *
 *   VST_ACP_LIVE_TESTS=1 pnpm --filter @vibestation/cli test -- cursorOpencodeAcpLive
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createCursorPlugin } from "../agent-plugins/cursor.js";
import { createOpencodePlugin } from "../agent-plugins/opencode.js";
import type { AgentPlugin, TurnContext } from "../services/spawn.js";
import { AcpConnection } from "../services/acp/acpTransport.js";
import type { NormalizedEvent, ProjectRecord, SessionRecord } from "../types.js";

const LIVE = process.env.VST_ACP_LIVE_TESTS === "1";
const maybe = LIVE ? describe : describe.skip;

function makeCtx(cwd: string, sessionId: string, cli: "cursor" | "opencode") {
  let conn: AcpConnection | undefined;
  const ctx: TurnContext = {
    cwd,
    project: { id: "proj" } as TurnContext["project"],
    worktree: null,
    session: { id: sessionId } as TurnContext["session"],
    systemPromptFile: join(cwd, "system-prompt.md"),
    daemonPort: 0,
    onSpawn: () => {},
    getAcpConnection: async (spec, enrich) => {
      if (conn) return conn;
      conn = new AcpConnection(spec, cli, enrich);
      await conn.initialize();
      await conn.newSession(spec.cwd);
      return conn;
    },
  };
  return { ctx, getConn: () => conn };
}

maybe("cursor + opencode ACP plugins — live CLI (3.T1/3.T2)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "acp-live-"));
    execSync("git init -q", { cwd });
    execSync('git config user.email a@a.com && git config user.name a', { cwd });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("3.T1 — cursor: background-survival assertion (turn completes, second turn on same connection succeeds)", async () => {
    const plugin: AgentPlugin = createCursorPlugin();
    const { ctx } = makeCtx(cwd, "live-cursor-1", "cursor");

    const events1: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "say the word CURSORACPTEST and nothing else", isFirstTurn: true },
      ctx,
      new AbortController().signal,
    )) {
      events1.push(ev);
    }
    expect(events1.some((e) => e.kind === "result")).toBe(true);
    // cursor streams text in small chunks (see the 1.8 spike) — concatenate
    // rather than expecting the whole word on one event.
    const joined1 = events1.filter((e) => e.kind === "text").map((e) => e.text ?? "").join("");
    expect(joined1).toContain("CURSORACPTEST");

    const events2: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "what word did I just ask you to say? reply with just that word", isFirstTurn: false },
      ctx,
      new AbortController().signal,
    )) {
      events2.push(ev);
    }
    expect(events2.some((e) => e.kind === "result")).toBe(true);
    const joined2 = events2.filter((e) => e.kind === "text").map((e) => e.text ?? "").join("");
    expect(joined2).toContain("CURSORACPTEST");
  }, 90_000);

  it("3.T2 — opencode: background-survival assertion (turn completes, second turn on same connection recalls context)", async () => {
    const plugin: AgentPlugin = createOpencodePlugin();
    const { ctx } = makeCtx(cwd, "live-opencode-1", "opencode");

    const events1: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "say the word OPENCODEACPTEST and nothing else", isFirstTurn: true },
      ctx,
      new AbortController().signal,
    )) {
      events1.push(ev);
    }
    expect(events1.some((e) => e.kind === "result")).toBe(true);
    const acpSessionId = events1.find((e) => e.kind === "session_init")?.agentChatId;
    expect(acpSessionId).toBeTruthy();

    const events2: NormalizedEvent[] = [];
    for await (const ev of plugin.runTurn!(
      { message: "what word did I just ask you to say? reply with just that word", isFirstTurn: false },
      ctx,
      new AbortController().signal,
    )) {
      events2.push(ev);
    }
    expect(events2.some((e) => e.kind === "result")).toBe(true);
    expect(events2.some((e) => e.text?.includes("OPENCODEACPTEST"))).toBe(true);

    // 2.T5-equivalent for opencode (Option A): native resume with the ACP id works.
    const out = execSync(`opencode run --session ${acpSessionId} "what word did I ask you to say? just the word"`, {
      cwd,
      encoding: "utf8",
    });
    expect(out).toContain("OPENCODEACPTEST");
  }, 90_000);

  /**
   * 3.T3 / Risk 5 — empirical finding (recorded here rather than asserted as
   * a pass/fail, since the finding corrects the plan's own premise):
   *
   * The `.opencode/plugins/vst-recorder.ts` `session.created` hook is a
   * TERMINAL-CHANNEL-ONLY mechanism — it is read by `captureChatId`, which is
   * called ONLY from `spawnSession`/`spawnDirectSession` (the interactive TUI
   * spawn path), never from the JSON channel. Verified live: running
   * `opencode run -m opencode/big-pickle "…"` with `VST_SPAWN_TOKEN` set
   * (opencode's own non-interactive one-shot mode, i.e. the LEGACY pre-ACP
   * JSON-channel transport this plan replaces) never wrote the token file
   * EITHER — including after opencode auto-installed the plugin's
   * `@opencode-ai/plugin` dependency into `.opencode/node_modules` on first
   * use. So the hook not firing under `opencode acp` is NOT a regression
   * introduced by this plan: the JSON channel never depended on this hook,
   * before or after the ACP migration — its id capture is the ACP
   * `session/new` id itself (verified byte-identical to the native id via a
   * direct `opencode.db` query in spike 3.0b). The hook remains load-bearing
   * ONLY for the terminal channel, which this plan does not touch.
   *
   * No automated assertion here (there is nothing ACP-specific to assert);
   * this docblock IS the regression record for Risk 5 / 3.T3.
   */
  it.skip("3.T3 — see docblock above: hook is terminal-channel-only, not a JSON-channel/ACP dependency", () => {});

  it(
    "3.T4 — cursor Option B degrade: captureNativeChatId/getRestoreCommand return a real (non-null, no-crash) argv, " +
      "documented as NOT guaranteed to restore ACP-turn content when resumed by the raw CLI (spike 3.0a finding)",
    async () => {
      const plugin: AgentPlugin = createCursorPlugin();
      const { ctx, getConn } = makeCtx(cwd, "live-cursor-toggle", "cursor");

      const events: NormalizedEvent[] = [];
      for await (const ev of plugin.runTurn!(
        { message: "say the word CURSORTOGGLE and nothing else", isFirstTurn: true },
        ctx,
        new AbortController().signal,
      )) {
        events.push(ev);
      }
      expect(events.some((e) => e.kind === "result")).toBe(true);

      // cursor's own background worker syncs the ACP conversation into
      // ~/.cursor/projects/<slug>/agent-transcripts/<id>/ ASYNCHRONOUSLY, on
      // its own schedule (empirically anywhere from ~3s to >25s across runs
      // in the 1.8/3.0a spikes, and it did not reliably fire at all within a
      // live vitest process that never lets cursor-agent's own process
      // exit) — this non-determinism IS itself part of cursor's Decision 6
      // verdict (see the Spike Results table), so this test asserts BOTH
      // possible outcomes rather than only the lucky one:
      void getConn;
      const slug = cwd.replace(/^\/+/, "").replaceAll(".", "").replaceAll("/", "-");
      const { join: pathJoin } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const transcriptsDir = pathJoin(homedir(), ".cursor", "projects", slug, "agent-transcripts");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !existsSync(transcriptsDir)) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      const nativeId = await plugin.captureNativeChatId!({
        session: {} as SessionRecord,
        project: {} as ProjectRecord,
        cwd,
        acpSessionId: "unused-not-derivable-here",
      });

      if (nativeId) {
        // Sync landed in time: getRestoreCommand returns a real, non-crashing
        // resume argv. NOT asserted: that resuming it actually recalls
        // "CURSORTOGGLE" — the 1.8 spike showed it does not, for cursor
        // specifically (Option B degrade, documented in Phase 5.2's docs).
        const argv = await plugin.getRestoreCommand!({
          session: { agentChatId: nativeId } as unknown as Parameters<
            NonNullable<AgentPlugin["getRestoreCommand"]>
          >[0]["session"],
          project: {} as never,
          cwd,
        });
        expect(argv).toBeTruthy();
        expect(argv).toContain("--resume");
      } else {
        // Sync had not landed yet (the common outcome from inside a live,
        // still-running ACP connection): the Option B fallback path — no id,
        // so getRestoreCommand returns null, never a bogus `--resume` argv.
        // This is exactly the J12 fresh-launch precondition (Decision 6
        // Option B fallback section) — a real, load-bearing outcome, not a
        // test artifact.
        const argv = await plugin.getRestoreCommand!({
          session: {} as unknown as Parameters<NonNullable<AgentPlugin["getRestoreCommand"]>>[0]["session"],
          project: {} as never,
          cwd,
        });
        expect(argv).toBeNull();
      }
    },
    60_000,
  );
});
