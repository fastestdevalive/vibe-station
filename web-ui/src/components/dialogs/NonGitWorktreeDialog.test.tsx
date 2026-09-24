import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NonGitWorktreeDialog } from "./NonGitWorktreeDialog";

describe("NonGitWorktreeDialog (4.T1)", () => {
  it("renders the PRD screen layout: title, explanation, primary + cancel", () => {
    render(
      <NonGitWorktreeDialog open onConfirm={() => Promise.resolve()} onCancel={() => {}} />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Can't create worktree")).toBeTruthy();
    expect(
      screen.getByText(/This project isn't a git repository/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Run git init and continue/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
  });

  it("Cancel calls onCancel with no side effects", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<NonGitWorktreeDialog open onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("onConfirm failure shows an inline error and re-enables the primary button (CUJ 3 error path)", async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error("git init failed")));
    render(<NonGitWorktreeDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Run git init and continue/i }));
    expect(await screen.findByText(/git init failed/i)).toBeTruthy();
    const primary = screen.getByRole("button", {
      name: /Run git init and continue/i,
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
  });

  it("onConfirm success resolves without showing an error", async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<NonGitWorktreeDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Run git init and continue/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/git init failed/i)).toBeNull();
  });
});
