// @ts-nocheck
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
import { newSession, hasSession, capturePane, pasteBuffer, sendKeys } from "./tmux.js";
import { DirectPtyBackend } from "./directPty.js";
import { worktreePath as getWorktreePath, sessionDataDir, systemPromptPath } from "./paths.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

/** Substring searched in pane output after paste (matches plugins' HTML tail marker). */
export function promptVerificationNeedle(sessionId: string): string {
  return `VSTPRMT:${sessionId}`;
}

export interface AgentPlugin {
  readonly name: string;
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
  setupWorkspaceHooks?(workspacePath: string): Promise<void>;
  /** Pre-spawn: obtain a chat id before launching (e.g. cursor-agent create-chat). */
  provideChatId?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    worktree: WorktreeRecord;
  }): Promise<string | null>;
  /** Post-ready: capture the agent's chat id written to a token file by a hook/plugin. */
  captureChatId?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    worktree: WorktreeRecord;
  }): Promise<string | null>;
  /**
   * Return the list of models available for this CLI.
   * Each plugin owns its own discovery strategy — callers never branch on CLI name.
   */
  listModels(): Promise<{ models: string[]; error?: string }>;
  /** Return argv for resuming a prior session, or null for fresh launch. */
  getRestoreCommand?(args: {
    session: SessionRecord;
    project: ProjectRecord;
    worktree: WorktreeRecord;
    /** Per-mode model override — plugin should include the model flag in the returned argv. */
    model?: string;
  }): Promise<string[] | null>;
}

export interface LaunchConfig {
  project: ProjectRecord;
  worktree: WorktreeRecord;
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

export interface SpawnSessionFromArgvOptions {
  project: ProjectRecord;
  worktree: WorktreeRecord;
  session: SessionRecord;
  argv: string[];
  env: Record<string, string>;
  fallbackMs: number;
}

/**
 * Spawn a session with an explicit argv (no prompt composition).
 * Used by resume path to spawn from restore argv directly.
 * Branches on useTmux: direct-pty spawns via DirectPtyBackend, tmux via newSession.
 */
export async function spawnSessionFromArgv(opts: SpawnSessionFromArgvOptions): Promise<void> {
  const { project, worktree, session, argv, env, fallbackMs } = opts;
  const wtPath = getWorktreePath(project.id, worktree.id);

  if (!session.useTmux) {
    // Direct-pty spawn
    await DirectPtyBackend.spawn({
      command: argv[0]!,
      args: argv.slice(1),
      cwd: wtPath,
      env,
      cols: 80,
      rows: 24,
      sessionId: session.id,
      projectId: project.id,
      worktreeId: worktree.id,
    });

    await sleep(fallbackMs);
    return;
  }

  // Tmux spawn (existing code)
  try {
    await newSession({
      name: session.tmuxName,
      cwd: wtPath,
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
  const wtPath = getWorktreePath(project.id, worktree.id);

  const launchCfg: LaunchConfig = {
    project,
    worktree,
    session,
    daemonPort,
    ...(model ? { model } : {}),
  };

  // Steps 2.5 + 3: provideChatId + setupWorkspaceHooks in parallel (both pre-spawn, independent)
  const [preSpawnChatId] = await Promise.all([
    plugin.provideChatId?.({ session, project, worktree }) ?? Promise.resolve(null),
    plugin.setupWorkspaceHooks ? plugin.setupWorkspaceHooks(wtPath) : Promise.resolve(),
  ]);
  if (preSpawnChatId) {
    session.agentChatId = preSpawnChatId;
  }

  // Write system-prompt file to per-session data dir
  const dataDir = sessionDataDir(project.id, worktree.id, session.id);
  mkdirSync(dataDir, { recursive: true });
  const promptFile = systemPromptPath(project.id, worktree.id, session.id);
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
      const capturedId = await plugin.captureChatId?.({ session, project, worktree }) ?? null;
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
  const capturedId = await plugin.captureChatId?.({ session, project, worktree }) ?? null;
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
