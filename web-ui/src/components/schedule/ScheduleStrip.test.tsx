import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { ScheduleStrip, type ScheduleStripVariant } from "./ScheduleStrip";
import type { ScheduleRowData } from "./useScheduledSends";

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function makeApi() {
  const ok = () => Promise.resolve({ ok: true as const });
  const api = {
    sendScheduledNow: vi.fn(ok),
    cancelScheduledMessage: vi.fn(ok),
    retryScheduledMessage: vi.fn(ok),
    dismissScheduledMessage: vi.fn(ok),
  };
  return { api, asApi: api as unknown as ApiInstance };
}

function renderStrip(
  rows: ScheduleRowData[],
  over: Partial<{ sessionLive: boolean; variant: ScheduleStripVariant; agentName: string }> = {},
) {
  const t = makeApi();
  const onEdit = vi.fn();
  const onError = vi.fn();
  const onHideSent = vi.fn();
  const utils = render(
    <ScheduleStrip
      rows={rows}
      api={t.asApi}
      sessionId="s1"
      sessionLive={over.sessionLive ?? true}
      variant={over.variant ?? "chat"}
      {...(over.agentName ? { agentName: over.agentName } : {})}
      onEdit={onEdit}
      onHideSent={onHideSent}
      onError={onError}
    />,
  );
  return { ...t, onEdit, onError, onHideSent, ...utils };
}

