import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { UpdateChip } from "./UpdateChip";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { UpdateStatus } from "@/api/types";
import * as updateApi from "@/api/update";

const BASE_STATUS: UpdateStatus = {
  current: "1.0.0",
  behindCount: 0,
  updateAvailable: false,
  skipped: [],
  installMethod: "curl",
  targets: [],
  autoCheck: true,
  platform: "linux-x86_64",
  noAsset: false,
};

describe("UpdateChip", () => {
  beforeEach(() => {
    useUpdateStore.setState({
      status: null,
      canInstall: true,
      remindedFor: null,
      dialogOpen: false,
      restarting: false,
      undoSkipVersion: null,
    });
    vi.restoreAllMocks();
  });

  it("renders nothing when status is null or not actionable", () => {
    const { container, rerender } = render(<UpdateChip />);
    // Only the (empty) screen-reader live region; no visible chip.
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("");

    useUpdateStore.setState({ status: BASE_STATUS });
    rerender(<UpdateChip />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("installing chip shows the stage label, never a backwards 0%", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        latest: "1.2.3",
        install: { stage: "installing", pct: 0, startedBy: "ui" },
      },
    });
    render(<UpdateChip />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("Installing…");
    expect(btn.textContent).not.toContain("0%");
    expect(btn.getAttribute("aria-label")).not.toContain("percent");
  });

  it("renders update available chip with exact aria-labels and opens dialog on click", async () => {
    const user = userEvent.setup();
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
      },
      canInstall: true,
    });

    render(<UpdateChip />);

    const mainBtn = screen.getByRole("button", {
      name: "Update available: vibe-station v1.2.3. Open update details",
    });
    expect(mainBtn).toBeInTheDocument();
    expect(mainBtn).toHaveTextContent("Update v1.2.3");

    const skipBtn = screen.getByRole("button", {
      name: "Skip version 1.2.3",
    });
    expect(skipBtn).toBeInTheDocument();

    await user.click(mainBtn);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });

  it("hides skip button when canInstall is false", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
      },
      canInstall: false,
    });

    render(<UpdateChip />);

    expect(
      screen.getByRole("button", {
        name: "Update available: vibe-station v1.2.3. Open update details",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Skip version/ })).toBeNull();
  });

  it("observes chip priority: installing > restartPending > rolledBack > updateAvailable", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
        rolledBack: { failedVersion: "1.2.0", at: new Date().toISOString() },
        restartPending: { version: "1.2.1", kind: "daemon" },
        install: { stage: "downloading", pct: 45, startedBy: "ui" },
      },
    });

    const { rerender } = render(<UpdateChip />);
    // 1. Installing wins
    expect(screen.getByText("Updating… 45%")).toBeInTheDocument();

    // 2. Clear install -> restartPending wins
    act(() => {
      useUpdateStore.setState((s) => ({
        status: s.status ? { ...s.status, install: undefined } : null,
      }));
    });
    rerender(<UpdateChip />);
    expect(screen.getByText("Restart to finish v1.2.1")).toBeInTheDocument();

    // 3. Clear restartPending -> rolledBack wins
    act(() => {
      useUpdateStore.setState((s) => ({
        status: s.status ? { ...s.status, restartPending: undefined } : null,
      }));
    });
    rerender(<UpdateChip />);
    expect(screen.getByText("v1.2.0 failed to start")).toBeInTheDocument();

    // 4. Clear rolledBack -> updateAvailable wins
    act(() => {
      useUpdateStore.setState((s) => ({
        status: s.status ? { ...s.status, rolledBack: undefined } : null,
      }));
    });
    rerender(<UpdateChip />);
    expect(screen.getByText("Update v1.2.3")).toBeInTheDocument();
  });

  it("hides when remindedFor equals latest version, and reappears for a different latest", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
      },
      remindedFor: "1.2.3",
    });

    const { rerender, container } = render(<UpdateChip />);
    expect(container.querySelector(".update-chip")).toBeNull();

    // Change latest version to 1.2.4
    act(() => {
      useUpdateStore.setState((s) => ({
        status: s.status ? { ...s.status, latest: "1.2.4" } : null,
      }));
    });
    rerender(<UpdateChip />);
    expect(screen.getByText("Update v1.2.4")).toBeInTheDocument();
  });


  it("clicking rolled-back chip navigates to /settings/updates", async () => {
    const user = userEvent.setup();
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        rolledBack: { failedVersion: "1.2.3", at: new Date().toISOString() },
      },
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<UpdateChip />} />
          <Route path="/settings/updates" element={<div>Updates Settings Page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const chipBtn = screen.getByRole("button", {
      name: /vibe-station v1.2.3 failed to start/,
    });
    expect(chipBtn).toBeInTheDocument();
    expect(screen.getByText("v1.2.3 failed to start")).toBeInTheDocument();

    await user.click(chipBtn);
    expect(await screen.findByText("Updates Settings Page")).toBeInTheDocument();
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("chip shows no Update button once only non-running copies were updated", () => {
    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
        lastResult: { version: "1.2.3", updated: ["/home/u/.local/bin/vst"], manual: [] },
      },
    });
    render(<UpdateChip />);
    expect(screen.queryByRole("button")).toBeNull();
  });



});
