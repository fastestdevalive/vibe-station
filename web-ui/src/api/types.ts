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
  prefix: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Worktree {
  id: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  baseSha?: string;
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
  lifecycleState: SessionState;
  tmuxName: string;
  useTmux?: boolean;
  createdAt: string;
}

export type CliId = "claude" | "cursor" | "opencode";

export interface Mode {
  id: string;
  name: string;
  cli: CliId;
  context: string;
  presetId?: string;
  /** Passed as CLI `--model` / `-m` when set; omitted uses CLI default. */
  model?: string;
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
      /** Legacy: mode id string when agent; omitted for terminal */
      mode?: string;
      /** Full session row for optimistic UI (daemon v1+) */
      snapshot?: Session;
    }
  | {
      type: "session:state";
      sessionId: string;
      state: SessionState;
      reason?: string;
    }
  | {
      type: "session:opened";
      sessionId: string;
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
      type: "session:deleted";
      sessionId: string;
    }
  | {
      type: "session:error";
      sessionId: string;
      message: string;
    }
  | {
      type: "session:resumed";
      sessionId: string;
      restoredFromHistory: boolean;
    }
  | {
      type: "file:changed";
      worktreeId: string;
      path: string;
    }
  | {
      type: "file:deleted";
      worktreeId: string;
      path: string;
    }
  | {
      type: "tree:changed";
      worktreeId: string;
      path: string;
      kind: "added" | "deleted" | "renamed";
      from?: string;
      to?: string;
    }
  | {
      type: "project:created";
      project: Project;
    }
  | {
      type: "project:deleted";
      projectId: string;
    }
  | {
      type: "worktree:created";
      worktree: Worktree;
    }
  | {
      type: "worktree:deleted";
      worktreeId: string;
    }
  | {
      type: "mode:created";
      mode: Mode;
    }
  | {
      type: "mode:updated";
      mode: Mode;
    }
  | {
      type: "mode:deleted";
      modeId: string;
    }
  | {
      type: "pong";
    }
  | {
      type: "system:error";
      message: string;
    };

export type DiffScope = "local" | "branch" | "none";

export type GitStatusChar = "M" | "A" | "D" | "R" | "?";

export interface ChangedPathEntry {
  path: string;
  status: GitStatusChar;
}

export interface CreateWorktreeBody {
  projectId: string;
  branch: string;
  modeId: string;
  baseBranch?: string;
  prompt?: string;
  useTmux?: boolean;
}

export interface CreateSessionBody {
  worktreeId: string;
  modeId: string | null;
  type: SessionType;
  prompt?: string;
  useTmux?: boolean;
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
  model?: string;
}

export interface UpdateModeBody {
  name?: string;
  cli?: CliId;
  context?: string;
  model?: string;
}

export interface TerminalApi {
  openSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  sendKeystroke: (sessionId: string, data: string) => Promise<void>;
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<void>;
}
