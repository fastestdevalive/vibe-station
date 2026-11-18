import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import type { Mode, Project, Session, SupportedCli } from "@/api/types";
import { ensureDraftTextSync } from "@/components/draftsync";
import { engineFor } from "@/components/draftsync/engine";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useGlobalDraftStore } from "@/store/globalDraftStore";
import { DraftComposer } from "./DraftComposer";

// A controllable stand-in for the Lexical editor: it renders `initialText` once
// (like Lexical does) and exposes the imperative `setText` the sync hook calls
// for a remote apply.
vi.mock("../chat/SkillEditor", async () => {
  const React = await import("react");
  return {
    useSoftKeyboardVisible: () => false,
    SkillEditor: React.forwardRef(function Stub(
      props: { initialText?: string; onChangeText: (text: string, hasContent: boolean) => void },
      ref: React.Ref<unknown>,
    ) {
      const [value, setValue] = React.useState(props.initialText ?? "");
      React.useImperativeHandle(ref, () => ({
        setText: (t: string) => setValue(t),
        getText: () => value,
        clear: () => setValue(""),
        focus: () => {},
        appendText: (t: string) => setValue((v: string) => (v ? `${v}\n${t}` : t)),
      }));
      return React.createElement("input", {
        "data-testid": "prompt-input",
        value,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          setValue(e.target.value);
          props.onChangeText(e.target.value, e.target.value.trim().length > 0);
        },
      });
    }),
  };
});

vi.mock("./ProjectCombobox", () => ({
  ProjectCombobox: () => null,
}));

const GLOBAL = "global-new";
const apis: ApiInstance[] = [];

function mockApi() {
  const api = createMockApi();
  apis.push(api);
  return api;
}

async function start(api: ApiInstance): Promise<void> {
  ensureDraftTextSync(api);
  await act(async () => {
    // the engine's one initial fetch
  });
}

function changed(api: ReturnType<typeof createMockApi>, scope: string, text: string, revision: number, clientId = "phone") {
  return act(async () => {
    api.__test.emit({
      type: "draft-text:changed",
      scope,
      text,
      revision,
      updatedAt: "2026-01-01T00:00:00.000Z",
      clientId,
    });
  });
}

const promptInput = () => screen.getByTestId("prompt-input") as HTMLInputElement;

async function typePrompt(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(promptInput(), { target: { value: text } });
  });
}

/** Wait out the composer's 1200 ms save debounce. */
async function settleSave(ms = 1400): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const cli: SupportedCli = {
  id: "claude",
  defaultModel: "sonnet",
  supportsJson: true,
  supportsTerminalDelivery: false,
  supportsTerminalComments: false,
  importsNativeHistory: true,
  supportsJsonToTerminalResume: true,
  detected: true,
  starterBundleNames: [],
  usingFallbackOnly: false,
  defaultChannel: "json",
  defaultChannelOverridden: false,
};
const mode: Mode = { id: "m-claude", name: "Claude", cli: "claude", context: "" };
const project: Project = {
  id: "p1",
  name: "p1",
  path: "/tmp/proj",
  prefix: "p",
  isGit: true,
  defaultBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  hidden: false,
  lspEnabled: false,
};

function draftSession(over: Partial<Session> = {}): Session {
  return {
    id: "t1-draft",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: "m-claude",
    type: "agent",
    isMain: false,
    state: "drafting",
    lifecycleState: "drafting",
    tmuxName: "tmux-t1-draft",
    channel: "json",
    createdAt: "2026-01-01T00:00:00.000Z",
    draftPrompt: "",
    draftConfig: { entryPoint: "tab", modeId: "m-claude", channel: "json" },
    ...over,
  };
}

async function renderTier1(api: ApiInstance, session: Session = draftSession()) {
  vi.spyOn(api, "listModes").mockResolvedValue([mode]);
  vi.spyOn(api, "getSupportedClis").mockResolvedValue([cli]);
  useServerStore.setState({
    projects: [project],
    worktrees: [{ id: "wt-1", projectId: "p1", branch: "feat" }],
    sessions: [session],
    loaded: true,
  } as never);
  const view = render(
    <MemoryRouter initialEntries={[`/draft/${session.id}`]}>
      <DraftComposer api={api} draftSessionId={session.id} onStarted={vi.fn()} onDiscard={vi.fn()} />
    </MemoryRouter>,
  );
  await screen.findByTestId("prompt-input");
  return view;
}

