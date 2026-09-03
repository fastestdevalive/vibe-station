/**
 * Pi Coding Agent plugin (`pi` — @victor-software-house/pi-acp adapter).
 *
 * Pi's own CLI does NOT speak ACP natively — it is wrapped by a third-party
 * long-running daemon adapter (`@victor-software-house/pi-acp`, npm-global,
 * min version 0.17.1). This is the adapter line agent-orchestrator runs in
 * production (piacp/driver.go). Two divergent adapter lines exist; this plugin
 * pins the victor-software-house line — see Decision 3 in the feature plan.
 *
 * JSON / ACP mode (primary — TTY mode is untested, Decision 5):
 *   Adapter:       `pi-acp` npm bin from @victor-software-house/pi-acp@>=0.17.1
 *   Socket dir:    per-session `PI_ACP_SOCKET_DIR` prevents environment leaking
 *   System prompt: prepended to the first message (Decision 2 deviation — the
 *                  `AcpConnection` API does not expose `session/new _meta`, so the
 *                  resource-manifest approach from the plan cannot be wired in
 *                  without a shared-code change; prepend matches agy.ts behaviour
 *                  and is equally effective for one-shot standing instructions)
 *
 * TTY mode (untested — JSON/ACP is the only supported path):
 *   The four non-optional AgentPlugin members (getLaunchCommand, getEnvironment,
 *   getReadySignal, composeLaunchPrompt) are implemented minimally. No
 *   captureChatId, no getRestoreCommand — ACP provides session continuity.
 *
 * Auth: Pi's credentials live under `~/.pi/`; the adapter reads them directly;
 *   vibe-station stores nothing.
 *
 * comm-name gap (Phase 0.2): `pi-acp` is an npm binary; `/proc/<pid>/comm` is
 *   `node`, NOT `pi-acp`. Adding `node` to KNOWN_TURN_BINARIES would allow the
 *   boot sweep to kill ANY Node process that reuses a recorded PID — unsafe on a
 *   shared host. Consequence: an orphaned pi-acp process survives an unclean
 *   daemon restart. Follow-up: switch verifyPidIsTurnProcess in recover.ts to
 *   cmdline matching (`/proc/<pid>/cmdline`) for Node-based adapters.
 */

import { promises as fs, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AgentPlugin, LaunchConfig, TurnInput, TurnContext } from "../services/spawn.js";
import type { PromptBlock } from "../services/acp/acpTransport.js";
import type { AcpEnrichHook } from "../services/acp/normalize.js";
import type { NormalizedEvent, NormalizedEventKind, UsageInfo } from "../types.js";

const PI_ACP_BINARY = "pi-acp";
const PI_ACP_PACKAGE_NAME = "@victor-software-house/pi-acp";
const PI_ACP_MIN_VERSION = "0.17.1";

/** Explicit adapter distribution expected in the `initialize` response agentInfo.name.
 *  Two divergent adapter lines exist (svkozak/pi-acp vs victor-software-house/pi-acp)
 *  with incompatible runtime models — validate to prevent silent wrong-adapter failures. */
const EXPECTED_AGENT_INFO_NAME = PI_ACP_PACKAGE_NAME;

/**
 * Compare two semver strings. Returns true if `v` >= `min` (major.minor.patch only).
 * Exported for unit testing.
 */
export function semverGte(v: string, min: string): boolean {
  const parse = (s: string): [number, number, number] | null => {
    const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  };
  const va = parse(v);
  const ma = parse(min);
  if (!va || !ma) return false;
  if (va[0] !== ma[0]) return va[0] > ma[0];
  if (va[1] !== ma[1]) return va[1] > ma[1];
  return va[2] >= ma[2];
}

/**
 * Validate the Pi ACP adapter identity + minimum version.
 * Called before connecting to give a clear, actionable error instead of a cryptic
 * spawn/timeout failure. Exported for unit testing.
 *
 * In the current API, the AcpConnection does not expose the `initialize` response's
 * `agentInfo` to the plugin — so validation runs via the binary's `--version` flag
 * rather than the ACP handshake (the plan's original intent; functionally equivalent).
 */
