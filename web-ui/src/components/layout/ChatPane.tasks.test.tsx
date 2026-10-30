import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Session } from "@/api/types";
import { mkTask } from "@/components/tasks/taskFixtures";
import { useTaskStore } from "@/hooks/useTaskStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ChatPane } from "./ChatPane";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const touch = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsTouch", () => ({ useIsTouch: () => touch.value }));

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    isMain: true,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "",
    channel: "json",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const seed = (sid: string, rev = Date.now()) =>
  act(() => useTaskStore.getState().applySnapshot(sid, rev, [mkTask({ id: "t1" }), mkTask({ id: "t2", label: "npm run dev" })]));

beforeEach(() => {
  touch.value = false;
  localStorage.clear();
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useWorkspaceStore.setState({ sessionStates: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChatPane task view (2.T5)", () => {
  it("opening/closing keeps the SAME body and composer nodes and the draft text; chat is inert only while open", async () => {
    const api = createMockApi();
    // jsdom cannot type into the Lexical editor; mount with a stored draft (the real restore path).
    localStorage.setItem("vst-chat-draft-c1", "my draft");
    const { container } = render(<ChatPane api={api} session={session("c1")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    const body = container.querySelector(".chat-pane__body");
    const composer = screen.getByRole("textbox", { name: /message/i });
    seed("c1");

    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    expect(screen.getByTestId("task-view")).toBeTruthy();
    expect(container.querySelector(".chat-pane__viewport")!.hasAttribute("inert")).toBe(true);
    expect(container.querySelector(".chat-pane__footer")!.hasAttribute("inert")).toBe(true);
    expect(container.querySelector(".chat-pane__body")).toBe(body);
    expect(screen.getByRole("textbox", { name: /message/i, hidden: true })).toBe(composer);

    fireEvent.click(screen.getByTestId("task-back"));
    expect(screen.queryByTestId("task-view")).toBeNull();
    expect(container.querySelector(".chat-pane__viewport")!.hasAttribute("inert")).toBe(false);
    expect(container.querySelector(".chat-pane__footer")!.hasAttribute("inert")).toBe(false);
    expect(container.querySelector(".chat-pane__body")).toBe(body);
    expect(screen.getByRole("textbox", { name: /message/i })).toBe(composer);
    expect(composer.textContent).toContain("my draft");
  });

  it("a reset + same-snapshot replay (WS reconnect) keeps the SAME task-view node", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c1")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    seed("c1", 5);
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    const view = screen.getByTestId("task-view");
    act(() => useTaskStore.getState().reset());
    expect(screen.getByTestId("task-view")).toBe(view);
    seed("c1", 5);
    expect(screen.getByTestId("task-view")).toBe(view);
  });

  it("hides the chat font overlay under the task view via CSS (R1F-01)", () => {
    const css = readFileSync(join(__dirname, "../../styles/tasks.css"), "utf8");
    expect(css).toMatch(/\.chat-pane__footer\[inert\] \.chat-font-overlay\s*\{\s*visibility:\s*hidden;/);
  });

  it("after close, focus returns to the originating row", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c2")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    seed("c2");
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    const row = screen.getAllByTestId("task-row")[1]!;
    fireEvent.click(row);
    expect(document.activeElement).toBe(screen.getByTestId("task-view"));
    fireEvent.keyDown(screen.getByTestId("task-view"), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getAllByTestId("task-row")[1]);
  });

  it("falls back to the chip when the row is gone (collapsed tray)", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c3")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    seed("c3");
    localStorage.setItem("vst.taskView.c3", "t1");
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    fireEvent.click(screen.getByTestId("task-tray-close")); // collapse the bar (footer inert: no focus, state flips)
    fireEvent.keyDown(screen.getByTestId("task-view"), { key: "Escape" });
    const chip = screen.getByTestId("task-tray-chip");
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(document.activeElement).toBe(chip);
  });

  it("finished-only tasks: focus returns to the strip chip when the row is gone", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c7")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    act(() => useTaskStore.getState().applySnapshot("c7", Date.now(), [mkTask({ id: "d1", state: "done" }), mkTask({ id: "d2", state: "done" })]));
    expect(screen.getByTestId("task-tray").getAttribute("data-mode")).toBe("dot");
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    expect(screen.getByTestId("task-view")).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-tray-close")); // bar -> strip
    fireEvent.keyDown(screen.getByTestId("task-view"), { key: "Escape" });
    const chip = screen.getByTestId("task-tray-chip");
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(document.activeElement).toBe(chip);
  });

  it("opening a task from the bar keeps the bar; collapsing it later returns strip -> dot after 5 s", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c8")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    act(() => useTaskStore.getState().applySnapshot("c8", Date.now(), [mkTask({ id: "d1", state: "done" })]));
    fireEvent.click(screen.getByTestId("task-tray-dot"));
    expect(screen.getByTestId("task-tray").getAttribute("data-mode")).toBe("strip");
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, sel: string) {
      return sel === ":focus-visible" ? false : matches.call(this, sel);
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByTestId("task-tray").getAttribute("data-mode")).toBe("bar");
    fireEvent.click(screen.getByTestId("task-back"));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByTestId("task-tray").getAttribute("data-mode")).toBe("bar");
    fireEvent.click(screen.getByTestId("task-tray-close"));
    act(() => void vi.advanceTimersByTime(4999));
    expect(screen.getByTestId("task-tray").getAttribute("data-mode")).toBe("strip");
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByTestId("task-tray").getAttribute("data-mode")).toBe("dot");
  });

  it("does not steal focus on touch / focusOnMount=false", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c4")} visible focusOnMount={false} />);
    await screen.findByRole("textbox", { name: /message/i });
    seed("c4");
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    expect(document.activeElement).not.toBe(screen.getByTestId("task-view"));
    fireEvent.click(screen.getByTestId("task-back"));
    expect(document.activeElement).not.toBe(screen.getAllByTestId("task-row")[0]);
  });

  it("a task that vanishes closes the view and shows the 'no longer tracked' notice", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c5")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    seed("c5", 100);
    fireEvent.click(screen.getByTestId("task-tray-chip"));
    fireEvent.click(screen.getAllByTestId("task-row")[0]!);
    act(() => useTaskStore.getState().applySnapshot("c5", 101, [mkTask({ id: "t2" })]));
    expect(screen.queryByTestId("task-view")).toBeNull();
    expect(screen.getByText("That task is no longer tracked")).toBeTruthy();
  });

  it("receives snapshots through the api event (ensureTaskSubscription before openChat)", async () => {
    const api = createMockApi();
    render(<ChatPane api={api} session={session("c6")} visible />);
    await screen.findByRole("textbox", { name: /message/i });
    expect(screen.queryByTestId("task-tray")).toBeNull();
    act(() => api.__test.emit({ type: "session:tasks", sessionId: "c6", rev: Date.now() + 5, tasks: [mkTask({ id: "z" })] }));
    expect(screen.getByTestId("task-tray")).toBeTruthy();
  });
});
