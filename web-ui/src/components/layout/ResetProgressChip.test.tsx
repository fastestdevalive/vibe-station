import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useResetProgress } from "@/hooks/useResetProgress";
import { ResetProgressChip } from "./ResetProgressChip";

afterEach(() => useResetProgress.setState({ active: {} }));

describe("ResetProgressChip", () => {
  it("renders nothing while the overlay is shown or no reset is running", () => {
    const { container, rerender } = render(<ResetProgressChip sessionId="s1" />);
    expect(container.firstChild).toBeNull();
    useResetProgress.getState().start("s1");
    rerender(<ResetProgressChip sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows only for the dismissed session and click reopens the overlay", async () => {
    useResetProgress.setState({ active: { s1: "dismissed" } });
    const { container } = render(<ResetProgressChip sessionId="other" />);
    expect(container.firstChild).toBeNull();
    render(<ResetProgressChip sessionId="s1" />);
    await userEvent.click(screen.getByRole("status"));
    expect(useResetProgress.getState().active.s1).toBe("shown");
  });
});
