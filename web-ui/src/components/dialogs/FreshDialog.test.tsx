import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Mode, Session, SupportedCli } from "@/api/types";
import { FreshDialog, type FreshDialogChoice } from "./FreshDialog";

const modes = [
  { id: "opus-planner", name: "opus-planner", cli: "claude", context: "", icon: "claude" },
  { id: "sonnet-implementer", name: "sonnet-implementer", cli: "claude", context: "", icon: "claude" },
  { id: "cursor-plan", name: "cursor-plan", cli: "cursor", context: "", icon: "cursor" },
  { id: "agy-mode", name: "agy-mode", cli: "agy", context: "", icon: "agy" },
] as Mode[];

const clis = [
  { id: "claude", defaultModel: "sonnet", supportsJson: true },
  { id: "cursor", defaultModel: "auto", supportsJson: true },
  { id: "agy", defaultModel: "gemini", supportsJson: false },
] as SupportedCli[];

const api = {
  listModes: vi.fn().mockResolvedValue(modes),
  getSupportedClis: vi.fn().mockResolvedValue(clis),
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: "opus-planner",
    type: "agent",
    isMain: true,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "s1",
    channel: "json",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function mount(overrides: Partial<React.ComponentProps<typeof FreshDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <FreshDialog
      open
      kind="fresh"
      api={api}
      session={session()}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

function lastChoice(onConfirm: ReturnType<typeof vi.fn>): FreshDialogChoice {
  return onConfirm.mock.calls[0]![0] as FreshDialogChoice;
}

describe("FreshDialog — Start fresh", () => {

  it("defaultCarryOver=summary preselects Summary and Enter confirms it", async () => {
    const { onConfirm } = mount({ defaultCarryOver: "summary" });
    await screen.findByText("opus-planner");
    expect(screen.getByRole("radio", { name: /Summary/ })).toBeChecked();
    await userEvent.keyboard("{Enter}");
    expect(lastChoice(onConfirm).carryOver).toBe("summary");
  });
  it("Escape cancels", async () => {
    const { onCancel } = mount();
    await screen.findByRole("radio", { name: /opus-planner/ });
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("defaults to the current mode and Carry over = Nothing, CTA 'Start fresh'", async () => {
    const { onConfirm } = mount();
    await screen.findByRole("radio", { name: /opus-planner/ });
    expect((screen.getByRole("radio", { name: /opus-planner/ }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("radio", { name: /^Nothing/ }) as HTMLInputElement).checked).toBe(true);
    const cta = screen.getByRole("button", { name: "Start fresh" });
    expect((cta as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Nothing carried")).toBeTruthy();

    await userEvent.click(cta);
    expect(lastChoice(onConfirm)).toEqual({
      modeId: "opus-planner",
      channel: "json",
      carryOver: "none",
      whenBusy: "stop",
      queued: "carry",
    });
  });

  it("offers Summary and Transcript and reports the picked carry mode", async () => {
    const { onConfirm } = mount();
    await screen.findByRole("radio", { name: /^Summary/ });
    await userEvent.click(screen.getByRole("radio", { name: /^Summary/ }));
    expect(screen.getByText("Summary first, up to 2 min")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(lastChoice(onConfirm).carryOver).toBe("summary");
  });

  it("shows a 'Terminal only' chip for an agy mode and forces channel tmux", async () => {
    const { onConfirm } = mount();
    await screen.findByRole("radio", { name: /agy-mode/ });
    await userEvent.click(screen.getByRole("radio", { name: /agy-mode/ }));
    expect(screen.getByText("Terminal only")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(lastChoice(onConfirm).channel).toBe("tmux");
    expect(lastChoice(onConfirm).modeId).toBe("agy-mode");
  });
});

describe("FreshDialog — Switch provider & mode", () => {
  it("starts with the current mode selected (and selectable), CTA 'Pick another mode' inactive", async () => {
    mount({ kind: "switch" });
    const current = await screen.findByRole("radio", { name: /opus-planner/ });
    expect((current as HTMLButtonElement).disabled).toBe(false);
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Current")).toBeTruthy();
    const cta = screen.getByRole("button", { name: "Pick another mode" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    // Switch never offers Nothing.
    expect(screen.queryByRole("radio", { name: /^Nothing/ })).toBeNull();
    expect((screen.getByRole("radio", { name: /^Summary/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Summary first, up to 2 min")).toBeTruthy();
  });

  it("lets you undo a stray pick by re-selecting the current mode", async () => {
    mount({ kind: "switch" });
    await screen.findByRole("radio", { name: /sonnet-implementer/ });
    await userEvent.click(screen.getByRole("radio", { name: /sonnet-implementer/ }));
    expect((screen.getByRole("button", { name: "Switch to sonnet-implementer" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("radio", { name: /opus-planner/ }));
    expect(screen.getByRole("radio", { name: /opus-planner/ }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("button", { name: "Pick another mode" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("selects a same-CLI mode and enables 'Switch to sonnet-implementer'", async () => {
    const { onConfirm } = mount({ kind: "switch" });
    await screen.findByRole("radio", { name: /sonnet-implementer/ });
    await userEvent.click(screen.getByRole("radio", { name: /sonnet-implementer/ }));
    const cta = screen.getByRole("button", { name: "Switch to sonnet-implementer" });
    expect((cta as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(cta);
    expect(lastChoice(onConfirm)).toEqual({
      modeId: "sonnet-implementer",
      channel: "json",
      carryOver: "summary",
      whenBusy: "stop",
      queued: "carry",
    });
  });
});

describe("FreshDialog — busy variant", () => {
  it("returns the default stop + carry choices for a busy agent", async () => {
    const { onConfirm } = mount({ busy: { busy: true, queued: 2 } });
    expect(screen.getByText("The agent is working on a turn.")).toBeTruthy();
    expect(screen.getByText("Stops the running turn first")).toBeTruthy();
    const queued = screen.getByRole("checkbox", { name: /Send the 2 queued messages/ }) as HTMLInputElement;
    expect(queued.checked).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Stop and start fresh" }));
    expect(lastChoice(onConfirm)).toMatchObject({ whenBusy: "stop", queued: "carry" });
  });

  it("hides the queued checkbox at N=0", async () => {
    mount({ busy: { busy: true, queued: 0 } });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("hides the queued checkbox and returns whenBusy=wait after 'Let it finish first'", async () => {
    const { onConfirm } = mount({ busy: { busy: true, queued: 2 } });
    await userEvent.click(screen.getByRole("radio", { name: /Let it finish first/ }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Waits for the current turn")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop and start fresh" }));
    expect(lastChoice(onConfirm)).toMatchObject({ whenBusy: "wait", queued: "carry" });
  });

  it("returns queued=drop when the checkbox is unchecked", async () => {
    const { onConfirm } = mount({ busy: { busy: true, queued: 2 } });
    await userEvent.click(screen.getByRole("checkbox", { name: /Send the 2 queued messages/ }));
    await userEvent.click(screen.getByRole("button", { name: "Stop and start fresh" }));
    expect(lastChoice(onConfirm)).toMatchObject({ queued: "drop" });
  });
});

describe("FreshDialog — terminal sources", () => {
  it("labels Transcript as a rough scrollback export for a tmux terminal", async () => {
    mount({ session: session({ channel: "tmux" }) });
    expect(await screen.findByText(/scrollback export, rough/)).toBeTruthy();
  });

  it("disables Transcript for a plain (non-tmux) terminal", async () => {
    mount({ session: session({ channel: "pty", useTmux: false }) });
    const transcript = (await screen.findByRole("radio", { name: /^Transcript/ })) as HTMLInputElement;
    expect(transcript.disabled).toBe(true);
    expect(screen.getByText("Not available for plain terminals")).toBeTruthy();
  });

  it("offers the Terminal / Rich Chat choice for a terminal source targeting a Rich-Chat CLI", async () => {
    const { onConfirm } = mount({ session: session({ channel: "tmux", modeId: "agy-mode" }) });
    await screen.findByRole("radio", { name: /cursor-plan/ });
    await userEvent.click(screen.getByRole("radio", { name: /cursor-plan/ }));
    await screen.findByRole("group", { name: "Continue as" });
    await userEvent.click(screen.getByRole("button", { name: "Rich Chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(lastChoice(onConfirm).channel).toBe("json");
  });
});
