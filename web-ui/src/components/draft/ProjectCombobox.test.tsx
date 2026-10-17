import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import type { Project } from "@/api/types";
import { ProjectCombobox } from "./ProjectCombobox";
import { summarizeFields } from "./draftComposerHelpers";

function makeProject(over: Partial<Project>): Project {
  return {
    id: "p1",
    name: "proj-a",
    path: "/home/dev/proj-a",
    prefix: "pa",
    isGit: true,
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    hidden: false,
    lspEnabled: false,
    ...over,
  };
}

describe("ProjectCombobox", () => {
  let api: MockApi;
  let onSelectExisting: ReturnType<typeof vi.fn>;
  let onNewName: ReturnType<typeof vi.fn>;
  let onAddPath: ReturnType<typeof vi.fn>;
  let onClear: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = createMockApi();
    onSelectExisting = vi.fn();
    onNewName = vi.fn();
    onAddPath = vi.fn();
    onClear = vi.fn();
  });

  function renderCombo(projects: Project[] = api ? [] : []) {
    return render(
      <ProjectCombobox
        api={api as never}
        projects={projects}
        settings={null}
        onSelectExisting={onSelectExisting}
        onNewName={onNewName}
        onAddPath={onAddPath}
        onClear={onClear}
      />,
    );
  }

  it("2.T2 — opens a single listbox with pinned create + Add existing folder outside it; selecting a project calls onSelectExisting; Esc closes", async () => {
    const projects = [makeProject({ id: "p1", name: "Proj A", path: "/home/dev/proj-a" })];
    renderCombo(projects);

    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }));
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    const options = screen.getAllByRole("option");
    expect(options[0]!.textContent).toMatch(/Create new project/);

    // The "required" tag carries the class the narrow-box rule (R1F-03) hides.
    expect(screen.getByText("required").className).toContain("draft-tag--required");

    // "Add existing folder…" is pinned but NOT inside the listbox.
    const addFolder = screen.getByRole("button", { name: /Add existing folder/ });
    expect(addFolder).toBeTruthy();
    expect(addFolder.closest('[role="listbox"]')).toBeNull();

    // Search field is a combobox.
    expect(screen.getByRole("combobox")).toBeTruthy();

    // Esc closes the popover without selecting.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onSelectExisting).not.toHaveBeenCalled();

    // Reopen and select an existing project.
    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }));
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Proj A/ }));
    await waitFor(() => expect(onSelectExisting).toHaveBeenCalledTimes(1));
    expect(onSelectExisting).toHaveBeenCalledWith(projects[0]);
  });

  it("2.T3 — add-existing-directory flow reports git state via the dot + hint", async () => {
    vi.spyOn(api, "checkFsPath").mockResolvedValue({
      exists: true,
      isDirectory: true,
      isGit: false,
      hasCommits: false,
    });
    renderCombo([]);

    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "/tmp/new-dir" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Add existing directory "\/tmp\/new-dir"/ }));

    await waitFor(() => expect(onAddPath).toHaveBeenCalledWith("/tmp/new-dir"));
    // After the git check resolves (isGit false), the hint mentions git init.
    await waitFor(() => {
      expect(screen.getByText(/runs git init/i)).toBeTruthy();
    });
    expect(document.querySelector(".draft-dot--warn")).toBeTruthy();
  });

  it("2.T3b — already-git directory shows the git-repository hint + idle dot", async () => {
    vi.spyOn(api, "checkFsPath").mockResolvedValue({
      exists: true,
      isDirectory: true,
      isGit: true,
      hasCommits: true,
    });
    renderCombo([]);

    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "/tmp/git-dir" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Add existing directory "\/tmp\/git-dir"/ }));

    await waitFor(() => expect(onAddPath).toHaveBeenCalledWith("/tmp/git-dir"));
    await waitFor(() => {
      expect(screen.getByText(/git repository detected/i)).toBeTruthy();
    });
    expect(document.querySelector(".draft-dot--idle")).toBeTruthy();
  });

  it("2.T4 — create-new-project flow: Name/Parent folder rows, then Change returns to search and calls onClear", async () => {
    renderCombo([]);

    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "my-app" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Create new project "my-app"/ }));

    await waitFor(() => expect(onNewName).toHaveBeenCalledWith("my-app", ""));
    expect(screen.getByText("my-app")).toBeTruthy();
    expect(screen.getByText("Parent folder")).toBeTruthy();
    const willCreate = screen.getByText(/Will create/);
    expect(willCreate).toBeTruthy();
    // R1F-13: the "Will create" note is a separate band with its own top padding
    // and bottom divider (draft-row__note).
    expect(willCreate.closest(".draft-row__note")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Choose a project/ })).toBeTruthy();
  });

  it("2.T5 — keyboard: ArrowDown moves aria-activedescendant; Enter on an existing option calls onSelectExisting", async () => {
    const projects = [
      makeProject({ id: "p1", name: "Proj A", path: "/home/dev/proj-a" }),
      makeProject({ id: "p2", name: "Proj B", path: "/home/dev/proj-b" }),
    ];
    renderCombo(projects);

    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }));
    const listbox = await screen.findByRole("listbox");
    const input = screen.getByRole("combobox");

    expect(input.getAttribute("aria-activedescendant")).toBe(`${listbox.id}-0`);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(`${listbox.id}-1`);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSelectExisting).toHaveBeenCalledTimes(1));
    expect(onSelectExisting).toHaveBeenCalledWith(projects[0]);
  });
});

describe("summarizeFields", () => {
  const base = {
    projectName: "vibe-station",
    newProject: false,
    useWorktree: true,
    worktreeChoice: "new" as const,
    existingBranch: null,
    baseBranch: "main",
  };

  it("2.T1 — new worktree from main", () => {
    expect(summarizeFields(base)).toBe("vibe-station · new worktree · from main");
  });

  it("2.T1 — project folder when not using a worktree", () => {
    expect(summarizeFields({ ...base, useWorktree: false })).toBe("vibe-station · project folder");
  });

  it("2.T1 — no project name falls back to Choose a project", () => {
    expect(summarizeFields({ ...base, projectName: null })).toBe("Choose a project · new worktree · from main");
  });

  it("2.T1 — existing worktree with a branch", () => {
    expect(summarizeFields({ ...base, worktreeChoice: "existing", existingBranch: "fix-x" })).toBe(
      "vibe-station · fix-x",
    );
  });
});
