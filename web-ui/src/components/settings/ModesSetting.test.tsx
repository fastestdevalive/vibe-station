import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { ModesSetting } from "./ModesSetting";

let testApi: MockApi;

beforeEach(() => {
  testApi = createMockApi();
});

/**
 * Phase 5 (OOBE onboarding) — Settings reuse. ModesSetting now mounts
 * `CliDetectionPanel variant="settings"` above the existing modes list. This
 * must be purely additive: the panel's bundle-creation action must never
 * disable, hide, or otherwise alter the pre-existing "+ New mode" button or
 * the modes list (R24). `mock.ts`'s `getSupportedClis` returns claude+cursor
 * detected, with claude carrying 3 named bundle modes.
 */
describe("ModesSetting with CliDetectionPanel (5.T1)", () => {
  it("renders CliDetectionPanel inside the settings page alongside the modes list", async () => {
    render(<ModesSetting api={testApi} />);

    // CliDetectionPanel renders a detected-CLI row (claude detected in mock).
    expect(await screen.findByTestId("cli-row-claude")).toBeInTheDocument();
    expect(screen.getByTestId("cli-row-cursor")).toBeInTheDocument();

    // The pre-existing modes list still renders its items.
    expect(screen.getByText("Bugfix")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();

    // And the "+ New mode" button is still there.
    expect(screen.getByRole("button", { name: "+ New mode" })).toBeEnabled();
  });

  it("bundle-creation action does not disable or remove the '+ New mode' button (R24)", async () => {
    // Empty modes -> CliDetectionPanel's claude row shows "Create starter modes".
    testApi.__test.seedModes([]);
    render(<ModesSetting api={testApi} />);

    const newModeButton = await screen.findByRole("button", { name: "+ New mode" });
    expect(newModeButton).toBeEnabled();

    // Click the CliDetectionPanel bundle-creation action.
    const claudeRow = await screen.findByTestId("cli-row-claude");
    const createBtn = await waitFor(() =>
      within(claudeRow).getByRole("button", { name: "Create starter modes" }),
    );
    fireEvent.click(createBtn);

    // The "+ New mode" button must still be present and enabled (R24).
    expect(newModeButton).toBeInTheDocument();
    expect(newModeButton).toBeEnabled();
  });
});
