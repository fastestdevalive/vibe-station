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

  it("renders 'Create starter modes' for a CLI even when OTHER CLIs already have modes", async () => {
    // Per-CLI only: cursor having a mode must not hide claude's button (which
    // has zero modes).
    testApi.__test.seedModes([
      { id: "m-plan", name: "Plan", cli: "cursor", context: "", presetId: "planning-no-pr", icon: "cursor" },
    ]);
    render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.getByRole("button", { name: "Create starter modes" })).toBeInTheDocument();
    });
    // cursor's mode means cursor already has its own slot (button never shows).
    const cursorRow = within(await screen.findByTestId("cli-row-cursor"));
    expect(cursorRow.queryByRole("button")).toBeNull();
  });

  it("renders the '✓ all created' confirmation (oobe only) when 0 are missing", async () => {
    testApi.__test.seedModes([
      { id: "m-bugfix", name: "Bugfix", cli: "claude", context: "", presetId: "bug-fix-with-pr", icon: "claude" },
      { id: "m-plan", name: "Plan", cli: "claude", context: "", presetId: "planning-no-pr", icon: "claude" },
      { id: "m-arch", name: "Architect", cli: "claude", context: "" },
    ]);
    const { unmount } = render(<CliDetectionPanel api={testApi} variant="oobe" />);

    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.queryByRole("button")).toBeNull();
    });
    expect(claudeRow.getByTestId("cli-all-created-claude")).toHaveTextContent("✓ all created");
    unmount();

    // The settings variant fills that slot with the default-channel select
    // instead — it never shows the confirmation label.
    render(<CliDetectionPanel api={testApi} variant="settings" />);
    await waitFor(() => {
      expect(screen.queryByTestId("cli-all-created-claude")).toBeNull();
    });
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
      expect(claudeRow.queryByRole("button")).toBeNull();
      expect(claudeRow.getByTestId("cli-all-created-claude")).toHaveTextContent("✓ all created");
    });
  });

  it("uses the default border (never green) on the row and a borderless plain-text badge", async () => {
    render(<CliDetectionPanel api={testApi} variant="oobe" />);
    const row = await screen.findByTestId("cli-row-claude");
    // claude is detected, but the row must NOT get the success/green border —
    // it always uses var(--border-default).
    expect(row.style.border).toContain("var(--border-width) solid var(--border-default)");
    expect(row.style.border).not.toContain("var(--fg-success)");
    expect(row.style.opacity).toBe("1");

    const undetectedRow = screen.getByTestId("cli-row-opencode");
    // Undetected keeps the same border plus dimming.
    expect(undetectedRow.style.border).toContain("var(--border-default)");
    expect(undetectedRow.style.border).not.toContain("var(--fg-success)");
    expect(undetectedRow.style.opacity).toBe("0.6");

    // Badge is plain text — no border/background, colour from fg tokens only.
    const badge = screen.getByTestId("cli-detected-claude");
    expect(badge.style.border).toBe("");
    expect(badge.style.background).toBe("");
    expect(badge.style.color).toContain("var(--fg-success)");
    expect(screen.getByTestId("cli-detected-opencode").style.color).toContain("var(--fg-muted)");
  });

  it("mutex: button and default-channel dropdown are never rendered together for one CLI", async () => {
    // With no claude mode yet: button only, no dropdown.
    testApi.__test.seedModes([]);
    const { unmount } = render(<CliDetectionPanel api={testApi} variant="settings" />);
    const claudeRow = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow.getByRole("button", { name: "Create starter modes" })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("default-channel-claude")).toBeNull();
    unmount();

    // Once a claude mode exists: dropdown only, no button.
    testApi.__test.seedModes([
      { id: "m-bugfix", name: "Bugfix", cli: "claude", context: "", presetId: "bug-fix-with-pr", icon: "claude" },
    ]);
    render(<CliDetectionPanel api={testApi} variant="settings" />);
    const claudeRow2 = within(await screen.findByTestId("cli-row-claude"));
    await waitFor(() => {
      expect(claudeRow2.getByTestId("default-channel-claude")).toBeInTheDocument();
    });
    // Dropdown only for claude — no button in the same row.
    expect(claudeRow2.queryByRole("button", { name: "Create starter modes" })).toBeNull();
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
      defaultChannel: "json",
      defaultChannelOverridden: false,
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

describe("CliDetectionPanel default-channel toggle (6.T4)", () => {
  it("settings variant renders the Default channel toggle; oobe renders none", async () => {
    const { unmount } = render(<CliDetectionPanel api={testApi} variant="settings" />);
    // claude is detected with defaultChannel json, not overridden -> Rich Chat is
    // the plugin default and is labeled "(built-in)".
    const claudeToggle = await screen.findByTestId("default-channel-claude");
    const claudeSelect = within(claudeToggle).getByRole("combobox") as HTMLSelectElement;
    expect(claudeSelect.value).toBe("json");
    expect(within(claudeToggle).getByRole("option", { name: /Rich Chat \(built-in\)/ })).toBeInTheDocument();
    unmount();

    // Same data but the oobe variant renders no selector at all.
    render(<CliDetectionPanel api={testApi} variant="oobe" />);
    await waitFor(() => {
      expect(screen.getByTestId("cli-row-claude")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("default-channel-claude")).toBeNull();
  });

  it("toggling claude's default to Terminal persists via updateSettings and is reflected after refetch", async () => {
    const updateSpy = vi.spyOn(testApi, "updateSettings");
    render(<CliDetectionPanel api={testApi} variant="settings" />);
    await screen.findByTestId("default-channel-claude");

    // Initially Rich Chat (the plugin default, not overridden) is selected.
    const select = within(screen.getByTestId("default-channel-claude")).getByRole(
      "combobox",
    ) as HTMLSelectElement;
    expect(select.value).toBe("json");

    // Select Terminal (the non-default option) -> sends a single-key explicit override.
    fireEvent.change(select, { target: { value: "tmux" } });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({ defaultChannelByCli: { claude: "tmux" } });
    });
    // After the refetch, Terminal is now the effective default (and overridden).
    await waitFor(() => {
      expect(select.value).toBe("tmux");
    });
  });

  it("selecting the (default)-labeled option sends null and reverts the override", async () => {
    const updateSpy = vi.spyOn(testApi, "updateSettings");
    render(<CliDetectionPanel api={testApi} variant="settings" />);
    await screen.findByTestId("default-channel-claude");

    const select = within(screen.getByTestId("default-channel-claude")).getByRole(
      "combobox",
    ) as HTMLSelectElement;

    // Override claude to Terminal first.
    fireEvent.change(select, { target: { value: "tmux" } });
    await waitFor(() => {
      expect(select.value).toBe("tmux");
    });

    // Now Rich Chat is the (default) option; selecting it clears the override (null).
    expect(
      within(screen.getByTestId("default-channel-claude")).getByRole("option", { name: /Rich Chat \(built-in\)/ }),
    ).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "json" } });
    await waitFor(() => {
      expect(updateSpy).toHaveBeenLastCalledWith({ defaultChannelByCli: { claude: null } });
    });
    // After the refetch, back to json and not overridden -> Rich Chat labeled (built-in) again.
    await waitFor(() => {
      expect(select.value).toBe("json");
      expect(
        within(screen.getByTestId("default-channel-claude")).getByRole("option", { name: /Rich Chat \(built-in\)/ }),
      ).toBeInTheDocument();
    });
  });

  it("hides the default-channel field until at least one mode exists for the CLI", async () => {
    testApi.__test.seedModes([]); // no modes for any CLI yet
    const { unmount } = render(<CliDetectionPanel api={testApi} variant="settings" />);
    await screen.findByTestId("cli-row-claude");
    expect(screen.queryByTestId("default-channel-claude")).toBeNull();
    unmount();

    // Once a mode exists for claude, the field appears.
    testApi.__test.seedModes([
      { id: "m-bugfix", name: "Bugfix", cli: "claude", context: "", presetId: "bug-fix-with-pr", icon: "claude" },
    ]);
    render(<CliDetectionPanel api={testApi} variant="settings" />);
    await waitFor(() => {
      expect(screen.getByTestId("default-channel-claude")).toBeInTheDocument();
    });
  });

  it("with zero modes the settings variant shows the create button, never the dropdown (mutex)", async () => {
    // round-3 m5's `|| cli.defaultChannelOverridden` clause is gone: for a
    // detected CLI the button and the default-channel dropdown are mutually
    // exclusive, and zero modes means the button wins regardless of an
    // override flag.
    const overridden: SupportedCli = {
      id: "agy",
      defaultModel: "m",
      supportsJson: true,
      importsNativeHistory: true,
      supportsJsonToTerminalResume: true,
      detected: true,
      starterBundleNames: [],
      usingFallbackOnly: false,
      defaultChannel: "json",
      defaultChannelOverridden: true,
    };
    vi.spyOn(testApi, "getSupportedClis").mockResolvedValue([overridden]);
    testApi.__test.seedModes([]); // no modes for agy
    render(<CliDetectionPanel api={testApi} variant="settings" />);

    await waitFor(() => {
      expect(
        within(screen.getByTestId("cli-row-agy")).getByRole("button", { name: "Create starter modes" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("default-channel-agy")).toBeNull();
  });

  it("shows an inline error and disables the select while a channel update is in flight (round-3 m3)", async () => {
    let resolveUpdate!: () => void;
    vi.spyOn(testApi, "updateSettings").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          resolveUpdate = () => reject(new Error("cli does not support json"));
        }),
    );
    render(<CliDetectionPanel api={testApi} variant="settings" />);
    const select = within(await screen.findByTestId("default-channel-claude")).getByRole(
      "combobox",
    ) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "tmux" } });
    expect(select).toBeDisabled();

    resolveUpdate();
    await waitFor(() => {
      expect(select).not.toBeDisabled();
      expect(screen.getByText("cli does not support json")).toBeInTheDocument();
    });
  });

  it("Rich Chat is disabled (not merely hidden) for a !supportsJson CLI", async () => {
    const noJson: SupportedCli = {
      id: "weird",
      defaultModel: "m",
      supportsJson: false,
      importsNativeHistory: true,
      supportsJsonToTerminalResume: true,
      detected: true,
      starterBundleNames: [],
      usingFallbackOnly: false,
      defaultChannel: "tmux",
      defaultChannelOverridden: false,
    };
    vi.spyOn(testApi, "getSupportedClis").mockResolvedValue([noJson]);
    // The default-channel field only shows once at least one mode exists for
    // the CLI — seed one so this test can reach the toggle it's asserting on.
    testApi.__test.seedModes([{ id: "m-weird", name: "Weird", cli: "weird", context: "" }]);
    render(<CliDetectionPanel api={testApi} variant="settings" />);

    const toggle = await screen.findByTestId("default-channel-weird");
    expect(within(toggle).getByRole("option", { name: /Rich Chat/ }) as HTMLOptionElement).toBeDisabled();
    expect(within(toggle).getByRole("option", { name: /Terminal/ }) as HTMLOptionElement).toBeEnabled();
  });
});
