import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { MessageList, groupEvents } from "./MessageList";

function userEvent(turnId: string, text: string, edited = false): NormalizedEvent {
  return {
    id: `${turnId}-${edited ? "edit" : "orig"}`,
    sessionId: "s1",
    ts: new Date().toISOString(),
    provider: "claude",
    kind: "user",
    role: "user",
    text,
    turnId,
    ...(edited ? { edited: true } : {}),
  };
}

describe("groupEvents dedupe (2.T1 / A7)", () => {
  it("keeps ONE bubble per turnId at the first position with the latest text", () => {
    const items = groupEvents([
      userEvent("t1", "original"),
      {
        id: "asst",
        sessionId: "s1",
        ts: "",
        provider: "claude",
        kind: "text",
        text: "…",
        turnId: "t1",
      },
      userEvent("t1", "edited text", true),
    ]);
    const users = items.filter((i) => i.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ type: "user", text: "edited text", turnId: "t1" });
    // First position preserved: the user bubble is item 0, assistant after it.
    expect(items[0]!.type).toBe("user");
  });
});

function statusEvent(id: string, text: string): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "status", text };
}

function textEvent(id: string, turnId: string, text: string): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "text", role: "assistant", text, turnId };
}

describe("groupEvents assistant turn boundaries", () => {
  it("merges streaming deltas within a turn but splits consecutive turns", () => {
    const items = groupEvents([
      textEvent("a1", "t1", "Hello "),
      textEvent("a2", "t1", "world"),
      textEvent("b1", "t2", "Second reply"),
      textEvent("c1", "t3", "Third reply"),
    ]);
    const assistants = items.filter((i) => i.type === "assistant") as { text: string }[];
    expect(assistants.map((a) => a.text)).toEqual(["Hello world", "Second reply", "Third reply"]);
  });
});

describe("groupEvents status filtering (RA6 — benign rate-limit noise)", () => {
  it("drops benign 'rate limit: unknown'/'allowed' but keeps real throttles + other notes", () => {
    const items = groupEvents([
      statusEvent("s1", "rate limit: unknown"),
      statusEvent("s2", "rate limit: allowed"),
      statusEvent("s3", "rate limit: rejected"),
      statusEvent("s4", "Turn stopped"),
    ]);
    const texts = items.filter((i) => i.type === "status").map((i) => (i as { text: string }).text);
    expect(texts).toEqual(["rate limit: rejected", "Turn stopped"]);
  });
});

describe("MessageList queued-turn filtering (tray relocation)", () => {
  it("hides user turns listed in hiddenTurnIds from the inline log", () => {
    render(
      <MessageList
        events={[userEvent("t1", "shown msg"), userEvent("t2", "queued msg")]}
        pending={[]}
        hiddenTurnIds={new Set(["t2"])}
      />,
    );
    expect(screen.getByText("shown msg")).toBeTruthy();
    expect(screen.queryByText("queued msg")).toBeNull();
  });

  it("carries no inline queue affordances (they live in the tray now)", () => {
    render(<MessageList events={[userEvent("t1", "queued msg")]} pending={[]} hiddenTurnIds={new Set(["t1"])} />);
    expect(screen.queryByLabelText("Send now")).toBeNull();
    expect(screen.queryByLabelText("Edit queued message")).toBeNull();
    expect(screen.queryByLabelText("Cancel queued turn")).toBeNull();
  });

  it("un-hides a turn once it leaves hiddenTurnIds (dequeued → shown in log)", () => {
    const { rerender } = render(
      <MessageList events={[userEvent("t1", "now running")]} pending={[]} hiddenTurnIds={new Set(["t1"])} />,
    );
    expect(screen.queryByText("now running")).toBeNull();
    rerender(<MessageList events={[userEvent("t1", "now running")]} pending={[]} hiddenTurnIds={new Set()} />);
    expect(screen.getByText("now running")).toBeTruthy();
  });
});

describe("MessageList thinking hint (Change 3)", () => {
  it("renders the hint after the last user message while thinking", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} thinking />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("does not render the hint when not thinking", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} />);
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("renders the hint after an optimistic pending bubble", () => {
    render(
      <MessageList
        events={[]}
        pending={[{ turnId: "p1", message: "just sent", attachments: [], queued: false }]}
        thinking
      />,
    );
    expect(screen.getByText("just sent")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });
});
