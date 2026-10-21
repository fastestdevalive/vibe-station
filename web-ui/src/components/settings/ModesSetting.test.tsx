import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { ModesSetting } from "./ModesSetting";

let testApi: MockApi;

beforeEach(() => {
  localStorage.clear();
  testApi = createMockApi();
});

// mock.ts: claude+cursor detected, opencode/agy/... not. Mode "Bugfix" is
// claude's, "Plan" is cursor's.
describe("ModesSetting harness tabs", () => {
  it("renders a tablist with one tab per harness and a tabpanel", async () => {
    render(<ModesSetting api={testApi} />);
    const tablist = await screen.findByRole("tablist", { name: "Harnesses" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId("harness-dot-claude")).toHaveAccessibleName("detected");
    expect(screen.getByTestId("harness-dot-opencode")).toHaveAccessibleName("not found");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "harness-tab-claude");
  });

  it("defaults to the first detected harness and lists only its modes", async () => {
    render(<ModesSetting api={testApi} />);
    expect(await screen.findByTestId("cli-row-claude")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /claude/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Bugfix")).toBeInTheDocument();
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New mode" })).toBeEnabled();
  });

  it("switching tabs filters the mode list to that harness", async () => {
    render(<ModesSetting api={testApi} />);
    fireEvent.click(await screen.findByTestId("harness-tab-cursor"));
    expect(await screen.findByTestId("cli-row-cursor")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.queryByText("Bugfix")).not.toBeInTheDocument();
  });

  it("not-found harness shows its install hint and no default-channel select", async () => {
    render(<ModesSetting api={testApi} />);
    fireEvent.click(await screen.findByTestId("harness-tab-opencode"));
    expect(await screen.findByTestId("cli-detected-opencode")).toHaveTextContent("not found");
    expect(screen.getByText(/opencode\.ai\/install/)).toBeInTheDocument();
    expect(screen.queryByTestId("default-channel-opencode")).not.toBeInTheDocument();
    expect(screen.getByText(/No modes for this harness yet/)).toBeInTheDocument();
  });

  it("arrow keys move selection and focus; Home/End jump", async () => {
    render(<ModesSetting api={testApi} />);
    const claudeTab = await screen.findByTestId("harness-tab-claude");
    claudeTab.focus();
    fireEvent.keyDown(claudeTab, { key: "ArrowRight" });
    const cursorTab = screen.getByTestId("harness-tab-cursor");
    expect(cursorTab).toHaveAttribute("aria-selected", "true");
    expect(cursorTab).toHaveFocus();
    expect(cursorTab).toHaveAttribute("tabindex", "0");
    expect(claudeTab).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(cursorTab, { key: "ArrowLeft" });
    expect(claudeTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(claudeTab, { key: "End" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs[tabs.length - 1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[tabs.length - 1]!, { key: "Home" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("remembers the last selected tab in localStorage", async () => {
    const first = render(<ModesSetting api={testApi} />);
    fireEvent.click(await screen.findByTestId("harness-tab-cursor"));
    expect(localStorage.getItem("vst.settings.harnessTab")).toBe("cursor");
    first.unmount();
    render(<ModesSetting api={testApi} />);
    expect(await screen.findByTestId("cli-row-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("harness-tab-cursor")).toHaveAttribute("aria-selected", "true");
  });

  it("'+ New mode' pre-selects the selected harness' CLI", async () => {
    render(<ModesSetting api={testApi} />);
    fireEvent.click(await screen.findByTestId("harness-tab-cursor"));
    await screen.findByTestId("cli-row-cursor");
    fireEvent.click(screen.getByRole("button", { name: "+ New mode" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /cursor/i })).toBeChecked());
  });

  it("keeps the 'editing a mode only affects new sessions' notice", async () => {
    render(<ModesSetting api={testApi} />);
    expect(await screen.findByText(/Editing a mode only affects new sessions/)).toBeInTheDocument();
  });

  it("default-channel select is wired per harness (Rich Chat disabled when unsupported)", async () => {
    render(<ModesSetting api={testApi} />);
    const sel = await screen.findByLabelText("Default channel for claude");
    expect(sel).toBeEnabled();
  });

  it("'Create starter modes' still appears for a detected harness with no modes and keeps '+ New mode' (R24)", async () => {
    testApi.__test.seedModes([]);
    render(<ModesSetting api={testApi} />);
    const newModeButton = await screen.findByRole("button", { name: "+ New mode" });
    const claudeRow = await screen.findByTestId("cli-row-claude");
    const createBtn = await waitFor(() =>
      within(claudeRow).getByRole("button", { name: "Create starter modes" }),
    );
    fireEvent.click(createBtn);
    expect(newModeButton).toBeEnabled();
  });
});
