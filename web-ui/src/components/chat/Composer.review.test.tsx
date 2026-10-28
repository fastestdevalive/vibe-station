import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ReviewApiError } from "@/api/errors";
import { useServerStore } from "@/hooks/useServerStore";
import { makeComment as c } from "@/components/comments/testFixtures";
import { useCommentStore } from "@/components/comments/useCommentStore";
import { Composer } from "./Composer";

/** Composer + the review Attach button and chip (R131-R134, R127, R72). */
const four = (attachedTo?: string) =>
  [1, 2, 3, 4].map((n) => c({ id: `c${n}`, pin: n, ...(attachedTo ? { attachedTo } : {}) }));
const seed = (comments = four(), scopeId = "wt-1") =>
  act(() => useCommentStore.getState().replace(scopeId, "worktree", { comments, nextPin: 20, terminalDeliveries: [] }));

function session(id: string, name: string) {
  return { id, worktreeId: "wt-1", projectId: "p1", name, type: "agent", isMain: false, state: "idle", channel: "json" } as never;
}

function setup(over: Record<string, unknown> = {}, sessionId = "s1") {
  const api = createMockApi();
  vi.spyOn(api, "listComments").mockResolvedValue({ comments: [], nextPin: 1, terminalDeliveries: [] });
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onScheduleSend = vi.fn().mockResolvedValue(undefined);
  render(<Composer api={api} sessionId={sessionId} onSend={onSend} onScheduleSend={onScheduleSend} initialText="hello" {...over} />);
  return { api, onSend, onScheduleSend };
}

beforeEach(() => {
  localStorage.clear();
  useCommentStore.getState().reset();
  useServerStore.setState({ sessions: [session("s1", "main"), session("s2", "reviewer")], worktrees: [] } as never);
});

