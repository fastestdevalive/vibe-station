import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import type { SupportedCli } from "@/api/types";
import { CliDetectionPanel } from "./CliDetectionPanel";

let testApi: MockApi;

beforeEach(() => {
  testApi = createMockApi();
});

/**
 * Phase 3 (OOBE onboarding) — shared detection/bundle panel. `mock.ts`'s
 * `getSupportedClis` returns claude+cursor detected, opencode/agy not, with
 * claude carrying 3 named bundle modes and the rest 1 generic each. The mock
 * `modes` array starts with one claude mode named "Bugfix" and one cursor mode
 * named "Plan". Queries are scoped to a per-CLI row (`cli-row-<id>`) because
 * multiple detected CLIs render the same button/label simultaneously.
 */
describe("CliDetectionPanel (3.T2)", () => {
  it("renders a ✘ not-found badge + hint for an undetected CLI, no action button", async () => {
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const badge = await screen.findByTestId("cli-detected-opencode");
    expect(badge).toHaveTextContent("✘ not found");
    expect(screen.getAllByText(/Install with your package manager, then re-check\./).length).toBeGreaterThan(0);

    const opencodeRow = within(screen.getByTestId("cli-row-opencode"));
    expect(opencodeRow.queryByRole("button")).toBeNull();
  });

  it("renders 'Create starter modes' for a detected CLI with no matching modes", async () => {
    testApi.__test.seedModes([]);
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.getByRole("button", { name: "Create starter modes" })).toBeInTheDocument();
    });
  });

  it("renders 'Recreate 1' when 1 of 3 names is missing (2 of 3 seeded)", async () => {
    testApi.__test.seedModes([
      { id: "m-bugfix", name: "Bugfix", cli: "claude", context: "", presetId: "bug-fix-with-pr", icon: "claude" },
      { id: "m-plan", name: "Plan", cli: "claude", context: "", presetId: "planning-no-pr", icon: "claude" },
    ]);
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.getByRole("button", { name: "Recreate 1" })).toBeInTheDocument();
    });
  });

  it("renders the disabled '✓ all created' label when 0 are missing", async () => {
    testApi.__test.seedModes([
      { id: "m-bugfix", name: "Bugfix", cli: "claude", context: "", presetId: "bug-fix-with-pr", icon: "claude" },
      { id: "m-plan", name: "Plan", cli: "claude", context: "", presetId: "planning-no-pr", icon: "claude" },
      { id: "m-arch", name: "Architect", cli: "claude", context: "" },
    ]);
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.getByTestId("cli-all-created-claude")).toHaveTextContent("✓ all created");
    });
    expect(claudeRow.queryByRole("button")).toBeNull();
  });

  it("renders the warning banner when usingFallbackOnly is true", async () => {
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    // agy is marked usingFallbackOnly: true in the mock.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("cli-row-agy")).getByText(
          /Using a generic fallback mode — model discovery didn't succeed for the named bundle\./,
        ),
      ).toBeInTheDocument();
    });
  });

  it("clicking 'Create starter modes' calls createStarterBundle and re-renders with an updated count", async () => {
    testApi.__test.seedModes([]);
    const createSpy = vi.spyOn(testApi, "createStarterBundle");
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.getByRole("button", { name: "Create starter modes" })).toBeInTheDocument();
    });

    // Simulate the server creating all 3 claude bundle modes (the mock's
    // createStarterBundle is a no-op, so mirror the post-creation mode list by
    // seeding them and letting the component's re-fetch pick them up).
    testApi.__test.seedModes([
      { id: "m-bugfix", name: "Bugfix", cli: "claude", context: "", presetId: "bug-fix-with-pr", icon: "claude" },
      { id: "m-plan", name: "Plan", cli: "claude", context: "", presetId: "planning-no-pr", icon: "claude" },
      { id: "m-arch", name: "Architect", cli: "claude", context: "" },
    ]);

    fireEvent.click(claudeRow.getByRole("button", { name: "Create starter modes" }));

    expect(createSpy).toHaveBeenCalledWith("claude");
    await waitFor(() => {
      expect(claudeRow.getByTestId("cli-all-created-claude")).toHaveTextContent("✓ all created");
    });
  });

  it("refetches getSupportedClis() when refreshSignal changes, picking up a sibling's detect-and-bundle result", async () => {
    // Regression: this panel used to only refetch on mount + mode WS events,
    // never on a SIBLING's own detectAndBundleOobe() call (OobeStep2Modes) —
    // so its detected/fallback badges raced that call instead of reading its
    // outcome.
    const notDetected: SupportedCli = {
      id: "opencode",
      defaultModel: "opencode/big-pickle",
      supportsJson: true,
      importsNativeHistory: true,
      supportsJsonToTerminalResume: true,
      detected: false,
      starterBundleNames: ["opencode-default"],
      usingFallbackOnly: false,
    };
    const nowDetected: SupportedCli = { ...notDetected, detected: true };
    const getSpy = vi
      .spyOn(testApi, "getSupportedClis")
      .mockResolvedValueOnce([notDetected])
      .mockResolvedValueOnce([nowDetected]);

    const { rerender } = render(
      <CliDetectionPanel api={testApi} variant="oobe" refreshSignal={0} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("cli-detected-opencode")).toHaveTextContent("✘ not found");
    });
    expect(getSpy).toHaveBeenCalledTimes(1);

    rerender(<CliDetectionPanel api={testApi} variant="oobe" refreshSignal={1} />);

    await waitFor(() => {
      expect(getSpy).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("cli-detected-opencode")).toHaveTextContent("✓ detected");
    });
  });
});
