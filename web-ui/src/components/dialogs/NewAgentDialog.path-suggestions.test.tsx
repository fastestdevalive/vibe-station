import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { NewAgentDialog } from "./NewAgentDialog";

/**
 * Path-autocomplete + Browse + git-status-hint tests, covering the regressions
 * called out in the opus-review.md for existing-directory-improvements:
 *  - B1: row-index desync between the keyboard model and the rendered rows
 *  - B2: selecting a suggestion keeps the popup open / stays in search mode
 *  - B3: a stale fsComplete/checkFsPath response must not clobber a newer one
 *  - B5: git-hint states, including the request-failure fallback to null
 *
 * The mock filesystem tree (web-ui/src/api/mock.ts, MOCK_HOME = "/home/user"):
 *   /home/user            -> projects, code, work
 *   /home/user/projects   -> proj-a, proj-b
 *   /home/user/code       -> webapp
 *   /home/user/work       -> cloned-repo
 * fsComplete sorts entries alphabetically, so listing "/home/user/" yields
 * ["code", "projects", "work"] in that order.
 */
describe("NewAgentDialog — path suggestions, Browse, git-status hint", () => {
  async function renderDialog(api = createMockApi()) {
    render(
      <MemoryRouter>
        <NewAgentDialog open api={api} onClose={() => {}} />
      </MemoryRouter>,
    );
    const combo = await screen.findByRole("combobox", { name: /Project/i });
    return { api, combo };
  }

  it("renders suggested directories between the add-path row and USE EXISTING", async () => {
    const { combo } = await renderDialog();
    await userEvent.type(combo, "/home/user/");

    await screen.findByText("SUGGESTED DIRECTORIES");
    const listbox = screen.getByRole("listbox");
    const optionTexts = within(listbox)
      .getAllByRole("option")
      .map((el) => el.textContent ?? "");

    const addPathIdx = optionTexts.findIndex((t) => t.includes("Add existing directory"));
    const codeIdx = optionTexts.findIndex((t) => t.includes("/home/user/code"));
    const projectsIdx = optionTexts.findIndex((t) => t.includes("/home/user/projects"));
    const workIdx = optionTexts.findIndex((t) => t.includes("/home/user/work"));

    expect(addPathIdx).toBe(0);
    expect(codeIdx).toBe(1);
    expect(projectsIdx).toBe(2);
    expect(workIdx).toBe(3);
  });

  it("B1 regression: ArrowDown x3 then Enter selects the row the highlight is on, not an offset row", async () => {
    const { combo } = await renderDialog();
    await userEvent.type(combo, "/home/user/");
    await screen.findByText("SUGGESTED DIRECTORIES");

    // Rows: [0] add-path, [1] code, [2] projects, [3] work.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options[3]).toHaveAttribute("aria-selected", "true");
    expect(options[3]!.textContent).toContain("/home/user/work");

    await userEvent.keyboard("{Enter}");

    // Enter must commit the row the highlight is on (idx 3, "work") — a
    // pre-fix index-desync bug would instead select "projects" (idx 2).
    await waitFor(() => expect(combo).toHaveValue("/home/user/work/"));
  });

  it("B2: picking a suggestion keeps the popup open, appends a trailing separator, and stays in search mode", async () => {
    const { combo } = await renderDialog();
    await userEvent.type(combo, "/home/user/");
    const codeOption = await screen.findByText("/home/user/code");
    await userEvent.click(codeOption);

    await waitFor(() => expect(combo).toHaveValue("/home/user/code/"));
    // Still in search mode: the plain <input role="combobox"> is present (an
    // "existing"-mode commit would swap it for a project chip instead), and
    // the popup is still open with fresh suggestions for the new directory.
    expect(screen.getByRole("combobox", { name: /Project/i })).toBeInTheDocument();
    await screen.findByText("/home/user/code/webapp");
  });

  it("B3: a stale fsComplete response does not clobber a newer one", async () => {
    const api = createMockApi();
    const real = api.fsComplete.bind(api);
    let resolveSlow: (() => void) | undefined;
    const spy = vi.spyOn(api, "fsComplete").mockImplementation(async (path: string) => {
      if (path === "/home/user/") {
        // First request — deliberately delayed past the second request.
        await new Promise<void>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return real(path);
    });

    const { combo } = await renderDialog(api);
    await userEvent.type(combo, "/home/user/"); // slow request kicked off, parked

    // Second, faster request supersedes it before the first resolves.
    await userEvent.type(combo, "code/");
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/home/user/code/"));
    await screen.findByText("/home/user/code/webapp");

    // Now let the first (stale) request resolve — it must NOT overwrite the
    // already-current "/home/user/code/" suggestions with "/home/user/"'s.
    resolveSlow?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText("/home/user/code/webapp")).toBeInTheDocument();
    expect(screen.queryByText("/home/user/projects")).not.toBeInTheDocument();
  });

  it("B5: git-hint reflects a detected git repo, and falls back to null (generic copy) on failure", async () => {
    const { api, combo } = await renderDialog();
    // "/home/user/projects" trips the mock's isGit heuristic (path includes
    // "project") and mock.ts marks git dirs as already having commits.
    await userEvent.type(combo, "/home/user/projects");
    const addPathRow = await screen.findByText(/Add existing directory/i);
    // Commit the add-path row (mode → "add-path") so the full hint under the
    // input renders — the popup's subtitle alone isn't the target here.
    await userEvent.click(addPathRow);

    await waitFor(() =>
      expect(screen.getByText(/Registers this directory as a project \(git repository detected\)/i))
        .toBeInTheDocument(),
    );

    // Now force checkFsPath to fail — the hint must fall back to the generic
    // copy (isGitFolder resets to null), not keep stale "git detected" text.
    // Editing the query snaps mode back to "search" (R5) and re-triggers the
    // debounced check against the failing spy.
    vi.spyOn(api, "checkFsPath").mockRejectedValue(new Error("offline"));
    await userEvent.type(combo, "x");
    await userEvent.click(await screen.findByText(/Add existing directory/i));
    await waitFor(() =>
      expect(
        screen.getByText(/Registers this directory and sets up git \(init \+ \.gitignore\)/i),
      ).toBeInTheDocument(),
    );
  });

  it("B5: a non-git directory shows the accurate init+commit hint copy", async () => {
    const { combo } = await renderDialog();
    // "/home/user/work" doesn't match the mock's git heuristic.
    await userEvent.type(combo, "/home/user/work");
    const addPathRow = await screen.findByText(/Add existing directory/i);
    await userEvent.click(addPathRow);
    await waitFor(() =>
      expect(
        screen.getByText(/runs git init, adds a \.gitignore, and makes an initial commit/i),
      ).toBeInTheDocument(),
    );
  });

  it("a trailing separator on an already-registered project's path still surfaces it (no dead-end empty popup)", async () => {
    // Found in manual sandbox verification: selecting a path-suggestion always
    // appends a trailing "/". If the resulting path exactly matches an
    // already-registered project, `alreadyRegistered` (which strips trailing
    // slashes) correctly suppresses the add-path row, but `matchesQuery` (which
    // didn't) failed to substring-match the project's path against the
    // slash-terminated query — zero rows, no way to proceed. Mock project
    // "Proj A" is registered at "/home/dev/proj-a".
    const { combo } = await renderDialog();
    await userEvent.type(combo, "/home/dev/proj-a/");
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("Proj A")).toBeInTheDocument();
    expect(within(listbox).queryAllByRole("option")).toHaveLength(1);
  });

  it("Browse button opens the FolderChooserDialog", async () => {
    await renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Browse/i }));
    expect(await screen.findByRole("dialog", { name: /Choose Directory/i })).toBeInTheDocument();
  });

  /**
   * The flow a directory lands in is decided by the path, never by which
   * control was used to pick it. Reported from the sandbox: choosing a folder
   * that is already a registered project still presented the "register a new
   * project" framing (and, via Browse, left the dialog in search mode with
   * Continue disabled).
   */
  describe("re-resolves the directory regardless of how it was selected", () => {
    it("Browse → Select Folder on a registered project's path adopts that project", async () => {
      await renderDialog();
      await userEvent.click(screen.getByRole("button", { name: /Browse/i }));
      const chooser = await screen.findByRole("dialog", { name: /Choose Directory/i });

      const pathInput = within(chooser).getByPlaceholderText(/Type path/i);
      await userEvent.clear(pathInput);
      await userEvent.type(pathInput, "/home/dev/proj-a");
      await userEvent.click(within(chooser).getByRole("button", { name: /Select Folder/i }));

      // Adopted: the project chip with the REAL project name, not the raw path,
      // and not the add-existing-directory copy.
      expect(await screen.findByText("Proj A")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByText(/Using existing project at \/home\/dev\/proj-a/i)).toBeInTheDocument(),
      );
      expect(screen.queryByText(/Registers this directory/i)).not.toBeInTheDocument();
    });

    it("Browse → Select Folder on an unregistered path drops straight into add-path", async () => {
      await renderDialog();
      await userEvent.click(screen.getByRole("button", { name: /Browse/i }));
      const chooser = await screen.findByRole("dialog", { name: /Choose Directory/i });

      const pathInput = within(chooser).getByPlaceholderText(/Type path/i);
      await userEvent.clear(pathInput);
      await userEvent.type(pathInput, "/home/user/projects/proj-a");
      await userEvent.click(within(chooser).getByRole("button", { name: /Select Folder/i }));

      // Committed to the register-this-directory flow — no lingering popup, and
      // the git-aware hint is what's shown.
      await waitFor(() => expect(screen.getByText(/Registers this directory/i)).toBeInTheDocument());
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("add-path mode self-corrects once the path is known to be a registered project", async () => {
      // Simulates the load race: the user commits to "Add existing directory"
      // before listProjects() resolves, so the add-path row was offered for a
      // path that is in fact already registered. Submitting would 409.
      const api = createMockApi();
      let releaseProjects: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseProjects = resolve;
      });
      const realList = api.listProjects.bind(api);
      vi.spyOn(api, "listProjects").mockImplementation(async () => {
        await gate;
        return realList();
      });

      const { combo } = await renderDialog(api);
      await userEvent.type(combo, "/home/dev/proj-a");

      // Projects haven't loaded, so nothing knows this path is taken yet.
      const addRow = await screen.findByText(/Add existing directory/i);
      await userEvent.click(addRow);
      expect(await screen.findByText(/Registers this directory/i)).toBeInTheDocument();

      releaseProjects();

      // Once the list arrives the dialog corrects itself to the real project.
      expect(await screen.findByText("Proj A")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByText(/Registers this directory/i)).not.toBeInTheDocument(),
      );
    });
  });
});
