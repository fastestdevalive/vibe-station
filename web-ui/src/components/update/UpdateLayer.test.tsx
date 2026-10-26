import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { UpdateChip } from "./UpdateChip";
import { UpdateLayer } from "./UpdateLayer";
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

function makeApi(): ApiInstance {
  return {
    health: () => Promise.resolve({ ok: true, port: 1, version: "1.0.0", bootId: "boot-1" }),
    on: () => () => {},
  } as unknown as ApiInstance;
}

/** The TopBar chip plus the app-global update layer, as Workspace mounts them. */
function renderWithLayer() {
  return render(
    <MemoryRouter>
      <UpdateChip />
      <UpdateLayer api={makeApi()} />
    </MemoryRouter>,
  );
}

describe("UpdateLayer", () => {
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
    // The sync hook's mount fetch must not overwrite the status each test seeds.
    vi.spyOn(updateApi, "fetchUpdateStatus").mockReturnValue(new Promise(() => {}));
  });

  it("chip skip button calls skipUpdate and displays the Undo toast, which can unskip", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const statusAfterSkip: UpdateStatus = {
      ...BASE_STATUS,
      updateAvailable: true,
      latest: "1.2.3",
      skipped: ["1.2.3"],
    };
    const statusAfterUnskip: UpdateStatus = {
      ...BASE_STATUS,
      updateAvailable: true,
      latest: "1.2.3",
      skipped: [],
    };

    const skipSpy = vi.spyOn(updateApi, "skipUpdate").mockResolvedValue(statusAfterSkip);
    const unskipSpy = vi.spyOn(updateApi, "unskipUpdate").mockResolvedValue(statusAfterUnskip);

    useUpdateStore.setState({
      status: {
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
      },
      canInstall: true,
    });

    renderWithLayer();

    const skipBtn = screen.getByRole("button", { name: "Skip version 1.2.3" });
    await user.click(skipBtn);

    expect(skipSpy).toHaveBeenCalledWith("1.2.3");

    // Toast appears
    expect(screen.getByText("Skipped v1.2.3")).toBeInTheDocument();
    const undoBtn = screen.getByRole("button", { name: "Undo" });
    expect(undoBtn).toBeInTheDocument();

    // Click Undo
    await user.click(undoBtn);
    expect(unskipSpy).toHaveBeenCalledWith("1.2.3");

    vi.useRealTimers();
  });

  it("Skip this version in the dialog shows the Undo toast; Undo unskips", async () => {
    const user = userEvent.setup();
    const status = { ...BASE_STATUS, updateAvailable: true, latest: "1.2.3" };
    vi.spyOn(updateApi, "skipUpdate").mockResolvedValue({ ...status, skipped: ["1.2.3"] });
    const unskip = vi.spyOn(updateApi, "unskipUpdate").mockResolvedValue(status);
    useUpdateStore.setState({ status, dialogOpen: true });
    renderWithLayer();
    await user.click(screen.getByRole("button", { name: "Skip this version" }));
    expect(await screen.findByText("Skipped v1.2.3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(unskip).toHaveBeenCalledWith("1.2.3");
    expect(useUpdateStore.getState().undoSkipVersion).toBeNull();
  });

  it("the polite live region is mounted empty and announces the stage on change, dialog closed", () => {
    useUpdateStore.setState({ status: { ...BASE_STATUS, updateAvailable: true, latest: "1.2.3" } });
    const { container } = renderWithLayer();
    const region = container.querySelector('[aria-live="polite"]')!;
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("");
    act(() =>
      useUpdateStore.getState().setStatus({
        ...BASE_STATUS,
        updateAvailable: true,
        latest: "1.2.3",
        install: { stage: "downloading", pct: 5, startedBy: "ui" },
      }),
    );
    expect(region.textContent).toBe("Downloading update");
  });

  it("the live region exists even before any status has loaded", () => {
    const { container } = renderWithLayer();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
