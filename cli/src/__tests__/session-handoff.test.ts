import { describe, it, expect } from "vitest";
import { registerSessionHandoff } from "../commands/session/handoff.js";
import { Command } from "commander";

describe("session handoff command", () => {
  it("registers a handoff command on the session group", () => {
    const session = new Command();
    registerSessionHandoff(session);

    const handoffCommand = session.commands.find((cmd) => cmd.name() === "handoff");
    expect(handoffCommand).toBeDefined();
    expect(handoffCommand?.description()).toMatch(/handoff/i);
  });

  it("takes a session ID argument", () => {
    const session = new Command();
    registerSessionHandoff(session);

    const handoffCommand = session.commands.find((cmd) => cmd.name() === "handoff");
    expect(handoffCommand).toBeDefined();
    // The usage should include <id>
    const usage = handoffCommand?.usage() || "";
    expect(usage).toContain("id");
  });
});
