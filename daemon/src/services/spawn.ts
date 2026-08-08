/**
 * Canonical session spawn ordering per HIGH-LEVEL-DESIGN.md §5.
 *
 * Step sequence (under project mutex, called by POST /worktrees and POST /sessions):
 * 1. Reserve identity (done by caller before invoking)
 * 2. Persist record at not_started (done by caller)
 * 2.5. provideChatId (optional, parallel with step 3) — pre-mint chat id before spawn
 * 3. Setup workspace hooks (plugin.setupWorkspaceHooks, parallel with 2.5)
 * 4. Resolve env (VST_*, including VST_SPAWN_TOKEN for chat-id capture)
 * 5a. For useTmux=true: tmux new-session
 * 5b. For useTmux=false: DirectPtyBackend.spawn
 * 6. Wait for ready signal (getReadySignal) — if sentinel not found, fallback after ms
 * 7. Send postLaunchInput if any
 * 7.5. captureChatId (optional) — read token file written by agent hook/plugin
 * 8. Flip state to working (caller persists)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { newSession, hasSession, killSession, capturePane, pasteBuffer, sendKeys } from "./tmux.js";
import { DirectPtyBackend } from "./directPty.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord, NormalizedEvent } from "../types.js";
import type { ResolvedContext } from "./context.js";
import { resolvedContextOf, systemPromptPathFor, sessionDataDirFor } from "./context.js";

/** Substring searched in pane output after paste (matches plugins' HTML tail marker). */
export function promptVerificationNeedle(sessionId: string): string {
  return `VSTPRMT:${sessionId}`;
}

/**
 * JSON agent-chat transport (Decision 3).
 *
 * The core asks the plugin to "run one turn" and consumes NormalizedEvents; it
 * NEVER sees raw CLI JSON, never `JSON.parse`es a CLI line, never branches on
 * `cli`. Each plugin owns spawn/transport AND normalization behind this
 * boundary. The async-iterator completing == the turn is done (a `result`
 * event was emitted). `signal` aborts/stops the turn.
 */
export interface AgentJsonTransport {
  /** Whether this plugin can run in the JSON channel. */
  supportsJson(): boolean;
  /**
   * Run ONE turn; yield normalized events as they arrive. The plugin spawns its
   * CLI (own process group for orphan safety, Decision 13), parses its native
   * event stream, and maps each event into a NormalizedEvent.
   */
  runTurn(input: TurnInput, ctx: TurnContext, signal: AbortSignal): AsyncIterable<NormalizedEvent>;
}

/** The user's message + attachments for one turn. */
export interface TurnInput {
  message: string;
  /** Absolute paths to attached files (already injected into `message` too). */
  attachmentPaths?: string[];
  /**
   * True for turn 1 — the plugin applies the system prompt (per-CLI transport,
   * Decision 3). Resumed turns rely on the CLI's own session state.
   */
  isFirstTurn: boolean;
}

/**
 * Everything a plugin needs to spawn correctly for a worktree OR direct session.
 * `cwd` is the worktree path OR the project path (direct). `chatId` is reused
 * across turns (stable — verified, Decision 10).
 */
export interface TurnContext {
  cwd: string;
  project: ProjectRecord;
  worktree: WorktreeRecord | null;
  session: SessionRecord;
  /** Harness chat/session id, when captured (turn ≥ 2). */
  chatId?: string;
  /**
   * Edit-a-sent-message fork (R3.2): when set, the plugin branches the harness's
   * OWN session from this chat id into a NEW session id (claude: `--resume <id>
   * --fork-session`) instead of resuming in place — so the fork never mutates the
   * original branch. Takes precedence over `chatId`.
   */
  forkFromChatId?: string;
  /** Per-mode model override. */
  model?: string;
  /** Absolute path to the system-prompt file (applied on the first turn). */
  systemPromptFile: string;
  daemonPort: number;
  /**
   * Called by the plugin with each spawned child PID. The child MUST be its own
   * process group (detached) so the core can group-kill orphans on boot/abort
   * (Decision 13).
   */
  onSpawn?: (pid: number) => void;
}

