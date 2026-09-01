#!/usr/bin/env node
/**
 * test-1m-context-beta.mjs — verify that the 1M context-window beta flows
 * end-to-end from vibe-station's ACP session/new call to the claude CLI.
 *
 * Strategy (two complementary checks):
 *
 * 1. ARGS CHECK (primary) — wraps the claude binary with a spy script that
 *    logs its argv to a temp file. Verifies that `--betas context-1m-2025-08-07`
 *    appears in the args for the WITH-beta run but NOT for the WITHOUT-beta run.
 *    This works even if the API key lacks the beta entitlement.
 *
 * 2. CONTEXT WINDOW CHECK (secondary) — watches usage_update notifications from
 *    the adapter for the `size` field. Useful when the account IS entitled to
 *    the beta; the expected change is 200K → 1M for claude-sonnet-4-5.
 *
 * Spawns the claude-agent-acp adapter directly (same way the daemon does),
 * runs one minimal prompt with and without the beta, and reports both checks.
 *
 * Usage:
 *   node scripts/test-1m-context-beta.mjs [--model <model>] [--skip-real-run]
 *
 * Requires: claude binary on PATH (or CLAUDE_BIN env), and the
 * @agentclientprotocol/claude-agent-acp adapter installed under cli/node_modules
 * (or VS_REPO_ROOT pointing at a checkout where it is).
 *
 * This is a manual/dev tool: it is deliberately NOT under any vitest `include`
 * glob and is not referenced by any package.json script, because it talks to
 * the real claude CLI and the real API.
 *
 * Exit code 0 = beta flag confirmed to reach the claude CLI.
 * Exit code 1 = beta flag not detected in CLI args.
 */

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { accessSync, constants, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const MODEL = modelIdx >= 0 ? args[modelIdx + 1] : "claude-sonnet-4-5";

// Resolve claude binary: CLAUDE_BIN env → ~/.local/bin → PATH
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidate = join(homedir(), ".local", "bin", "claude");
  try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  try { return execFileSync("which", ["claude"], { encoding: "utf8" }).trim(); } catch {}
  throw new Error("claude binary not found — set CLAUDE_BIN or install Claude Code");
}
const REAL_CLAUDE_BIN = resolveClaude();

// Resolve the adapter entry. The daemon sources it from cli/node_modules; in a
// git worktree that directory may not exist, so VS_REPO_ROOT can point at the
// main checkout whose node_modules is actually installed.
function resolveAdapterEntry() {
  const bases = [import.meta.url, new URL("../cli/package.json", import.meta.url).href];
  if (process.env.VS_REPO_ROOT) bases.push(new URL("file://" + join(process.env.VS_REPO_ROOT, "cli", "package.json")).href);
  for (const base of bases) {
    try {
      return createRequire(base).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
    } catch {}
  }
  throw new Error(
    "Cannot find @agentclientprotocol/claude-agent-acp — run pnpm install, or set VS_REPO_ROOT to a checkout that has it",
  );
}
const ADAPTER_ENTRY = resolveAdapterEntry();

// ---------------------------------------------------------------------------
// Spy wrapper: logs claude CLI args to a file, then delegates to real binary.
// ---------------------------------------------------------------------------

// One wrapper (and one log) per run, so a run that spawns claude more than once
// can never be confused with the other run's args. Everything lives inside the
// returned dir, which the caller removes.
function createSpyWrapper(realBin) {
  const dir = mkdtempSync(join(tmpdir(), "claude-spy-"));
  const logFile = join(dir, "args.log");
  const wrapperPath = join(dir, "claude");
  writeFileSync(wrapperPath, `#!/usr/bin/env bash\necho "ARGS: $*" >> "${logFile}"\nexec "${realBin}" "$@"\n`, { mode: 0o755 });
  return { wrapperPath, logFile, dir };
}

// ---------------------------------------------------------------------------
// Minimal ACP client
// ---------------------------------------------------------------------------

