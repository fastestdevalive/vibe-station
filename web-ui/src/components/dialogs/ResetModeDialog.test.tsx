import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Mode } from "@/api/types";
import { ResetModeDialog } from "./ResetModeDialog";

const modes: Mode[] = [
  { id: "m1", name: "Alpha", cli: "claude", context: "" },
  { id: "m2", name: "Beta", cli: "cursor", context: "" },
  { id: "m3", name: "Gamma", cli: "agy", context: "" },
];

describe("ResetModeDialog", () => {
  it("renders with default title, confirm label, prompt and modes list", async () => {
    const listModes = vi.fn().mockResolvedValue(modes);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        reason="Session mode missing"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(await screen.findByText("Choose a mode to reset with")).toBeTruthy();
    expect(screen.getByText(/Session mode missing/)).toBeTruthy();
    expect(screen.getByText(/Pick a mode for the fresh session\./)).toBeTruthy();

    const select = (await screen.findByLabelText("Mode")) as HTMLSelectElement;
    expect(select.value).toBe("m1");
    expect(select.children.length).toBe(3);

    const confirmBtn = screen.getByRole("button", { name: "Reset with this mode" });
    await userEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith("m1");
  });

  it("supports custom title, confirm label, and prompt", async () => {
    const listModes = vi.fn().mockResolvedValue(modes);
    const onConfirm = vi.fn();

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        title="Choose a mode for Rich Chat"
        confirmLabel="Use this mode"
        prompt="Pick a mode for Rich Chat."
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText("Choose a mode for Rich Chat")).toBeTruthy();
    expect(screen.getByText(/Pick a mode for Rich Chat\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this mode" })).toBeTruthy();
  });

  it("filters modes and defaults selection to the first filtered mode", async () => {
    const listModes = vi.fn().mockResolvedValue(modes);
    const onConfirm = vi.fn();

    // Only allow cursor (m2)
    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        filterMode={(m) => m.cli === "cursor"}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const select = (await screen.findByLabelText("Mode")) as HTMLSelectElement;
    expect(select.value).toBe("m2");
    expect(select.children.length).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Reset with this mode" }));
    expect(onConfirm).toHaveBeenCalledWith("m2");
  });

  it("displays the neutral default empty state copy and disables confirm when all modes are filtered out", async () => {
    const listModes = vi.fn().mockResolvedValue(modes);

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        filterMode={() => false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // The default dialog has nothing to do with Rich Chat — it must show the
    // neutral copy, not "No Rich Chat-capable modes…" (review #1).
    expect(
      await screen.findByText("No modes — create one in Settings → Modes."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Mode")).toBeNull();
    const confirmBtn = screen.getByRole("button", { name: "Reset with this mode" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("renders a custom emptyMessage when provided", async () => {
    const listModes = vi.fn().mockResolvedValue(modes);

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        filterMode={() => false}
        emptyMessage="No Rich Chat-capable modes — create one in Settings → Modes."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("No Rich Chat-capable modes — create one in Settings → Modes."),
    ).toBeTruthy();
  });

  it("does not show the empty state copy before listModes resolves", async () => {
    let resolveModes: (ms: Mode[]) => void;
    const listModes = vi.fn().mockReturnValue(
      new Promise<Mode[]>((resolve) => {
        resolveModes = resolve;
      }),
    );

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        filterMode={() => false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Before the fetch resolves, the empty-state line must NOT flash.
    expect(screen.queryByText(/No modes — create one in Settings → Modes\./)).toBeNull();
    expect(screen.queryByText(/No Rich Chat-capable modes/)).toBeNull();

    resolveModes!([]);
    expect(
      await screen.findByText("No modes — create one in Settings → Modes."),
    ).toBeTruthy();
  });

  it("handles load failure gracefully", async () => {
    const listModes = vi.fn().mockRejectedValue(new Error("Network failed"));

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Couldn't load the mode list — close this and try again."),
    ).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: "Reset with this mode" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const listModes = vi.fn().mockResolvedValue(modes);
    const onCancel = vi.fn();

    render(
      <ResetModeDialog
        open={true}
        api={{ listModes }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await screen.findByLabelText("Mode");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