export interface AgentPlugin {
  readonly name: string;
  /** Default model id for UI when creating modes for this CLI. */
  readonly defaultModel: string;
  readonly promptDelivery: "inline" | "post-launch";
  /** Extra settle time after ready sentinel (or fallback delay), before stdin paste. */
  readonly postSentinelDelayMs?: number;
  /** Return argv (binary + flags) — tmux execs this directly, no shell. */
  getLaunchCommand(cfg: LaunchConfig): string[];
  getEnvironment(cfg: LaunchConfig): Record<string, string>;
  getReadySignal(): { sentinel?: string; fallbackMs: number };
  composeLaunchPrompt(prompt: {
    systemPrompt: string;
    taskPrompt?: string;
    sessionId: string;
    systemPromptFile: string;
    launchCfg: LaunchConfig;
  }): { launchArgs?: string[]; postLaunchInput?: string; postLaunchSubmit?: boolean; useShell?: boolean; shellLine?: string };
  /**
   * One-time-per-worktree setup of CLI-specific workspace files (hook scripts,
   * settings, plugin files). Idempotent — called on every spawn/restore, must
   * be safe to re-run.
   *
   * `/vst` in-chat slash command (sqlite-agent-naming Part 02, Phase 3): all
   * three plugins additionally write a `/vst` custom-slash-command file here,
   * each mapping `/vst reset|handoff|rename ...` to the matching
   * `vst session reset|handoff|rename` / `vst worktree rename` CLI invocation
   * (verified per-CLI via research, not assumed):
   *   - claude.ts   -> `.claude/commands/vst.md`   (`$ARGUMENTS` substitution)
   *   - opencode.ts -> `.opencode/commands/vst.md` (`$ARGUMENTS` substitution,
   *     near-exact analog of Claude Code's mechanism)
   *   - cursor.ts   -> `.cursor/commands/vst.md`   (NO `$ARGUMENTS` placeholder —
   *     Cursor appends trailing user text after the file's content rather than
   *     substituting it in, so that template is phrased to read naturally either way)
   */
  setupWorkspaceHooks?(workspacePath: string): Promise<void>;
  /**
   * Pre-spawn: obtain a chat id before launching (e.g. cursor-agent create-chat).
   *
   * `cwd` is the session's working directory — a worktree checkout, or
   * project.absolutePath for a direct session. Plugins must use it rather than
   * deriving a path from a worktree id: direct sessions have no worktree, and
   * a fabricated one resolves to a nonexistent directory.
   */
  provideChatId?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    cwd: string;
  }): Promise<string | null>;
  /** Post-ready: capture the agent's chat id written to a token file by a hook/plugin. */
  captureChatId?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    /** Session working directory — see provideChatId. */
    cwd: string;
  }): Promise<string | null>;
  /**
   * Called on a tty→json channel toggle, AFTER the terminal has been torn
   * down, to re-verify `agentChatId` against the CLI's own live state.
   * Optional — only implement this when the plugin's `captureChatId` is
   * fragile enough that a stale/wrong value could have been captured at
   * spawn time without erroring (e.g. agy's cache file is keyed by cwd, not
   * by session, so a premature read can silently return a DIFFERENT
   * conversation's id rather than failing). By the time a user actually
   * toggles a live terminal session, the CLI's own state should correctly
   * reflect that session's real conversation — this is the self-healing
   * moment. CLIs with a reliable session-scoped `captureChatId` (claude,
   * opencode) should NOT implement this: their already-correct
   * `agentChatId` should be trusted as-is, and for opencode specifically,
   * re-invoking its poll-based `captureChatId` here would hang for its full
   * 30s timeout (the token file it polls for was already consumed at spawn
   * time and will never reappear).
   */
  refreshChatIdOnToggle?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    worktree: WorktreeRecord;
  }): Promise<string | null>;
  /**
   * Return the list of models available for this CLI.
   * Each plugin owns its own discovery strategy — callers never branch on CLI name.
   */
  listModels(): Promise<{ models: string[]; error?: string }>;
  /**
   * Fork capability (R3.2): plugins that can branch a resumed session into a NEW
   * session id return the extra argv that does so (claude: `["--fork-session"]`).
   * Presence is the fork gate — the fork endpoint is claude-only at launch (R3.5),
   * so only claude implements this; other CLIs are blocked until their at-rest
   * "new-conversation-replay" fallback ships (deferred).
   */
  getForkCommand?(): string[];
  /**
   * Return argv for resuming a prior session, or null for fresh launch.
   * Works for direct sessions too — see `cwd` on provideChatId.
   */
  getRestoreCommand?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    /** Session working directory — see provideChatId. */
    cwd: string;
    /** Per-mode model override — plugin should include the model flag in the returned argv. */
    model?: string;
  }): Promise<string[] | null>;

  // --- JSON agent-chat transport (AgentJsonTransport, Decision 3) ---
  // Optional: only plugins that support the JSON channel implement these.
  /** Whether this plugin can run in the JSON channel. */
  supportsJson?(): boolean;
  /**
   * Run ONE turn; yield NormalizedEvents as they arrive. Completing the iterator
   * == the turn is done. The plugin owns spawn/transport + normalization.
   */
  runTurn?(
    input: TurnInput,
    ctx: TurnContext,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedEvent>;
}

