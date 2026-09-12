import { describe, it, expect, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  getStatus,
  enableServe,
  disableServe,
  getServeStatus,
  runUp,
  TailscaleRuleNotOursError,
} from "../services/tailscaleServe.js";

interface ExecRes {
  stdout: string;
  stderr: string;
}

/**
 * Drive the mocked execFile. `handler` inspects the argv and returns either a
 * successful { stdout, stderr } or an Error to reject the promisified call.
 */
function mockTailscale(handler: (args: string[]) => ExecRes | { error: Error }): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, res?: ExecRes) => void,
    ) => {
      const result = handler(args as string[]);
      if (result && "error" in (result as { error?: Error })) {
        cb((result as { error: Error }).error);
      } else {
        cb(null, result as ExecRes);
      }
    },
  );
}

const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "machine.tail0123.ts.net." },
  CertDomains: ["machine.tail0123.ts.net"],
});

function serveConfig(port: number): string {
  return JSON.stringify({
    Web: {
      "machine.tail0123.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } },
    },
  });
}

describe("tailscaleServe.getStatus", () => {
  it("returns not_installed when tailscale is missing (ENOENT / nonzero)", async () => {
    mockTailscale(() => ({ error: new Error("spawn tailscale ENOENT") }));
    expect(await getStatus(7421)).toEqual({ state: "not_installed" });
  });

  it("maps transient BackendState to starting", async () => {
    mockTailscale(() => ({ stdout: JSON.stringify({ BackendState: "Starting" }), stderr: "" }));
    expect(await getStatus(7421)).toEqual({ state: "starting" });
  });

  it("maps login-required BackendState to not_connected", async () => {
    mockTailscale(() => ({ stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" }));
    expect(await getStatus(7421)).toEqual({ state: "not_connected" });
  });

  it("reports needs_operator when serve status stderr says access denied (linux)", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") {
        return { stdout: "", stderr: "tailscale: access denied: need root or operator" };
      }
      return { stdout: RUNNING, stderr: "" };
    });
    const status = await getStatus(7421);
    expect(status.state).toBe("needs_operator");
    if (status.state === "needs_operator") {
      expect(status.fixCommand).toContain("sudo tailscale set --operator=");
    }
  });

  it("reports certs_not_enabled when CertDomains is empty", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: "{}", stderr: "" };
      return {
        stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "m.ts.net." }, CertDomains: [] }),
        stderr: "",
      };
    });
    expect(await getStatus(7421)).toEqual({ state: "certs_not_enabled", dnsName: "m.ts.net" });
  });

  it("reports connected_no_serve when nothing is configured", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: "{}", stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    const status = await getStatus(7421);
    expect(status.state).toBe("connected_no_serve");
    if (status.state === "connected_no_serve") {
      expect(status.httpsUrl).toBe("https://machine.tail0123.ts.net");
      expect(status.setupCommand).toContain("--https=443 http://127.0.0.1:7421");
    }
  });

  it("reports serve_active when the rule proxies the current port", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: serveConfig(7421), stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    expect(await getStatus(7421)).toEqual({
      state: "serve_active",
      httpsUrl: "https://machine.tail0123.ts.net",
    });
  });

  it("reports port_mismatch when the rule proxies a different port (parsed, not string-matched)", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: serveConfig(7422), stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    const status = await getStatus(7421);
    expect(status.state).toBe("port_mismatch");
    if (status.state === "port_mismatch") {
      expect(status.expectedPort).toBe(7421);
      expect(status.actualPort).toBe(7422);
    }
  });
});

describe("tailscaleServe.enableServe", () => {
  it("confirms success by re-reading serve status, not the exit code", async () => {
    // First call (the serve --bg command) "fails" with a nonzero exit; the
    // follow-up serve status read confirms the rule landed anyway.
    mockTailscale((args) => {
      if (args[0] === "serve" && args[1] === "--bg") {
        return { error: new Error("exit code 1") };
      }
      if (args[0] === "serve") return { stdout: serveConfig(7421), stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    expect(await enableServe(7421)).toEqual({ httpsUrl: "https://machine.tail0123.ts.net" });
  });

  it("throws with the ACME enablement URL when the certs gate fires", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve" && args[1] === "--bg") {
        return { stdout: "Visit https://login.tailscale.com/admin/dns#enable-https to enable HTTPS", stderr: "" };
      }
      if (args[0] === "serve") return { stdout: "{}", stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    await expect(enableServe(7421)).rejects.toMatchObject({
      enableUrl: "https://login.tailscale.com/admin/dns#enable-https",
    });
  });
});

describe("tailscaleServe.disableServe", () => {
  it("refuses with TailscaleRuleNotOursError when the rule proxies another port", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: serveConfig(9999), stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    await expect(disableServe(7421)).rejects.toBeInstanceOf(TailscaleRuleNotOursError);
  });

  it("runs serve off and verifies removal", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "serve") return { stdout: "{}", stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    await expect(disableServe(7421)).resolves.toBeUndefined();
  });
});

describe("tailscaleServe.runUp", () => {
  it("spawns exactly ['up', '--timeout=20s'] (no --reset, no --ssh)", async () => {
    execFileMock.mockClear();
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, res?: ExecRes) => void,
      ) => {
        capturedArgs = args as string[];
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const result = await runUp();
    expect(capturedArgs).toEqual(["up", "--timeout=20s"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.loginUrl).toBeNull();
  });

  it("surfaces a login URL and timedOut when tailscale up blocks on auth", async () => {
    execFileMock.mockClear();
    const err = new Error("Command failed: tailscale up") as Error & {
      killed?: boolean; signal?: string; code?: number; stderr?: string; stdout?: string;
    };
    err.killed = true;
    err.signal = "SIGTERM";
    err.code = -1;
    err.stderr = "To authenticate, visit:\nhttps://login.tailscale.com/a/xyz\n";
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res?: ExecRes) => void,
      ) => cb(err),
    );
    const result = await runUp();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.loginUrl).toBe("https://login.tailscale.com/a/xyz");
  });
});

describe("tailscaleServe.getServeStatus", () => {
  it("returns the configured port and URL when a rule exists", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: serveConfig(7421), stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    expect(await getServeStatus()).toEqual({
      port: 7421,
      httpsUrl: "https://machine.tail0123.ts.net",
    });
  });

  it("returns null when no :443 rule exists", async () => {
    mockTailscale((args) => {
      if (args[0] === "serve") return { stdout: "{}", stderr: "" };
      return { stdout: RUNNING, stderr: "" };
    });
    expect(await getServeStatus()).toBeNull();
  });
});
