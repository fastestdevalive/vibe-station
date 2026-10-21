import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { Mode, Project, Session, SupportedCli, Worktree } from "@/api/types";
import { DraftComposer } from "./DraftComposer";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
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
  let onStarted: Mock<(...args: unknown[]) => void>;

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
    // The scroll/pin contract the above restores: body scrolls, folded rows hide.
    const body = /\.draft-composer__body \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/overflow-y:\s*auto/);
    const rowsHidden = /\.draft-composer__rows\[hidden\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rowsHidden).toMatch(/display:\s*none/);
  });

  it("`.draft-composer .draft-row__label` fixes the label column so it cannot grow to half the row (R1F-01)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const block = /\.draft-composer \.draft-row__label \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/flex:\s*none/);
    expect(block).toMatch(/width:\s*84px/);
  });

  it("`.draft-composer__composer` zeroes the shell's own padding so the draft inset aligns with the rows (R1F-02)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const block = /\.draft-composer \.draft-composer__composer \.chat-composer \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/padding:\s*0/);
  });

  it("`.draft-composer .draft-composer__hint` wraps instead of clipping (R1F-06)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const block = /\.draft-composer \.draft-composer__hint \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/white-space:\s*normal/);
  });

  it("`.draft-composer .draft-popover__search` carries focus on the single wrapper border, no inner ring (R1F-08)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const focus = /\.draft-composer \.draft-popover__search:focus-within \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(focus).toMatch(/border-color:\s*var\(--fg-muted\)/);
    const input = /\.draft-composer \.draft-popover__search input:focus[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(input).toMatch(/outline:\s*none/);
    expect(input).toMatch(/box-shadow:\s*none/);
  });

  it("`.draft-composer` is an inline-size container so short panes can give the Discard ✕ its own band (R2F-01)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const block = /\.draft-composer \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/container:\s*draft-pane\s*\/\s*inline-size/);
    const short = /\.draft-composer--short \.draft-composer__discard \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(short).toMatch(/top:\s*var\(--space-2\)/);
    expect(short).toMatch(/right:\s*var\(--space-3\)/);
    const band = /@container draft-pane \(max-width: 608px\) \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(band).toMatch(/padding-top:\s*44px/);
  });

  it("`.draft-composer__body` is positioned so the Discard ✕ scrolls with its band and never lands on the box (R3F-01)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const body = /\.draft-composer__body \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/position:\s*relative/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it("Start goes icon-only in a very narrow composer so the toolbar never overflows the shell (R2F-02)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const narrow = /@container composer \(max-width: 340px\) \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/draft-composer__start-label/);
    expect(narrow).toMatch(/display:\s*none/);
  });

  it("`.draft-composer .draft-composer__hint` lays items out with 14px gaps, no '·' separators (R2F-03)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const block = /\.draft-composer \.draft-composer__hint \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/column-gap:\s*14px/);
  });
});