const pending = (over: object = {}): ScheduleRowData => ({
  kind: "pending",
  id: "p1",
  message: "Review the auth changes",
  fireAt: inHours(3),
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ScheduleStrip rows", () => {
  it("renders failed first, then pending in fire-time order, then sent (R1F-03)", () => {
    const sentAt = new Date(2030, 0, 1, 15, 0).toISOString();
    const rows: ScheduleRowData[] = [
      { kind: "failed", id: "f1", message: "Failed one", fireAt: inHours(-1), failureReason: "boom", failureKind: "timed_out" },
      pending({ id: "p1", message: "Pending one", fireAt: inHours(1) }),
      pending({ id: "p2", message: "Pending two", fireAt: inHours(2) }),
      pending({ id: "p3", message: "Pending three", fireAt: inHours(3) }),
      { kind: "sent", id: "s1", message: "Sent one", fireAt: sentAt, sentAt },
    ];
    renderStrip(rows);
    const labels = screen.getAllByRole("listitem").map((r) => r.getAttribute("aria-label") ?? "");
    expect(labels).toHaveLength(5);
    expect(labels[0]).toContain("Failed one");
    expect(labels.slice(1, 4).map((l) => l.replace(/^.*: /, ""))).toEqual(["Pending one", "Pending two", "Pending three"]);
    expect(labels[4]).toContain("Sent one");
  });

  it("renders nothing for zero rows", () => {
    const { container } = renderStrip([]);
    expect(container.firstChild).toBeNull();
  });

  it("is a labelled list with the variant class, and the list itself is not a live region (L4-03)", () => {
    renderStrip([pending()], { variant: "overlay" });
    const list = screen.getByRole("list", { name: "Scheduled messages" });
    expect(list.hasAttribute("aria-live")).toBe(false);
    expect(list.className).toContain("sched-strip--overlay");
  });

  it("the countdown never sits in a live region; the status node only changes text on a phase change (L4-03)", () => {
    vi.useFakeTimers();
    const fireAt = new Date(Date.now() + 90_000).toISOString();
    const t = renderStrip([pending({ fireAt })]);
    const live = () => [...t.container.querySelectorAll('[aria-live], [role="status"]')];
    const before = live().map((e) => e.textContent);
    expect(live().some((e) => e.contains(screen.getByText(/^in 1m/)))).toBe(false);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(live().map((e) => e.textContent)).toEqual(before);
    // A pending row failing is announced.
    t.rerender(
      <ScheduleStrip
        rows={[{ kind: "failed", id: "p1", message: "x", fireAt, failureReason: "boom", failureKind: "error" }]}
        api={t.asApi}
        sessionId="s1"
        sessionLive
        variant="chat"
        onEdit={t.onEdit}
        onHideSent={t.onHideSent}
        onError={t.onError}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("A scheduled message failed");
  });

  it("renders a pending row with time copy, pending suffix and its three actions", () => {
    renderStrip([pending()]);
    const row = screen.getByRole("listitem", { name: "Scheduled message: Review the auth changes" });
    expect(within(row).getByText(/(Today|Tomorrow) .*· pending$/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Reschedule message" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Cancel scheduled message" })).toBeTruthy();
    expect(row.className).toContain("sched-strip__row--scheduled");
  });

  it("renders a waiting row with Cancel only", () => {
    renderStrip([pending({ phase: "waiting", fireAt: new Date(2030, 0, 1, 15, 0).toISOString() })]);
    expect(screen.getByText("Waiting for agent · due 3:00 PM")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reschedule message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel scheduled message" })).toBeTruthy();
    expect(screen.getByRole("listitem").className).toContain("sched-strip__row--waiting");
  });

  it("renders a pasting row with no actions", () => {
    renderStrip([pending({ phase: "pasting" })]);
    expect(screen.getByText("Pasting…")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders a sent row with the pasted time, agent name and a Hide action", () => {
    const sentAt = new Date(2030, 0, 1, 15, 0).toISOString();
    const { onHideSent } = renderStrip(
      [{ kind: "sent", id: "x", message: "/review src/auth", fireAt: sentAt, sentAt }],
      { agentName: "Agent 1" },
    );
    expect(screen.getByText("pasted at 3:00 PM · Agent 1")).toBeTruthy();
    const row = screen.getByRole("listitem");
    expect(row.className).toContain("sched-strip__row--sent");
    fireEvent.click(screen.getByRole("button", { name: "Hide sent message" }));
    expect(onHideSent).toHaveBeenCalledWith("x");
  });

  it("shows the reason for a timed-out failure with the warn class only for timed_out", () => {
    renderStrip([
      { kind: "failed", id: "a", message: "Run the linter", fireAt: inHours(-1), failureReason: "Not ready within 10 min", failureKind: "timed_out" },
      { kind: "failed", id: "b", message: "Summarise", fireAt: inHours(-1), failureReason: "Agent exited, not delivered", failureKind: "agent_exited" },
      { kind: "failed", id: "c", message: "Legacy", fireAt: inHours(-1), failureReason: "boom" },
    ]);
    const [a, b, c] = screen.getAllByRole("listitem");
    expect(a!.getAttribute("aria-label")).toBe("Failed scheduled message: Run the linter — Not ready within 10 min");
    expect(within(a!).getByText("Not ready within 10 min").className).toContain("sched-strip__reason--warn");
    expect(a!.className).toContain("sched-strip__row--warn");
    expect(b!.className).toContain("sched-strip__row--fail");
    expect(b!.className).not.toContain("--warn");
    expect(within(b!).getByText("Agent exited, not delivered").className).toContain("sched-strip__reason--fail");
    expect(c!.className).toContain("sched-strip__row--fail");
  });

  it("shows a comments chip only when commentCount is present, singular for one", () => {
    renderStrip([
      pending({ id: "a", commentCount: 3 }),
      pending({ id: "b", commentCount: 1, message: "one" }),
      pending({ id: "c", message: "none" }),
    ]);
    expect(screen.getByText("3 comments").className).toContain("chip--sm");
    expect(screen.getByText("1 comment")).toBeTruthy();
    expect(screen.getAllByText(/comments?$/)).toHaveLength(2);
  });

  it("a comments-only pending row shows the chip, not (attachments only) (R1F-07)", () => {
    renderStrip([pending({ message: "", commentCount: 3 })]);
    expect(screen.queryByText("(attachments only)")).toBeNull();
    expect(screen.getByText("3 comments")).toBeTruthy();
    expect(screen.getByRole("listitem").getAttribute("aria-label")).toBe("Scheduled message: 3 review comments");
  });

  it("a comments-only row orders icon, chip, then text (R1F-17)", () => {
    renderStrip([pending({ message: "", commentCount: 3 })]);
    const kids = Array.from(screen.getByRole("listitem").children);
    const chip = kids.findIndex((k) => k.textContent === "3 comments");
    const text = kids.findIndex((k) => k.classList.contains("sched-strip__text"));
    expect(chip).toBe(1);
    expect(text).toBe(2);
  });

  it("a failed row with comments says comments restored and shows the chip (R1F-08)", () => {
    renderStrip([
      { kind: "failed", id: "a", message: "Summarise", fireAt: inHours(-1), failureReason: "Agent exited, not delivered", failureKind: "agent_exited", commentCount: 2 },
      { kind: "failed", id: "b", message: "Plain", fireAt: inHours(-1), failureReason: "boom", failureKind: "error" },
    ]);
    const [a, b] = screen.getAllByRole("listitem");
    expect(within(a!).getByText("Agent exited, not delivered · comments restored")).toBeTruthy();
    expect(within(a!).getByText("2 comments")).toBeTruthy();
    expect(within(b!).getByText("boom")).toBeTruthy();
    expect(within(b!).queryByText(/comments/)).toBeNull();
  });

  it("an empty sent row reads (no message), never (attachments only) (R1V-08)", () => {
    const sentAt = new Date(2030, 0, 1, 15, 0).toISOString();
    renderStrip([{ kind: "sent", id: "x", message: "", fireAt: sentAt, sentAt }]);
    expect(screen.getByText("(no message)")).toBeTruthy();
    expect(screen.queryByText("(attachments only)")).toBeNull();
  });

  it("falls back to (attachments only) and shows an attachment indicator", () => {
    renderStrip([
      pending({
        message: "",
        attachments: [{ id: "a1", name: "a.png", mimeType: "image/png", size: 1 }],
      }),
    ]);
    expect(screen.getByText("(attachments only)")).toBeTruthy();
    expect(screen.getByLabelText("1 attachment")).toBeTruthy();
  });

  it("shows Terminal rows as plain text and Rich Chat rows through the chip renderer", () => {
    renderStrip([
      pending({ id: "t", channel: "tmux", message: "run {/review src} brace" }),
      pending({ id: "j", channel: "json", message: "run {/review src} brace" }),
    ]);
    const texts = screen.getAllByText(/brace/).map((e) => e.textContent);
    expect(texts[0]).toBe("run {/review src} brace");
    expect(texts[1]).toBe("run /review src brace");
  });

  it("keeps the per-second countdown live under 10 minutes", () => {
    vi.useFakeTimers();
    renderStrip([pending({ fireAt: new Date(Date.now() + 90_000).toISOString() })]);
    expect(screen.getByText(/^in 1m (29|30)s · pending$/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/^in 1m (24|25)s · pending$/)).toBeTruthy();
  });
});

describe("ScheduleStrip actions", () => {
  it("pending: Send now / Cancel call the API, Edit calls onEdit with the row and anchor", () => {
    const t = renderStrip([pending()]);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(t.api.sendScheduledNow).toHaveBeenCalledWith("s1", "p1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled message" }));
    expect(t.api.cancelScheduledMessage).toHaveBeenCalledWith("s1", "p1");
    const edit = screen.getByRole("button", { name: "Reschedule message" });
    fireEvent.click(edit);
    expect(t.onEdit).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "p1" }), edit);
  });

  it("waiting: Cancel calls the API", () => {
    const t = renderStrip([pending({ phase: "waiting" })]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled message" }));
    expect(t.api.cancelScheduledMessage).toHaveBeenCalledWith("s1", "p1");
  });

  it("not live: Send now is disabled with a title, Edit and Cancel stay enabled", () => {
    renderStrip([pending()], { sessionLive: false, variant: "inline" });
    const send = screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Agent isn't running");
    expect((screen.getByRole("button", { name: "Reschedule message" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Cancel scheduled message" }) as HTMLButtonElement).disabled).toBe(false);
  });

  const failed = (): ScheduleRowData => ({
    kind: "failed",
    id: "f1",
    message: "Run the linter",
    fireAt: inHours(-1),
    failureReason: "Not ready within 10 min",
    failureKind: "timed_out",
  });

  it("failed: Retry, Copy as text and Dismiss", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const t = renderStrip([failed()]);
    fireEvent.click(screen.getByRole("button", { name: "Retry scheduled send" }));
    expect(t.api.retryScheduledMessage).toHaveBeenCalledWith("s1", "f1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    });
    expect(writeText).toHaveBeenCalledWith("Run the linter");
    expect(t.onError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss failed scheduled send" }));
    expect(t.api.dismissScheduledMessage).toHaveBeenCalledWith("s1", "f1");
  });

  it("failed: Retry is disabled with a title while the agent is not live", () => {
    renderStrip([failed()], { sessionLive: false });
    const retry = screen.getByRole("button", { name: "Retry scheduled send" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe("Agent isn't running");
    // Copy as text and Dismiss still work.
    expect((screen.getByRole("button", { name: "Copy as text" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a clipboard failure and an API rejection through onError", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) } });
    const t = renderStrip([failed(), pending()]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    });
    expect(t.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Couldn't copy the message." }));

    const boom = new Error("nope");
    t.api.cancelScheduledMessage.mockRejectedValueOnce(boom);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled message" }));
    });
    expect(t.onError).toHaveBeenCalledWith(boom);
  });
});
