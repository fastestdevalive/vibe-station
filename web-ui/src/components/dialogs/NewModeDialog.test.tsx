import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewModeDialog } from "./NewModeDialog";

describe("NewModeDialog", () => {
  const api = createMockApi();

  it("selecting Custom clears textarea", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    const ctx = screen.getByRole("textbox", { name: /context/i });
    expect(ctx).not.toHaveValue("");
    await user.click(screen.getByRole("radio", { name: /Custom/i }));
    expect(ctx).toHaveValue("");
  });

  it("submitting empty name shows validation error", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(screen.getByText(/Name is required/i)).toBeInTheDocument();
  });

  it("submitting name length >64 shows error", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    const name = screen.getByRole("textbox", { name: /mode name/i });
    await user.type(name, "a".repeat(65));
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(screen.getByText(/64 characters/i)).toBeInTheDocument();
  });

  it("submitting context >10KB shows error", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "ok");
    const ctx = screen.getByRole("textbox", { name: /context/i });
    fireEvent.change(ctx, { target: { value: "x".repeat(10 * 1024 + 1) } });
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(screen.getByText(/10KB/i)).toBeInTheDocument();
  });

  it("duplicate name shows error", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={["Dup"]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "Dup");
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
  });

  it("submit calls api.createMode when valid", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "createMode");
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "UniqueMode");
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(spy).toHaveBeenCalled();
  });
});