export interface LaunchConfig {
  project: ProjectRecord;
  /**
   * The context this agent runs in — worktree or project-direct. Use
   * `ctx.cwd` and the `*For(ctx, …)` path helpers rather than deriving paths
   * from a worktree id: a direct session has no worktree, and the fabricated
   * one this replaced resolved to a nonexistent directory.
   *
   * `ctx.worktree` is null for direct sessions. Gate on it for things that are
   * genuinely worktree-only (branch metadata, VST_WORKTREE).
   */
  ctx: ResolvedContext;
  session: SessionRecord;
  daemonPort: number;
  /** Per-mode model override passed to the agent CLI when set. */
  model?: string;
}

export interface SpawnOptions {
  project: ProjectRecord;
  worktree: WorktreeRecord;
  session: SessionRecord;
  plugin: AgentPlugin;
  daemonPort: number;
  systemPrompt: string;
  taskPrompt?: string;
  model?: string;
}

export interface DirectSpawnOptions {
  project: ProjectRecord;
  session: SessionRecord;
  plugin: AgentPlugin;
  daemonPort: number;
  systemPrompt: string;
  taskPrompt?: string;
  model?: string;
}

export interface SpawnSessionFromArgvOptions {
  project: ProjectRecord;
  /** Working directory: worktree checkout, or project.absolutePath for a direct session. */
  cwd: string;
  /** Worktree id, or undefined for a direct session (direct-pty bookkeeping only). */
  worktreeId?: string;
  session: SessionRecord;
  argv: string[];
  env: Record<string, string>;
  fallbackMs: number;
}

/**
 * tmux refuses `new-session -s <name>` when a session of that name already
 * exists ("duplicate session"), which surfaces to the user as a 500 rather
 * than anything actionable.
 *
 * Every caller here is spawning what it believes is a *new* pane for this
 * session id — a fresh spawn, or a resume that is about to restore the
 * conversation from the agent's own history. An existing pane under that name
 * is therefore stale by definition, so replace it rather than failing.
 *
 * Note this is a real (if intentional) process kill: it is safe only because
 * the caller is committed to respawning the pane immediately.
 */
async function killStaleTmuxSession(name: string): Promise<void> {
  if (await hasSession(name)) {
    console.warn(`[spawn] tmux session ${name} already exists — killing stale pane before respawn`);
    await killSession(name);
  }
}

/**
 * Spawn a session with an explicit argv (no prompt composition).
 * Used by resume path to spawn from restore argv directly.
 * Branches on useTmux: direct-pty spawns via DirectPtyBackend, tmux via newSession.
 */
export async function spawnSessionFromArgv(opts: SpawnSessionFromArgvOptions): Promise<void> {
  const { project, cwd, worktreeId, session, argv, env, fallbackMs } = opts;

  if (!session.useTmux) {
    // Direct-pty spawn
    await DirectPtyBackend.spawn({
      command: argv[0]!,
      args: argv.slice(1),
      cwd,
      env,
      cols: 80,
      rows: 24,
      sessionId: session.id,
      projectId: project.id,
      worktreeId,
    });

    await sleep(fallbackMs);
    return;
  }

  // Tmux spawn (existing code)
  try {
    await killStaleTmuxSession(session.tmuxName);
    await newSession({
      name: session.tmuxName,
      cwd,
      env,
      command: argv,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        "tmux is not installed or not on PATH. Install tmux to launch agent sessions.",
      );
    }
    throw err;
  }

  await sleep(fallbackMs);
}

