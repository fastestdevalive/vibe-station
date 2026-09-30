import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMockApi, type MockApi } from "@/api/mock";
import type { DetectAndBundleResult, Mode, SupportedCli } from "@/api/types";
import { OobeStep2Modes } from "./OobeStep2Modes";

function cli(over: Partial<SupportedCli>): SupportedCli {
  return {
    id: "claude",
    defaultModel: "sonnet",
    supportsJson: true,
    importsNativeHistory: true,
    supportsJsonToTerminalResume: true,
    detected: false,
    starterBundleNames: [],
    usingFallbackOnly: false,
    defaultChannel: "json",
    defaultChannelOverridden: false,
    ...over,
  };
}

function mode(over: Partial<Mode>): Mode {
  return { id: "m1", name: "Bugfix", cli: "claude", context: "ctx", ...over };
}

describe("OobeStep2Modes", () => {
  it("shows the per-CLI models error with a Retry that re-runs detect-and-bundle", async () => {
    const api = createMockApi() as MockApi;
    const detect = vi.spyOn(api, "detectAndBundleOobe").mockResolvedValue({
      supportedClis: [cli({ id: "claude", detected: true })],
      created: [],
      modelsErrors: { claude: "Couldn't fetch the model list from Claude: timed out." },
    } as DetectAndBundleResult);
    vi.spyOn(api, "listModes").mockResolvedValue([]);

    render(<OobeStep2Modes api={api} onStep2Confirmed={vi.fn()} />);

    const banner = await screen.findByTestId("models-error-claude");
    expect(banner.textContent).toContain("timed out");
    const before = detect.mock.calls.length;
    fireEvent.click(screen.getAllByText("Retry")[0]!);
    await waitFor(() => expect(detect.mock.calls.length).toBeGreaterThan(before));
  });

  it("4.T3 — with zero detected CLIs the Next button is disabled", async () => {
    const api = createMockApi() as MockApi;
    vi.spyOn(api, "detectAndBundleOobe").mockResolvedValue({
      supportedClis: [
        cli({ id: "claude", detected: false }),
        cli({ id: "cursor", detected: false }),
      ],
      created: [],
    } as DetectAndBundleResult);
    vi.spyOn(api, "listModes").mockResolvedValue([mode({ id: "m1", cli: "claude" })]);

    const onStep2Confirmed = vi.fn();
    render(<OobeStep2Modes api={api} onStep2Confirmed={onStep2Confirmed} />);

    await waitFor(() => {
      expect(screen.getByTestId("oobe-finish")).toBeDisabled();
    });
    // The zero-CLI warning with a Re-check button renders.
    expect(screen.getByText("Re-check")).toBeTruthy();
  });

  it("4.T3 — with a detected CLI bundle and a matching mode the Next button is enabled, and clicking calls confirmOobeStep2", async () => {
    const api = createMockApi() as MockApi;
    vi.spyOn(api, "detectAndBundleOobe").mockResolvedValue({
      supportedClis: [cli({ id: "claude", detected: true })],
      created: [mode({ id: "m1", cli: "claude" })],
    } as DetectAndBundleResult);
    vi.spyOn(api, "listModes").mockResolvedValue([mode({ id: "m1", cli: "claude" })]);
    const step2Spy = vi.spyOn(api, "confirmOobeStep2").mockResolvedValue({ ok: true });

    const onStep2Confirmed = vi.fn();
    render(<OobeStep2Modes api={api} onStep2Confirmed={onStep2Confirmed} />);

    await waitFor(() => {
      expect(screen.getByTestId("oobe-finish")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("oobe-finish"));

    await waitFor(() => {
      expect(step2Spy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(onStep2Confirmed).toHaveBeenCalledTimes(1);
    });
  });

  it("a failed detectAndBundleOobe() shows an error + Retry instead of leaving the screen stuck with no way forward", async () => {
    const api = createMockApi() as MockApi;
    const detectSpy = vi
      .spyOn(api, "detectAndBundleOobe")
      .mockRejectedValueOnce(new Error("network error"));
    vi.spyOn(api, "listModes").mockResolvedValue([]);

    const onStep2Confirmed = vi.fn();
    render(<OobeStep2Modes api={api} onStep2Confirmed={onStep2Confirmed} />);

    // Before the fix, a rejected call left supportedClis at [] forever, so
    // NEITHER the mode list NOR the zero-CLI Re-check UI rendered — nothing
    // told the user why the Next button was stuck disabled.
    await waitFor(() => {
      expect(screen.getByText(/Couldn't check installed CLIs/)).toBeInTheDocument();
    });
    expect(screen.getByTestId("oobe-finish")).toBeDisabled();

    detectSpy.mockResolvedValueOnce({
      supportedClis: [cli({ id: "claude", detected: true })],
      created: [mode({ id: "m1", cli: "claude" })],
    } as DetectAndBundleResult);
    vi.spyOn(api, "listModes").mockResolvedValue([mode({ id: "m1", cli: "claude" })]);

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(screen.queryByText(/Couldn't check installed CLIs/)).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("oobe-finish")).toBeEnabled();
    });
  });
});
