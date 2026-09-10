import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { loadDraft } from "@/hooks/useDraftPersistence";
import { NewAgentDialog } from "./NewAgentDialog";

/** Draft persistence (CUJ 1, Decision 1): the prompt survives an accidental
 *  close/reopen, and is cleared only after a successful create.
 *
 *  Technique note: jsdom cannot type prose into a Lexical contenteditable (no
 *  working `beforeinput` — see SkillEditor.test.tsx), so the tests seed the
 *  draft into localStorage and drive it into the live editor via the
 *  close/reopen restore path, then mutate it through the chip-arg input — the
 *  repo's established in-jsdom route into OnChangePlugin. */
describe("NewAgentDialog — draft persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores the saved draft after close + reopen", async () => {
    const api = createMockApi();
    localStorage.setItem("vst-newagent-draft-proj-a", "don't lose this");
    const { rerender } = render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));
    await screen.findByLabelText(/Initial prompt/i);

    // Simulate closing (Escape/outside click) and reopening — the component
    // stays mounted, only `open` toggles (matches LeftSidebar's usage). The
    // still-selected project keeps draftKey = proj-a, so the open-restore
    // effect reloads the saved draft and remounts a freshly seeded editor.
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
    await waitFor(() => expect(reopenedPrompt).toHaveTextContent("don't lose this"), { timeout: 1000 });
  });

  it("keeps saving edits to the draft once the editor has content", async () => {
    const api = createMockApi();
    // Seed a skill chip — the only in-jsdom input (chip args are real <input>s
    // wired into Lexical state; prose typing into the contenteditable isn't
    // supported by jsdom, see file header).
    localStorage.setItem("vst-newagent-draft-proj-a", "{/code-review high}");
    const { rerender } = render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    // Reopen to restore the seeded chip into the live editor.
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

    const arg = await screen.findByLabelText("Arguments for code-review");
    expect(arg).toHaveValue("high");

    // Mutating the arg fires OnChangePlugin → onChangeText → prompt state →
    // (debounced) draft.save.
    fireEvent.change(arg, { target: { value: "high2" } });
    await waitFor(
      () => expect(loadDraft("vst-newagent-draft-proj-a")).toBe("{/code-review high2}"),
      { timeout: 1000 },
    );
  });

  it("clears the draft key on a successful create", async () => {
    const api = createMockApi();
    localStorage.setItem("vst-newagent-draft-proj-a", "fix the thing");
    const { rerender } = render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));
    await screen.findByLabelText(/Initial prompt/i);

    // Load the saved draft into the editor (see first test) so the cleared
    // draft is the very prompt being submitted.
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
    await screen.findByLabelText(/Initial prompt/i);

    const submitBtn = await screen.findByRole("button", { name: "Start" });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    await userEvent.click(submitBtn);

    await waitFor(() => expect(loadDraft("vst-newagent-draft-proj-a")).toBe(""));
  });

  it("surfaces a create failure and keeps the draft for a retry", async () => {
    const api = createMockApi();
    // createWorktree (the LAST thing that can fail structurally after the user
    // clicks Start for an existing git project — Rich Chat, worktree on) rejects
    // — the dialog must show the error and the draft must survive for a retry.
    vi.spyOn(api, "createWorktree").mockRejectedValue(new Error("disk full"));

    const { rerender } = render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));
    await screen.findByLabelText(/Initial prompt/i);

    localStorage.setItem("vst-newagent-draft-proj-a", "don't lose this either");
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
    await screen.findByLabelText(/Initial prompt/i);

    const submitBtn = await screen.findByRole("button", { name: "Start" });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
    await userEvent.click(submitBtn);

    // The failure surfaces (dialog stays open for a retry)...
    await waitFor(() => expect(screen.getByText(/disk full/i)).toBeInTheDocument());
    // ...and the draft is still there.
    expect(loadDraft("vst-newagent-draft-proj-a")).toBe("don't lose this either");
  });
});