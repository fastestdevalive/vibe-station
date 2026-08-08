import { describe, it, expect } from "vitest";
import {
  rowToBool,
  boolToRow,
  rowToSession,
  sessionToRow,
  rowToWorktree,
  worktreeToRow,
  rowToProject,
  projectToRow,
} from "../state/sqliteRowMappers.js";
import type { ProjectRecord, SessionRecord, WorktreeRecord } from "../types.js";

describe("rowToBool / boolToRow", () => {
  it("1.T5 rowToBool(0) === false, rowToBool(1) === true", () => {
    expect(rowToBool(0)).toBe(false);
    expect(rowToBool(1)).toBe(true);
  });

  it("boolToRow round-trips", () => {
    expect(boolToRow(true)).toBe(1);
    expect(boolToRow(false)).toBe(0);
    expect(boolToRow(undefined)).toBe(0);
  });
});

describe("session row <-> record round-trip", () => {
  const session: SessionRecord = {
    id: "vs-1-a-abcd1234",
    worktreeId: "vs-1",
    projectId: "proj-1",
    isMain: false,
    sortOrder: 2,
    type: "agent",
    modeId: "claude-default",
    name: "fix-login-bug",
    nameSource: "auto",
    tmuxName: "vst-vs-1-a-abcd1234",
    useTmux: true,
    channel: "tmux",
    lifecycle: { state: "working", reason: "spawned", lastTransitionAt: "2024-01-01T00:00:00.000Z" },
    transcriptRef: { kind: "vst-json", path: "/data/messages.jsonl" },
    agentChatId: "chat-123",
    modelOverride: "claude-opus",
    pinnedAt: "2024-01-02T00:00:00.000Z",
    initialPrompt: "fix the login bug",
    archivedAt: undefined,
    handoffSummary: undefined,
  };

  it("round-trips every field through sessionToRow -> rowToSession", () => {
    const row = sessionToRow(session, "proj-1", "vs-1");
    const back = rowToSession(row);
    expect(back).toEqual(session);
  });

  it("omits optional fields entirely when the row column is NULL", () => {
    const minimal: SessionRecord = {
      id: "proj-1-t-11112222",
      projectId: "proj-1",
      isMain: false,
      sortOrder: 0,
      type: "terminal",
      tmuxName: "vst-proj-1-t-11112222",
      useTmux: false,
      lifecycle: { state: "not_started", lastTransitionAt: "2024-01-01T00:00:00.000Z" },
    };
    const row = sessionToRow(minimal, "proj-1", null);
    const back = rowToSession(row);
    expect(back).toEqual(minimal);
    expect(back.worktreeId).toBeUndefined();
    expect(back.transcriptRef).toBeUndefined();
  });
});

describe("worktree row <-> record round-trip", () => {
  it("round-trips including the new name/sortOrder fields", () => {
    const wt: WorktreeRecord = {
      id: "vs-1",
      name: "Login fix",
      branch: "feature-login",
      baseBranch: "main",
      baseSha: "0".repeat(40),
      createdAt: "2024-01-01T00:00:00.000Z",
      pinnedAt: "2024-01-02T00:00:00.000Z",
      sortOrder: 3,
      terminalSeq: 2,
      agentSeq: 5,
      sessions: [],
    };
    const row = worktreeToRow(wt, "proj-1");
    expect(rowToWorktree(row, [])).toEqual(wt);
  });
});

describe("project row <-> record round-trip", () => {
  it("round-trips including hidden/counters", () => {
    const p: ProjectRecord = {
      id: "proj-1",
      absolutePath: "/repos/proj-1",
      prefix: "vs",
      isGit: true,
      defaultBranch: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      hidden: true,
      directSessions: [],
      directSessionSeq: 4,
      worktrees: [],
      nextWorktreeNum: 6,
    };
    const row = projectToRow(p);
    expect(rowToProject(row, [], [])).toEqual(p);
  });

  it("omits `hidden` when false", () => {
    const p: ProjectRecord = {
      id: "proj-2",
      absolutePath: "/repos/proj-2",
      prefix: "vs",
      isGit: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      directSessions: [],
      worktrees: [],
    };
    const row = projectToRow(p);
    const back = rowToProject(row, [], []);
    expect(back.hidden).toBeUndefined();
  });
});
