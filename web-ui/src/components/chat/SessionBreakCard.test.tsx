import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionBreakCard } from "./SessionBreakCard";

describe("SessionBreakCard", () => {
  it("renders a 'Fresh start' card for a carryOver reset, with no pills", () => {
    render(<SessionBreakCard kind="reset" carryOver="summary" ts="2026-01-02T14:02:00Z" />);
    expect(screen.getByText("Fresh start")).toBeInTheDocument();
    expect(screen.queryByText(/Switched/)).toBeNull();
    expect(document.querySelectorAll(".chat-session-break__pill")).toHaveLength(0);
    expect(document.querySelector(".chat-session-break__time")).toHaveTextContent(/:/);
  });

  it("titles a switch with toMode and shows both mode pills", () => {
    render(
      <SessionBreakCard
        kind="switch"
        carryOver="summary"
        fromMode="opus-planner"
        toMode="sonnet-implementer"
        fromProvider="claude"
        toProvider="claude"
      />,
    );
    expect(screen.getByText("Switched to sonnet-implementer")).toBeInTheDocument();
    const pills = document.querySelectorAll(".chat-session-break__pill");
    expect(pills).toHaveLength(2);
    expect(pills[0]!.textContent).toContain("opus-planner");
    expect(pills[1]!.textContent).toContain("sonnet-implementer");
    expect(screen.getByText("Summary carried over. The new agent can't see the messages above this line.")).toBeInTheDocument();
  });

  it("labels a transcript carry and expands the instruction behind 'Show instruction'", () => {
    render(<SessionBreakCard kind="reset" carryOver="transcript" text="Read previous-chat.md. Reply with a recap." />);
    expect(screen.getByText("Transcript linked. The new agent can read the earlier chat from a file.")).toBeInTheDocument();
    const toggle = screen.getByText("Show instruction");
    expect(screen.queryByText(/Read previous-chat\.md/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/Read previous-chat\.md/)).toBeInTheDocument();
    expect(screen.getByText("Hide instruction")).toBeInTheDocument();
  });

  it("shows 'Show summary' for a summary carry", () => {
    render(<SessionBreakCard kind="reset" carryOver="summary" text="the summary" />);
    expect(screen.getByText("Show summary")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show summary"));
    expect(screen.getByText("the summary")).toBeInTheDocument();
    expect(screen.getByText("Hide summary")).toBeInTheDocument();
  });

  it("offers 'Previous sessions' when the pane wires onOpenPrevious", () => {
    const onOpenPrevious = vi.fn();
    render(<SessionBreakCard kind="reset" carryOver="summary" onOpenPrevious={onOpenPrevious} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    expect(onOpenPrevious).toHaveBeenCalledTimes(1);
  });

  it("uses the shared fixed width class on both card kinds", () => {
    const { rerender } = render(<SessionBreakCard kind="reset" carryOver="summary" />);
    expect(document.querySelector(".chat-session-break__card")).not.toBeNull();
    rerender(<SessionBreakCard kind="switch" carryOver="transcript" fromMode="a" toMode="b" />);
    const card = document.querySelector(".chat-session-break__card");
    expect(card?.className).toContain("chat-session-break__card--switch");
  });

  // ── Legacy rows (written before `carryOver` existed) render as before ──
  it("renders a legacy reset row with the old wording and no toggle without a summary", () => {
    render(<SessionBreakCard kind="reset" ts="2026-01-02T14:02:00Z" />);
    expect(screen.getByText("Agent restarted")).toBeInTheDocument();
    expect(screen.queryByText(/Show summary/)).not.toBeInTheDocument();
  });

  it("renders a legacy switch row with provider chips", () => {
    render(<SessionBreakCard kind="switch" fromProvider="claude" toProvider="opencode" />);
    expect(screen.getByText("Switched provider")).toBeInTheDocument();
    const chips = document.querySelectorAll(".chat-session-break__chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain("claude");
    expect(chips[1]!.textContent).toContain("opencode");
  });

  it("shows the legacy summary toggle only when a summary is present", () => {
    const { rerender } = render(<SessionBreakCard kind="reset" />);
    expect(screen.queryByText("Show summary")).not.toBeInTheDocument();
    rerender(<SessionBreakCard kind="reset" text="the summary" />);
    fireEvent.click(screen.getByText("Show summary"));
    expect(screen.getByText("the summary")).toBeInTheDocument();
    expect(screen.getByText("Hide summary")).toBeInTheDocument();
  });

  it("only claims a summary was passed when the row carries one", () => {
    const { rerender } = render(<SessionBreakCard kind="reset" />);
    expect(screen.queryByText(/received a summary\./)).not.toBeInTheDocument();
    expect(screen.getByText("Earlier messages are above.")).toBeInTheDocument();
    rerender(<SessionBreakCard kind="reset" text="the summary" />);
    expect(screen.getByText(/The new agent was given a summary\./)).toBeInTheDocument();
  });

  it("ignores a blank/whitespace-only summary (no toggle)", () => {
    render(<SessionBreakCard kind="switch" fromProvider="claude" toProvider="opencode" text="   " />);
    expect(screen.queryByText("Show summary")).not.toBeInTheDocument();
  });
});
