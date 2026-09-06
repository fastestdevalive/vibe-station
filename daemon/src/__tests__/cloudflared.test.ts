import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let logPath: string;
let nextPid = 1000;

class FakeChild extends EventEmitter {
  pid: number;
  kill = vi.fn();
  unref = vi.fn();
  constructor() {
    super();
    this.pid = nextPid++;
  }
}

let spawnedChildren: FakeChild[] = [];
const spawnMock = vi.fn(() => {
  const child = new FakeChild();
  spawnedChildren.push(child);
  return child;
});
// Default: `ps` reports every persisted pid "looks like" cloudflared, and
// `pgrep` finds no orphans — so existing tests that don't care about the
// identity check or the sweep keep passing unmodified. Individual tests
// override this to exercise the "pid reused by something else" (B2) or
// "sweep found orphans" paths.
const execFileSyncMock = vi.fn((cmd: string) => (cmd === "pgrep" ? "" : "cloudflared\n"));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock("../services/paths.js", async () => {
  const { join: pathJoin } = await import("node:path");
  return {
    vstHome: () => tempDir,
    dbPath: () => pathJoin(tempDir, "vibe-station.db"),
    cloudflaredLogPath: () => logPath,
  };
});

async function writeUrlToLog(url: string) {
  await appendFile(logPath, `some cloudflared banner text\n${url}\nmore text\n`);
}

