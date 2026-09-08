import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { loadDraft } from "@/hooks/useDraftPersistence";
import { NewAgentDialog } from "./NewAgentDialog";

/** Draft persistence (CUJ 1, Decision 1): the prompt survives an accidental
 *  close/reopen, and is cleared only after a successful create. */
describe("NewAgentDialog — draft persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores the typed prompt after close + reopen", async () => {
    const api = createMockApi();
    const { rerender } = render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    const promptField = await screen.findByLabelText(/Initial prompt/i);
    await userEvent.type(promptField, "don't lose this");

    // Wait for the 400ms debounce to flush the write to localStorage.
    await waitFor(
      () => expect(loadDraft("vst-newagent-draft-proj-a")).toBe("don't lose this"),
      { timeout: 1000 },
    );

    // Simulate closing (Escape/outside click) and reopening — the component
    // stays mounted, only `open` toggles (matches LeftSidebar's usage).
    rerender(
      <MemoryRouter>
        <NewAgentDialog open={false} api={api} onClose={() => {}} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const reopenedPrompt = await screen.findByLabelText(/Initial prompt/i);
    await waitFor(() => expect(reopenedPrompt).toHaveValue("don't lose this"));
  });

  it("clears the draft key on a successful create", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    const promptField = await screen.findByLabelText(/Initial prompt/i);
    await userEvent.type(promptField, "fix the thing");

    const submitBtn = await screen.findByRole("button", { name: "Start" });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    await userEvent.click(submitBtn);

    await waitFor(() => expect(loadDraft("vst-newagent-draft-proj-a")).toBe(""));
  });

  it("does NOT clear the draft when a later step in the create flow throws (existing project, Rich Chat)", async () => {
    const api = createMockApi();
    // createDirectSession succeeds, but the subsequent sendJsonFirstTurn call
    // (the LAST thing that can fail in submitExisting's Rich Chat path) rejects
    // — the draft must survive so a retry doesn't lose the typed prompt.
    vi.spyOn(api, "sendChat").mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    await waitFor(() => expect(screen.getByRole("radio", { name: /Rich Chat/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio", { name: /Rich Chat/i }));

    const promptField = await screen.findByLabelText(/Initial prompt/i);
    await userEvent.type(promptField, "don't lose this either");
    await waitFor(
      () => expect(loadDraft("vst-newagent-draft-proj-a")).toBe("don't lose this either"),
      { timeout: 1000 },
    );

    const submitBtn = await screen.findByRole("button", { name: "Start" });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    await userEvent.click(submitBtn);

    // The failure surfaces (dialog stays open for a retry)...
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeInTheDocument());
    // ...and the draft is still there.
    expect(loadDraft("vst-newagent-draft-proj-a")).toBe("don't lose this either");

    errorSpy.mockRestore();
  });
});
