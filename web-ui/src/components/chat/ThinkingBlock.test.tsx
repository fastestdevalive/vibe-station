import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock label (1.T4 — Decision 4 'Thought for Xs')", () => {
  it("renders 'Thinking' (no trailing ellipsis) while endedTs is unset", () => {
    render(<ThinkingBlock text="" startedTs="2024-01-01T00:00:00.000Z" />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  it("falls back to 'Thinking' rather than 'Thought for NaNs' on a malformed timestamp", () => {
    render(<ThinkingBlock text="" startedTs="" endedTs="2024-01-01T00:00:06.400Z" />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  it("renders 'Thought for 6s' when startedTs/endedTs are 6400ms apart (rounds to nearest second)", () => {
    render(
      <ThinkingBlock
        text=""
        startedTs="2024-01-01T00:00:00.000Z"
        endedTs="2024-01-01T00:00:06.400Z"
      />,
    );
    expect(screen.getByText("Thought for 6s")).toBeTruthy();
  });

  it("renders 'Thought for 0s' (not suppressed) when the span is under 500ms", () => {
    render(
      <ThinkingBlock
        text=""
        startedTs="2024-01-01T00:00:00.000Z"
        endedTs="2024-01-01T00:00:00.300Z"
      />,
    );
    expect(screen.getByText("Thought for 0s")).toBeTruthy();
  });

  it("expands to the reasoning body and shows the duration EXACTLY ONCE (no duplicate footer row)", async () => {
    render(
      <ThinkingBlock
        text="some reasoning"
        startedTs="2024-01-01T00:00:00.000Z"
        endedTs="2024-01-01T00:00:03.000Z"
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /thought for 3s/i }));
    expect(screen.getByText("some reasoning")).toBeTruthy();
    // Once expanded the label must still appear a single time — the toggle
    // row carries it; there is no second footer copy of the same string.
    expect(screen.getAllByText("Thought for 3s")).toHaveLength(1);
    expect(document.querySelector(".chat-thinking__summary")).toBeNull();
  });

  it("renders 'Worked for Xs' instead of 'Thought for Xs' when hadToolCall is set", () => {
    render(
      <ThinkingBlock
        text=""
        startedTs="2024-01-01T00:00:00.000Z"
        endedTs="2024-01-01T00:00:06.400Z"
        hadToolCall
      />,
    );
    expect(screen.getByText("Worked for 6s")).toBeTruthy();
    expect(screen.queryByText("Thought for 6s")).toBeNull();
  });

  it("keeps the LIVE label as 'Thinking' even when hadToolCall is set (no 'Working' variant)", () => {
    render(<ThinkingBlock text="" startedTs="2024-01-01T00:00:00.000Z" hadToolCall />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });
});
