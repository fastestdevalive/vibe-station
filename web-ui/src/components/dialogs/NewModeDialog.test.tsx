import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewModeDialog } from "./NewModeDialog";
import { PRESET_BUG_FIX_TEXT } from "@/lib/modeContextPresets";

describe("NewModeDialog", () => {
  const api = createMockApi();

  it("selecting Custom keeps the preset text as a starting point", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    const ctx = screen.getByRole("textbox", { name: /context/i });
    expect(ctx).toHaveValue(PRESET_BUG_FIX_TEXT);
    await user.click(screen.getByRole("radio", { name: /Custom/i }));
    expect(ctx).toHaveValue(PRESET_BUG_FIX_TEXT);
  });

  it("typing in the context switches the preset to Custom", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /context/i }), " Extra.");
    expect(screen.getByRole("radio", { name: /Custom/i })).toBeChecked();
  });

  it("sends presetId for an untouched preset and none after an edit", async () => {
    const user = userEvent.setup();
    const mock = createMockApi();
    const spy = vi.spyOn(mock, "createMode");
    const { rerender } = render(<NewModeDialog open api={mock} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "A");
    await user.click(screen.getByRole("button", { name: /Save/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ presetId: "bug-fix-with-pr", context: PRESET_BUG_FIX_TEXT });

    rerender(<NewModeDialog open={false} api={mock} onClose={() => {}} existingNames={[]} />);
    rerender(<NewModeDialog open api={mock} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "B");
    await user.type(screen.getByRole("textbox", { name: /context/i }), " Mine.");
    await user.click(screen.getByRole("button", { name: /Save/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ presetId: undefined, context: `${PRESET_BUG_FIX_TEXT} Mine.` });
  });

  it("reopening after Cancel starts fresh, and Save sends what is shown", async () => {
    const user = userEvent.setup();
    const mock = createMockApi();
    const spy = vi.spyOn(mock, "createMode");
    const { rerender } = render(<NewModeDialog open api={mock} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "Half");
    await user.clear(screen.getByRole("textbox", { name: /context/i }));
    await user.type(screen.getByRole("textbox", { name: /context/i }), "stale");
    rerender(<NewModeDialog open={false} api={mock} onClose={() => {}} existingNames={[]} />);
    rerender(<NewModeDialog open api={mock} onClose={() => {}} existingNames={[]} />);
    expect(screen.getByRole("textbox", { name: /mode name/i })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: /context/i })).toHaveValue(PRESET_BUG_FIX_TEXT);
    expect(screen.getByRole("radio", { name: /Bug fix with PR/i })).toBeChecked();
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "Fresh");
    await user.click(screen.getByRole("button", { name: /Save/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ context: PRESET_BUG_FIX_TEXT });
  });

  it("shows the daemon's error when createMode fails", async () => {
    const user = userEvent.setup();
    const mock = createMockApi();
    vi.spyOn(mock, "createMode").mockRejectedValueOnce(new Error("Mode context must not exceed 10000 characters."));
    const onClose = vi.fn();
    render(<NewModeDialog open api={mock} onClose={onClose} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "X");
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/must not exceed/);
    expect(onClose).not.toHaveBeenCalled();
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

  it("submitting context over 10,000 bytes shows error", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    await user.type(screen.getByRole("textbox", { name: /mode name/i }), "ok");
    const ctx = screen.getByRole("textbox", { name: /context/i });
    fireEvent.change(ctx, { target: { value: "x".repeat(10_001) } });
    await user.click(screen.getByRole("button", { name: /Save/i }));
    expect(screen.getByText(/10,000 bytes/i)).toBeInTheDocument();
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

  it("shows an icon on each CLI option and previews the derived icon", async () => {
    const user = userEvent.setup();
    render(<NewModeDialog open api={api} onClose={() => {}} existingNames={[]} />);
    const claude = await screen.findByRole("radio", { name: "Claude" });
    const label = claude.closest("label") as HTMLElement;
    expect(within(label).getByRole("img", { hidden: true })).toBeInTheDocument();
    await user.click(claude);
    await waitFor(() => {
      expect(within(screen.getByTestId("new-mode-icon-preview")).getByRole("img")).toHaveAttribute("aria-label", "claude");
    });
  });
});
