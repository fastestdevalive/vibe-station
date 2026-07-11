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
  /** True if this is a git repository; false for non-git directories. */
  isGit: boolean;
  /** Default branch (git projects only). */
  defaultBranch?: string;
  createdAt: string;
  /** When true, the project and all its worktrees are hidden from the sidebar
   *  and dashboard. Always emitted by the daemon (defaults to false). */
  hidden: boolean;
}

export interface Worktree {
  id: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  baseSha?: string;
  createdAt: string;
  /**
   * ISO8601 timestamp set when the user pins this worktree to the top of the
   * sidebar; null when unpinned. The timestamp also encodes recency for
   * default sort order (newest first).
   */
  pinnedAt: string | null;
}

/**
 * File-browsing scope. "worktree" hits /worktrees/:id/... (git-aware);
 * "project" hits /projects/:id/... (plain files in the project base dir, used
 * by direct sessions which have no worktree).
 */
export type FileScope = "worktree" | "project";

export type SessionType = "agent" | "terminal";

export type SessionState = "not_started" | "working" | "idle" | "done" | "exited";

export interface Session {
  id: string;
  /** Worktree this session belongs to; null for direct sessions. */
  worktreeId: string | null;
  /** Project this session belongs to. Always present. */
  projectId: string;
  modeId: string | null;
  type: SessionType;
  /** Display label in tabs / sidebar (custom name when set, else slot-derived) */
  label: string;
  /** User-set/default display name (terminals). null when slot-derived. */
  name?: string | null;
  /** Stable slot: `m` = main (non-closable), `a{n}`, `t{n}`, `d{n}` (direct) */
  slot: string;
  state: SessionState;
  lifecycleState: SessionState;
  tmuxName: string;
  useTmux?: boolean;
  createdAt: string;
  /** When set, the session is pinned to the top of its sidebar group. */
  pinnedAt?: string | null;
}

/** Dynamic CLI id strings — canonical list from GET /supported-clis */
export type CliId = string;

export interface SupportedCli {
  id: string;
  defaultModel: string;
}

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
      /** Null for direct sessions (no worktree). */
      worktreeId: string | null;
      /** Project ID (present for direct sessions). */
      projectId?: string;
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
      type: "session:updated";
      sessionId: string;
      pinnedAt?: string | null;
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
      type: "project:updated";
      project: Project;
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
      type: "worktree:updated";
      worktree: Worktree;
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
      /** Synthetic event emitted from the client on initial connect and every
       *  reconnect. Consumers use this to refetch server state — the client's
       *  persisted live caches (e.g. sessionStates) survive cold loads and can
       *  be stale, so we trust the server on every fresh handshake. */
      type: "ws:open";
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

export interface ProjectBranchesResponse {
  branches: string[];
  /** Null for a non-git project (the daemon sends null in that case). */
  defaultBranch: string | null;
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
  /** Optional display name for terminals; blank → daemon assigns "Terminal N". */
  name?: string;
}

/** Body for creating a direct session (no worktree). */
export interface CreateDirectSessionBody {
  target: "direct";
  projectId: string;
  type: SessionType;
  modeId?: string;
  prompt?: string;
  useTmux?: boolean;
  name?: string;
}

/** Body for adding a new project. */
export interface AddProjectBody {
  path: string;
  name?: string;
  /** When true, run the git-ready setup script (init + .gitignore + initial
   *  `main` commit) against the directory after registering it. */
  setup?: boolean;
}

/** Response from POST /projects. Extends Project with an optional `warning`
 *  when `setup: true` was requested but the setup script failed (the project
 *  stays registered regardless — see daemon routes/projects.ts). */
export type AddProjectResponse = Project & { warning?: string };

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
  /** Diagnostic channel (mobile double-text investigation): ship batched input/
   *  composition events to the daemon's input-debug log. Optional so the mock
   *  can omit it. */
  sendDebug?: (entries: Record<string, unknown>[]) => Promise<void>;
}

/** User-configurable settings from GET/PATCH /settings */
export interface Settings {
  defaultProjectsDir: string;
  /** Runtime-computed home dir (not persisted) — for `~` display/expansion. */
  homeDir?: string;
}

/** Body for POST /projects/create — create a brand new project directory. */
export interface CreateProjectBody {
  /** Project name (directory name). */
  name: string;
  /** Parent directory override (default: settings.defaultProjectsDir). */
  dir?: string;
  /** Optional: start an agent after creating. */
  startAgent?: {
    modeId: string;
    prompt?: string;
    useWorktree?: boolean;
    /** Branch name for the worktree (useWorktree only). Default "feature". */
    branch?: string;
  };
}

/** Response from POST /projects/create. */
export interface CreateProjectResponse {
  project: Project;
  worktree?: Worktree;
  session?: Session;
  warning?: string;
}

/** Response from GET /fs/complete — directory-only autocomplete. */
export interface FsCompleteResponse {
  /** The directory being listed (absolute path). */
  base: string;
  /** Child directories matching the completion, sorted by name (capped). */
  entries: { name: string; path: string }[];
}
