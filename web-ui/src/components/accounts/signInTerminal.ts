import type { ApiInstance } from "@/api";
import type { Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";

/**
 * Which worktree hosts a sign-in Terminal (assumption A3): the active worktree,
 * else the first worktree of the active project, else the first worktree in
 * the store (Settings has no project context, and any worktree can run the
 * login command). Null only when there is no worktree at all.
 */
export function pickSignInWorktreeId(
  activeWorktreeId: string | null,
  activeProjectId: string | null,
  worktrees: Worktree[],
): string | null {
  if (activeWorktreeId) return activeWorktreeId;
  if (activeProjectId) {
    const inProject = worktrees.find((w) => w.projectId === activeProjectId);
    if (inProject) return inProject.id;
  }
  return worktrees[0]?.id ?? null;
}

/** Whether a sign-in Terminal has a worktree to run in right now. */
export function canOpenSignInTerminal(): boolean {
  const ws = useWorkspaceStore.getState();
  return pickSignInWorktreeId(ws.activeWorktreeId, ws.activeProjectId, useServerStore.getState().worktrees) !== null;
}

/** Reactive `canOpenSignInTerminal` for components. */
export function useCanOpenSignInTerminal(): boolean {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const worktrees = useServerStore((s) => s.worktrees);
  return pickSignInWorktreeId(activeWorktreeId, activeProjectId, worktrees) !== null;
}

/**
 * Restart the account's sign-in in a Terminal session and focus it. Resolves
 * false (and does nothing) when no worktree can host it; a daemon refusal
 * rejects so the caller can show it.
 */
export async function openSignInTerminal(
  api: Pick<ApiInstance, "restartAccountSignIn">,
  cli: string,
  accountId: string,
): Promise<boolean> {
  const ws = useWorkspaceStore.getState();
  const worktreeId = pickSignInWorktreeId(
    ws.activeWorktreeId,
    ws.activeProjectId,
    useServerStore.getState().worktrees,
  );
  if (!worktreeId) return false;
  const res = await api.restartAccountSignIn(cli, accountId, worktreeId);
  focusSignInSession(worktreeId, res.sessionId);
  return true;
}

/**
 * Focus the Terminal session the daemon opened for a sign-in: make its
 * worktree active, select the session and reveal the terminal dock. Uses the
 * same store actions the sidebar/tabs use to open a session.
 */
export function focusSignInSession(worktreeId: string, sessionId: string): void {
  const server = useServerStore.getState();
  const ws = useWorkspaceStore.getState();
  if (ws.activeWorktreeId !== worktreeId) {
    const wt = server.worktrees.find((w) => w.id === worktreeId);
    if (wt) {
      ws.setActiveWorktree(
        wt.projectId,
        worktreeId,
        server.sessions.filter((s) => s.worktreeId === worktreeId),
      );
    }
  }
  useWorkspaceStore.getState().setActiveTerminalSession(sessionId);
  const dockVisible = useWorkspaceStore.getState().layoutByWorktree[worktreeId]?.terminalDockVisible;
  if (!dockVisible) useWorkspaceStore.getState().toggleTerminalDock();
}
