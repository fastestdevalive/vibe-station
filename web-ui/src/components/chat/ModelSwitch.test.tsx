import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ModelSwitch, type ModelAction } from "./ModelSwitch";

const actions: ModelAction[] = [
  { key: "fresh", label: "Start fresh…", onSelect: vi.fn() },
  { key: "switch", label: "Switch provider & mode…", onSelect: vi.fn() },
  { key: "previous", label: "Previous sessions", hint: "2", dividerBefore: true, onSelect: vi.fn() },
];

describe("ModelSwitch", () => {
  it("shows the current model on the button", () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" />);
    expect(screen.getByRole("button", { name: /Change model/i }).textContent).toContain("sonnet");
  });

  it("opens a menu with the mode title, the note row and the CLI's models", async () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" title="Claude Code" />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await waitFor(() => expect(screen.getByRole("menu", { name: "Agent menu" })).toBeInTheDocument());
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Model · applies to the next turn")).toBeTruthy();
    expect(await screen.findByRole("menuitemradio", { name: /\(mode default\)/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: / opus$/ })).toBeTruthy();
  });

  it("renders the 3 action rows after the model divider, with the Previous sessions count", async () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Start fresh…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Switch provider & mode…/ })).toBeTruthy();
    const prev = screen.getByRole("menuitem", { name: /Previous sessions/ });
    expect(prev.textContent).toContain("2");
    // Two dividers: one under the models, one before Previous sessions.
    expect(document.querySelectorAll(".chat-model-switch__divider")).toHaveLength(2);
  });

  it("hides Previous sessions when the chain has no predecessors", async () => {
    const api = createMockApi();
    const noPrev = actions.filter((a) => a.key !== "previous");
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" actions={noPrev} />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /Previous sessions/ })).toBeNull();
    expect(document.querySelectorAll(".chat-model-switch__divider")).toHaveLength(1);
  });

  it("shows actions only for cursor (hideModels — no model list)", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "listCliModels");
    render(<ModelSwitch api={api} sessionId="s1" cli="cursor" model="auto" hideModels actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Start fresh…" })).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("moves focus into the menu on open so the arrow keys work straight away", async () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    const first = await screen.findByRole("menuitemradio", { name: /\(mode default\)/ });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("ArrowDown reaches the action rows (roving over models AND actions)", async () => {
    const api = createMockApi();
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" actions={actions} />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    const menu = await screen.findByRole("menu");
    await screen.findByRole("menuitemradio", { name: /\(mode default\)/ });
    const options = screen.getAllByRole("menuitemradio");
    options[0]!.focus();
    // Walk past every model row to the first action.
    for (let i = 0; i < options.length; i++) fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Start fresh…");
  });

  it("calls setSessionModel with the picked model and optimistically shows it", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "setSessionModel");
    render(<ModelSwitch api={api} sessionId="s1" cli="claude" model="sonnet" />);
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: / opus$/ }));
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
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /\(mode default\)/ }));
    expect(spy).toHaveBeenCalledWith("s1", null);
  });

  it("invokes an action's onSelect and closes the menu", async () => {
    const api = createMockApi();
    const fresh = vi.fn();
    render(
      <ModelSwitch
        api={api}
        sessionId="s1"
        cli="claude"
        model="sonnet"
        actions={[{ key: "fresh", label: "Start fresh…", onSelect: fresh }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Change model/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Start fresh…" }));
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
