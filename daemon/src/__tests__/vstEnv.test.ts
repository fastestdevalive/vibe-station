import { describe, it, expect } from "vitest";
import { buildVstEnv } from "../services/context.js";
import type { ProjectRecord, WorktreeRecord, SessionRecord } from "../types.js";

const project = { id: "proj-1" } as unknown as ProjectRecord;
const worktree = { id: "wt-1" } as unknown as WorktreeRecord;
const session = { id: "sess-1" } as unknown as SessionRecord;

describe("buildVstEnv (Decision 1 — single source of VST env)", () => {
  it("1.T1 — returns all six vars for a worktree session", () => {
    const env = buildVstEnv({ project, worktree, session, daemonPort: 7421 });
    expect(env.VST_SESSION).toBe("sess-1");
    expect(env.VST_SPAWN_TOKEN).toBe("sess-1");
    expect(env.VST_WORKTREE).toBe("wt-1");
    expect(env.VST_PROJECT).toBe("proj-1");
    expect(env.VST_DATA_DIR).toContain("proj-1");
    expect(env.VST_DAEMON_URL).toBe("http://127.0.0.1:7421");
  });

  it("1.T1 — omits VST_WORKTREE entirely (not an empty string) when worktree is null", () => {
    const env = buildVstEnv({ project, worktree: null, session, daemonPort: 7421 });
    expect("VST_WORKTREE" in env).toBe(false);
    expect(env.VST_SESSION).toBe("sess-1");
  });
});
