import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Mode } from "@/api/types";
import { EditModeDialog } from "./EditModeDialog";
import { PRESET_BUG_FIX_TEXT, PRESET_PLANNING_TEXT } from "@/lib/modeContextPresets";

function mode(context: string, extra: Partial<Mode> = {}): Mode {
  return { id: "mode-1", name: "Bugfix", cli: "claude", context, ...extra };
}

describe("EditModeDialog context preset", () => {
  it("opens a saved preset-text mode on that preset", () => {
    render(<EditModeDialog mode={mode(PRESET_PLANNING_TEXT)} open onClose={() => {}} api={createMockApi()} />);
    expect(screen.getByRole("radio", { name: /Planning without PR/ })).toBeChecked();
  });

  it("derives the preset from the text, not a stale presetId", () => {
    render(
      <EditModeDialog
        mode={mode("my own context", { presetId: "bug-fix-with-pr" })}
        open
        onClose={() => {}}
        api={createMockApi()}
      />,
    );
    expect(screen.getByRole("radio", { name: /Custom/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: /mode context/i })).toHaveValue("my own context");
  });

  it("asks before replacing an untouched saved custom context", async () => {
    const user = userEvent.setup();
    render(<EditModeDialog mode={mode("my own context")} open onClose={() => {}} api={createMockApi()} />);
    await user.click(screen.getByRole("radio", { name: /Bug fix with PR/ }));
    expect(screen.getByRole("dialog", { name: /Replace your custom context/ })).toBeInTheDocument();
    expect(screen.getByText(/Your custom context will be replaced with the “Bug fix with PR” preset/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByRole("textbox", { name: /mode context/i })).toHaveValue(PRESET_BUG_FIX_TEXT);
  });

  it("reopening starts again from the saved mode", async () => {
    const user = userEvent.setup();
    const m = mode("my own context");
    const api = createMockApi();
    const { rerender } = render(<EditModeDialog mode={m} open onClose={() => {}} api={api} />);
    await user.type(screen.getByRole("textbox", { name: /mode context/i }), " edited");
    rerender(<EditModeDialog mode={m} open={false} onClose={() => {}} api={api} />);
    rerender(<EditModeDialog mode={m} open onClose={() => {}} api={api} />);
    expect(screen.getByRole("textbox", { name: /mode context/i })).toHaveValue("my own context");
  });

  it("saves exactly the shown context", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const spy = vi.spyOn(api, "updateMode");
    const onClose = vi.fn();
    render(<EditModeDialog mode={mode(PRESET_BUG_FIX_TEXT)} open onClose={onClose} api={api} />);
    await user.type(screen.getByRole("textbox", { name: /mode context/i }), " Mine.");
    await waitFor(() => expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ context: `${PRESET_BUG_FIX_TEXT} Mine.` });
  });

  it("shows an inline error for context over 10,000 bytes", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const spy = vi.spyOn(api, "updateMode");
    render(<EditModeDialog mode={mode("€".repeat(3_334))} open onClose={() => {}} api={api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(/10,000 bytes/);
    expect(spy).not.toHaveBeenCalled();
  });
});
