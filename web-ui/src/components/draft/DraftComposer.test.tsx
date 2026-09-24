import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { Project, Session, Worktree } from "@/api/types";
import { DraftComposer } from "./DraftComposer";
import { useServerStore } from "@/hooks/useServerStore";
import { useGlobalDraftStore } from "@/store/globalDraftStore";

// DraftComposer renders the Lexical-backed SkillEditor and the directory
// auto-complete ProjectCombobox, neither of which is needed to exercise the
// new-directory creation + navigation logic under test. Stub both to simple,
// controllable controls.
vi.mock("../chat/SkillEditor", () => ({
  SkillEditor: ({
    onChangeText,
    onSubmit,
  }: {
    onChangeText: (text: string, hasContent: boolean) => void;
    onSubmit: () => void;
  }) => (
    <div>
      <input
        data-testid="prompt-input"
        onChange={(e) => onChangeText(e.target.value, e.target.value.trim().length > 0)}
      />
      <button data-testid="start-btn" onClick={onSubmit}>
        Start
      </button>
    </div>
  ),
}));

vi.mock("./ProjectCombobox", () => ({
  ProjectCombobox: ({ onAddPath }: { onAddPath: (path: string) => void }) => (
    <button data-testid="add-path-btn" onClick={() => onAddPath("/tmp/brand-new-dir")}>
      Add directory
    </button>
  ),
}));

function makeApi() {
  return createMockApi() as MockApi;
}

