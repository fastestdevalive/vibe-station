import { describe, it, expect, beforeEach } from "vitest";
import { useServerStore } from "./useServerStore";
import type { AccountSummary, Project } from "@/api/types";

function proj(id: string, hidden = false): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    prefix: id.slice(0, 2),
    isGit: true,
      defaultBranch: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    hidden,
    lspEnabled: false,
  };
}

describe("useServerStore.applyProjectUpdated", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("replaces the matching project (flips hidden)", () => {
    useServerStore.getState().replaceAll({
      projects: [proj("a"), proj("b")],
      worktrees: [],
      sessions: [],
    });
    useServerStore.getState().applyProjectUpdated(proj("a", true));
    const { projects } = useServerStore.getState();
    expect(projects.find((p) => p.id === "a")?.hidden).toBe(true);
    expect(projects.find((p) => p.id === "b")?.hidden).toBe(false);
  });

  it("ignores an unknown project id (no surprise insert)", () => {
    useServerStore.getState().replaceAll({
      projects: [proj("a")],
      worktrees: [],
      sessions: [],
    });
    useServerStore.getState().applyProjectUpdated(proj("ghost", true));
    expect(useServerStore.getState().projects.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("useServerStore diffStats slice (rev monotonic)", () => {
  beforeEach(() => {
    useServerStore.setState({
      projects: [],
      worktrees: [],
      sessions: [],
      diffStats: {},
      loaded: false,
    });
  });

  it("applyWorktreeDiffStat keeps higher rev", () => {
    const store = useServerStore.getState();
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 5,
      deletions: 2,
      state: "ok",
      rev: 10,
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(10);

    // Stale event with lower rev is dropped
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 3,
      deletions: 1,
      state: "ok",
      rev: 5,
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(10);
    expect(useServerStore.getState().diffStats["wt-1"]?.insertions).toBe(5);

    // Higher rev is applied
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 8,
      deletions: 0,
      state: "ok",
      rev: 15,
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(15);
    expect(useServerStore.getState().diffStats["wt-1"]?.insertions).toBe(8);
  });

  it("seedDiffStats merges keeping higher rev (event then stale snapshot => event wins; restart rev higher wins)", () => {
    const store = useServerStore.getState();
    // Live event arrives first with rev 20
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 10,
      deletions: 2,
      state: "ok",
      rev: 20,
    });

    // Stale snapshot arriving later with rev 15 is ignored for wt-1, but wt-2 is added
    store.seedDiffStats({
      "wt-1": { insertions: 1, deletions: 1, state: "ok", rev: 15 },
      "wt-2": { insertions: 4, deletions: 0, state: "ok", rev: 10 },
    });

    const diffs = useServerStore.getState().diffStats;
    expect(diffs["wt-1"]?.rev).toBe(20);
    expect(diffs["wt-1"]?.insertions).toBe(10);
    expect(diffs["wt-2"]?.rev).toBe(10);

    // Restart higher rev (unix ms timestamp) wins over prior entry
    store.seedDiffStats({
      "wt-1": { insertions: 12, deletions: 3, state: "ok", rev: 1730000000000 },
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(1730000000000);
    expect(useServerStore.getState().diffStats["wt-1"]?.insertions).toBe(12);
  });
});

function acct(over: Partial<AccountSummary> & Pick<AccountSummary, "id" | "cli">): AccountSummary {
  return {
    label: null,
    displayName: over.id,
    email: null,
    plan: null,
    method: "sign_in",
    auth: "signed_in",
    isDefault: false,
    limited: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const CLAUDE_SYSTEM = acct({
  id: "system",
  cli: "claude",
  method: "system",
  displayName: "System login",
  isDefault: true,
  createdAt: null,
});
const CLAUDE_WORK = acct({ id: "acc_1a2b3c4d", cli: "claude", label: "Work", displayName: "Work" });
const CURSOR_SYSTEM = acct({
  id: "system",
  cli: "cursor",
  method: "system",
  displayName: "System login",
  isDefault: true,
  createdAt: null,
});

describe("useServerStore accounts slice", () => {
  beforeEach(() => {
    useServerStore.setState({ accounts: [], accountsLoaded: false });
  });

  it("applyAccountUpdated upserts by (cli,id)", () => {
    useServerStore.getState().replaceAccounts([CLAUDE_SYSTEM, CLAUDE_WORK, CURSOR_SYSTEM]);
    expect(useServerStore.getState().accountsLoaded).toBe(true);

    // Same (cli,id) — replace in place, do not append.
    useServerStore.getState().applyAccountUpdated({
      ...CLAUDE_WORK,
      displayName: "Work (renamed)",
      auth: "signed_out",
    });
    let rows = useServerStore.getState().accounts;
    expect(rows).toHaveLength(3);
    expect(rows.find((a) => a.cli === "claude" && a.id === "acc_1a2b3c4d")?.displayName).toBe("Work (renamed)");
    expect(rows.find((a) => a.cli === "claude" && a.id === "acc_1a2b3c4d")?.auth).toBe("signed_out");
    expect(rows.find((a) => a.cli === "cursor" && a.id === "system")).toBe(CURSOR_SYSTEM);

    // A new (cli,id) — append.
    useServerStore.getState().applyAccountUpdated(acct({ id: "acc_9f9f9f9f", cli: "claude", label: "Side" }));
    rows = useServerStore.getState().accounts;
    expect(rows).toHaveLength(4);
    expect(rows.some((a) => a.id === "acc_9f9f9f9f")).toBe(true);
  });

  it("applyAccountUpdated never collides the per-CLI System rows", () => {
    useServerStore.getState().replaceAccounts([CLAUDE_SYSTEM, CURSOR_SYSTEM]);
    useServerStore.getState().applyAccountUpdated({
      ...CLAUDE_SYSTEM,
      email: "me@personal.dev",
    });
    const rows = useServerStore.getState().accounts;
    expect(rows).toHaveLength(2);
    expect(rows.find((a) => a.cli === "claude")?.email).toBe("me@personal.dev");
    expect(rows.find((a) => a.cli === "cursor")?.email).toBeNull();
  });

  it("applyAccountRemoved removes only the matching (cli,id)", () => {
    useServerStore.getState().replaceAccounts([CLAUDE_SYSTEM, CLAUDE_WORK, CURSOR_SYSTEM]);
    useServerStore.getState().applyAccountRemoved("claude", "acc_1a2b3c4d");
    expect(useServerStore.getState().accounts.map((a) => `${a.cli}:${a.id}`)).toEqual([
      "claude:system",
      "cursor:system",
    ]);

    // Removing the claude System row leaves cursor's System row alone.
    useServerStore.getState().applyAccountRemoved("claude", "system");
    expect(useServerStore.getState().accounts.map((a) => `${a.cli}:${a.id}`)).toEqual(["cursor:system"]);
  });

  it("applyAccountLimited patches only `limited`", () => {
    useServerStore.getState().replaceAccounts([CLAUDE_SYSTEM, CLAUDE_WORK]);
    const limited = { windowId: "five_hour", resetsAt: "2026-01-01T02:00:00.000Z", source: "poller" as const };

    useServerStore.getState().applyAccountLimited("claude", "acc_1a2b3c4d", limited);
    const work = useServerStore.getState().accounts.find((a) => a.id === "acc_1a2b3c4d");
    expect(work?.limited).toEqual(limited);
    // Everything else is untouched.
    expect(work?.displayName).toBe("Work");
    expect(work?.auth).toBe("signed_in");
    expect(work?.isDefault).toBe(false);

    // A null accountId means the CLI's System row.
    useServerStore.getState().applyAccountLimited("claude", null, limited);
    expect(useServerStore.getState().accounts.find((a) => a.id === "system")?.limited).toEqual(limited);

    // An identical broadcast is a no-op (no new array).
    const before = useServerStore.getState().accounts;
    useServerStore.getState().applyAccountLimited("claude", "acc_1a2b3c4d", limited);
    expect(useServerStore.getState().accounts).toBe(before);

    // null clears.
    useServerStore.getState().applyAccountLimited("claude", "acc_1a2b3c4d", null);
    expect(useServerStore.getState().accounts.find((a) => a.id === "acc_1a2b3c4d")?.limited).toBeNull();
  });

  it("applyAccountLimited ignores an unknown account", () => {
    useServerStore.getState().replaceAccounts([CLAUDE_SYSTEM]);
    const before = useServerStore.getState().accounts;
    useServerStore.getState().applyAccountLimited("claude", "acc_missing", {
      windowId: "five_hour",
      resetsAt: null,
      source: "chat",
    });
    expect(useServerStore.getState().accounts).toBe(before);
  });
});

