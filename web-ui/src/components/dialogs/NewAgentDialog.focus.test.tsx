import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDialog } from "./NewAgentDialog";

/**
 * Autofocus the prompt field once a project is selected/locked in, without
 * regressing the project-picker's own autoFocus for the not-yet-selected case.
 */
describe("NewAgentDialog — prompt autofocus", () => {
  it("regression: no project selected yet → focus stays on the project search combobox", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await waitFor(() => expect(combo).toHaveFocus());
  });

  it("a project already selected/locked in → focus moves to the prompt textarea", async () => {
    const api = createMockApi();
    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );

    const combo = await screen.findByRole("combobox", { name: /Project/i });
    await userEvent.type(combo, "Proj A");
    await userEvent.click(await screen.findByText("Proj A"));

    const prompt = await screen.findByLabelText(/Initial prompt/i);
    await waitFor(() => expect(prompt).toHaveFocus());
  });
});