/**
 * Spawn a session from plugin configuration.
 * Assumes the session record is already in memory + on disk at not_started state.
 * Branches on session.useTmux.
 */
export async function spawnSession(opts: SpawnOptions): Promise<void> {
  const { project, worktree, session, plugin, daemonPort, systemPrompt, taskPrompt, model } = opts;
  const ctx = resolvedContextOf(project, worktree);
  const wtPath = ctx.cwd;

  const launchCfg: LaunchConfig = {
    project,
    ctx,
    session,
    daemonPort,
    ...(model ? { model } : {}),
  };

  // Steps 2.5 + 3: provideChatId + setupWorkspaceHooks in parallel (both pre-spawn, independent)
  const [preSpawnChatId] = await Promise.all([
    plugin.provideChatId?.({ session, project, cwd: wtPath }) ?? Promise.resolve(null),
    plugin.setupWorkspaceHooks ? plugin.setupWorkspaceHooks(wtPath) : Promise.resolve(),
  ]);
  if (preSpawnChatId) {
    session.agentChatId = preSpawnChatId;
  }

  // Write system-prompt file to per-session data dir
  const dataDir = sessionDataDirFor(ctx, session.id);
  mkdirSync(dataDir, { recursive: true });
  const promptFile = systemPromptPathFor(ctx, session.id);
  writeFileSync(promptFile, systemPrompt, "utf8");

  // Compose launch prompt
  const { launchArgs, postLaunchInput, postLaunchSubmit, useShell, shellLine } = plugin.composeLaunchPrompt({
    systemPrompt,
    taskPrompt,
    sessionId: session.id,
    systemPromptFile: promptFile,
    launchCfg,
  });

  // Step 4: Resolve env
  const baseEnv: Record<string, string> = {
    VST_SESSION: session.id,
    VST_SPAWN_TOKEN: session.id,
    VST_WORKTREE: worktree.id,
    VST_PROJECT: project.id,
    VST_DATA_DIR: `${process.env.HOME ?? "~"}/.vibe-station/projects/${project.id}`,
    VST_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
    ...plugin.getEnvironment(launchCfg),
  };

  // Build launch command (binary + flags)
  const commandParts: string[] = useShell && shellLine
    ? ["sh", "-lc", shellLine]
    : [...plugin.getLaunchCommand(launchCfg), ...(launchArgs ?? [])];

  // Step 5: Spawn (branch on useTmux)
  if (!session.useTmux) {
    // Direct-pty path
    let stream = null;
    try {
      stream = await DirectPtyBackend.spawn({
        command: commandParts[0]!,
        args: commandParts.slice(1),
        cwd: wtPath,
        env: baseEnv,
        cols: 80,
        rows: 24,
        sessionId: session.id,
        projectId: project.id,
        worktreeId: worktree.id,
      });

      // Step 6: Wait for ready signal
      const { sentinel, fallbackMs } = plugin.getReadySignal();
      if (sentinel) {
        const ready = await stream.waitForOutput(sentinel, fallbackMs);
        if (!ready) {
          console.warn(
            `[spawn] Ready sentinel not found for ${session.id} (${plugin.name}); proceeding anyway`,
          );
        }
      } else {
        await sleep(fallbackMs);
      }

      await sleep(plugin.postSentinelDelayMs ?? 0);

      // Step 7: Send postLaunchInput
      if (postLaunchInput) {
        stream.write(postLaunchInput);
        // postLaunchSubmit: explicit Enter so the TUI submits the message.
        // Direct-pty has no bracketed paste, so embedded newlines may already
        // act as Enter in some TUIs — but a trailing Enter is harmless when
        // the input box already submitted on its own (it just opens an empty
        // line on the next prompt) and necessary for TUIs that consumed the
        // whole write as one input event.
        if (postLaunchSubmit) {
          stream.write("\r");
        }
      }

      // Step 7.5: Capture chat ID written by agent hook/plugin
      const capturedId = await plugin.captureChatId?.({ session, project, cwd: wtPath }) ?? null;
      if (capturedId) {
        session.agentChatId = capturedId;
      }
    } catch (err) {
      // Clean up the stream on error
      if (stream) {
        stream.kill();
      }
      throw err;
    }
    return;
  }

  // Tmux path (existing logic)
  try {
    await killStaleTmuxSession(session.tmuxName);
    await newSession({
      name: session.tmuxName,
      cwd: wtPath,
      env: baseEnv,
      command: commandParts,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        "tmux is not installed or not on PATH. Install tmux to launch agent sessions.",
      );
    }
    throw err;
  }

  // Step 6: Wait for ready signal
  const { sentinel, fallbackMs } = plugin.getReadySignal();
  if (sentinel) {
    await waitForSentinel(session.tmuxName, sentinel, fallbackMs);
  } else {
    await sleep(fallbackMs);
  }

  await sleep(plugin.postSentinelDelayMs ?? 0);

  // Step 7: Send postLaunchInput if any — use paste-buffer to avoid shell arg-length limits
  if (postLaunchInput) {
    if (!(await hasSession(session.tmuxName))) {
      const binary = commandParts[0] ?? plugin.name;
      console.warn(
        `[spawn] Skipping post-launch prompt for ${session.id}: pane ${session.tmuxName} is gone (${binary} likely exited at startup).`,
      );
      return;
    }
    await pasteBuffer(session.tmuxName, `vst-prompt-${session.id}`, postLaunchInput);
    // Bracketed paste in pasteBuffer (-p) prevents embedded newlines from
    // being interpreted as Enter — necessary for multi-line prompts not to
    // be split across multiple submissions. The trade-off: we now need an
    // explicit Enter to submit. Plugins that want auto-submit (e.g. opencode)
    // opt in via postLaunchSubmit.
    if (postLaunchSubmit) {
      await sendKeys(session.tmuxName, "", true);
    }

    const needle = promptVerificationNeedle(session.id);
    if (postLaunchInput.includes(needle)) {
      await sleep(500);
      let pane = await capturePane(session.tmuxName, { lines: 50 });
      let ok = pane.includes(needle);
      if (!ok) {
        await sleep(1500);
        pane = await capturePane(session.tmuxName, { lines: 50 });
        ok = pane.includes(needle);
      }
      if (!ok) {
        console.warn(
          `[spawn] prompt-injection unverified for ${session.id} (${plugin.name})`,
        );
      }
    }
  }

  // Step 7.5: Capture chat ID written by agent hook/plugin
  const capturedId = await plugin.captureChatId?.({ session, project, cwd: wtPath }) ?? null;
  if (capturedId) {
    session.agentChatId = capturedId;
  }
}

