import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import type { Session } from "@/api/types";
import { makeComment as c } from "@/components/comments/testFixtures";
import { useCommentStore } from "@/components/comments/useCommentStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useGlobalDraftStore } from "@/store/globalDraftStore";
import { DraftComposer } from "./DraftComposer";

// Same stubs as DraftComposer.test.tsx, except the editor stub renders `topRight` (the review Attach button).
vi.mock("../chat/SkillEditor", () => ({
  useSoftKeyboardVisible: () => false,
  SkillEditor: ({
    onChangeText,
    onSubmit,
    topRight,
  }: {
    onChangeText: (text: string, hasContent: boolean) => void;
    onSubmit: () => void;
    topRight?: ReactNode;
  }) => (
    <div data-testid="skill-editor-stub">
      {topRight}
      <input data-testid="prompt-input" onChange={(e) => onChangeText(e.target.value, e.target.value.trim().length > 0)} />
      <button data-testid="start-btn" onClick={onSubmit}>
        Start
      </button>
    </div>
  ),
}));
vi.mock("./ProjectCombobox", () => ({ ProjectCombobox: () => <div /> }));

const draft = (over: Partial<Session> = {}): Session =>
  ({
    id: "d1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: "m1",
    type: "agent",
    isMain: false,
    state: "drafting",
    lifecycleState: "drafting",
    tmuxName: "t",
    channel: "json",
    createdAt: "2026-01-01T00:00:00Z",
    draftPrompt: "",
    draftConfig: { entryPoint: "tab", channel: "json", modeId: "m1" },
    ...over,
  }) as Session;

const comments = (attachedTo?: string) => [1, 2, 3].map((n) => c({ id: `c${n}`, pin: n, ...(attachedTo ? { attachedTo } : {}) }));
const seed = (rows = comments()) => useCommentStore.getState().replace("wt-1", "worktree", { comments: rows, nextPin: 9, terminalDeliveries: [] });

let api: MockApi;
const onStarted = vi.fn();

function mount(id: string | null = "d1") {
  return render(
    <MemoryRouter initialEntries={[id ? `/draft/${id}` : "/draft/new"]}>
      <DraftComposer api={api as never} draftSessionId={id} onStarted={onStarted} onDiscard={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  onStarted.mockReset();
  api = createMockApi() as MockApi;
  vi.spyOn(api, "listComments").mockResolvedValue({ comments: [], nextPin: 1, terminalDeliveries: [] });
  useGlobalDraftStore.setState({ draft: null });
  useCommentStore.getState().reset();
  useServerStore.setState({ projects: [], worktrees: [], sessions: [draft()], loaded: true });
});

describe("DraftComposer review Attach (6.T4)", () => {
  it("shows the Attach button on a Tier-1 tab draft when the panel has comments", async () => {
    seed();
    mount();
    expect(await screen.findByRole("button", { name: "Attach 3 comments" })).toBeInTheDocument();
  });

  it("is not rendered without comments", async () => {
    seed([]);
    mount();
    await screen.findByTestId("prompt-input");
    expect(screen.queryByRole("button", { name: /Attach \d+ comment/ })).toBeNull();
  });

  it("is not rendered on /draft/new (Tier 2 has no worktree)", async () => {
    seed();
    mount(null);
    await screen.findByTestId("prompt-input");
    expect(screen.queryByRole("button", { name: /Attach \d+ comment/ })).toBeNull();
  });

  it("is not rendered for a new-worktree draft (it would leave the comments' scope)", async () => {
    useServerStore.setState({ sessions: [draft({ worktreeId: null, draftConfig: { entryPoint: "worktree", worktreeChoice: "new" } as never })] });
    seed();
    mount();
    await screen.findByTestId("prompt-input");
    expect(screen.queryByRole("button", { name: /Attach \d+ comment/ })).toBeNull();
  });

  it("with a chip attached, Start sends the ids and an EMPTY prompt is allowed (the daemon enqueues the first turn)", async () => {
    seed(comments("session:d1"));
    const start = vi.spyOn(api, "startDraft").mockResolvedValue({ ok: true, worktreeId: "wt-1" });
    const first = vi.spyOn(api, "sendChat");
    mount();
    expect(await screen.findByTestId("review-chip")).toHaveTextContent("3 comments attached");
    const startButton = screen.getByRole("button", { name: "Start agent" });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const body = start.mock.calls[0]![1];
    expect(body.reviewCommentIds).toEqual(["c1", "c2", "c3"]);
    expect(body.draftPrompt).toBe("");
    // the first turn is the daemon's: no client-side skipAutoTurn flag and no second send
    expect((body as Record<string, unknown>).skipAutoTurn).toBeUndefined();
    expect(first).not.toHaveBeenCalled();
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0);
  });

  it("without a chip an empty prompt still cannot start", async () => {
    seed();
    mount();
    await screen.findByTestId("prompt-input");
    expect(screen.getByRole("button", { name: "Start agent" })).toBeDisabled();
  });

  it("a refused start (comments changed) keeps the draft and says why", async () => {
    const { ReviewApiError } = await import("@/api/errors");
    seed(comments("session:d1"));
    vi.spyOn(api, "startDraft").mockRejectedValue(new ReviewApiError("x", 409, "comments_changed", { remaining: 2 }));
    mount();
    await screen.findByTestId("review-chip");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    });
    expect(await screen.findByText("2 comments changed, review and send again")).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("the REAL client maps a 409 comments_changed from /start to a review error and refetches the scope", async () => {
    const { createClientApi } = await import("@/api/client");
    seed(comments("session:d1"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "comments_changed", remaining: 2 }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const real = createClientApi();
    vi.spyOn(api, "startDraft").mockImplementation((id, body) => real.startDraft(id, body));
    const list = vi.spyOn(api, "listComments");
    mount();
    await screen.findByTestId("review-chip");
    list.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    });
    expect(await screen.findByText("2 comments changed, review and send again")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalled();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("comments and staged files do not mix: the paperclip is disabled with a chip, the Attach button while files are staged", async () => {
    seed();
    mount();
    const attach = await screen.findByRole("button", { name: "Attach 3 comments" });
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.drop(document.querySelector(".chat-composer")!, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    await waitFor(() => expect(attach).toBeDisabled());
    expect(attach).toHaveAttribute("title", expect.stringContaining("Remove the staged files first"));
  });
});
