export function getVSTProject(): string | undefined {
  return process.env.VST_PROJECT;
}

export function getVSTWorktree(): string | undefined {
  return process.env.VST_WORKTREE;
}

export function getVSTSession(): string | undefined {
  return process.env.VST_SESSION;
}

export function getVSTDaemonUrl(): string | undefined {
  return process.env.VST_DAEMON_URL;
}