describe("cloudflared", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vst-cloudflared-test-"));
    logPath = join(tempDir, "cloudflared.log");
    await writeFile(logPath, "");
    spawnedChildren = [];
    spawnMock.mockClear();
    execFileSyncMock.mockClear();
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "" : "cloudflared\n"));
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("2.T1 — enable() resolves with the scraped URL and stops polling afterward", async () => {
    const cf = await import("../services/cloudflared.js");
    const promise = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://abc-def.trycloudflare.com");
    const result = await vi.advanceTimersByTimeAsync(500).then(() => promise);
    expect(result.tunnelUrl).toBe("https://abc-def.trycloudflare.com");

    // No further scraping after resolve — write a NEW url, advance time, state must not change.
    await writeUrlToLog("https://should-not-match.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(1000);
    expect(cf.getState().tunnelUrl).toBe("https://abc-def.trycloudflare.com");
  });

  it("2.T2 — a stale URL already in the log from a prior spawn is truncated away, not matched", async () => {
    await writeUrlToLog("https://stale-old.trycloudflare.com");
    const cf = await import("../services/cloudflared.js");
    const promise = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(500);
    // spawnTunnel truncates the log file at spawn time — the stale URL is gone,
    // so nothing has matched yet even though time has passed.
    let settled = false;
    void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await writeUrlToLog("https://fresh-new.trycloudflare.com");
    const result = await vi.advanceTimersByTimeAsync(500).then(() => promise);
    expect(result.tunnelUrl).toBe("https://fresh-new.trycloudflare.com");
  });

  it("2.T3 — enable() persists to tunnel-store on success; disable() clears fully; shutdownKill() keeps enabled", async () => {
    const cf = await import("../services/cloudflared.js");
    const store = await import("../state/tunnel-store.js");
    const promise = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://persisted.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(500).then(() => promise);

    expect(store.getState().enabled).toBe(true);
    expect(store.getState().currentUrl).toBe("https://persisted.trycloudflare.com");

    cf.disable(7421);
    expect(store.getState().enabled).toBe(false);
    expect(store.getState().currentUrl).toBeNull();

    // Re-enable then shutdownKill — enabled must stay true.
    const promise2 = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://second.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(500).then(() => promise2);
    cf.shutdownKill();
    expect(store.getState().enabled).toBe(true);
    expect(store.getState().currentUrl).toBeNull();
  });

  it("2.T4 — a late exit event for a superseded child does not clobber the newer (live) process's state", async () => {
    const cf = await import("../services/cloudflared.js");

    const promiseA = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://process-a.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(500).then(() => promiseA);
    const childA = spawnedChildren[0]!;

    cf.disable(7421); // kills A in-memory tracking (state.process cleared)

    const promiseB = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://process-b.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(500).then(() => promiseB);

    expect(cf.getState().tunnelUrl).toBe("https://process-b.trycloudflare.com");

    // A's exit event arrives late — must be a no-op against B's live state.
    childA.emit("exit", 0);
    expect(cf.getState().tunnelUrl).toBe("https://process-b.trycloudflare.com");
    expect(cf.getState().enabled).toBe(true);
  });

  it("2.T4b — an ENOENT error rejects immediately with the vst-doctor hint, not after the 10s timeout", async () => {
    const cf = await import("../services/cloudflared.js");
    const promise = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    const child = spawnedChildren[0]!;
    const err = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
    child.emit("error", err);
    await expect(promise).rejects.toThrow(/run: vst doctor/);
  });

  it("2.T4c — exit before any URL match rejects with a specific message and stops polling", async () => {
    const cf = await import("../services/cloudflared.js");
    const promise = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    const child = spawnedChildren[0]!;
    child.emit("exit", 1);
    await expect(promise).rejects.toThrow(/before emitting URL/);
  });

  it("2.T5 — restoreOnBoot no-ops (never spawns) when noAuth is true or token is missing", async () => {
    const cf = await import("../services/cloudflared.js");
    await cf.restoreOnBoot(7421, { noAuth: true, token: "x" });
    expect(spawnMock).not.toHaveBeenCalled();
    await cf.restoreOnBoot(7421, { noAuth: false, token: undefined });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("2.T6 — restoreOnBoot does not spawn when persisted state is enabled:false", async () => {
    const cf = await import("../services/cloudflared.js");
    await cf.restoreOnBoot(7421, { noAuth: false, token: "x" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("2.T7 — restoreOnBoot kills the recorded pid before spawning, and swallows an ESRCH-style error", async () => {
    const cf = await import("../services/cloudflared.js");
    const store = await import("../state/tunnel-store.js");
    store.setState({ enabled: true, currentUrl: "https://old.trycloudflare.com", currentPid: 99999, startedAt: 1, port: 7421 });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = Object.assign(new Error("no such process"), { code: "ESRCH" });
      throw err;
    });

    const promise = cf.restoreOnBoot(7421, { noAuth: false, token: "x" });
    // Identity is checked (via `ps`, mocked to report "cloudflared") before the kill.
    expect(execFileSyncMock).toHaveBeenCalledWith("ps", ["-o", "comm=", "-p", "99999"], expect.anything());
    expect(killSpy).toHaveBeenCalledWith(99999, "SIGTERM");

    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://restored.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(cf.getState().tunnelUrl).toBe("https://restored.trycloudflare.com");
    killSpy.mockRestore();
  });

  it("B2 — restoreOnBoot does NOT kill a persisted pid that ps reports as a different process", async () => {
    execFileSyncMock.mockReturnValue("some-unrelated-daemon\n");
    const cf = await import("../services/cloudflared.js");
    const store = await import("../state/tunnel-store.js");
    store.setState({ enabled: false, currentUrl: null, currentPid: 55555, startedAt: 1, port: 7421 });

    const killSpy = vi.spyOn(process, "kill");
    await cf.restoreOnBoot(7421, { noAuth: false, token: "x" });

    expect(execFileSyncMock).toHaveBeenCalledWith("ps", ["-o", "comm=", "-p", "55555"], expect.anything());
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("B1 — disable() during an in-flight spawn cancels it instead of leaving pending wedged", async () => {
    const cf = await import("../services/cloudflared.js");
    const store = await import("../state/tunnel-store.js");

    const firstEnable = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Disable while cloudflared is still "starting" (no URL scraped yet).
    cf.disable(7421);
    await expect(firstEnable).rejects.toThrow(/tunnel disabled/);

    // A second enable() must actually spawn again immediately — not reuse the
    // (now-rejected) `pending` promise or wait out the rest of the 10s timeout.
    const secondEnable = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await writeUrlToLog("https://second-attempt.trycloudflare.com");
    const result = await vi.advanceTimersByTimeAsync(500).then(() => secondEnable);
    expect(result.tunnelUrl).toBe("https://second-attempt.trycloudflare.com");

    // The cancelled first attempt's poll must be dead — advancing well past
    // its original 10s timeout must not write a phantom "enabled" state for
    // the (already-killed) first child.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().currentPid).toBe(spawnedChildren[1]!.pid);
  });

  // --- Orphan reconciliation sweep (cloudflared-orphan-sweep) ---

  it("S1 — enable() sweeps orphans found via pgrep (SIGTERM, port-scoped, $-anchored pattern) before spawning", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "111\n222\n" : "cloudflared\n"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const cf = await import("../services/cloudflared.js");

    cf.enable(7421);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "pgrep",
      ["-f", "cloudflared tunnel --url http://127\\.0\\.0\\.1:7421$"],
      expect.anything(),
    );
    expect(killSpy).toHaveBeenCalledWith(111, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(222, "SIGTERM");
    // Sweep (enumerate + SIGTERM) happens synchronously before spawn — no window
    // where old and new tunnels are briefly both alive (report § Proposed).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    killSpy.mockRestore();
  });

  it("S2 — enable()'s already-enabled early return does NOT sweep (must not kill the live tunnel it reports as healthy)", async () => {
    const cf = await import("../services/cloudflared.js");
    const promise = cf.enable(7421);
    await vi.advanceTimersByTimeAsync(0);
    await writeUrlToLog("https://already-live.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(500).then(() => promise);

    execFileSyncMock.mockClear();
    const killSpy = vi.spyOn(process, "kill");

    const result = await cf.enable(7421);
    expect(result.tunnelUrl).toBe("https://already-live.trycloudflare.com");
    expect(execFileSyncMock).not.toHaveBeenCalledWith("pgrep", expect.anything(), expect.anything());
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("S3 — disable(port) sweeps orphans found via pgrep before the existing tracked-process cleanup", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "333\n" : "cloudflared\n"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const cf = await import("../services/cloudflared.js");
    const store = await import("../state/tunnel-store.js");

    cf.disable(7421);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "pgrep",
      ["-f", "cloudflared tunnel --url http://127\\.0\\.0\\.1:7421$"],
      expect.anything(),
    );
    expect(killSpy).toHaveBeenCalledWith(333, "SIGTERM");
    // Existing clear-on-disable behavior is unchanged (additive, not a replacement).
    expect(store.getState().enabled).toBe(false);
    killSpy.mockRestore();
  });

  it("S4 — restoreOnBoot() sweeps via pgrep before the existing persisted-pid kill, even before the noAuth/token guard", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "444\n" : "cloudflared\n"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const cf = await import("../services/cloudflared.js");

    await cf.restoreOnBoot(7421, { noAuth: true, token: "x" });

    // Sweep ran even though noAuth short-circuits the rest of restore.
    expect(killSpy).toHaveBeenCalledWith(444, "SIGTERM");
    expect(spawnMock).not.toHaveBeenCalled();

    // Call order: the sweep's pgrep call precedes any ps-based identity check.
    const cmds = execFileSyncMock.mock.calls.map((call) => call[0]);
    expect(cmds.indexOf("pgrep")).toBeLessThan(cmds.includes("ps") ? cmds.indexOf("ps") : Infinity);
    killSpy.mockRestore();
  });

  it("S5 — pgrep exiting with status 1 (no matches) is treated as zero orphans, not an error", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "pgrep") {
        throw Object.assign(new Error("no processes matched"), { status: 1 });
      }
      return "cloudflared\n";
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const killSpy = vi.spyOn(process, "kill");
    const cf = await import("../services/cloudflared.js");

    cf.enable(7421);

    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/pgrep enumeration failed/));
    killSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("S6 — a non-1-status pgrep failure is logged and treated as zero orphans, never throws", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "pgrep") {
        throw Object.assign(new Error("pgrep: command not found"), { status: 127 });
      }
      return "cloudflared\n";
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cf = await import("../services/cloudflared.js");

    expect(() => cf.disable(7421)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("pgrep enumeration failed"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("S7 — a pid still alive after the grace period is escalated to SIGKILL (identity-checked)", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "555\n" : "cloudflared\n"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      // SIGTERM "succeeds" but the process stays alive (kill(pid, 0) keeps not throwing).
      if (signal === "SIGKILL") return true;
      return true;
    });
    const cf = await import("../services/cloudflared.js");

    cf.disable(7421);
    expect(killSpy).toHaveBeenCalledWith(555, "SIGTERM");
    killSpy.mockClear();

    await vi.advanceTimersByTimeAsync(2000);
    expect(killSpy).toHaveBeenCalledWith(555, "SIGKILL");
    killSpy.mockRestore();
  });

  it("S8 — a pid that's already dead by the grace-period check is NOT escalated to SIGKILL", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "666\n" : "cloudflared\n"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      // The liveness probe (signal === 0) reports the process is already gone.
      if (signal === 0) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    });
    const cf = await import("../services/cloudflared.js");

    cf.disable(7421);
    killSpy.mockClear();

    await vi.advanceTimersByTimeAsync(2000);
    expect(killSpy).not.toHaveBeenCalledWith(666, "SIGKILL");
    killSpy.mockRestore();
  });

  it("S9 — the escalation timer is unref'd so it can never keep the daemon process alive", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => (cmd === "pgrep" ? "777\n" : "cloudflared\n"));
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const cf = await import("../services/cloudflared.js");

    // sweepOrphans calls `.unref()` on the setTimeout return value synchronously —
    // if the escalation timer weren't unref'd (or didn't expose `.unref()` at
    // all under vitest's fake timers), this call would throw a TypeError.
    expect(() => cf.disable(7421)).not.toThrow();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
  });
});
