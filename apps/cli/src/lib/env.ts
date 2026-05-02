export function getVRProject(): string | undefined {
  return process.env.VR_PROJECT;
}

export function getVRWorktree(): string | undefined {
  return process.env.VR_WORKTREE;
}

export function getVRSession(): string | undefined {
  return process.env.VR_SESSION;
}

export function getVRDaemonUrl(): string | undefined {
  return process.env.VR_DAEMON_URL;
}