/**
 * Spawn a direct session (in project directory, no worktree).
 * Similar to spawnSession but uses project.absolutePath as cwd.
 */
export async function spawnDirectSession(opts: DirectSpawnOptions): Promise<void> {
  const { project, session, plugin, daemonPort, systemPrompt, taskPrompt, model } = opts;
  // A project context — no worktree. Plugins read ctx.cwd / ctx.worktree
  // instead of the fabricated worktree record this replaced, whose id pointed
  // at a directory that never existed.
  const ctx = resolvedContextOf(project, null);
  const cwd = ctx.cwd;

  const launchCfg: LaunchConfig = {
    project,
    ctx,
    session,
    daemonPort,
    ...(model ? { model } : {}),
  };

  // Setup workspace hooks in project directory
  if (plugin.setupWorkspaceHooks) {
    await plugin.setupWorkspaceHooks(cwd);
  }

  // Write system-prompt file to this context's session data dir
  const dataDir = sessionDataDirFor(ctx, session.id);
  mkdirSync(dataDir, { recursive: true });
  const promptFile = systemPromptPathFor(ctx, session.id);
  writeFileSync(promptFile, systemPrompt, "utf8");

  // Compose launch prompt
  const { launchArgs, postLaunchInput, postLaunchSubmit, useShell, shellLine } = plugin.composeLaunchPrompt({
    systemPrompt,
    taskPrompt,
    sessionId: session.id,
    systemPromptFile: promptFile,
    launchCfg,
  });

  // Resolve env (no worktree env vars for direct sessions)
  const baseEnv: Record<string, string> = {
    VST_SESSION: session.id,
    VST_SPAWN_TOKEN: session.id,
    VST_PROJECT: project.id,
    VST_DATA_DIR: `${process.env.HOME ?? "~"}/.vibe-station/projects/${project.id}`,
    VST_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
    ...plugin.getEnvironment(launchCfg),
  };

  // Build launch command
  const commandParts: string[] = useShell && shellLine
    ? ["sh", "-lc", shellLine]
    : [...plugin.getLaunchCommand(launchCfg), ...(launchArgs ?? [])];

  // Spawn (branch on useTmux)
  if (!session.useTmux) {
    let stream = null;
    try {
      stream = await DirectPtyBackend.spawn({
        command: commandParts[0]!,
        args: commandParts.slice(1),
        cwd,
        env: baseEnv,
        cols: 80,
        rows: 24,
        sessionId: session.id,
        projectId: project.id,
        worktreeId: undefined,
      });

      const { sentinel, fallbackMs } = plugin.getReadySignal();
      if (sentinel) {
        const ready = await stream.waitForOutput(sentinel, fallbackMs);
        if (!ready) {
          console.warn(
            `[spawn] Ready sentinel not found for ${session.id} (${plugin.name}); proceeding anyway`,
          );
        }
      } else {
        await sleep(fallbackMs);
      }

      await sleep(plugin.postSentinelDelayMs ?? 0);

      if (postLaunchInput) {
        stream.write(postLaunchInput);
        if (postLaunchSubmit) {
          stream.write("\r");
        }
      }

      // Step 7.5: capture chat id — mirrors spawnSession. Without this a direct
      // session has no agentChatId, so Resume can never restore its history.
      const capturedId = await plugin.captureChatId?.({ session, project, cwd }) ?? null;
      if (capturedId) {
        session.agentChatId = capturedId;
      }
    } catch (err) {
      if (stream) {
        stream.kill();
      }
      throw err;
    }
    return;
  }

  // Tmux path
  try {
    await killStaleTmuxSession(session.tmuxName);
    await newSession({
      name: session.tmuxName,
      cwd,
      env: baseEnv,
      command: commandParts,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        "tmux is not installed or not on PATH. Install tmux to launch agent sessions.",
      );
    }
    throw err;
  }

  const { sentinel, fallbackMs } = plugin.getReadySignal();
  if (sentinel) {
    await waitForSentinel(session.tmuxName, sentinel, fallbackMs);
  } else {
    await sleep(fallbackMs);
  }

  await sleep(plugin.postSentinelDelayMs ?? 0);

  if (postLaunchInput) {
    if (!(await hasSession(session.tmuxName))) {
      const binary = commandParts[0] ?? plugin.name;
      console.warn(
        `[spawn] Skipping post-launch prompt for ${session.id}: pane ${session.tmuxName} is gone (${binary} likely exited at startup).`,
      );
      return;
    }
    await pasteBuffer(session.tmuxName, `vst-prompt-${session.id}`, postLaunchInput);
    if (postLaunchSubmit) {
      await sendKeys(session.tmuxName, "", true);
    }
  }

  // Step 7.5: capture chat id — see the direct-pty branch above.
  const capturedId = await plugin.captureChatId?.({ session, project, cwd }) ?? null;
  if (capturedId) {
    session.agentChatId = capturedId;
  }
}

async function waitForSentinel(
  tmuxName: string,
  sentinel: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 200;

  while (Date.now() < deadline) {
    try {
      const sessionExists = await hasSession(tmuxName);
      if (!sessionExists) return; // Session died — caller will detect

      const output = await capturePane(tmuxName, { lines: 50 });
      if (output.includes(sentinel)) return;
    } catch {
      // Tmux not ready yet — keep waiting
    }
    await sleep(pollMs);
  }
  // Timed out — proceed anyway (fallback behavior)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