describe("ReviewAttachButton in the composer (6.T4)", () => {
  it("is not rendered when the panel has no comments", () => {
    seed([]);
    setup();
    expect(screen.queryByRole("button", { name: /Attach \d+ comment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /comments? attached/ })).toBeNull();
  });

  it("Attach with the count, then Attached ✓ with the chip; pressing again detaches", async () => {
    seed();
    const { api } = setup();
    vi.spyOn(api, "attachComments").mockResolvedValue({ attached: ["c1", "c2", "c3", "c4"] });
    const detach = vi.spyOn(api, "detachComments").mockResolvedValue({ detached: ["c1", "c2", "c3", "c4"] });

    const btn = await screen.findByRole("button", { name: "Attach 4 comments" });
    expect(btn).toHaveTextContent("4");
    expect(btn).toHaveTextContent("Attach");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("title", "Attach all 4 comments to this message");
    expect(screen.queryByTestId("review-chip")).toBeNull();

    fireEvent.click(btn);
    const on = await screen.findByRole("button", { name: "4 comments attached, press to detach" });
    expect(api.attachComments).toHaveBeenCalledWith("wt-1", "worktree", { composerKey: "session:s1" });
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(on).toHaveTextContent("Attached ✓");
    expect(screen.getByTestId("review-chip")).toHaveTextContent("4 comments attached");
    expect(screen.getByTestId("review-chip")).toHaveTextContent("Detach");

    fireEvent.click(on);
    await waitFor(() => expect(detach).toHaveBeenCalledWith("wt-1", "worktree", { composerKey: "session:s1" }));
    expect(await screen.findByRole("button", { name: "Attach 4 comments" })).toBeInTheDocument();
    expect(screen.queryByTestId("review-chip")).toBeNull();
  });

  it("the chip's own Detach releases them too", async () => {
    seed(four("session:s1"));
    const { api } = setup();
    const detach = vi.spyOn(api, "detachComments").mockResolvedValue({ detached: ["c1", "c2", "c3", "c4"] });
    fireEvent.click(await screen.findByRole("button", { name: "Detach 4 comments" }));
    await waitFor(() => expect(detach).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("review-chip")).toBeNull());
  });

  it("a comment added while some are attached shows +N and the chip stays at 4 until pressed", async () => {
    seed(four("session:s1"));
    const { api } = setup();
    const attach = vi.spyOn(api, "attachComments").mockResolvedValue({ attached: ["c1", "c2", "c3", "c4", "c5"] });
    act(() => useCommentStore.getState().upsertLocal(c({ id: "c5", pin: 5 })));
    const btn = await screen.findByRole("button", { name: "Attach 1 more comment" });
    expect(btn).toHaveTextContent("+1");
    expect(btn).toHaveTextContent("4");
    expect(screen.getByTestId("review-chip")).toHaveTextContent("4 comments attached");
    fireEvent.click(btn);
    await waitFor(() => expect(attach).toHaveBeenCalledWith("wt-1", "worktree", { composerKey: "session:s1" }));
    await waitFor(() => expect(screen.getByTestId("review-chip")).toHaveTextContent("5 comments attached"));
  });

  it("comments attached to another composer are not this one's: its button reads Attach N and a press moves them", async () => {
    seed(four("session:s2"));
    const { api } = setup();
    expect(screen.queryByTestId("review-chip")).toBeNull();
    const btn = await screen.findByRole("button", { name: "Attach 4 comments" });
    vi.spyOn(api, "attachComments").mockResolvedValue({ attached: ["c1", "c2", "c3", "c4"] });
    fireEvent.click(btn);
    await screen.findByTestId("review-chip");
  });

  it("moves between composers: attaching in one removes the other's chip (server push)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "listComments").mockResolvedValue({ comments: [], nextPin: 1, terminalDeliveries: [] });
    render(
      <>
        <div data-testid="one">
          <Composer api={api} sessionId="s1" onSend={vi.fn()} />
        </div>
        <div data-testid="two">
          <Composer api={api} sessionId="s2" onSend={vi.fn()} />
        </div>
      </>,
    );
    seed(four("session:s1"));
    expect(within(screen.getByTestId("one")).getByTestId("review-chip")).toBeInTheDocument();
    expect(within(screen.getByTestId("two")).queryByTestId("review-chip")).toBeNull();
    act(() => useCommentStore.getState().setAttachedLocal("wt-1", ["c1", "c2", "c3", "c4"], "session:s2"));
    expect(within(screen.getByTestId("one")).queryByTestId("review-chip")).toBeNull();
    expect(within(screen.getByTestId("one")).getByRole("button", { name: "Attach 4 comments" })).toBeInTheDocument();
    expect(within(screen.getByTestId("two")).getByTestId("review-chip")).toHaveTextContent("4 comments attached");
  });

  it("pluralises one comment", async () => {
    seed([c({ id: "only" })]);
    setup();
    expect(await screen.findByRole("button", { name: "Attach 1 comment" })).toBeInTheDocument();
  });

  it("is disabled offline with the reason", async () => {
    seed();
    setup();
    const api = createMockApi();
    vi.spyOn(api, "getConnectionState").mockReturnValue("offline");
    vi.spyOn(api, "subscribeConnection").mockImplementation(() => () => {});
    vi.spyOn(api, "listComments").mockResolvedValue({ comments: [], nextPin: 1, terminalDeliveries: [] });
    render(<Composer api={api} sessionId="s2" onSend={vi.fn()} />);
    const btns = await screen.findAllByRole("button", { name: "Attach 4 comments" });
    const offline = btns.find((b) => (b as HTMLButtonElement).disabled)!;
    expect(offline).toHaveAttribute("title", "Attach needs the daemon connection");
  });
});

