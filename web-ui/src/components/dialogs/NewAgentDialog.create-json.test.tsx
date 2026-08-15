import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDialog } from "./NewAgentDialog";

/**
 * Brand-new-project JSON path: register the project WITHOUT a one-shot
 * startAgent (that spawns TTY only), then create the agent on the json channel
 * and send turn 1. Verifies the previously-gated "create" flow now supports JSON.
 */
describe("NewAgentDialog create-new-project JSON path", () => {
  it("createProject (no startAgent) → createDirectSession json → first turn", async () => {
    const api = createMockApi();
    const projSpy = vi.spyOn(api, "createProject");
    const sessSpy = vi.spyOn(api, "createDirectSession");
    const chatSpy = vi.spyOn(api, "sendChat");

    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    // Type a brand-new (non-existing) project name → pick the "create" row.
    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "brand-new-proj");
    await userEvent.click(await screen.findByText(/Create new project "brand-new-proj"/i));

    await screen.findByText("Bugfix"); // modes loaded
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Rich Chat/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));
    await userEvent.type(screen.getByLabelText(/Initial prompt/i), "scaffold it");

    const startBtn = await screen.findByRole("button", { name: /Create & Start/i });
    await waitFor(() => expect(startBtn).not.toBeDisabled());
    await userEvent.click(startBtn);

    // createProject called WITHOUT a startAgent (json wires the agent separately).
    await waitFor(() => expect(projSpy).toHaveBeenCalled());
    expect("startAgent" in projSpy.mock.calls[0]![0]).toBe(false);

    // Then a json direct session + first turn. `prompt` is carried in the
    // create body so the daemon can derive the auto name/initialPrompt from
    // it; `skipAutoTurn` stops it from also enqueueing that as turn 1 (the
    // chat send below is the single source of truth for turn 1 delivery).
    await waitFor(() => expect(sessSpy).toHaveBeenCalled());
    expect(sessSpy.mock.calls[0]![0]).toMatchObject({
      type: "agent",
      channel: "json",
      prompt: "scaffold it",
      skipAutoTurn: true,
    });
    const sess = await sessSpy.mock.results[0]!.value;
    await waitFor(() => expect(chatSpy).toHaveBeenCalledWith(sess.id, "scaffold it", []));
  });
});
