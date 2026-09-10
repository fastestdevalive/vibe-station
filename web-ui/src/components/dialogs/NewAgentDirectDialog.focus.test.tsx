import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDirectDialog } from "./NewAgentDirectDialog";

/**
 * The mode <Select> renders before the Initial Prompt textarea in DOM order,
 * so Dialog.tsx's generic auto-focus fallback (first input/select/textarea)
 * would land on the dropdown unless the prompt field opts in via
 * `data-autofocus`.
 */
describe("NewAgentDirectDialog — prompt autofocus", () => {
  it("focuses the initial-prompt textarea on open, not the mode dropdown", async () => {
    const api = createMockApi();
    render(
      <NewAgentDirectDialog
        open
        api={api}
        projectId="proj-a"
        projectName="Proj A"
        onClose={() => {}}
      />,
    );

    const prompt = await screen.findByLabelText(/Initial Prompt/i);
    await waitFor(() => expect(prompt).toHaveFocus());
  });
});
