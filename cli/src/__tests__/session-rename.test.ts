import { describe, it, expect } from "vitest";
import { registerSessionRename } from "../commands/session/rename.js";
import { Command } from "commander";

describe("session rename command", () => {
  it("registers a rename command on the session group", () => {
    const session = new Command();
    registerSessionRename(session);

    const renameCommand = session.commands.find((cmd) => cmd.name() === "rename");
    expect(renameCommand).toBeDefined();
    expect(renameCommand?.description()).toMatch(/rename/i);
  });

  it("takes session ID and name arguments", () => {
    const session = new Command();
    registerSessionRename(session);

    const renameCommand = session.commands.find((cmd) => cmd.name() === "rename");
    expect(renameCommand).toBeDefined();
    // The usage should include both id and name
    const usage = renameCommand?.usage() || "";
    expect(usage).toContain("id");
    expect(usage).toContain("name");
  });
});
