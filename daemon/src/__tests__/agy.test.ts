import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord, LaunchConfig } from "../types.js";

// Mirrors the existing pattern in nativeChatIdClaude.test.ts — swap homedir() so
// agy's per-session `--log-file` (~/.vibe-station/agy-logs/<id>.log) AND its
// last-resort cache-file fallback land under a temp dir we control.
let testHomeDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testHomeDir || actual.homedir(),
  };
});

function session(id = "sess-agy"): SessionRecord {
  return {
    id,
    slot: "m",
    type: "agent",
    modeId: "mode-agy",
    tmuxName: `vst-${id}`,
    useTmux: true,
    channel: "tmux",
    lifecycle: { state: "working", lastTransitionAt: new Date().toISOString() },
  } as SessionRecord;
}

function logPathFor(id: string): string {
  return join(testHomeDir, ".vibe-station", "agy-logs", `${id}.log`);
}

async function writeLog(id: string, content: string): Promise<void> {
  const path = logPathFor(id);
  await mkdir(join(testHomeDir, ".vibe-station", "agy-logs"), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function appendLog(id: string, content: string): Promise<void> {
  const path = logPathFor(id);
  await mkdir(join(testHomeDir, ".vibe-station", "agy-logs"), { recursive: true });
  await appendFile(path, content, "utf8");
}

describe("agy chat-id capture — log-file design (json-mode-followups, iteration 3)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-agy-test-"));
    testHomeDir = tempDir;
  });

  afterEach(async () => {
    testHomeDir = "";
    await rm(tempDir, { recursive: true, force: true });
  });

  it("getLaunchCommand wires a per-session --log-file and creates its directory synchronously", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const cfg = { session: session("sess-launch") } as LaunchConfig;

    const argv = plugin.getLaunchCommand(cfg);
    const idx = argv.indexOf("--log-file");
    expect(idx).toBeGreaterThanOrEqual(0);
    const path = argv[idx + 1]!;
    expect(path).toBe(logPathFor("sess-launch"));

    // Directory must exist immediately (getLaunchCommand is synchronous —
    // agy itself will not create the parent dir for --log-file).
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(testHomeDir, ".vibe-station", "agy-logs"))).toBe(true);
  });

  it("captureChatId resolves once the log's Created-conversation line appears", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session();

    await writeLog(s.id, "I0719 12:00:00.000000 server.go:861] Created conversation abcdef01-2345-6789-abcd-ef0123456789\n");
    const id = await plugin.captureChatId?.({ session: s });
    expect(id).toBe("abcdef01-2345-6789-abcd-ef0123456789");
  });

  it("captureChatId prefers the LAST Streaming line over Created (reflects the current conversation, not the first)", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session();

    await writeLog(
      s.id,
      [
        "I0719 12:00:00 server.go:861] Created conversation 11111111-1111-1111-1111-111111111111",
        "I0719 12:00:01 conversation_manager.go:520] Streaming conversation 11111111-1111-1111-1111-111111111111",
        "I0719 12:05:00 conversation_manager.go:520] Streaming conversation 22222222-2222-2222-2222-222222222222",
      ].join("\n") + "\n",
    );
    const id = await plugin.captureChatId?.({ session: s });
    expect(id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("captureChatId times out to null when no log file exists yet (e.g. the trust-prompt gap)", async () => {
    const { pollLogForConversationId } = await import("../agent-plugins/agy.js");
    // Drives the extracted poll helper directly with a short real timeout —
    // see the identical rationale in the helper's own doc comment.
    const id = await pollLogForConversationId(logPathFor("sess-never-created"), {
      timeoutMs: 150,
      intervalMs: 20,
    });
    expect(id).toBeNull();
  });

  it("captureChatId (via the plugin, real poll constants) resolves once a line is appended mid-poll", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session();

    // File exists but is empty at first (agy has started but not yet logged
    // conversation creation) — the poll must keep re-reading, not give up
    // after one empty check.
    await writeLog(s.id, "");
    const pending = plugin.captureChatId?.({ session: s });
    await new Promise((r) => setTimeout(r, 50));
    await appendLog(s.id, "I0719 server.go:861] Created conversation 99999999-9999-9999-9999-999999999999\n");

    const id = await pending;
    expect(id).toBe("99999999-9999-9999-9999-999999999999");
  }, 10_000);

  it("refreshChatIdOnToggle does an immediate read (no polling) — resolves for an already-populated log", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session();

    await writeLog(
      s.id,
      "I0719 server.go:861] Created conversation 33333333-3333-3333-3333-333333333333\n" +
        "I0719 conversation_manager.go:520] Streaming conversation 33333333-3333-3333-3333-333333333333\n",
    );
    const id = await plugin.refreshChatIdOnToggle?.({ session: s });
    expect(id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("refreshChatIdOnToggle returns null (not a stale/wrong value) when the log has no conversation line yet — the killSession-before-flush case", async () => {
    // This is the EXACT scenario that broke iteration 2: vibe-station kills
    // the tmux pane (no graceful agy exit), so anything relying on
    // last_conversations.json would see a stale, unrelated value. The
    // log-file design must return null here instead of fabricating a value —
    // it correctly has no evidence yet, and must say so rather than guess.
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session();

    await writeLog(s.id, "I0719 some unrelated startup line\n");
    const id = await plugin.refreshChatIdOnToggle?.({ session: s });
    expect(id).toBeNull();
  });

  it("two sessions get fully independent, session-scoped log files (no cross-session ambiguity)", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const a = session("sess-a");
    const b = session("sess-b");

    await writeLog(a.id, "I0719 server.go:861] Created conversation aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n");
    await writeLog(b.id, "I0719 server.go:861] Created conversation bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\n");

    const idA = await plugin.captureChatId?.({ session: a });
    const idB = await plugin.captureChatId?.({ session: b });
    expect(idA).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(idB).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("parseLastConversationIdFromLog tolerates trailing garbage/partial lines (glog format isn't a documented contract)", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session();

    await writeLog(
      s.id,
      "some totally unrelated log noise\n" +
        "I0719 server.go:861] Created conversation cccccccc-cccc-cccc-cccc-cccccccccccc extra trailing text\n",
    );
    const id = await plugin.captureChatId?.({ session: s });
    expect(id).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
  });

  it("composeLaunchPrompt writes combined prompt file and returns shellLine launch config", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session("sess-prompt-test");
    const systemPromptFile = join(testHomeDir, "system_prompt.txt");

    const result = plugin.composeLaunchPrompt({
      systemPrompt: "System Rules",
      taskPrompt: "Do the task",
      sessionId: s.id,
      systemPromptFile,
      launchCfg: {
        project: { id: "p1" },
        ctx: { cwd: "/tmp" },
        session: s,
        daemonPort: 1234,
        model: "Gemini 3.5 Flash (Medium)",
      } as any,
    });

    expect(result.useShell).toBe(true);
    expect(result.shellLine).toContain("agy --dangerously-skip-permissions");
    expect(result.shellLine).toContain("--model 'Gemini 3.5 Flash (Medium)'");
    expect(result.shellLine).toContain("-i \"$(cat '");

    const { readFileSync } = await import("node:fs");
    const writtenCombined = readFileSync(join(testHomeDir, "combined_prompt.txt"), "utf8");
    expect(writtenCombined).toBe("System Rules\n\nDo the task");
  });
});

