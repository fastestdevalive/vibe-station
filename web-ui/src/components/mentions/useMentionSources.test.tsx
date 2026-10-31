import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Mode, Project, Session, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useModesStore } from "@/store/modesStore";
import { useMentionSources } from "./useMentionSources";
import type { MentionEditorConfig } from "./types";
import { parseMentionQuery } from "./mentionQuery";
import { rankItems } from "./mentionFilter";
import { fromWire, serializeMentionToken, toWire } from "@/lib/mentions";

async function flushDebounce(ms = 60) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function projectFixture(id: string, name: string, path: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name,
    path,
    prefix: id,
    isGit: true,
    createdAt: "2026-01-01T00:00:00Z",
    hidden: false,
    lspEnabled: false,
    ...overrides,
  };
}

function worktreeFixture(id: string, projectId: string, name: string, branch: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    projectId,
    name,
    branch,
    baseBranch: "main",
    pinnedAt: null,
    hiddenAt: null,
    lspEnabled: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function sessionFixture(id: string, projectId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectId,
    worktreeId: null,
    type: "agent",
    state: "idle",
    lifecycleState: "idle",
    tmuxName: `tmux-${id}`,
    modeId: "m-claude",
    channel: "json",
    isMain: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("useMentionSources (2.T2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true });
    useWorkspaceStore.setState({ sessionStates: {} });
    useModesStore.setState({
      modes: new Map([
        [
          "m-claude",
          {
            id: "m-claude",
            name: "Claude",
            cli: "claude",
            createdAt: "2026-01-01T00:00:00Z",
          } as unknown as Mode,
        ],
      ]),
      loaded: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("agents exclude archived, superseded, drafting, self and other projects", () => {
    const p1 = projectFixture("p1", "Project 1", "/Users/alice/p1");
    const p2 = projectFixture("p2", "Project 2", "/Users/alice/p2");
    const wt1 = worktreeFixture("wt1", "p1", "wt-1", "feature-x");

    const activeAgent = sessionFixture("s-active", "p1", { worktreeId: "wt1", name: "Worker" });
    const archivedAgent = sessionFixture("s-archived", "p1", { archivedAt: "2026-01-02T00:00:00Z" });
    const supersededAgent = sessionFixture("s-superseded", "p1", { supersededBy: "s-active" });
    const draftingAgent = sessionFixture("s-drafting", "p1", { state: "drafting" });
    const liveDraftingAgent = sessionFixture("s-live-draft", "p1", { state: "idle" });
    const otherProjectAgent = sessionFixture("s-other", "p2", { name: "Other" });
    const selfAgent = sessionFixture("s-self", "p1", { name: "Self" });

    useServerStore.setState({
      projects: [p1, p2],
      worktrees: [wt1],
      sessions: [
        activeAgent,
        archivedAgent,
        supersededAgent,
        draftingAgent,
        liveDraftingAgent,
        otherProjectAgent,
        selfAgent,
      ],
    });

    useWorkspaceStore.setState({
      sessionStates: {
        "s-live-draft": "drafting",
        "s-active": "working",
      },
    });

    const api = createMockApi();
    const cfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: "wt1",
      selfSessionId: "s-self",
    };

    const parsed = parseMentionQuery("");
    const { result } = renderHook(() => useMentionSources(cfg, parsed, true));

    expect(result.current.agent.items).toHaveLength(1);
    expect(result.current.agent.items[0]?.id).toBe("s-active");
    expect(result.current.agent.items[0]?.status).toBe("working");
    expect(result.current.agent.items[0]?.secondary).toBe("claude · this worktree");

    // When projectId is null (global draft), agents from ALL projects are listed
    const globalCfg: MentionEditorConfig = {
      api,
      projectId: null,
      worktreeId: null,
      selfSessionId: null,
    };
    const { result: globalResult } = renderHook(() => useMentionSources(globalCfg, parsed, true));
    const ids = globalResult.current.agent.items.map((a) => a.id);
    expect(ids).toContain("s-active");
    expect(ids).toContain("s-other");
    expect(ids).toContain("s-self");
  });

  it("agents: same-worktree first and labelled, direct agents say direct, other worktrees show their label", () => {
    const p1 = projectFixture("p1", "Project 1", "/Users/alice/p1");
    const wt1 = worktreeFixture("wt1", "p1", "wt-1", "feature-x");
    const wt2 = worktreeFixture("wt2", "p1", "wt-2", "feature-y");

    // Newest first would be: other-wt, direct, same-wt — same-context must still win.
    const sameWt = sessionFixture("s-same", "p1", { worktreeId: "wt1", name: "Same", createdAt: "2026-01-01T00:00:00Z" });
    const direct = sessionFixture("s-direct", "p1", { name: "Direct", createdAt: "2026-01-02T00:00:00Z" });
    const otherWt = sessionFixture("s-other-wt", "p1", { worktreeId: "wt2", name: "Other", createdAt: "2026-01-03T00:00:00Z" });
    useServerStore.setState({ projects: [p1], worktrees: [wt1, wt2], sessions: [otherWt, direct, sameWt] });
    useWorkspaceStore.setState({ sessionStates: {} });

    const api = createMockApi();
    const parsed = parseMentionQuery("");

    const inWorktree: MentionEditorConfig = { api, projectId: "p1", worktreeId: "wt1", selfSessionId: null };
    const { result: a } = renderHook(() => useMentionSources(inWorktree, parsed, true));
    expect(a.current.agent.items.map((i) => i.id)).toEqual(["s-same", "s-other-wt", "s-direct"]);
    expect(a.current.agent.items[0]?.secondary).toContain("this worktree");
    expect(a.current.agent.items[1]?.secondary).toContain("wt-2");
    expect(a.current.agent.items[2]?.secondary).toContain("direct");

    const inProject: MentionEditorConfig = { api, projectId: "p1", worktreeId: null, selfSessionId: null };
    const { result: b } = renderHook(() => useMentionSources(inProject, parsed, true));
    expect(b.current.agent.items.map((i) => i.id)[0]).toBe("s-direct");
    expect(b.current.agent.items[0]?.secondary).toContain("direct");
  });

  it("two agents named main in different worktrees: items keep distinct ids and the second inserts/rehydrates its own id", () => {
    const p1 = projectFixture("p1", "Project 1", "/Users/alice/p1");
    const wt1 = worktreeFixture("wt1", "p1", "wt-1", "feature-x");
    const wt2 = worktreeFixture("wt2", "p1", "wt-2", "feature-y");
    const m1 = sessionFixture("s-main-1", "p1", { worktreeId: "wt1", name: "main", createdAt: "2026-01-01T00:00:00Z" });
    const m2 = sessionFixture("s-main-2", "p1", { worktreeId: "wt2", name: "main", createdAt: "2026-01-02T00:00:00Z" });
    useServerStore.setState({ projects: [p1], worktrees: [wt1, wt2], sessions: [m1, m2] });
    useWorkspaceStore.setState({ sessionStates: {} });

    const cfg: MentionEditorConfig = { api: createMockApi(), projectId: "p1", worktreeId: "wt1", selfSessionId: null };
    const { result } = renderHook(() => useMentionSources(cfg, parseMentionQuery("main"), true));
    const items = result.current.agent.items;
    expect(items.map((i) => i.id).sort()).toEqual(["s-main-1", "s-main-2"]);
    expect(items.map((i) => i.label)).toEqual(["main", "main"]);
    const second = items.find((i) => i.id === "s-main-2")!;
    expect(second.secondary).toContain("wt-2");

    // The picked item's id (not its label) is what the chip carries into the wire text and back.
    const mention = { kind: second.kind, id: second.id, label: second.label };
    const w = toWire(serializeMentionToken(mention));
    expect(w.text).toBe("@agent:main (id=s-main-2)");
    expect(w.mentions).toEqual([mention]);
    expect(fromWire(w.text, w.mentions)).toBe(serializeMentionToken(mention));
  });

  it("@agents:<project>: lists that project's agents (worktree searchable in secondary); plain @agents: stays current-project", () => {
    const p1 = projectFixture("p1", "Alpha", "/Users/alice/p1");
    const p2 = projectFixture("p2", "Beta", "/Users/alice/p2");
    const wtB = worktreeFixture("wtb", "p2", "plugin-sys", "feat/plugin-system");
    useServerStore.setState({
      projects: [p1, p2],
      worktrees: [wtB],
      sessions: [
        sessionFixture("s-a", "p1", { name: "main" }),
        sessionFixture("s-b1", "p2", { name: "main", worktreeId: "wtb" }),
        sessionFixture("s-b2", "p2", { name: "Direct helper" }),
        sessionFixture("s-b-old", "p2", { name: "gone", archivedAt: "2026-01-02T00:00:00Z" }),
      ],
    });
    const cfg: MentionEditorConfig = { api: createMockApi(), projectId: "p1", worktreeId: null, selfSessionId: null };
    const refs = [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ];

    const plain = renderHook(() => useMentionSources(cfg, parseMentionQuery("agents:", refs), true));
    expect(plain.result.current.agent.items.map((a) => a.id)).toEqual(["s-a"]);

    const picked = renderHook(() => useMentionSources(cfg, parseMentionQuery("agents:beta:", refs), true));
    const items = picked.result.current.agent.items;
    expect(items.map((a) => a.id).sort()).toEqual(["s-b1", "s-b2"]);
    expect(items.find((a) => a.id === "s-b1")?.secondary).toBe("claude · plugin-sys");
    expect(items.find((a) => a.id === "s-b2")?.secondary).toBe("claude · direct");
    // The worktree label is matchable via the secondary text.
    expect(rankItems(items, "plugin").map((a) => a.id)).toEqual(["s-b1"]);

    // A worktree-scoped pick must not leak into the agent source.
    const wt = renderHook(() => useMentionSources(cfg, parseMentionQuery("worktrees:Beta:", refs), true));
    expect(wt.result.current.agent.items.map((a) => a.id)).toEqual(["s-a"]);
  });

  it("worktrees limited to the current project (all when unknown), secondary = branch", () => {
    const wt1 = worktreeFixture("wt1", "p1", "wt-1", "main");
    const wt2 = worktreeFixture("wt2", "p2", "wt-2", "feat-2");
    const wtHidden = worktreeFixture("wt-h", "p1", "hidden-wt", "feat-h", {
      hiddenAt: "2026-01-02T00:00:00Z",
    });

    useServerStore.setState({
      worktrees: [wt1, wt2, wtHidden],
    });

    const api = createMockApi();
    const cfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: "wt1",
      selfSessionId: null,
    };

    const parsed = parseMentionQuery("");
    const { result } = renderHook(() => useMentionSources(cfg, parsed, true));

    expect(result.current.worktree.items).toHaveLength(1);
    expect(result.current.worktree.items[0]?.id).toBe("wt1");
    expect(result.current.worktree.items[0]?.secondary).toBe("main");

    // All when project is null
    const globalCfg: MentionEditorConfig = {
      api,
      projectId: null,
      worktreeId: null,
      selfSessionId: null,
    };
    const { result: globalResult } = renderHook(() => useMentionSources(globalCfg, parsed, true));
    expect(globalResult.current.worktree.items).toHaveLength(2);
  });

  it("projects: all non-hidden, current first, secondary path with ~", () => {
    const p1 = projectFixture("p1", "Project 1", "/Users/alice/code/p1", { createdAt: "2026-01-01T00:00:00Z" });
    const p2 = projectFixture("p2", "Project 2", "/Users/alice/code/p2", { createdAt: "2026-01-02T00:00:00Z" });
    const pHidden = projectFixture("p-h", "Hidden", "/home/bob/h", { hidden: true });

    useServerStore.setState({
      projects: [p1, p2, pHidden],
    });

    const api = createMockApi();
    const cfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: null,
      selfSessionId: null,
    };

    const parsed = parseMentionQuery("");
    const { result } = renderHook(() => useMentionSources(cfg, parsed, true));

    expect(result.current.project.items).toHaveLength(2);
    // Current project p1 is first even though p2 has a later createdAt
    expect(result.current.project.items[0]?.id).toBe("p1");
    expect(result.current.project.items[0]?.secondary).toBe("~/code/p1");
    expect(result.current.project.items[1]?.id).toBe("p2");
    expect(result.current.project.items[1]?.secondary).toBe("~/code/p2");
  });

  it("projects: closed returns a stable empty result across project changes", () => {
    const p1 = projectFixture("p1", "Project 1", "/Users/alice/code/p1");
    useServerStore.setState({ projects: [p1] });
    const cfg: MentionEditorConfig = { api: createMockApi(), projectId: "p1", worktreeId: null, selfSessionId: null };
    const parsed = parseMentionQuery("");
    const { result, rerender } = renderHook(() => useMentionSources(cfg, parsed, false));

    expect(result.current.project.items).toEqual([]);
    const before = result.current.project;
    act(() => {
      useServerStore.setState({ projects: [p1, projectFixture("p2", "Project 2", "/Users/alice/code/p2")] });
    });
    rerender();
    expect(result.current.project.items).toEqual([]);
    expect(result.current.project).toBe(before);
  });

  it("files call fileSearch with correct target and scope, handles control characters", async () => {
    const api = createMockApi();
    const fileSearch = vi.spyOn(api, "fileSearch").mockResolvedValue({
      files: ["src/a.ts", "invalid\x00path.ts", "src/nested/b.ts"],
      truncated: false,
    });

    const cfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: "wt1",
      selfSessionId: null,
    };

    const parsed = parseMentionQuery("foo");
    const { result } = renderHook(() => useMentionSources(cfg, parsed, true));

    await flushDebounce();

    expect(fileSearch).toHaveBeenCalledWith("wt1", "foo", 50, expect.any(AbortSignal), "worktree");
    // Invalid control character path was skipped
    expect(result.current.file.items).toHaveLength(2);
    expect(result.current.file.items[0]?.id).toBe("src/a.ts");
    expect(result.current.file.items[0]?.label).toBe("a.ts");
    expect(result.current.file.items[0]?.secondary).toBe("src");
    expect(result.current.file.items[1]?.id).toBe("src/nested/b.ts");
    expect(result.current.file.items[1]?.label).toBe("b.ts");
    expect(result.current.file.items[1]?.secondary).toBe("src/nested");

    // Project scope when worktreeId is null
    fileSearch.mockClear();
    const projectCfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: null,
      selfSessionId: null,
    };
    renderHook(() => useMentionSources(projectCfg, parsed, true));
    await flushDebounce();
    expect(fileSearch).toHaveBeenCalledWith("p1", "foo", 50, expect.any(AbortSignal), "project");
  });

  it("NO fileSearch call while open=false, when target is null, or when scoped to another kind", async () => {
    const api = createMockApi();
    const fileSearch = vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });

    const cfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: "wt1",
      selfSessionId: null,
    };

    // open = false
    renderHook(() => useMentionSources(cfg, parseMentionQuery("foo"), false));
    await flushDebounce();
    expect(fileSearch).not.toHaveBeenCalled();

    // target is null
    const noTargetCfg: MentionEditorConfig = {
      api,
      projectId: null,
      worktreeId: null,
      selfSessionId: null,
    };
    renderHook(() => useMentionSources(noTargetCfg, parseMentionQuery("foo"), true));
    await flushDebounce();
    expect(fileSearch).not.toHaveBeenCalled();

    // scoped to another kind (@agents:foo)
    renderHook(() => useMentionSources(cfg, parseMentionQuery("agents:foo"), true));
    await flushDebounce();
    expect(fileSearch).not.toHaveBeenCalled();
  });

  it("render count stays bounded with a stable store", () => {
    let renderCount = 0;
    const api = createMockApi();
    const cfg: MentionEditorConfig = {
      api,
      projectId: "p1",
      worktreeId: "wt1",
      selfSessionId: null,
    };
    const parsed = parseMentionQuery("");

    const { rerender } = renderHook(() => {
      renderCount++;
      return useMentionSources(cfg, parsed, false);
    });

    rerender();
    rerender();
    expect(renderCount).toBeLessThan(10);
  });

  it("returns stable empty agent/worktree results while closed", () => {
    const api = createMockApi();
    const cfg: MentionEditorConfig = { api, projectId: "p1", worktreeId: "wt1", selfSessionId: null };
    const parsed = parseMentionQuery("");
    const { result, rerender } = renderHook(({ open }) => useMentionSources(cfg, parsed, open), {
      initialProps: { open: false },
    });
    const closed = result.current;
    expect(closed.agent.items).toHaveLength(0);
    expect(closed.worktree.items).toHaveLength(0);
    rerender({ open: false });
    expect(result.current.agent).toBe(closed.agent);
    expect(result.current.worktree).toBe(closed.worktree);
  });
});