describe("Phase 4 — channel default follows the mode's CLI defaultChannel", () => {
  let api: MockApi;
  let onStarted: Mock<(...args: unknown[]) => void>;

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
    renderTier2(
      [makeMode({ id: "m1", name: "Claude One" }), makeMode({ id: "m2", name: "Claude Two" })],
      [makeCli({ id: "claude" })],
    );
    fireEvent.click(await screen.findByLabelText("Mode"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Claude Two/ })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("falls back to the first mode when settings.lastModeId no longer exists", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue({ defaultProjectsDir: "/p", lastModeId: "gone" });
    renderTier2(
      [makeMode({ id: "m1", name: "Claude One" }), makeMode({ id: "m2", name: "Claude Two" })],
      [makeCli({ id: "claude" })],
    );
    fireEvent.click(await screen.findByLabelText("Mode"));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Claude One/ })).toHaveAttribute("aria-selected", "true");
    });
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
      [
        makeMode({ id: "tmux-default-mode", name: "Tmux", cli: "tmux-default" }),
        makeMode({ id: "claude-mode", name: "Claude", cli: "claude" }),
      ],
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
      fireEvent.click(screen.getByLabelText("Mode"));
    });
    fireEvent.click(await screen.findByRole("option", { name: /^Claude/ }));
    await waitFor(() => expect(channelSwitch()).not.toBeChecked());
  });

  it("4.T8a — an untouched agy default flips back to Rich Chat when the mode changes to claude", async () => {
    const agy = makeCli({ id: "agy", defaultChannel: "tmux", supportsJson: false });
    const claude = makeCli({ id: "claude", defaultChannel: "json" });
    renderTier2(
      [makeMode({ id: "agy-mode", name: "Agy", cli: "agy" }), makeMode({ id: "claude-mode", name: "Claude", cli: "claude" })],
      [agy, claude],
    );
    const sw = await findChannelSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    // No manual pick -> switching to claude follows claude's json default.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Mode"));
    });
    fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
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

  it("the Start button carries `.draft-composer__start-label` so the narrow-composer CSS can hide it (R2F-02)", async () => {
    renderTier1(makeDraftSession({}));
    await findChannelSwitch();
    const btn = screen.getByRole("button", { name: "Start agent" });
    const label = btn.querySelector(".draft-composer__start-label");
    expect(label).toBeTruthy();
    expect(label?.textContent).toBe("Start");
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

  it("the Rich Chat hint has no '·' separator dangling at the end of a wrapped line (R2F-03)", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    await findChannelSwitch();
    const hint = document.querySelector(".draft-composer__hint")!;
    expect(hint.textContent).not.toContain("·");
  });

  it("the Terminal draft hint has no '·' separator (R2F-03)", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier1(
      makeDraftSession({
        modeId: "claude-mode",
        draftConfig: { entryPoint: "worktree", worktreeChoice: "new", modeId: "claude-mode", channel: "pty", channelExplicit: true },
      }),
    );
    await waitFor(async () => expect(await findChannelSwitch()).not.toBeChecked());
    const hint = document.querySelector(".draft-composer__hint")!;
    expect(hint.textContent).not.toContain("·");
  });

  it("the Rich Chat hint renders 3 hint items, the first carrying the drop-files prefix (R1F-06)", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    await findChannelSwitch();
    const items = Array.from(document.querySelectorAll(".draft-composer__hint .chat-composer__hint-item"));
    // Drop files here + Enter to start + Shift + Enter newline.
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("Drop files here");
    expect(items[0]!.textContent).toContain("⤓");
  });

  // ── Minimal box layout (Phase 1) ─────────────────────────────────────────
  function projectFixture(id = "p1"): Project {
    return {
      id,
      name: id,
      path: "/tmp/proj",
      prefix: "p",
      isGit: true,
      defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      hidden: false,
      lspEnabled: false,
    };
  }

  it("minimal box layout: caption, box, no logo/hero/old mode select, hint outside the box (1.T5)", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude", name: "Claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    await findChannelSwitch();
    expect(document.querySelector(".draft-composer__box")).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "New agent" });
    expect(heading.className).toContain("draft-composer__caption");
    const logo = document.querySelector('img[src="/logo.svg"]');
    expect(logo).toBeTruthy();
    expect(logo?.nextElementSibling).toBe(heading);
    expect(screen.queryByRole("button", { name: "+ New mode" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Mode" })).toBeNull();
    const hint = document.querySelector(".chat-composer__hint")!;
    expect(hint.closest(".draft-composer__box")).toBeNull();
  });

  it("mode popover: opens, lists New mode + modes, keyboard select, Esc refocuses, New mode opens dialog (1.T6)", async () => {
    const modes = [
      makeMode({ id: "m1", name: "Alpha", cli: "claude" }),
      makeMode({ id: "m2", name: "Beta", cli: "claude" }),
    ];
    vi.spyOn(api, "listModes").mockResolvedValue(modes);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier2(modes, [makeCli({ id: "claude" })]);
    await waitFor(() => expect(screen.getByLabelText("Mode")).toHaveTextContent("Alpha"));

    fireEvent.click(screen.getByLabelText("Mode"));
    expect(screen.getByRole("listbox", { name: "Modes" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /New mode…/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true");

    // ArrowDown + Enter selects the next mode (Beta); chip text changes. The
    // cursor starts on the current mode Alpha (R1F-10), so one ArrowDown lands
    // on Beta.
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Modes" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Modes" }), { key: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("Mode")).toHaveTextContent("Beta"));
    expect(screen.queryByRole("listbox", { name: "Modes" })).toBeNull();
    // Choosing a mode returns focus to the chip (no drop to <body>).
    expect(screen.getByLabelText("Mode")).toHaveFocus();

    // Tab closes the popover instead of leaving it open behind the focus move.
    fireEvent.click(screen.getByLabelText("Mode"));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Modes" }), { key: "Tab" });
    expect(screen.queryByRole("listbox", { name: "Modes" })).toBeNull();

    // Reopen, Escape closes and refocuses the chip.
    fireEvent.click(screen.getByLabelText("Mode"));
    expect(screen.getByRole("listbox", { name: "Modes" })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Mode"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Modes" })).toBeNull());
    expect(screen.getByLabelText("Mode")).toHaveFocus();

    // New mode… opens the NewModeDialog.
    fireEvent.click(screen.getByLabelText("Mode"));
    fireEvent.click(screen.getByRole("option", { name: /New mode…/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("mode chip carries the current mode name as its title for the icon-only state (R1F-04)", async () => {
    const modes = [
      makeMode({ id: "m1", name: "Alpha", cli: "claude" }),
      makeMode({ id: "m2", name: "Beta", cli: "claude" }),
    ];
    vi.spyOn(api, "listModes").mockResolvedValue(modes);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier2(modes, [makeCli({ id: "claude" })]);
    const chip = await screen.findByLabelText("Mode");
    await waitFor(() => expect(chip).toHaveAttribute("title", "Alpha"));
  });

  it("mode popover keyboard cursor starts on the current mode, both on click and ArrowDown (R1F-10)", async () => {
    const modes = [
      makeMode({ id: "m1", name: "Alpha", cli: "claude" }),
      makeMode({ id: "m2", name: "Beta", cli: "claude" }),
      makeMode({ id: "m3", name: "Gamma", cli: "claude" }),
    ];
    vi.spyOn(api, "listModes").mockResolvedValue(modes);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    // Current mode is Beta (m2): the chip's modeId state seeds from draftConfig.modeId.
    renderTier1(makeDraftSession({ modeId: "m2", draftConfig: { entryPoint: "worktree", worktreeChoice: "new", modeId: "m2" } }));

    const chip = await screen.findByLabelText("Mode");
    await waitFor(() => expect(chip).toHaveTextContent("Beta"));

    // Opening via ArrowDown on the closed chip starts on the current mode.
    fireEvent.keyDown(chip, { key: "ArrowDown" });
    let beta = screen.getByRole("option", { name: /Beta/ });
    expect(chip.getAttribute("aria-activedescendant")).toBe(beta.id);
    expect(beta).toHaveClass("draft-popover__item--active");

    // Close, then opening by click also starts on Beta, highlighted and selected.
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Modes" }), { key: "Escape" });
    fireEvent.click(chip);
    beta = screen.getByRole("option", { name: /Beta/ });
    expect(chip.getAttribute("aria-activedescendant")).toBe(beta.id);
    expect(beta).toHaveClass("draft-popover__item--active");
    expect(beta).toHaveAttribute("aria-selected", "true");

    // ArrowDown + Enter moves relative to Beta and selects the next mode (Gamma).
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Modes" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Modes" }), { key: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("Mode")).toHaveTextContent("Gamma"));
  });

  it("R4F-01 — mode popover is bounded to the space above it (short pane)", async () => {
    const modes = [
      makeMode({ id: "m1", name: "Alpha", cli: "claude" }),
      makeMode({ id: "m2", name: "Beta", cli: "claude" }),
      makeMode({ id: "m3", name: "Gamma", cli: "claude" }),
    ];
    vi.spyOn(api, "listModes").mockResolvedValue(modes);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier2(modes, [makeCli({ id: "claude" })]);
    await waitFor(() => expect(screen.getByLabelText("Mode")).toHaveTextContent("Alpha"));

    // The popover's bottom edge sits below the body's clip top (a short pane):
    // bottom 214, body top 35, minus the 8px edge gap => 171px. Anything else
    // returns the default zero rect.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rect.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("draft-popover--up")) return { bottom: 214 } as DOMRect;
      if (this.classList.contains("draft-composer__body")) return { top: 35 } as DOMRect;
      return { top: 0, bottom: 0 } as DOMRect;
    });

    try {
      fireEvent.click(screen.getByLabelText("Mode"));
      await waitFor(() => {
        expect(screen.getByRole("listbox", { name: "Modes" }).style.maxHeight).toBe("171px");
      });
    } finally {
      rect.mockRestore();
    }
  });

  it("R4F-01 — mode popover height has a floor even in an extremely short pane", async () => {
    const modes = [
      makeMode({ id: "m1", name: "Alpha", cli: "claude" }),
      makeMode({ id: "m2", name: "Beta", cli: "claude" }),
      makeMode({ id: "m3", name: "Gamma", cli: "claude" }),
    ];
    vi.spyOn(api, "listModes").mockResolvedValue(modes);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    renderTier2(modes, [makeCli({ id: "claude" })]);
    await waitFor(() => expect(screen.getByLabelText("Mode")).toHaveTextContent("Alpha"));

    // bottom 60, body top 35: 60 - 35 - 8 = 17, which floors to 120px.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rect.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("draft-popover--up")) return { bottom: 60 } as DOMRect;
      if (this.classList.contains("draft-composer__body")) return { top: 35 } as DOMRect;
      return { top: 0, bottom: 0 } as DOMRect;
    });

    try {
      fireEvent.click(screen.getByLabelText("Mode"));
      await waitFor(() => {
        expect(screen.getByRole("listbox", { name: "Modes" }).style.maxHeight).toBe("120px");
      });
    } finally {
      rect.mockRestore();
    }
  });

  it("`.draft-popover--up` flexes so the bound shrinks only the mode list, not the pinned row/label (R4F-01)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    // There are two `.draft-popover--up { … }` blocks: the positioning one and
    // the flex one that lets the inline max-height shrink only the list.
    const blocks = [...css.matchAll(/\.draft-popover--up \{([^}]*)\}/g)].map((m) => m[1] ?? "");
    const flex = blocks.find((b) => /flex-direction/.test(b));
    expect(flex).toBeTruthy();
    expect(flex!).toMatch(/display:\s*flex/);
    expect(flex!).toMatch(/flex-direction:\s*column/);
    const list = /\.draft-popover--up > \.draft-popover__list \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(list).toMatch(/min-height:\s*0/);
    const pinned = /\.draft-popover--up > \.draft-popover__pinned,([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(pinned).toMatch(/flex:\s*none/);
  });

  it("error strip renders inside the box above the composer (1.T7)", async () => {
    vi.spyOn(api, "listModes").mockResolvedValue([makeMode({ id: "claude-mode", cli: "claude", name: "Claude" })]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([makeCli({ id: "claude" })]);
    vi.spyOn(api, "startDraft").mockRejectedValue(new Error("boom"));
    renderTier1(makeDraftSession({ modeId: "claude-mode" }));
    await findChannelSwitch();
    await typePrompt("do it");
    await startTier1Draft();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(alert.closest(".draft-composer__box")).not.toBeNull();
    expect(alert.nextElementSibling?.className).toContain("draft-composer__composer");
  });

  it("tab entry shows a join header with the worktree branch and running agent count (1.T8a)", async () => {
    const wt: Worktree = {
      id: "wt-1",
      projectId: "p1",
      branch: "feat/foo",
      baseBranch: "main",
      baseSha: "sha",
      createdAt: "2026-01-01T00:00:00.000Z",
      pinnedAt: null,
      hiddenAt: null,
      mainSessionId: "a-main",
      lspEnabled: false,
    };
    const a1: Session = {
      id: "a1",
      worktreeId: "wt-1",
      projectId: "p1",
      modeId: "opencode",
      type: "agent",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "t",
      channel: "json",
      createdAt: "2026-01-01T00:00:00.000Z",
      draftPrompt: "",
      draftConfig: { entryPoint: "tab" },
    };
    const a2: Session = {
      id: "a2",
      worktreeId: "wt-1",
      projectId: "p1",
      modeId: "opencode",
      type: "agent",
      isMain: false,
      state: "exited",
      lifecycleState: "exited",
      tmuxName: "t",
      channel: "json",
      createdAt: "2026-01-01T00:00:00.000Z",
      draftPrompt: "",
      draftConfig: { entryPoint: "tab" },
    };
    const draft = makeDraftSession({ id: "tab-draft", worktreeId: "wt-1", projectId: "p1", draftConfig: { entryPoint: "tab" } });
    useServerStore.setState({ projects: [projectFixture("p1")], worktrees: [wt], sessions: [draft, a1, a2], loaded: true });
    useWorkspaceStore.setState({ sessionStates: { a1: "working", a2: "exited" } });
    render(
      <MemoryRouter initialEntries={["/draft/tab-draft"]}>
        <DraftComposer api={api as never} draftSessionId="tab-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    const join = screen.getByTestId("draft-join");
    // Worktree has no display name, so the branch is the name; it must appear
    // exactly once and not be repeated in the "joins this worktree" sub (R1F-12).
    expect(join.textContent).toContain("feat/foo");
    expect(join.textContent!.split("feat/foo").length).toBe(2);
    expect(join.textContent).toContain("joins this worktree");
    expect(screen.queryByText("Project")).toBeNull();
    expect(join.textContent).toContain("1 agent running");
  });

  it("the Discard ✕ is the first child of `__body` so it scrolls with its band and never overlaps the box (R3F-01)", async () => {
    const draft = makeDraftSession({ id: "tab-draft", worktreeId: "wt-1", projectId: "p1", draftConfig: { entryPoint: "tab" } });
    useServerStore.setState({ projects: [projectFixture("p1")], worktrees: [], sessions: [draft], loaded: true });
    render(
      <MemoryRouter initialEntries={["/draft/tab-draft"]}>
        <DraftComposer api={api as never} draftSessionId="tab-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    const discard = screen.getByRole("button", { name: "Discard draft" });
    const body = discard.parentElement;
    expect(body).toBeTruthy();
    expect(body!.className).toBe("draft-composer__body");
    expect(body!.firstElementChild).toBe(discard);
  });

  it("project tab entry shows the project name and 'runs in the project folder', no worktree copy (R1F-11)", async () => {
    const draft = makeDraftSession({
      id: "ptab-draft",
      projectId: "alpha",
      worktreeId: null,
      draftConfig: { entryPoint: "tab" },
    });
    useServerStore.setState({ projects: [projectFixture("alpha")], worktrees: [], sessions: [draft], loaded: true });
    vi.spyOn(api, "listProjects").mockResolvedValue([projectFixture("alpha")]);
    render(
      <MemoryRouter initialEntries={["/draft/ptab-draft"]}>
        <DraftComposer api={api as never} draftSessionId="ptab-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    const join = await screen.findByTestId("draft-join");
    await waitFor(() => expect(join.textContent).toContain("alpha"));
    expect(join.textContent).toContain("runs in the project folder");
    expect(join.textContent).not.toContain("worktree");
    expect(join.textContent).not.toContain("agent running");
  });

  it("direct entry with project shows the padlock and Remove project (1.T8b)", async () => {
    const draft = makeDraftSession({
      id: "direct-draft",
      projectId: "p1",
      draftConfig: { entryPoint: "direct", useWorktree: true, worktreeChoice: "new" },
    });
    useServerStore.setState({ projects: [projectFixture("p1")], worktrees: [], sessions: [draft], loaded: true });
    render(
      <MemoryRouter initialEntries={["/draft/direct-draft"]}>
        <DraftComposer api={api as never} draftSessionId="direct-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    expect(screen.getByRole("img", { name: "Locked to this project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove project" })).toBeTruthy();
  });

  it("global Tier 1 with project shows Remove project but no padlock (1.T8c)", async () => {
    const draft = makeDraftSession({
      id: "g-draft",
      projectId: "p1",
      draftConfig: { entryPoint: "global", useWorktree: true, worktreeChoice: "new" },
    });
    useServerStore.setState({ projects: [projectFixture("p1")], worktrees: [], sessions: [draft], loaded: true });
    render(
      <MemoryRouter initialEntries={["/draft/g-draft"]}>
        <DraftComposer api={api as never} draftSessionId="g-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    expect(screen.getByRole("button", { name: "Remove project" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Locked to this project" })).toBeNull();
  });

  it("rows: direct draft shows worktree/switch/branch/base; toggling off hides them; Existing shows Join select (1.T9)", async () => {
    const draft = makeDraftSession({
      id: "r-draft",
      projectId: "proj-a",
      draftConfig: { entryPoint: "direct", useWorktree: true, worktreeChoice: "new" },
    });
    useServerStore.setState({ projects: [projectFixture("proj-a")], worktrees: [], sessions: [draft], loaded: true });
    render(
      <MemoryRouter initialEntries={["/draft/r-draft"]}>
        <DraftComposer api={api as never} draftSessionId="r-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    expect(screen.getByRole("radiogroup", { name: "Worktree" })).toBeTruthy();
    const sw = screen.getByRole("switch", { name: "Use worktree" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "Branch" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Base branch" })).toBeTruthy());

    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radiogroup", { name: "Worktree" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Use worktree" }));
    fireEvent.click(screen.getByRole("radio", { name: "Existing worktree" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Worktree to join" })).toBeTruthy());
  });

  it("global draft gates rows behind a chosen target (W1) (1.T10)", async () => {
    render(
      <MemoryRouter initialEntries={["/draft/new"]}>
        <DraftComposer api={api as never} draftSessionId={null} onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();
    expect(screen.queryByRole("switch", { name: "Use worktree" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Worktree" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Base branch" })).toBeNull();

    await act(async () => {
      screen.getByTestId("add-path-btn").click();
    });
    expect(screen.getByRole("switch", { name: "Use worktree" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Worktree" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Branch" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Base branch" })).toBeTruthy();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2.T6 — short pane folds the field rows into a summary; click expands; tall pane removes it", async () => {
    let roCb: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          roCb = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    const draft = makeDraftSession({
      id: "s-draft",
      projectId: "p1",
      draftConfig: { entryPoint: "direct", useWorktree: true, worktreeChoice: "new" },
    });
    vi.spyOn(api, "listProjects").mockResolvedValue([projectFixture("p1")]);
    useServerStore.setState({ projects: [projectFixture("p1")], worktrees: [], sessions: [draft], loaded: true });
    render(
      <MemoryRouter initialEntries={["/draft/s-draft"]}>
        <DraftComposer api={api as never} draftSessionId="s-draft" onStarted={onStarted} onDiscard={() => {}} />
      </MemoryRouter>,
    );
    await findChannelSwitch();

    // Short pane -> rows fold into a summary.
    act(() => {
      roCb!([{ contentRect: { height: 360 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    const summaryName = new RegExp(`${projectFixture("p1").name}.*Edit`);
    const summary = screen.getByRole("button", { name: summaryName });
    expect(summary).toHaveAttribute("aria-controls", "draft-composer-rows");
    expect(document.getElementById("draft-composer-rows")).toBe(document.querySelector(".draft-composer__rows"));
    expect(summary.textContent).toContain(projectFixture("p1").name);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".draft-composer__rows")).toHaveAttribute("hidden");
    expect(screen.getByRole("switch", { name: /Rich Chat/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeTruthy();
    // R1F-07: the root carries the short class and the caption stays mounted (a11y).
    expect(document.querySelector(".draft-composer")).toHaveClass("draft-composer--short");
    expect(screen.getByRole("heading", { name: "New agent" })).toBeTruthy();

    // Click the summary -> rows expand.
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".draft-composer__rows")).not.toHaveAttribute("hidden");

    // Tall pane -> summary gone, short class removed.
    act(() => {
      roCb!([{ contentRect: { height: 700 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(document.querySelector(".draft-composer__summary")).toBeNull();
    expect(document.querySelector(".draft-composer")).not.toHaveClass("draft-composer--short");
  });

  it("phone block gives attach, discard, channel toggle and project trigger 44px targets (R1F-04)", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/draft/DraftComposer.css"), "utf8");
    const start = css.indexOf("@media (max-width: 640px) {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}\n", start));
    for (const sel of [
      ".chat-composer__attach",
      ".draft-composer__discard",
      ".chat-composer__channel-toggle",
      ".draft-row__trigger",
    ]) {
      const rule = new RegExp(`\\.draft-composer ${sel.replace(".", "\\.")}[^{]*\\{([^}]*)\\}`).exec(block)?.[1] ?? "";
      expect(rule, sel).toMatch(/min-height:\s*var\(--h-touch\)/);
    }
    const send = /\.draft-composer \.chat-composer__send[^{]*\{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(send).toMatch(/min-width:\s*var\(--h-touch\)/);
    expect(send).toMatch(/min-height:\s*var\(--h-touch\)/);
  });
});
