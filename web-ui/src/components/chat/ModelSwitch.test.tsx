import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ModelSwitch } from "./ModelSwitch";

describe("ModelSwitch", () => {
  it("shows the current model on the button", () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" />);
    expect(screen.getByRole("button", { name: /Change model/i }).textContent).toContain("sonnet");
  });

  it("opens the popover and lists the CLI's models + a mode-default entry", async () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    expect(await screen.findByRole("option", { name: "(mode default)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "opus" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "haiku" })).toBeTruthy();
  });

  it("calls setSessionModel with the picked model and optimistically shows it", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionModel");
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await userEvent.click(await screen.findByRole("option", { name: "opus" }));
    expect(spy).toHaveBeenCalledWith("s1", "opus");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Change model/i }).textContent).toContain("opus"),
    );
  });

  it("clears the override via the mode-default entry (setSessionModel null)", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionModel");
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="opus" />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await userEvent.click(await screen.findByRole("option", { name: "(mode default)" }));
    expect(spy).toHaveBeenCalledWith("s1", null);
  });

  it("navigates options with Arrow keys", async () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    const listbox = await screen.findByRole("listbox");
    const options = await screen.findAllByRole("option");
    options[0]!.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
  });
});