async function renderTier2(api: ApiInstance) {
  vi.spyOn(api, "listModes").mockResolvedValue([mode]);
  vi.spyOn(api, "getSupportedClis").mockResolvedValue([cli]);
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true } as never);
  render(
    <MemoryRouter initialEntries={["/draft/new"]}>
      <DraftComposer api={api} draftSessionId={null} onStarted={vi.fn()} onDiscard={vi.fn()} />
    </MemoryRouter>,
  );
  await screen.findByTestId("prompt-input");
}

/** Simulate another client's `session:updated` landing for this draft. */
async function remoteSessionPrompt(session: Session, text: string): Promise<void> {
  await act(async () => {
    useServerStore.setState({ sessions: [{ ...session, draftPrompt: text }] } as never);
  });
}

beforeEach(() => {
  localStorage.clear();
  useGlobalDraftStore.setState({ draft: null });
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  useWorkspaceStore.setState({ sessionStates: {}, activeSessionId: null } as never);
  apis.length = 0;
});

afterEach(() => {
  for (const api of apis) engineFor(api)?.stop();
  vi.restoreAllMocks();
});

describe("DraftComposer live draft sync (Phase 4 Track B)", () => {
  it("tier2_prompt_syncs_to_global_new", async () => {
    const api = mockApi();
    await start(api);
    await renderTier2(api);
    const put = vi.spyOn(api, "putDraftText");
    await typePrompt("hello global");
    await waitFor(() => expect(put).toHaveBeenCalledWith(GLOBAL, "hello global", expect.any(String), undefined));
    expect((await api.getDraftText(GLOBAL)).text).toBe("hello global");
  }, 10_000);

  it("tier2_remote_applies_when_clean", async () => {
    const api = mockApi();
    await start(api);
    await renderTier2(api);
    await changed(api, GLOBAL, "from phone", 1);
    expect(promptInput().value).toBe("from phone");
    // The mirror keeps the sidebar in step too (Decision 10).
    expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("from phone");
  }, 10_000);

  it("tier1_remote_draftPrompt_applies_when_clean", async () => {
    const api = mockApi();
    const session = draftSession();
    const update = vi.spyOn(api, "updateDraft").mockResolvedValue({ ok: true, name: null });
    await renderTier1(api, session);

    await remoteSessionPrompt(session, "from phone");

    expect(promptInput().value).toBe("from phone");
    // A remote apply on a clean editor leaves Start usable (prompt non-empty).
    expect(screen.getByRole("button", { name: "Start agent" })).toBeEnabled();
    expect(update).not.toHaveBeenCalled();
  }, 10_000);

  it("tier1_out_of_order_own_echo_ignored", async () => {
    const api = mockApi();
    const session = draftSession();
    const update = vi.spyOn(api, "updateDraft").mockResolvedValue({ ok: true, name: null });
    await renderTier1(api, session);

    await typePrompt("first");
    await settleSave();
    await typePrompt("second");
    await settleSave();
    await waitFor(() => expect(update.mock.calls.some(([, b]) => b.draftPrompt === "second")).toBe(true));

    // Our own earlier PATCH echo arrives late: it must not roll the editor back.
    await remoteSessionPrompt(session, "first");
    expect(promptInput().value).toBe("second");
  }, 15_000);

  it("tier1_remote_apply_does_not_patch", async () => {
    const api = mockApi();
    const session = draftSession();
    const update = vi.spyOn(api, "updateDraft").mockResolvedValue({ ok: true, name: null });
    await renderTier1(api, session);

    await remoteSessionPrompt(session, "from phone");
    expect(promptInput().value).toBe("from phone");

    // The config effect (`[currentConfig, scheduleSave]`) re-runs after the
    // apply because `scheduleSave` changed identity — its re-save must dedupe.
    await settleSave();
    expect(update).not.toHaveBeenCalled();
  }, 10_000);

  it("tier1_type_back_to_last_sent_saves_right_text", async () => {
    const api = mockApi();
    const session = draftSession();
    const update = vi.spyOn(api, "updateDraft").mockResolvedValue({ ok: true, name: null });
    await renderTier1(api, session);

    await typePrompt("alpha");
    await settleSave();
    await typePrompt("alpha plus");
    await settleSave();
    await typePrompt("alpha");
    await settleSave();
    await waitFor(() => expect(update.mock.calls.filter(([, b]) => b.draftPrompt === "alpha").length).toBe(2), { timeout: 3000 });

    const sent = update.mock.calls.map(([, b]) => b.draftPrompt);
    expect(sent).toEqual(["alpha", "alpha plus", "alpha"]);
  }, 15_000);

  it("discard_clears_global_new_via_mirror", async () => {
    const api = mockApi();
    await start(api);
    await renderTier2(api);
    const put = vi.spyOn(api, "putDraftText");
    await typePrompt("typed draft");
    await waitFor(() => expect(put).toHaveBeenCalledWith(GLOBAL, "typed draft", expect.any(String), undefined));
    await waitFor(() => expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("typed draft"));

    // The Tier-2 discard lives in the sidebar (`confirmDiscardGlobal`): it clears
    // the store, and the mirror turns that into a server clear (Decision 10).
    await act(async () => {
      useGlobalDraftStore.getState().clearDraft();
    });

    expect(useGlobalDraftStore.getState().draft).toBeNull();
    await waitFor(() => expect(put).toHaveBeenCalledWith(GLOBAL, "", expect.any(String), undefined));
    expect((await api.getDraftText(GLOBAL)).text).toBe("");
  }, 15_000);
});