// captureNativeChatId — Decision 6 Option B, revised 2026-08-30 after live
// verification against a real `bunx antigravity-acp@1.1.0` + real `agy`: the
// adapter's own `~/.agy-acp/sessions.json` (keyed by ACP sessionId) carries
// agy's real native `conversationId`, which `agy --conversation <id>` was
// confirmed live to resume correctly. See the block comment above
// `readAgyAcpSessionConversationId` in agy.ts for the full investigation.
describe("agy captureNativeChatId — antigravity-acp adapter session store", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-agy-acp-test-"));
    testHomeDir = tempDir;
  });

  afterEach(async () => {
    testHomeDir = "";
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeAcpSessionsFile(
    sessions: Record<string, { conversationId: string | null; cwd?: string }>,
  ): Promise<void> {
    const dir = join(testHomeDir, ".agy-acp");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "sessions.json"),
      JSON.stringify({ sessions }, null, 2),
      "utf8",
    );
  }

  it("prefers the antigravity-acp adapter's session-keyed conversationId over the cwd-keyed fallback", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session("sess-acp-1");
    await writeAcpSessionsFile({
      "acp-session-1": { conversationId: "e1daa217-70be-4b99-b7e5-78706623762b", cwd: "/tmp/ws" },
    });

    const id = await plugin.captureNativeChatId?.({
      session: s,
      project: { id: "p1" } as any,
      cwd: "/tmp/ws",
      acpSessionId: "acp-session-1",
    });
    expect(id).toBe("e1daa217-70be-4b99-b7e5-78706623762b");
  });

  it("never overwrites an already-captured native id (write-once semantics)", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = { ...session("sess-acp-2"), agentChatId: "already-set-id" };
    await writeAcpSessionsFile({
      "acp-session-2": { conversationId: "some-other-id" },
    });

    const id = await plugin.captureNativeChatId?.({
      session: s,
      project: { id: "p1" } as any,
      cwd: "/tmp/ws",
      acpSessionId: "acp-session-2",
    });
    expect(id).toBe("already-set-id");
  });

  it("falls back to the cwd-keyed last_conversations.json when the acp session id is unknown to the adapter store", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session("sess-acp-3");
    // No ~/.agy-acp/sessions.json at all (older adapter / cleared state).
    const cacheDir = join(testHomeDir, ".gemini", "antigravity-cli", "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "last_conversations.json"),
      JSON.stringify({ "/tmp/ws": "fallback-conversation-id" }),
      "utf8",
    );

    const id = await plugin.captureNativeChatId?.({
      session: s,
      project: { id: "p1" } as any,
      cwd: "/tmp/ws",
      acpSessionId: "acp-session-missing",
    });
    expect(id).toBe("fallback-conversation-id");
  });

  it("returns null when neither channel has a value", async () => {
    const { createAgyPlugin } = await import("../agent-plugins/agy.js");
    const plugin = createAgyPlugin();
    const s = session("sess-acp-4");

    const id = await plugin.captureNativeChatId?.({
      session: s,
      project: { id: "p1" } as any,
      cwd: "/tmp/ws",
      acpSessionId: "acp-session-4",
    });
    expect(id).toBeNull();
  });
});