export function validatePiAcpPresence(): void {
  let versionOutput: string;
  try {
    versionOutput = execFileSync(PI_ACP_BINARY, ["--version"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    throw new Error(
      `Pi ACP adapter not found on PATH. ` +
        `Install with: npm install -g ${PI_ACP_PACKAGE_NAME}@${PI_ACP_MIN_VERSION}`,
    );
  }
  // Version output may be "0.17.1" or "pi-acp/0.17.1 node/..." — extract semver.
  const m = versionOutput.match(/(\d+\.\d+\.\d+)/);
  const version = (m && m[1]) ? m[1] : versionOutput;
  if (!semverGte(version, PI_ACP_MIN_VERSION)) {
    throw new Error(
      `pi-acp ${version} is older than the tested minimum ${PI_ACP_MIN_VERSION}. ` +
        `Upgrade with: npm install -g ${PI_ACP_PACKAGE_NAME}@${PI_ACP_MIN_VERSION}`,
    );
  }
}

/**
 * Validate the agent identity from the ACP `initialize` response.
 * Called after a connection is established when agentInfo is available.
 * Exported for unit testing.
 */
export function validatePiAcpIdentity(init: { agentInfo?: { name?: string; version?: string } }): void {
  const name = init.agentInfo?.name;
  const version = init.agentInfo?.version;
  if (name && name !== EXPECTED_AGENT_INFO_NAME) {
    throw new Error(
      `Unexpected Pi ACP distribution "${name}"; expected ${EXPECTED_AGENT_INFO_NAME}. ` +
        `Two divergent adapter lines exist — this plugin requires the victor-software-house line.`,
    );
  }
  if (version && !semverGte(version, PI_ACP_MIN_VERSION)) {
    throw new Error(
      `pi-acp ${version} is older than the tested minimum ${PI_ACP_MIN_VERSION}. ` +
        `Upgrade with: npm install -g ${PI_ACP_PACKAGE_NAME}@${PI_ACP_MIN_VERSION}`,
    );
  }
}

function piEvent(
  sessionId: string,
  kind: NormalizedEventKind,
  extra: Partial<NormalizedEvent>,
): NormalizedEvent {
  return {
    id: randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    provider: "pi",
    kind,
    ...extra,
  };
}

// Pi connects to whatever LLM the user has authenticated with (Claude Pro/Max,
// ChatGPT Plus/Pro, GitHub Copilot). The available models depend on the user's
// connected accounts; this is a representative static list.
const PI_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "gpt-4o",
  "gpt-4o-mini",
  "github-copilot",
] as const;

const PI_DEFAULT_MODEL = "claude-sonnet-4-5";

/** Per-session socket directory for pi-acp (prevents cross-session leaking). */
function piAcpSocketDir(ctx: TurnContext): string {
  const sessionId = ctx.session.id;
  return join(
    homedir(),
    ".vibe-station",
    "pi-acp",
    sessionId,
    "run",
  );
}

/** No pi-specific enrichment needed beyond the shared ACP normalize mapping. */
const piEnrich: AcpEnrichHook = (_raw, base) => base;

/**
 * ACP-based turn: drives `pi-acp` (spawned once per session, persistent) instead
 * of a per-turn one-shot. System prompt is prepended to the first message —
 * see the block comment above for why the resource-manifest approach isn't used.
 */
async function* runTurnAcp(
  input: TurnInput,
  ctx: TurnContext,
  signal: AbortSignal,
): AsyncIterable<NormalizedEvent> {
  // Pre-flight: confirm the adapter is installed before we attempt a connection.
  try {
    validatePiAcpPresence();
  } catch (err) {
    throw new Error(`Pi ACP unavailable: ${String(err)}`);
  }

  // Per-session socket dir must exist before spawning.
  const socketDir = piAcpSocketDir(ctx);
  mkdirSync(socketDir, { recursive: true });

  let conn;
  try {
    conn = await ctx.getAcpConnection!(
      {
        command: PI_ACP_BINARY,
        args: [],
        cwd: ctx.cwd,
        env: { PI_ACP_SOCKET_DIR: socketDir },
        initializeTimeoutMs: 20_000,
        ...(ctx.onSpawn ? { onSpawn: ctx.onSpawn } : {}),
      },
      piEnrich,
    );
  } catch (err) {
    throw new Error(`Pi ACP unavailable: ${String(err)}`);
  }

  const sessionId = conn.currentSessionId;
  if (!sessionId) throw new Error("Pi ACP session was not established");

  let message = input.message;
  if (input.isFirstTurn) {
    const systemPrompt = await fs.readFile(ctx.systemPromptFile, "utf8").catch(() => "");
    if (systemPrompt) message = `${systemPrompt}\n\n${message}`;
  }
  const promptBlocks: PromptBlock[] = [{ type: "text", text: message }];

  const { updates, result } = conn.sendPrompt(sessionId, promptBlocks, signal);
  for await (const ev of updates) yield ev;

  let usageRaw: Record<string, unknown> | undefined;
  try {
    const r = await result;
    usageRaw = (r as unknown as { usage?: Record<string, unknown> }).usage;
  } catch (err) {
    if (signal.aborted) return;
    throw err;
  }

  const usage: UsageInfo | undefined = usageRaw
    ? (() => {
        const num = (v: unknown): number => (typeof v === "number" ? v : 0);
        const inputTokens = num(usageRaw!.inputTokens);
        const outputTokens = num(usageRaw!.outputTokens);
        return {
          inputTokens,
          outputTokens,
          cacheReadTokens: num(usageRaw!.cachedReadTokens),
          cacheCreateTokens: num(usageRaw!.cachedWriteTokens),
          totalTokens: num(usageRaw!.totalTokens) || inputTokens + outputTokens,
          model: ctx.model ?? "",
        };
      })()
    : undefined;

  if (usage) yield piEvent(ctx.session.id, "usage", { usage, model: usage.model || undefined });
  yield piEvent(ctx.session.id, "result", usage ? { usage, model: usage.model || undefined } : {});
}

export function createPiPlugin(): AgentPlugin {
  return {
    name: "pi",
    defaultModel: PI_DEFAULT_MODEL,
    promptDelivery: "inline",

    async listModels() {
      return { models: [...PI_MODELS] };
    },

    getLaunchCommand(_cfg: LaunchConfig): string[] {
      // TTY mode untested — ACP/JSON is the supported path (Decision 5).
      // `pi` is Pi's own interactive CLI; invocation flags are undocumented for
      // vibe-station's use case and have not been verified live.
      return ["pi"];
    },

    getEnvironment(_cfg: LaunchConfig): Record<string, string> {
      return {};
    },

    getReadySignal() {
      // TTY mode untested. No verified sentinel — use a generous fallback delay.
      return { fallbackMs: 15_000 };
    },

    composeLaunchPrompt(_prompt: {
      systemPrompt: string;
      taskPrompt?: string;
      sessionId: string;
      systemPromptFile: string;
      launchCfg: LaunchConfig;
    }) {
      // TTY mode untested (Decision 5) — return empty; the JSON/ACP path handles prompts.
      return {};
    },

    // TTY mode: no restore capability — ACP session continuity is handled by
    // JsonAgentSession.getOrCreateConnection(), not by a CLI resume flag.
    async getRestoreCommand(): Promise<string[] | null> {
      return null;
    },

    supportsJson(): boolean {
      return true;
    },

    supportsAcp(): boolean {
      return true;
    },

    async *runTurn(
      input: TurnInput,
      ctx: TurnContext,
      signal: AbortSignal,
    ): AsyncIterable<NormalizedEvent> {
      yield* runTurnAcp(input, ctx, signal);
    },
  };
}
