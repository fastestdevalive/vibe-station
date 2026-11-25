import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { Dialog } from "./Dialog";
import { ModeContextField } from "./ModeContextField";
import { useReducer } from "react";
import {
  PRESET_BUG_FIX_TEXT,
  PRESET_PLANNING_TEXT,
  contextFieldReducer,
  initContextField,
} from "@/lib/modeContextPresets";

function Harness({ saved }: { saved?: string }) {
  const [state, dispatch] = useReducer(contextFieldReducer, saved, initContextField);
  return (
    <Dialog open title="Mode" onClose={() => {}}>
      <ModeContextField state={state} dispatch={dispatch} />
    </Dialog>
  );
}

const ctx = () => screen.getByRole("textbox", { name: /mode context/i });
const radio = (name: RegExp) => screen.getByRole("radio", { name });
const confirmDialog = () => screen.queryByRole("dialog", { name: /replace your custom context/i });

describe("ModeContextField", () => {
  it("groups the radios under a 'Context preset' legend", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Context preset" })).toBeInTheDocument();
  });

  it("typing switches to Custom and announces it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(radio(/Bug fix with PR/)).toBeChecked();
    await user.type(ctx(), " Also lint.");
    expect(radio(/Custom/)).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Context preset: Custom");
  });

  it("Custom keeps the preset text as a starting point", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(radio(/Custom/));
    expect(radio(/Custom/)).toBeChecked();
    expect(ctx()).toHaveValue(PRESET_BUG_FIX_TEXT);
    await waitFor(() => expect(ctx()).toHaveFocus());
  });

  it("preset → preset with untouched text does not ask", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(radio(/Planning without PR/));
    expect(confirmDialog()).toBeNull();
    expect(ctx()).toHaveValue(PRESET_PLANNING_TEXT);
  });

  it("a preset over custom text asks; Cancel keeps it and refocuses Custom", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    await user.type(ctx(), "mine");
    await user.click(radio(/Planning without PR/));
    expect(confirmDialog()).toBeInTheDocument();
    expect(radio(/Custom/)).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmDialog()).toBeNull();
    expect(ctx()).toHaveValue("mine");
    expect(radio(/Custom/)).toBeChecked();
    await waitFor(() => expect(radio(/Custom/)).toHaveFocus());
  });

  it("Replace applies the preset, shows the hint, and Custom restores the text", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    await user.type(ctx(), "mine");
    await user.click(radio(/Planning without PR/));
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(ctx()).toHaveValue(PRESET_PLANNING_TEXT);
    expect(radio(/Planning without PR/)).toBeChecked();
    expect(screen.getByText(/Select Custom to restore it/)).toBeInTheDocument();
    await waitFor(() => expect(radio(/Planning without PR/)).toHaveFocus());
    await user.click(radio(/Custom/));
    expect(ctx()).toHaveValue("mine");
    expect(screen.queryByText(/Select Custom to restore it/)).toBeNull();
  });

  it("Esc closes only the confirm, not the mode dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    await user.type(ctx(), "mine");
    await user.click(radio(/Planning without PR/));
    expect(confirmDialog()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(confirmDialog()).toBeNull();
    expect(screen.getByRole("dialog", { name: "Mode" })).toBeInTheDocument();
    expect(ctx()).toHaveValue("mine");
  });

  it("arrow keys from Custom onto a preset ask first", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    await user.type(ctx(), "mine");
    act(() => radio(/Custom/).focus());
    await user.keyboard("{ArrowUp}");
    expect(confirmDialog()).toBeInTheDocument();
    expect(ctx()).toHaveValue("mine");
  });

  it("untouched saved custom context asks with the one confirm message", async () => {
    const user = userEvent.setup();
    render(<Harness saved="saved custom" />);
    expect(radio(/Custom/)).toBeChecked();
    await user.click(radio(/Bug fix with PR/));
    expect(screen.getByText(/Your custom context will be replaced with the “Bug fix with PR” preset/)).toBeInTheDocument();
  });

  it("after Replace, clearing the box then Custom keeps it empty and drops the hint", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    await user.type(ctx(), "mine");
    await user.click(radio(/Planning without PR/));
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.clear(ctx());
    expect(screen.queryByText(/Select Custom to restore it/)).toBeNull();
    await user.click(radio(/Custom/));
    expect(ctx()).toHaveValue("");
  });

  it("typing back to a preset re-selects it and announces it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    expect(screen.getByRole("status")).toHaveTextContent("Context preset: Custom");
    await user.click(ctx());
    await user.paste(PRESET_PLANNING_TEXT);
    expect(radio(/Planning without PR/)).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Context preset: Planning without PR");
  });

  it("an empty Custom shows the no-context hint", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(ctx());
    expect(screen.getByText(/No extra context/)).toBeInTheDocument();
  });
});
