/**
 * Tmux command wrappers.
 * All functions use execFile so each argument is passed directly as an argv
 * element — no shell quoting, no ARG_MAX issues with large prompts.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

async function run(args: string[]): Promise<string> {
  const { stdout } = await execFile("tmux", args, { env: { ...process.env } });
  return stdout.trim();
}

/** Returns true if the named tmux session exists. */
export async function hasSession(name: string): Promise<boolean> {
  try {
    await run(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session by name. Best-effort — does not throw if not found. */
export async function killSession(name: string): Promise<void> {
  try {
    await run(["kill-session", "-t", name]);
  } catch {
    // Session may not exist
  }
}

export interface NewSessionOptions {
  name: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Command + args to run as the initial command */
  command?: string[];
}

/** Create a new detached tmux session. */
export async function newSession(opts: NewSessionOptions): Promise<void> {
  const args: string[] = ["new-session", "-d", "-s", opts.name];
  if (opts.cwd) {
    args.push("-c", opts.cwd);
  }
  if (opts.env) {
    for (const [key, val] of Object.entries(opts.env)) {
      args.push("-e", `${key}=${val}`);
    }
  }
  if (opts.command && opts.command.length > 0) {
    // command must be the last argument
    args.push(...opts.command);
  }
  await run(args);
}

/** Send keys to a tmux session/pane. */
export async function sendKeys(target: string, keys: string, enter = false): Promise<void> {
  const args: string[] = ["send-keys", "-t", target, keys];
  if (enter) args.push("Enter");
  await run(args);
}

/** Capture pane output from a tmux session. */
export async function capturePane(
  target: string,
  opts: { lines?: number; escape?: boolean } = {},
): Promise<string> {
  const args: string[] = ["capture-pane", "-p", "-t", target];
  if (opts.escape) args.push("-e");
  if (opts.lines !== undefined) {
    args.push("-S", String(-Math.abs(opts.lines)));
  }
  return run(args);
}

/** List all tmux sessions, returning their names. */
export async function listSessions(): Promise<string[]> {
  try {
    const output = await run(["list-sessions", "-F", "#{session_name}"]);
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Load data into a named tmux buffer via a temp file and paste it into the
 * target pane. This avoids the shell argument-length limit that `send-keys`
 * hits with large prompts.
 */
export async function pasteBuffer(target: string, bufferId: string, data: string): Promise<void> {
  const { writeFile, unlink } = await import("node:fs/promises");
  const tmpFile = `/tmp/vr-buf-${bufferId}-${Date.now()}`;
  try {
    await writeFile(tmpFile, data, "utf8");
    await run(["load-buffer", "-b", bufferId, tmpFile]);
    await run(["paste-buffer", "-b", bufferId, "-d", "-t", target]);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
