import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { DiffLayoutSwitch } from "./DiffLayoutSwitch";

describe("DiffLayoutSwitch (in the file strip)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ diffLayoutMode: "inline" });
  });

  it("reflects and sets the one store value DiffView renders from", () => {
    render(<DiffLayoutSwitch />);
    expect(screen.getByRole("button", { name: "Inline" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Side-by-side" }));
    expect(useWorkspaceStore.getState().diffLayoutMode).toBe("side-by-side");
    expect(screen.getByRole("button", { name: "Side-by-side" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Inline" }));
    expect(useWorkspaceStore.getState().diffLayoutMode).toBe("inline");
  });

  it("Side-by-side is never disabled and has no title — no minimum pane-width gate (the toggle stays usable at normal pane sizes)", () => {
    render(<DiffLayoutSwitch />);
    const btn = screen.getByRole("button", { name: "Side-by-side" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.title).toBeFalsy();
  });
});