async function typePrompt(text: string) {
  const input = await screen.findByTestId("prompt-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
}

async function selectNewDirectoryAndStart() {
  await act(async () => {
    screen.getByTestId("add-path-btn").click();
  });
  await act(async () => {
    screen.getByTestId("start-btn").click();
  });
  await waitFor(() => {
    expect(screen.getByTestId("start-btn")).toBeEnabled();
  });
}

describe("DraftComposer new-directory creation", () => {
  let api: MockApi;
  let onStarted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = makeApi();
    onStarted = vi.fn();
    // Reset persisted Tier 2 global draft so each test starts empty.
    useGlobalDraftStore.setState({ draft: null });
    // `useServerStore` is a singleton shared across tests — clear it so the
    // store-registration assertion below starts from a known-empty state.
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  function renderComposer() {
    return render(
      <MemoryRouter initialEntries={["/draft/new"]}>
        <DraftComposer
          api={api as never}
          draftSessionId={null}
          onStarted={onStarted}
          onDiscard={() => {}}
        />
      </MemoryRouter>,
    );
  }

  it("registers the created worktree in the store before onStarted navigates", async () => {
    renderComposer();
    await typePrompt("build the thing");
    await selectNewDirectoryAndStart();

    // The worktree that was created must already be in the server store by the
    // time onStarted fires — otherwise URL sync / the direct-session redirect
    // effect bounce away and the UI never lands on the new agent.
    expect(onStarted).toHaveBeenCalledTimes(1);
    const result = onStarted.mock.calls[0]![0] as { worktreeId?: string; sessionId: string };
    expect(result.worktreeId).toBeTruthy();
    const store = useServerStore.getState();
    expect(store.worktrees.some((w: Worktree) => w.id === result.worktreeId)).toBe(true);
  });

  it("passes the user's selected channel to createWorktree (not a hardcoded json)", async () => {
    renderComposer();
    await typePrompt("build the thing");

    // Switch to Terminal channel so the created agent must be a terminal agent.
    await act(async () => {
      screen.getByRole("radio", { name: /Terminal/i }).click();
    });

    const spy = vi.spyOn(api, "createWorktree");
    await selectNewDirectoryAndStart();

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const body = spy.mock.calls[0]![0] as { channel?: string };
    expect(body.channel).toBe("tmux");
  });

  it("non-git worktree creation shows the recovery dialog; confirming git-inits then retries exactly once (4.T3)", async () => {
    const nonGitProject: Project = {
      id: "non-git-proj",
      name: "non-git-proj",
      path: "/tmp/non-git-proj",
      prefix: "ngp",
      isGit: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      hidden: false,
      lspEnabled: false,
    };
    vi.spyOn(api, "addProject").mockResolvedValue(nonGitProject);

    const notGitErr = new ApiError(JSON.stringify({ error: "NOT_GIT" }), 422);
    let worktreeCalls = 0;
    const createWorktreeSpy = vi.spyOn(api, "createWorktree").mockImplementation(async (body) => {
      worktreeCalls += 1;
      if (worktreeCalls === 1) throw notGitErr;
      const wt: Worktree = {
        id: "wt-retry",
        projectId: body.projectId,
        branch: "wip/wt-retry",
        baseBranch: "main",
        baseSha: "sha",
        createdAt: "2026-01-01T00:00:00.000Z",
        pinnedAt: null,
        hiddenAt: null,
        mainSessionId: "wt-retry-m",
        lspEnabled: false,
      };
      return wt;
    });
    const gitInitSpy = vi.spyOn(api, "gitInitProject").mockResolvedValue({
      ok: true,
      isGit: true,
      defaultBranch: "main",
    });

    renderComposer();
    await typePrompt("build the thing");
    await selectNewDirectoryAndStart();

    // A non-git project now reaches createWorktree (items 4.5/4.6 — previously
    // the client silently fell through to a direct session). It rejects with
    // NOT_GIT → the recovery dialog appears, no worktree created yet.
    expect(createWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /Run git init and continue/i })).toBeTruthy();

    // Confirm: git-init, then re-issue the SAME payload → exactly one retry.
    await act(async () => {
      screen.getByRole("button", { name: /Run git init and continue/i }).click();
    });

    await waitFor(() => {
      expect(gitInitSpy).toHaveBeenCalledTimes(1);
      expect(createWorktreeSpy).toHaveBeenCalledTimes(2);
      expect(onStarted).toHaveBeenCalledTimes(1);
    });

    // Dialog closed after success; no duplicate worktree, no second dialog.
    expect(screen.queryByRole("button", { name: /Run git init and continue/i })).toBeNull();
    const result = onStarted.mock.calls[0]![0] as { worktreeId?: string };
    expect(result.worktreeId).toBe("wt-retry");
  });

  it("Tier 1 startDraft NOT_GIT shows the recovery dialog; confirming git-inits, applies isGit to the store, and retries the SAME startDraft (review Fix A/B)", async () => {
    const project: Project = {
      id: "t1-proj",
      name: "t1-proj",
      path: "/tmp/t1-proj",
      prefix: "t1",
      isGit: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      hidden: false,
      lspEnabled: false,
    };
    const draft: Session = {
      id: "t1-draft",
      worktreeId: null,
      projectId: project.id,
      modeId: "opencode",
      type: "agent",
      isMain: false,
      state: "drafting",
      lifecycleState: "drafting",
      tmuxName: "tmux-t1-draft",
      channel: "json",
      createdAt: "2026-01-01T00:00:00.000Z",
      draftPrompt: "build the thing",
      draftConfig: {
        entryPoint: "worktree",
        modeId: "opencode",
        channel: "json",
        useWorktree: true,
        worktreeChoice: "new",
      },
    };
    useServerStore.setState({ projects: [project], worktrees: [], sessions: [draft], loaded: true });

    const notGitErr = new ApiError(JSON.stringify({ error: "NOT_GIT" }), 422);
    let startCalls = 0;
    const startSpy = vi.spyOn(api, "startDraft").mockImplementation(async () => {
      startCalls += 1;
      if (startCalls === 1) throw notGitErr;
      return { ok: true, worktreeId: undefined };
    });
    const gitInitSpy = vi.spyOn(api, "gitInitProject").mockResolvedValue({
      ok: true,
      isGit: true,
      defaultBranch: "main",
    });

    render(
      <MemoryRouter initialEntries={["/draft/t1-draft"]}>
        <DraftComposer
          api={api as never}
          draftSessionId="t1-draft"
          onStarted={onStarted}
          onDiscard={() => {}}
        />
      </MemoryRouter>,
    );

    await typePrompt("build the thing");
    await act(async () => {
      screen.getByTestId("start-btn").click();
    });

    // The Tier 1 startDraft call hit NOT_GIT → the recovery dialog appears and
    // no onStarted fires (the previous bug: the error fell through to the
    // generic "Failed to start agent." catch with no recovery path at all).
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /Run git init and continue/i })).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole("button", { name: /Run git init and continue/i }).click();
    });

    await waitFor(() => {
      expect(gitInitSpy).toHaveBeenCalledWith(project.id);
      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(onStarted).toHaveBeenCalledTimes(1);
    });

    // Fix B: the calling client applied its OWN git-init response to the store
    // (isGit/defaultBranch) instead of waiting on the ProjectUpdated WS echo.
    expect(useServerStore.getState().projects.find((p) => p.id === project.id)?.isGit).toBe(true);

    // Dialog closed after success; no second dialog.
    expect(screen.queryByRole("button", { name: /Run git init and continue/i })).toBeNull();
  });

  it("already-git project worktree creation never shows the recovery dialog (4.T4)", async () => {
    const gitProject: Project = {
      id: "git-proj",
      name: "git-proj",
      path: "/tmp/git-proj",
      prefix: "gp",
      isGit: true,
      defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      hidden: false,
      lspEnabled: false,
    };
    vi.spyOn(api, "addProject").mockResolvedValue(gitProject);
    const createWorktreeSpy = vi.spyOn(api, "createWorktree");

    renderComposer();
    await typePrompt("build the thing");
    await selectNewDirectoryAndStart();

    await waitFor(() => {
      expect(createWorktreeSpy).toHaveBeenCalledTimes(1);
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
    // No recovery dialog for an already-git project.
    expect(screen.queryByRole("button", { name: /Run git init and continue/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Regression for "the tab and prompt composer are still getting cropped" on a
  // ~412x924 phone viewport. `.draft-composer` is a flex item of `.pane-stack`
  // AND declares `height: 100%`. `height` is also the flex item's "specified
  // size suggestion", so the default `min-height: auto` resolved its automatic
  // minimum size to the FULL pane-stack height — which then beat `flex: 1`'s
  // share of the space left over after the agent `TabsStrip` above it. The
  // composer therefore rendered exactly one tab-strip taller than its slot and
  // its footer bar (prompt textarea + ▶ Start) was pushed past
  // `.pane-shell__body`'s `overflow: hidden` edge, unreachable and unscrollable.
  // jsdom does no flex layout, so assert the declaration itself — the same
  // approach ChatPane.test.tsx uses for `.chat-pane`'s font-size token.
  it("`.draft-composer` pins min-height:0 so it can shrink to its pane slot", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const block = /\.draft-composer \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/height:\s*100%/);
    expect(block).toMatch(/min-height:\s*0/);
    // The scroll/pin contract the above restores: body scrolls, bar never does.
    const body = /\.draft-composer__body \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/overflow-y:\s*auto/);
    const bar = /\.draft-composer__bar \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(bar).toMatch(/flex-shrink:\s*0/);
  });
});
