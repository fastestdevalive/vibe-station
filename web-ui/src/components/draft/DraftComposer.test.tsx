import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import type { Worktree } from "@/api/types";
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
