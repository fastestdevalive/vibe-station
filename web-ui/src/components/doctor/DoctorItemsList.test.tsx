import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { ApiError } from "@/api/errors";
import type { DoctorItemDto } from "@/api/types";
import { DoctorItemsList } from "./DoctorItemsList";

const forget = (id: string): DoctorItemDto => ({
  id,
  label: `proj / ${id}`,
  path: `/tmp/${id}`,
  command: `vst worktree rm ${id} --yes`,
  action: "forget",
});

async function confirm(label: string) {
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: label }));
}

const kill = (id: string): DoctorItemDto => ({
  id,
  label: id,
  path: null,
  command: `tmux kill-session -t ${id}`,
  action: "kill",
});

describe("DoctorItemsList (6.T2)", () => {
  it("Cancel in the confirm dialog performs no action", async () => {
    const api = createMockApi();
    const del = vi.spyOn(api, "deleteWorktree").mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<DoctorItemsList api={api} items={[forget("a-1"), forget("a-2")]} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Forget all 2" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/permanently deletes/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("Kill all warns about live tmux sessions and only kills after confirm", async () => {
    const api = createMockApi();
    const k = vi.spyOn(api, "killOrphanSession").mockResolvedValue({ ok: true } as never);
    const onChanged = vi.fn();
    render(<DoctorItemsList api={api} items={[kill("vr-1"), kill("vr-2")]} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Kill all 2" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/another vibe-station daemon/)).toBeInTheDocument();
    expect(k).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Kill" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(k).toHaveBeenCalledTimes(2);
  });

  it("Forget calls deleteWorktree with exactly the id (no done-check option) then onChanged", async () => {
    const api = createMockApi();
    const del = vi.spyOn(api, "deleteWorktree").mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<DoctorItemsList api={api} items={[forget("atls-1")]} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Forget proj / atls-1" }));
    await confirm("Forget");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]).toEqual(["atls-1"]);
  });

  it("Forget all runs one delete per item, then onChanged once", async () => {
    const api = createMockApi();
    const del = vi.spyOn(api, "deleteWorktree").mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(
      <DoctorItemsList api={api} items={[forget("a-1"), forget("a-2"), forget("a-3")]} onChanged={onChanged} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Forget all 3" }));
    await confirm("Forget");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(del.mock.calls.map((c) => c[0])).toEqual(["a-1", "a-2", "a-3"]);
  });

  it("a 404 on Forget counts as success", async () => {
    const api = createMockApi();
    vi.spyOn(api, "deleteWorktree").mockRejectedValue(new ApiError("gone", 404));
    const onChanged = vi.fn();
    render(<DoctorItemsList api={api} items={[forget("a-1")]} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: /Forget/ }));
    await confirm("Forget");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByText(/gone/)).toBeNull();
  });

  it("Kill 404 shows 'No longer orphaned'", async () => {
    const api = createMockApi();
    vi.spyOn(api, "killOrphanSession").mockRejectedValue(new ApiError("NOT_ORPHAN", 404));
    const onChanged = vi.fn();
    render(
      <DoctorItemsList
        api={api}
        items={[{ id: "vr-x", label: "vr-x", path: null, command: "tmux kill-session -t vr-x", action: "kill" }]}
        onChanged={onChanged}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Kill vr-x" }));
    await confirm("Kill");
    expect(await screen.findByText("No longer orphaned")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("collapses to collapsedCount rows with a 'Show N more' toggle and shows the CLI command", async () => {
    const api = createMockApi();
    const items = Array.from({ length: 5 }, (_, i) => forget(`w-${i}`));
    render(<DoctorItemsList api={api} items={items} collapsedCount={3} onChanged={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^Forget proj/ })).toHaveLength(3);
    expect(screen.getByText("Or from a terminal:")).toBeInTheDocument();
    // The terminal block lists every item's command, not just the first.
    const block = screen.getByText(/vst worktree rm w-0 --yes/);
    expect(block.textContent).toContain("vst worktree rm w-4 --yes");
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getAllByRole("button", { name: /^Forget proj/ })).toHaveLength(5);
  });
});
