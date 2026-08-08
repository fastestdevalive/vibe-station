import { describe, it, expect } from "vitest";
import { registerWorktreeRename } from "../commands/worktree/rename.js";
import { Command } from "commander";

describe("worktree rename command", () => {
  it("registers a rename command on the worktree group", () => {
    const worktree = new Command();
    registerWorktreeRename(worktree);

    const renameCommand = worktree.commands.find((cmd) => cmd.name() === "rename");
    expect(renameCommand).toBeDefined();
    expect(renameCommand?.description()).toMatch(/rename/i);
  });

  it("takes worktree ID and name arguments", () => {
    const worktree = new Command();
    registerWorktreeRename(worktree);

    const renameCommand = worktree.commands.find((cmd) => cmd.name() === "rename");
    expect(renameCommand).toBeDefined();
    // The usage should include both id and name
    const usage = renameCommand?.usage() || "";
    expect(usage).toContain("id");
    expect(usage).toContain("name");
  });
});
