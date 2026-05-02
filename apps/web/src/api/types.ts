/** Mirrors docs/HIGH-LEVEL-DESIGN.md §8 */

export interface HealthResponse {
  ok: boolean;
  version: string;
  port: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  baseBranch: string;
  createdAt: string;
}

export type SessionType = "agent" | "terminal";

export type SessionState = "not_started" | "working" | "idle" | "done" | "exited";

export interface Session {
  id: string;
  worktreeId: string;
  modeId: string | null;
  type: SessionType;
  /** Display label in tabs / sidebar */
  label: string;
  /** Stable slot: `m` = main (non-closable), `a{n}`, `t{n}` */
  slot: string;
  state: SessionState;
  createdAt: string;
}

export type CliId = "claude" | "cursor" | "opencode";

export interface Mode {
  id: string;
  name: string;
  cli: CliId;
  context: string;
  presetId?: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export type WSEvent =
  | {
      type: "session:created";
      sessionId: string;
      worktreeId: string;
      sessionType: SessionType;
      mode: Mode | null;
    }
  | {
      type: "session:state";
      sessionId: string;
      state: SessionState;
      reason?: string;
    }
  | {
      type: "session:output";
      sessionId: string;
      chunk: string;
    }
  | {
      type: "session:exited";
      sessionId: string;
      exitCode?: number;
    }
  | {
      type: "session:resumed";
      sessionId: string;
      restoredFromHistory: boolean;
    };

export type DiffScope = "local" | "branch" | "none";

export type GitStatusChar = "M" | "A" | "D" | "R" | "?";

export interface ChangedPathEntry {
  path: string;
  status: GitStatusChar;
}

export interface CreateWorktreeBody {
  projectId: string;
  name: string;
  baseBranch: string;
}

export interface CreateSessionBody {
  worktreeId: string;
  modeId: string | null;
  type: SessionType;
  initialPrompt?: string;
}

export interface SendInputBody {
  data: string;
  sendEnter?: boolean;
}

export interface CreateModeBody {
  name: string;
  cli: CliId;
  context: string;
  presetId?: string;
}

export interface UpdateModeBody {
  name?: string;
  cli?: CliId;
  context?: string;
}