/**
 * The real app's `/draft/*` route: `Workspace.tsx` keys `DraftComposer` on the
 * session id (or the new location key), so a Tier-1 → Tier-2 demote remounts it.
 */
function DraftApp({ api }: { api: ApiInstance }) {
  const location = useLocation();
  const draftSessionId = location.pathname === "/draft/new" ? null : "t1-draft";
  return (
    <DraftComposer
      key={draftSessionId ?? `new:${location.key}`}
      api={api}
      draftSessionId={draftSessionId}
      onStarted={vi.fn()}
      onDiscard={vi.fn()}
    />
  );
}

/** Seed the mock server's `global-new` row before any engine exists. */
async function seedGlobal(api: ReturnType<typeof createMockApi>, text: string): Promise<void> {
  await api.putDraftText(GLOBAL, text, "seed");
}

const putCalls = (put: { mock: { calls: unknown[][] } }) =>
  put.mock.calls.filter(([scope]) => scope === GLOBAL).length;

describe("DraftComposer draft-sync fixes (final review)", () => {
  it("tier2_cold_load_keeps_the_synced_prompt", async () => {
    // A hard reload of /draft/new: the composer mounts BEFORE `useServerSync`'s
    // `ensureDraftTextSync` creates the engine, so its first paint is "".
    const api = mockApi();
    await seedGlobal(api, "abc");
    useGlobalDraftStore.setState({ draft: { draftPrompt: "", draftConfig: { entryPoint: "global" } } });
    await renderTier2(api);
    const put = vi.spyOn(api, "putDraftText");

    await start(api);
    await act(async () => {
      // the delayed bind (`setTimeout(0)`) and the fetch land
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(promptInput().value).toBe("abc"));
    expect(put).not.toHaveBeenCalledWith(GLOBAL, "", expect.any(String), undefined);
    expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("abc");
  }, 10_000);

  it("tier2_bind_before_doc_arrival_keeps_the_synced_prompt", async () => {
    // The engine binds while its first list fetch is still in flight: the record
    // is still empty at bind time, and the doc must then win (not the empty paint).
    const api = mockApi();
    await seedGlobal(api, "abc");
    const list = api.listDraftTexts.bind(api);
    let releaseList: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    vi.spyOn(api, "listDraftTexts").mockImplementation(async () => {
      await held;
      return list();
    });
    useGlobalDraftStore.setState({ draft: { draftPrompt: "", draftConfig: { entryPoint: "global" } } });
    await renderTier2(api);
    const put = vi.spyOn(api, "putDraftText");

    ensureDraftTextSync(api);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0)); // the delayed bind
    });
    await act(async () => {
      releaseList();
    });

    await waitFor(() => expect(promptInput().value).toBe("abc"));
    expect(put).not.toHaveBeenCalledWith(GLOBAL, "", expect.any(String), undefined);
    expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("abc");
  }, 10_000);

  it("tier2_one_put_per_burst", async () => {
    vi.useFakeTimers();
    try {
      const api = mockApi();
      await start(api);
      vi.spyOn(api, "listModes").mockResolvedValue([mode]);
      vi.spyOn(api, "getSupportedClis").mockResolvedValue([cli]);
      useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: true } as never);
      const view = render(
        <MemoryRouter initialEntries={["/draft/new"]}>
          <DraftComposer api={api} draftSessionId={null} onStarted={vi.fn()} onDiscard={vi.fn()} />
        </MemoryRouter>,
      );
      const put = vi.spyOn(api, "putDraftText");

      let text = "";
      for (const ch of ["a", "b", "c", "d", "e"]) {
        text += ch;
        act(() => {
          fireEvent.change(promptInput(), { target: { value: text } });
        });
        act(() => {
          vi.advanceTimersByTime(100);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(putCalls(put)).toBe(1);
      expect(put).toHaveBeenCalledWith(GLOBAL, "abcde", expect.any(String), undefined);

      // The text is already synced: unmounting must not send it again.
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(putCalls(put)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("clear_project_carries_the_prompt_into_global_new", async () => {
    const api = mockApi();
    await start(api);
    // The demote terminates the draft record; the mock has no such session, and
    // that call is irrelevant to the prompt carry asserted here.
    vi.spyOn(api, "terminateSession").mockResolvedValue({ ok: true });
    vi.spyOn(api, "listModes").mockResolvedValue([mode]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([cli]);
    useServerStore.setState({
      projects: [project],
      worktrees: [{ id: "wt-1", projectId: "p1", branch: "feat" }],
      sessions: [
        draftSession({
          draftPrompt: "keep me",
          draftConfig: { entryPoint: "direct", modeId: "m-claude", channel: "json" },
        }),
      ],
      loaded: true,
    } as never);
    render(
      <MemoryRouter initialEntries={["/draft/t1-draft"]}>
        <DraftApp api={api} />
      </MemoryRouter>,
    );
    await screen.findByTestId("prompt-input");
    expect(promptInput().value).toBe("keep me");
    const put = vi.spyOn(api, "putDraftText");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    });

    // Remounted on /draft/new: Tier 2 seeds from the server-owned scope.
    await screen.findByTestId("prompt-input");
    expect(promptInput().value).toBe("keep me");
    expect(useGlobalDraftStore.getState().draft?.draftPrompt).toBe("keep me");
    expect(useGlobalDraftStore.getState().draft?.draftConfig.entryPoint).toBe("global");

    await settleSave();
    expect(put).toHaveBeenCalledWith(GLOBAL, "keep me", expect.any(String), undefined);
  }, 15_000);

  it("tier1_failed_patch_is_re_sent_on_unmount", async () => {
    const api = mockApi();
    const update = vi
      .spyOn(api, "updateDraft")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, name: null });
    const view = await renderTier1(api);

    await typePrompt("keep");
    await settleSave();
    expect(update.mock.calls.filter(([, b]) => b.draftPrompt === "keep")).toHaveLength(1);

    // The failed PATCH must not count as sent: the unmount flush re-sends it.
    view.unmount();
    await waitFor(() =>
      expect(update.mock.calls.filter(([, b]) => b.draftPrompt === "keep")).toHaveLength(2),
    );
  }, 15_000);
});
