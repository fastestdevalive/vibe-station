import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewTabDialog } from "./NewTabDialog";

describe("NewTabDialog channel toggle (5.T3 / 5.T4)", () => {
  it("sends channel:'json' when the JSON chat radio is selected", async () => {
    const api = createMockApi();
    const createSpy = vi.spyOn(api, "createSession");
    render(<NewTabDialog open api={api} worktreeId="wt-1" onClose={() => {}} />);

    await screen.findByText("Bugfix"); // modes loaded

    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0];
    expect(body).toMatchObject({ worktreeId: "wt-1", type: "agent", channel: "json" });
    // JSON forces useTmux false daemon-side — the dialog omits useTmux entirely.
    expect("useTmux" in body).toBe(false);
  });

  it("disables the JSON chat radio when the selected mode's CLI can't run JSON", async () => {
    const api = createMockApi();
    // A CLI whose plugin reports supportsJson=false → JSON channel is gated off.
    vi.spyOn(api, "listModes").mockResolvedValue([
      { id: "n", name: "No-JSON", cli: "nojson", context: "x" },
    ]);
    vi.spyOn(api, "getSupportedClis").mockResolvedValue([
      { id: "nojson", defaultModel: "auto", supportsJson: false, importsNativeHistory: false, supportsJsonToTerminalResume: true },
    ]);
    render(<NewTabDialog open api={api} worktreeId="wt-1" onClose={() => {}} />);

    await screen.findByText("No-JSON"); // mode loaded
    const jsonRadio = screen.getByRole("radio", { name: /Rich Chat/i });
    await waitFor(() => expect(jsonRadio).toBeDisabled());
    expect(screen.getByText(/Rich Chat not available for nojson/i)).toBeInTheDocument();
  });

  it("leaves the default (terminal) create unchanged — no channel, useTmux sent (5.T4)", async () => {
    const api = createMockApi();
    const createSpy = vi.spyOn(api, "createSession");
    render(<NewTabDialog open api={api} worktreeId="wt-1" onClose={() => {}} />);

    await screen.findByText("Bugfix");
    await userEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0];
    expect(body.channel).toBeUndefined();
    expect(body.useTmux).toBe(true);
  });
});
