import { describe, it, expect } from "vitest";
import { registerSessionReset } from "../commands/session/reset.js";
import { Command } from "commander";

describe("session reset command", () => {
  it("registers a reset command on the session group", () => {
    const session = new Command();
    registerSessionReset(session);

    const resetCommand = session.commands.find((cmd) => cmd.name() === "reset");
    expect(resetCommand).toBeDefined();
    expect(resetCommand?.description()).toMatch(/reset/i);
  });

  it("has required options", () => {
    const session = new Command();
    registerSessionReset(session);

    const resetCommand = session.commands.find((cmd) => cmd.name() === "reset");
    expect(resetCommand).toBeDefined();

    const optionNames = resetCommand?.options.map((opt) => opt.name()) || [];
    expect(optionNames).toContain("handoff");
    expect(optionNames).toContain("prompt");
  });
});
