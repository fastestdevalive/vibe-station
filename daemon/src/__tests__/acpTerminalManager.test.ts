import { describe, it, expect } from "vitest";
import { AcpTerminalManager } from "../services/acp/acpTerminalManager.js";

describe("AcpTerminalManager (1.T2)", () => {
  it("hasLiveTerminals is true while a tracked child runs, false after release", async () => {
    const mgr = new AcpTerminalManager();
    const { terminalId } = mgr.create({ command: "sleep", args: ["5"] });
    expect(mgr.hasLiveTerminals()).toBe(true);
    mgr.release(terminalId);
    expect(mgr.hasLiveTerminals()).toBe(false);
  });

  it("hasLiveTerminals is false once the child exits on its own", async () => {
    const mgr = new AcpTerminalManager();
    const { terminalId } = mgr.create({ command: "node", args: ["-e", "process.exit(0)"] });
    const { exitStatus } = await mgr.waitForExit(terminalId);
    expect(exitStatus.exitCode).toBe(0);
    expect(mgr.hasLiveTerminals()).toBe(false);
  });

  it("output() returns buffered stdout and truncated:false under the byte limit", async () => {
    const mgr = new AcpTerminalManager();
    const { terminalId } = mgr.create({ command: "node", args: ["-e", "process.stdout.write('hello')"] });
    await mgr.waitForExit(terminalId);
    const { output, truncated } = mgr.output(terminalId);
    expect(output).toContain("hello");
    expect(truncated).toBe(false);
  });

  it("kill() force-stops a live child", async () => {
    const mgr = new AcpTerminalManager();
    const { terminalId } = mgr.create({ command: "sleep", args: ["30"] });
    mgr.kill(terminalId);
    const { exitStatus } = await mgr.waitForExit(terminalId);
    expect(exitStatus.signal ?? exitStatus.exitCode).toBeDefined();
  });
});