async function runSession({ useBeta, claudeBin }) {
  const label = useBeta ? "WITH beta" : "WITHOUT beta";
  const child = spawn(process.execPath, [ADAPTER_ENTRY], {
    cwd: "/tmp",
    env: {
      ...process.env,
      CLAUDE_CODE_EXECUTABLE: claudeBin,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += d.toString(); });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 1;
  const pending = new Map();
  let contextWindowSeen = null;

  function writeLine(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      writeLine({ jsonrpc: "2.0", id, method, params });
    });
  }

  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line.trim()); } catch { return; }
    if (!msg) return;

    if ("id" in msg && !("method" in msg)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} [code=${msg.error.code}, data=${JSON.stringify(msg.error.data ?? null).slice(0, 200)}]`));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method === "session/update") {
      const update = msg.params?.update;
      if (update?.sessionUpdate === "usage_update" && typeof update.size === "number") {
        contextWindowSeen = update.size;
      }
      return;
    }

    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const options = msg.params?.options ?? [];
      const chosen =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind?.startsWith("allow_"));
      writeLine({
        jsonrpc: "2.0", id: msg.id,
        result: chosen
          ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
    }
  });

  try {
    await Promise.race([
      request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("initialize timed out")), 30_000)),
    ]);
    console.log(`  [${label}] initialize OK`);

    // Same shape the daemon sends (jsonAgent.getOrCreateConnection). `model` is
    // included in BOTH runs so --model actually selects a model; only `betas`
    // differs between the two runs, which is what the args check compares.
    const meta = {
      claudeCode: { options: { model: MODEL, ...(useBeta ? { betas: ["context-1m-2025-08-07"] } : {}) } },
    };

    const newSessionResult = await Promise.race([
      request("session/new", { cwd: "/tmp", mcpServers: [], _meta: meta }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("session/new timed out")), 30_000)),
    ]);
    const sessionId = newSessionResult.sessionId;
    console.log(`  [${label}] session/new → sessionId=${sessionId}`);

    const promptResult = await Promise.race([
      request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly one word: ok" }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("session/prompt timed out")), 120_000)),
    ]);
    console.log(`  [${label}] session/prompt → stopReason=${promptResult.stopReason}`);
  } catch (err) {
    const tail = stderr.trim().split("\n").slice(-5).join("\n    ");
    if (tail) console.error(`  [${label}] adapter stderr (tail):\n    ${tail}`);
    throw err;
  } finally {
    // Reject anything still in flight so no timer/promise keeps the loop alive.
    for (const [, p] of pending) p.reject(new Error("session torn down"));
    pending.clear();
    rl.close();
    try { child.kill(); } catch {}
  }

  return contextWindowSeen;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nTesting 1M context-window beta (model: ${MODEL})`);
console.log("──────────────────────────────────────────────────────────────\n");

const spyDirs = [];

/** One run: fresh spy wrapper, one session, then read back that run's args. */
async function run(label, useBeta) {
  const spy = createSpyWrapper(REAL_CLAUDE_BIN);
  spyDirs.push(spy.dir);
  console.log(`${label}\n  spy wrapper: ${spy.wrapperPath}`);
  const window = await runSession({ useBeta, claudeBin: spy.wrapperPath }).catch((err) => {
    console.error(`  FAILED: ${err.message}`);
    return null;
  });
  console.log(`  → contextWindowSize: ${window ?? "(no usage_update received)"}\n`);
  let log = "";
  try { log = readFileSync(spy.logFile, "utf8"); } catch {}
  return { window, log, hasBeta: log.includes("context-1m-2025-08-07") };
}

let exitCode = 1;
try {
  const without = await run("Run 1: WITHOUT beta flag", false);
  await new Promise((r) => setTimeout(r, 1000));
  const with_ = await run("Run 2: WITH beta flag", true);

  const { window: windowWithout } = without;
  const { window: windowWith } = with_;

  console.log("──────────────────────────────────────────────────────────────");
  console.log("Args check:");
  console.log(`  Run 1 (no betas): ${without.hasBeta ? "⚠ --betas PRESENT (unexpected)" : "✓ --betas absent"}`);
  console.log(`  Run 2 (with betas): ${with_.hasBeta ? "✓ --betas context-1m-2025-08-07 PRESENT" : "✗ --betas MISSING"}`);
  console.log(`\nRaw CLI args (run 1):\n  ${without.log.trim() || "(claude was never invoked)"}`);
  console.log(`Raw CLI args (run 2):\n  ${with_.log.trim() || "(claude was never invoked)"}`);

  console.log("\nContext window check:");
  console.log(`  Without beta: ${windowWithout?.toLocaleString() ?? "n/a"}`);
  console.log(`  With beta:    ${windowWith?.toLocaleString() ?? "n/a"}`);
  if (windowWith !== null && windowWith >= 1_000_000) {
    console.log("  ✓ Context window confirmed ≥1M with beta");
  } else if (windowWithout !== null && windowWith !== null && windowWith > windowWithout) {
    console.log("  ✓ Context window increased with beta");
  } else {
    console.log("  ⚠ Context window unchanged (account may not have beta entitlement — args check is authoritative)");
  }

  const PASS = !without.hasBeta && with_.hasBeta;
  console.log(`\n${PASS ? "✓ PASS" : "✗ FAIL"} — ${PASS
    ? "--betas context-1m-2025-08-07 is forwarded to the claude CLI when the beta is configured"
    : "beta flag was not detected in claude CLI args"}`);
  exitCode = PASS ? 0 : 1;
} finally {
  // NB: cleanup must happen before process.exit — a finally block does not run
  // once process.exit has been called, so the exit is deliberately last.
  for (const dir of spyDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

process.exit(exitCode);
