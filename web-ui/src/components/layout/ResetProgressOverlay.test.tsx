import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useResetProgress } from "@/hooks/useResetProgress";
import { ResetProgressOverlay } from "./ResetProgressOverlay";

afterEach(() => useResetProgress.setState({ active: {} }));

describe("ResetProgressOverlay", () => {
  it("makes the sibling pane content inert while shown (no typing into the agent) and restores it after", () => {
    function Pane() {
      const active = useResetProgress((s) => s.active.s1);
      return (
        <div>
          <div data-testid="pane-content" />
          <ResetProgressOverlay sessionId="s1" />
          <span data-active={active ?? ""} />
        </div>
      );
    }
    render(<Pane />);
    expect(screen.getByTestId("pane-content").hasAttribute("inert")).toBe(false);
    act(() => useResetProgress.getState().start("s1"));
    expect(screen.getByTestId("pane-content").hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    act(() => useResetProgress.getState().dismiss("s1"));
    expect(screen.getByTestId("pane-content").hasAttribute("inert")).toBe(false);
  });

  it("renders nothing unless THIS session is resetting", () => {
    useResetProgress.getState().start("other");
    const { container } = render(<ResetProgressOverlay sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows for the resetting session and Close dismisses it without finishing the reset", async () => {
    useResetProgress.getState().start("s1");
    render(<ResetProgressOverlay sessionId="s1" />);
    expect(screen.getByText("Resetting with handoff…")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Resetting with handoff…")).toBeNull();
    // still tracked as in flight — the reset itself carries on in the background
    expect(useResetProgress.getState().active.s1).toBe("dismissed");
  });
});
