import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { Mode, Project, Session, SupportedCli, Worktree } from "@/api/types";
import { DraftComposer } from "./DraftComposer";
import { useServerStore } from "@/hooks/useServerStore";
import { useGlobalDraftStore } from "@/store/globalDraftStore";

// DraftComposer renders the Lexical-backed SkillEditor and the directory
// auto-complete ProjectCombobox, neither of which is needed to exercise the
// new-directory creation + navigation logic under test. Stub both to simple,
// controllable controls.
vi.mock("../chat/SkillEditor", () => ({
  useSoftKeyboardVisible: () => false,
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

/** The composer-toolbar channel switch: ON = Rich Chat (json), OFF = Terminal (tmux). */
function channelSwitch() {
  return screen.getByRole("switch", { name: /Rich Chat/i });
}
function findChannelSwitch() {
  return screen.findByRole("switch", { name: /Rich Chat/i });
}

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
      channelSwitch().click(); // Rich Chat (default) → Terminal
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

describe("Phase 4 — channel default follows the mode's CLI defaultChannel", () => {
  let api: MockApi;
  let onStarted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = makeApi();
    onStarted = vi.fn();
    useGlobalDraftStore.setState({ draft: null });
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  function makeCli(over: Partial<SupportedCli>): SupportedCli {
    return {
      id: "claude",
      defaultModel: "sonnet",
      supportsJson: true,
      importsNativeHistory: true,
      supportsJsonToTerminalResume: true,
      detected: true,
      starterBundleNames: [],
      usingFallbackOnly: false,
      defaultChannel: "json",
      defaultChannelOverridden: false,
      ...over,
    };
  }

  function makeMode(over: Partial<Mode>): Mode {
    return { id: "m1", name: "Mode", cli: "claude", context: "c", ...over };
  }

  function renderTier2(modes: Mode[], clis: SupportedCli[]) {
    vi.spyOn(api, "listModes").mockResolvedValue(modes);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue(clis);
    return render(
      <MemoryRouter initialEntries={["/draft/new"]}>
        <DraftComposer api={api as never} draftSessionId={null} onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
  }

  function renderTier1(session: Session) {
    const projectId = session.projectId ?? "p1";
    const project: Project = {
      id: projectId,
      name: projectId,
      path: "/tmp/proj",
      prefix: "p",
      isGit: true,
      defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      hidden: false,
      lspEnabled: false,
    };
    useServerStore.setState({ projects: [project], worktrees: [], sessions: [session], loaded: true });
    return render(
      <MemoryRouter initialEntries={[`/draft/${session.id}`]}>
        <DraftComposer api={api as never} draftSessionId={session.id} onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
  }

  function makeDraftSession(over: Partial<Session>): Session {
    return {
      id: "t1-draft",
      worktreeId: null,
      projectId: "p1",
      modeId: "claude-mode",
      type: "agent",
      isMain: false,
      state: "drafting",
      lifecycleState: "drafting",
      tmuxName: "tmux-t1-draft",
      channel: "json",
      createdAt: "2026-01-01T00:00:00.000Z",
      draftPrompt: "",
      draftConfig: { entryPoint: "worktree", worktreeChoice: "new" },
      ...over,
    };
  }

  it("4.T1 — agy mode with no explicit channel defaults the switch to Terminal", async () => {
    const agy = makeCli({ id: "agy", defaultChannel: "tmux", supportsJson: false });
    renderTier2([makeMode({ id: "agy-mode", cli: "agy" })], [agy]);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it("4.T2 — claude mode defaults the switch to Rich Chat", async () => {
    const claude = makeCli({ id: "claude" });
    renderTier2([makeMode({ id: "claude-mode", cli: "claude" })], [claude]);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).toBeChecked());
  });

  it("preselects settings.lastModeId when it still exists, else the first mode", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue({ defaultProjectsDir: "/p", lastModeId: "m2" });
    renderTier2([makeMode({ id: "m1", name: "One" }), makeMode({ id: "m2", name: "Two" })], [makeCli({ id: "claude" })]);
    const select = await screen.findByRole("combobox", { name: "Mode" });
    await waitFor(() => expect(select).toHaveValue("m2"));
  });

  it("falls back to the first mode when settings.lastModeId no longer exists", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue({ defaultProjectsDir: "/p", lastModeId: "gone" });
    renderTier2([makeMode({ id: "m1", name: "One" }), makeMode({ id: "m2", name: "Two" })], [makeCli({ id: "claude" })]);
    const select = await screen.findByRole("combobox", { name: "Mode" });
    await waitFor(() => expect(select).toHaveValue("m1"));
  });

  it("4.T5 — scaffold draft with channel:json and no channelExplicit flips to Terminal for an agy mode (B1)", async () => {
    // LeftSidebar's scaffold `{ entryPoint, worktreeChoice, channel: "json" }`
    // carries channel but NOT channelExplicit — so the mode-follow effect must
    // still fire and flip an agy mode's channel to Terminal.
    const agy = makeCli({ id: "agy", defaultChannel: "tmux", supportsJson: false });
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "agy-mode", cli: "agy" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([agy]);
    const session = makeDraftSession({
      modeId: "agy-mode",
      channel: "json",
      draftConfig: { entryPoint: "worktree", worktreeChoice: "new", modeId: "agy-mode", channel: "json" },
    });
    renderTier1(session);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it("4.T4 — an explicit prior channel choice (channelExplicit) is respected, not flipped", async () => {
    // Restored draft: user previously chose Terminal (channel tmux + explicit),
    // mode is claude (defaultChannel json) — must STAY Terminal.
    const claude = makeCli({ id: "claude" });
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([claude]);
    const session = makeDraftSession({
      modeId: "claude-mode",
      channel: "tmux",
      draftConfig: {
        entryPoint: "worktree",
        worktreeChoice: "new",
        modeId: "claude-mode",
        channel: "tmux",
        channelExplicit: true,
      },
    });
    renderTier1(session);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it("4.T3 — a manual channel pick survives a later mode change (touched ref)", async () => {
    // agy can no longer be the tmux-default starter here (it can't pick Rich
    // Chat at all now), so use a synthetic tmux-default, json-capable CLI to
    // exercise the touched-ref logic.
    const tmuxDefault = makeCli({ id: "tmux-default", defaultChannel: "tmux" });
    const claude = makeCli({ id: "claude", defaultChannel: "json" });
    // Auto-select the tmux-default mode first (ms[0]) so the default is Terminal.
    renderTier2(
      [makeMode({ id: "tmux-default-mode", cli: "tmux-default" }), makeMode({ id: "claude-mode", cli: "claude" })],
      [tmuxDefault, claude],
    );
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());

    // User explicitly picks Terminal (touches the ref), then switches to claude.
    await act(async () => {
      channelSwitch().click(); // touch → Rich Chat
    });
    await act(async () => {
      channelSwitch().click(); // explicit Terminal
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "claude-mode" } });
    });
    await waitFor(() => expect(channelSwitch()).not.toBeChecked());
  });

  it("4.T8a — an untouched agy default flips back to Rich Chat when the mode changes to claude", async () => {
    const agy = makeCli({ id: "agy", defaultChannel: "tmux", supportsJson: false });
    const claude = makeCli({ id: "claude", defaultChannel: "json" });
    renderTier2(
      [makeMode({ id: "agy-mode", cli: "agy" }), makeMode({ id: "claude-mode", cli: "claude" })],
      [agy, claude],
    );
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    // No manual pick -> switching to claude follows claude's json default.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "claude-mode" } });
    });
    await waitFor(() => expect(channelSwitch()).toBeChecked());
  });

  it("4.T8b — a CLI that can't do Rich Chat still forces Terminal via jsonSupported", async () => {
    // defaultChannel json but supportsJson:false -> the capability override
    // forces Terminal (independent of the mode-follow default).
    const noJson = makeCli({ id: "weird", defaultChannel: "json", supportsJson: false });
    renderTier2([makeMode({ id: "weird-mode", cli: "weird" })], [noJson]);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(channelSwitch()).toBeDisabled();
  });

  it("4.T10 — a persisted json default override for agy is dropped (agy is terminal-only)", async () => {
    // The daemon drops a json override for a CLI that can't run Rich Chat
    // (agy supportsJson=false), so the server never reports agy's defaultChannel
    // as json. Rich Chat stays disabled and Terminal is forced.
    const agyJson = makeCli({ id: "agy", defaultChannel: "json", defaultChannelOverridden: true, supportsJson: false });
    renderTier2([makeMode({ id: "agy-mode", cli: "agy" })], [agyJson]);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(sw).toBeDisabled();
  });

  it("4.T6 — Tier 2 agy mode: the default Terminal channel reaches the createWorktree payload as tmux", async () => {
    const agy = makeCli({ id: "agy", defaultChannel: "tmux", supportsJson: false });
    const spy = vi.spyOn(api, "createWorktree");
    renderTier2([makeMode({ id: "agy-mode", cli: "agy" })], [agy]);
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    await typePrompt("build the thing");
    await selectNewDirectoryAndStart();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]![0] as { channel?: string };
    expect(body.channel).toBe("tmux");
  });

  it("4.T9 — with no modes/clis loaded yet, the channel falls back to Rich Chat (json)", async () => {
    // On the very first render modes/clis are both empty, so selectedCli is
    // undefined and the mode-follow effect's fallback (`?? "json"`) selects Rich
    // Chat. The effect must not persist channelExplicit as true from this alone.
    vi.spyOn(api, "listModes").mockResolvedValue([]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/draft/new"]}>
        <DraftComposer api={api as never} draftSessionId={null} onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).toBeChecked());
  });

  // ── Shared composer (ComposerShell) in the draft ─────────────────────────
  async function startTier1Draft() {
    await act(async () => {
      screen.getByTestId("start-btn").click();
    });
  }

  it("uses the shared composer: no schedule button, no Channel radios / Use tmux / Attachments field", async () => {
    renderTier1(makeDraftSession({}));
    await findChannelSwitch();
    expect(document.querySelector(".chat-composer.chat-composer--draft")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Schedule send" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Terminal|Rich Chat/i })).toBeNull();
    expect(screen.queryByText(/Use tmux/i)).toBeNull();
    expect(screen.queryByText("Attachments")).toBeNull();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeTruthy();
  });

  it("toggle ON submits channel json; OFF submits channel tmux (explicit)", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    const spy = vi.spyOn(api, "startDraft");
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).toBeChecked());
    await typePrompt("do it");
    await act(async () => {
      sw.click();
    });
    expect(sw).not.toBeChecked();
    await startTier1Draft();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]![1] as { draftConfig: { channel?: string; channelExplicit?: boolean; useTmux?: boolean }; skipAutoTurn?: boolean };
    expect(body.draftConfig.channel).toBe("tmux");
    expect(body.draftConfig.channelExplicit).toBe(true);
    expect(body.draftConfig.useTmux).toBeUndefined();
    expect(body.skipAutoTurn).toBe(false);
  });

  it("toggle ON (default) submits channel json and doesn't mark it explicit", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    const spy = vi.spyOn(api, "startDraft");
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    await waitFor(async () => expect(await findChannelSwitch()).toBeChecked());
    await typePrompt("do it");
    await startTier1Draft();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]![1] as { draftConfig: { channel?: string; channelExplicit?: boolean } };
    expect(body.draftConfig.channel).toBe("json");
    expect(body.draftConfig.channelExplicit).toBe(false);
  });

  it("a legacy persisted useTmux:false is ignored — Terminal always means tmux", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    const spy = vi.spyOn(api, "startDraft");
    renderTier1(
      makeDraftSession({
        modeId: "claude-mode",
        draftConfig: { entryPoint: "worktree", worktreeChoice: "new", modeId: "claude-mode", channel: "pty", channelExplicit: true, useTmux: false },
      }),
    );
    await waitFor(async () => expect(await findChannelSwitch()).not.toBeChecked());
    await typePrompt("do it");
    await startTier1Draft();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]![1] as { draftConfig: { channel?: string } };
    expect(body.draftConfig.channel).toBe("tmux");
  });

  it("files dropped on the composer show as chips and are uploaded to the started session", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    // The mock daemon doesn't know this store-only draft; stub a successful start.
    vi.spyOn(api, "startDraft").mockResolvedValue({ ok: true });
    const upload = vi.spyOn(api, "uploadAttachments");
    const send = vi.spyOn(api, "sendChat").mockResolvedValue(undefined as never);
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    await findChannelSwitch();
    await typePrompt("look at this");
    const file = new File(["png"], "screen.png", { type: "image/png" });
    const composer = document.querySelector(".chat-composer")!;
    await act(async () => {
      fireEvent.dragEnter(composer, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    expect(composer.classList.contains("chat-composer--dragover")).toBe(true);
    await act(async () => {
      fireEvent.drop(composer, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    expect(screen.getByText("screen.png")).toBeTruthy();
    // Staged, not uploaded yet — there's no live session until Start.
    expect(upload).not.toHaveBeenCalled();
    await startTier1Draft();
    await waitFor(() => expect(upload).toHaveBeenCalledWith("t1-draft", [file]));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]![2]).toHaveLength(1);
  });

  it("a staged chip can be removed before Start", async () => {
    renderTier1(makeDraftSession({}));
    await findChannelSwitch();
    const file = new File(["a"], "notes.md");
    await act(async () => {
      fireEvent.drop(document.querySelector(".chat-composer")!, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    await act(async () => {
      screen.getByRole("button", { name: "Remove notes.md" }).click();
    });
    expect(screen.queryByText("notes.md")).toBeNull();
  });

  it("Terminal disables attaching (only Rich Chat delivers attachments)", async () => {
    const agy = makeCli({ id: "agy", defaultChannel: "tmux" });
    renderTier2([makeMode({ id: "agy-mode", cli: "agy" })], [agy]);
    await waitFor(async () => expect(await findChannelSwitch()).not.toBeChecked());
    expect(screen.getByRole("button", { name: "Attach files" })).toBeDisabled();
  });

  it("the hint row renders keycaps for the draft's start shortcut", async () => {
    renderTier1(makeDraftSession({}));
    await findChannelSwitch();
    const hint = document.querySelector(".chat-composer__hint")!;
    const keys = Array.from(hint.querySelectorAll("kbd")).map((k) => k.textContent);
    expect(keys).toEqual(["Enter", "Shift + Enter"]);
    expect(hint.textContent).toContain("to start");
    expect(hint.textContent).not.toContain("to queue");
  });
});