describe("Composer send / schedule with a chip (6.T6)", () => {
  it("sends the attached ids as the 4th argument and the rows leave the panel", async () => {
    seed(four("session:s1"));
    const { onSend } = setup();
    fireEvent.click(await screen.findByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("hello", [], undefined, ["c1", "c2", "c3", "c4"]);
    expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0);
  });

  it("an empty message is sendable while a chip is attached", async () => {
    seed(four("session:s1"));
    const { onSend } = setup({ initialText: "" });
    const send = await screen.findByLabelText("Send message");
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", [], undefined, ["c1", "c2", "c3", "c4"]));
  });

  it("typing alone never includes comments that are not attached (R127)", async () => {
    seed(four());
    const { onSend } = setup();
    fireEvent.click(await screen.findByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]).toEqual(["hello", []]);
  });

  it("Ctrl/Cmd+Enter with a chip keeps queue semantics and passes the ids", async () => {
    seed(four("session:s1"));
    const { onSend } = setup();
    await screen.findByTestId("review-chip");
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", [], true, ["c1", "c2", "c3", "c4"]));
  });

  it("a 409 comments_changed keeps the text, shows the reason and refreshes the scope", async () => {
    const onSend = vi.fn().mockRejectedValue(new ReviewApiError("x", 409, "comments_changed", { remaining: 2 }));
    seed(four("session:s1"));
    const { api } = setup({ onSend });
    fireEvent.click(await screen.findByLabelText("Send message"));
    expect(await screen.findByRole("alert")).toHaveTextContent("2 comments changed, review and send again");
    expect(screen.getByLabelText("Message").textContent).toBe("hello");
    await waitFor(() => expect(api.listComments).toHaveBeenCalled());
  });

  it("a refusal alert is cleared by the next send attempt", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new ReviewApiError("x", 409, "comments_changed", { remaining: 2 }))
      .mockResolvedValue(undefined);
    seed(four("session:s1"));
    setup({ onSend });
    fireEvent.click(await screen.findByLabelText("Send message"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    act(() => useCommentStore.getState().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: four(), deleted: [] }));
    await waitFor(() => expect(screen.queryByTestId("review-chip")).toBeNull());
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a lease-expiry push removes the chip and Enter sends the text only", async () => {
    seed(four("session:s1"));
    const { onSend } = setup();
    await screen.findByTestId("review-chip");
    // the daemon released the lease: the comments come back unattached
    act(() => useCommentStore.getState().applyChanged({ scopeId: "wt-1", scopeKind: "worktree", upserted: four(), deleted: [] }));
    await waitFor(() => expect(screen.queryByTestId("review-chip")).toBeNull());
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]).toEqual(["hello", []]);
  });

  it("the composer Schedule passes the chip's ids, enabled even with no text", async () => {
    seed(four("session:s1"));
    const { onScheduleSend } = setup({ initialText: "" });
    const clock = await screen.findByLabelText("Schedule send");
    expect(clock).toBeEnabled();
    fireEvent.click(clock);
    const pop = await screen.findByRole("dialog", { name: "Schedule send" });
    expect(within(pop).getByTestId("review-chip")).toHaveTextContent("4 comments attached");
    fireEvent.click(within(pop).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(onScheduleSend).toHaveBeenCalledTimes(1));
    const [message, ids, fireAt, review] = onScheduleSend.mock.calls[0]!;
    expect([message, ids, review]).toEqual(["", [], ["c1", "c2", "c3", "c4"]]);
    expect(new Date(fireAt as string).getTime()).toBeGreaterThan(Date.now());
    await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]!.comments).toHaveLength(0));
  });

  it("a schedule without a chip keeps its old call shape", async () => {
    seed([]);
    const { onScheduleSend } = setup();
    fireEvent.click(await screen.findByLabelText("Schedule send"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Schedule send" })).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(onScheduleSend).toHaveBeenCalled());
    expect(onScheduleSend.mock.calls[0]).toHaveLength(3);
  });
});

describe("attach lease refresh (Decision 10)", () => {
  afterEach(() => vi.restoreAllMocks()); // a failed assertion must not leave Date.now mocked

  it("touches the lease with refreshOnly at most every 5 minutes while the user works in the composer", async () => {
    seed(four("session:s1"));
    const { api } = setup();
    const touch = vi.spyOn(api, "attachComments").mockResolvedValue({ attached: ["c1", "c2", "c3", "c4"] });
    await screen.findByTestId("review-chip");
    const root = document.querySelector(".chat-composer")!;
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    fireEvent.keyDown(root, { key: "a" });
    expect(touch).not.toHaveBeenCalled(); // inside the 5-minute window
    now += 5 * 60 * 1000 + 1;
    fireEvent.keyDown(root, { key: "b" });
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith("wt-1", "worktree", { composerKey: "session:s1", refreshOnly: true });
    now += 60 * 1000;
    fireEvent.focusIn(root);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a chip", async () => {
    seed(four());
    const { api } = setup();
    const touch = vi.spyOn(api, "attachComments");
    await screen.findByRole("button", { name: "Attach 4 comments" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    fireEvent.keyDown(document.querySelector(".chat-composer")!, { key: "a" });
    expect(touch).not.toHaveBeenCalled();
  });
});

