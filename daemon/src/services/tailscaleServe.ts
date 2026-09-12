/**
 * Tailscale serve integration for the Remote Access feature.
 *
 * All functions shell out to the `tailscale` CLI using execFile (arg array, no
 * shell string) with an explicit 15 s timeout — modelled on `git.ts`. The rule
 * is stored by `tailscaled` itself and persists across all restarts, so the
 * daemon stores no tailscale state; it only reads live status on demand.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";

const execFile = promisify(execFileCb);

const TIMEOUT_MS = 15_000;

// `tailscale up` blocks on interactive auth (NeedsLogin), so give it more time
// than the read-only status probes. 20s is passed to tailscale itself as
// --timeout; the execFile kill timeout sits above it at 30s.
const UP_TIMEOUT_MS = 30_000;

export type TailscaleStatus =
  | { state: "not_installed" }
  | { state: "starting" }
  | { state: "not_connected" }
  | { state: "needs_operator"; fixCommand: string }
  | { state: "certs_not_enabled"; dnsName: string }
  | { state: "connected_no_serve"; httpsUrl: string; setupCommand: string }
  | { state: "serve_active"; httpsUrl: string }
  | { state: "port_mismatch"; expectedPort: number; actualPort: number; fixCommand: string }
  | { state: "error"; message: string };

/**
 * Thrown by `disableServe` when the existing serve rule points at a port other
 * than this daemon's — the route maps this to 409 so we never clobber a
 * user's unrelated `tailscale serve` rule.
 */
export class TailscaleRuleNotOursError extends Error {
  readonly actualPort: number;
  constructor(actualPort: number) {
    super(`Tailscale serve rule points to port ${actualPort}, not this daemon's port`);
    this.name = "TailscaleRuleNotOursError";
    this.actualPort = actualPort;
  }
}

interface TailscaleStatusJson {
  BackendState?: string;
  Self?: { DNSName?: string };
  CertDomains?: string[] | null;
}

interface TailscaleServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

interface ServeRead {
  config: TailscaleServeJson | null;
  accessDenied: boolean;
}

function trimTrailingDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

/** Run `tailscale` and return stdout. Throws on ENOENT (not installed) or nonzero exit. */
async function runTailscale(args: string[]): Promise<string> {
  const { stdout } = await execFile("tailscale", args, { timeout: TIMEOUT_MS, encoding: "utf8" });
  return stdout;
}

/** Run `tailscale` capturing both streams (used where stderr carries the signal, e.g. access denied). */
async function runTailscaleCapture(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFile("tailscale", args, { timeout: TIMEOUT_MS, encoding: "utf8" });
  return { stdout, stderr };
}

/**
 * Read `tailscale serve status --json`. Never throws — an unreadable/invalid
 * response degrades to `{ config: null }`, and a stderr containing "access
 * denied" is surfaced via `accessDenied` (the operator-permission signal on
 * Linux).
 */
async function readServeStatus(): Promise<ServeRead> {
  try {
    const { stdout, stderr } = await runTailscaleCapture(["serve", "status", "--json"]);
    const config = stdout.trim() ? (JSON.parse(stdout) as TailscaleServeJson) : null;
    return { config, accessDenied: /access denied/i.test(stderr) };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    return { config: null, accessDenied: /access denied/i.test(stderr) };
  }
}

/**
 * Parse the port out of a serve `Proxy` URL — always by URL parsing, never
 * string-matching (serve config Proxy URLs are not normalized). Falls back to
 * the protocol's default port when none is written explicitly.
 */
function parseProxyPort(proxyUrl: string): number | null {
  try {
    const u = new URL(proxyUrl);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Find the port the `tailscale serve` rule for `:443` proxies to, if any.
 * Scans every `Web` key ending in `:443` and returns the port its `/` handler
 * points at, or null when no such rule exists.
 */
function findServePort(config: TailscaleServeJson | null): number | null {
  if (!config?.Web) return null;
  for (const [key, value] of Object.entries(config.Web)) {
    if (!key.endsWith(":443")) continue;
    const proxy = value?.Handlers?.["/"]?.Proxy;
    if (!proxy) continue;
    const port = parseProxyPort(proxy);
    if (port !== null) return port;
  }
  return null;
}

/** Best-effort read of the MagicDNS name. `Self.DNSName` carries a trailing dot. */
async function getDnsName(): Promise<string> {
  try {
    const out = await runTailscale(["status", "--json"]);
    const json = JSON.parse(out) as TailscaleStatusJson;
    return trimTrailingDot(json.Self?.DNSName ?? "");
  } catch {
    return "";
  }
}

/** Extract the ACME / HTTPS enablement URL from command output, if present. */
function extractTailscaleUrl(text: string): string | null {
  const m = /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(text);
  return m ? m[0] : null;
}

/**
 * Full status detection (GET /tailscale/status). `port` is the current daemon
 * port, used to detect a port-mismatched serve rule.
 */
export async function getStatus(port: number): Promise<TailscaleStatus> {
  // Step 1 — tailscaled reachable / logged in?
  let statusJson: TailscaleStatusJson | null = null;
  try {
    const out = await runTailscale(["status", "--json"]);
    statusJson = JSON.parse(out) as TailscaleStatusJson;
  } catch {
    // ENOENT (not installed) or nonzero exit (tailscaled unreachable) both
    // mean we can't talk to tailscale.
    return { state: "not_installed" };
  }

  const backend = statusJson.BackendState ?? "NoState";
  if (backend === "NoState" || backend === "Starting") {
    return { state: "starting" };
  }
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth" || backend === "Stopped") {
    return { state: "not_connected" };
  }
  if (backend !== "Running") {
    return { state: "not_connected" };
  }

  const dnsName = trimTrailingDot(statusJson.Self?.DNSName ?? "");

  // Step 2 — operator permission (`tailscale serve` needs PermitWrite; Linux only)
  if (process.platform === "linux") {
    const serve = await readServeStatus();
    if (serve.accessDenied) {
      // $USER can be empty when the daemon runs under systemd — fall back to
      // the OS account name so the operator command is still usable.
      const user = process.env.USER || (() => { try { return userInfo().username; } catch { return ""; } })();
      return { state: "needs_operator", fixCommand: `sudo tailscale set --operator=${user}` };
    }
  }

  // Step 3 — HTTPS certs. Pre-enable gate, not a post-serve state.
  const certDomains = statusJson.CertDomains;
  if (!certDomains || certDomains.length === 0) {
    return { state: "certs_not_enabled", dnsName };
  }

  // Step 4 — serve config
  const serve = await readServeStatus();
  const httpsUrl = `https://${dnsName}`;
  const setupCommand = `tailscale serve --bg --yes --https=443 http://127.0.0.1:${port}`;

  const configuredPort = findServePort(serve.config);
  if (configuredPort === null) {
    return { state: "connected_no_serve", httpsUrl, setupCommand };
  }
  if (configuredPort === port) {
    return { state: "serve_active", httpsUrl };
  }
  return {
    state: "port_mismatch",
    expectedPort: port,
    actualPort: configuredPort,
    fixCommand: setupCommand,
  };
}

/**
 * Enable `tailscale serve` for this daemon (POST /tailscale/serve/enable).
 * `--bg` is mandatory — without it the rule is foreground-scoped and dies with
 * the child process. Never trusts the exit code: the rule is confirmed by
 * re-reading `serve status --json` afterwards. Throws on failure; an ACME
 * enablement URL is attached to the error as `.enableUrl` when the certs gate
 * fires during enable.
 */
export async function enableServe(port: number): Promise<{ httpsUrl: string }> {
  let output = "";
  try {
    const res = await runTailscaleCapture(["serve", "--bg", "--yes", "--https=443", `http://127.0.0.1:${port}`]);
    output = `${res.stdout}\n${res.stderr}`;
  } catch (err) {
    // Do NOT trust the exit code — fall through and confirm via serve status.
    // Concat both streams: the ACME enablement URL may appear on stdout.
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }

  const serve = await readServeStatus();
  const dnsName = await getDnsName();
  const httpsUrl = `https://${dnsName}`;

  if (findServePort(serve.config) === port) {
    return { httpsUrl };
  }

  const enableUrl = extractTailscaleUrl(output);
  const err = new Error(`Tailscale serve did not register a rule for port ${port}`);
  if (enableUrl) (err as { enableUrl?: string }).enableUrl = enableUrl;
  throw err;
}

/**
 * Disable `tailscale serve` (POST /tailscale/serve/disable). Refuses (by
 * throwing `TailscaleRuleNotOursError`) when the existing `/` handler points to
 * a port other than this daemon's, so we never clobber a user's own rule.
 * Verifies removal by re-reading serve status.
 */
export async function disableServe(port: number): Promise<void> {
  const serve = await readServeStatus();
  const currentPort = findServePort(serve.config);
  if (currentPort === null) return; // already disabled — nothing to do
  if (currentPort !== port) {
    throw new TailscaleRuleNotOursError(currentPort);
  }

  await runTailscale(["serve", "--https=443", "off"]);

  const after = await readServeStatus();
  if (findServePort(after.config) !== null) {
    throw new Error("Tailscale serve rule was not removed");
  }
}

export interface TailscaleUpResult {
  stdout: string;
  stderr: string;
  exitCode: number; // 0 = success; -1 when killed by timeout
  timedOut: boolean;
  loginUrl: string | null;
}

/**
 * Bring the tailnet interface up (POST /tailscale/up). Deliberately minimal:
 * no `--reset`, no `--ssh`, no `sudo` — preserves the user's existing node
 * config. `tailscale up` blocks on interactive auth (NeedsLogin) and prints an
 * auth URL; that case is NOT an error — it surfaces as `timedOut` with a
 * non-null `loginUrl` that the UI renders as a link. A nonzero exit (or a
 * kill by timeout) still returns a resolved result with the captured output;
 * only an ENOENT / unexpected throw rejects.
 */
export async function runUp(): Promise<TailscaleUpResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let timedOut = false;
  try {
    const res = await execFile("tailscale", ["up", "--timeout=20s"], {
      timeout: UP_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
    exitCode = 0;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = typeof e.code === "number" ? e.code : -1;
    timedOut = e.killed === true || e.signal === "SIGTERM";
  }

  const loginUrl = extractTailscaleUrl(`${stdout}\n${stderr}`);

  return {
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-4000),
    exitCode,
    timedOut,
    loginUrl,
  };
}

/**
 * Read-only snapshot of the current serve rule for the startup port-drift
 * check. Returns null when no `:443` serve rule exists.
 */
export async function getServeStatus(): Promise<{ port: number; httpsUrl: string } | null> {
  const serve = await readServeStatus();
  const port = findServePort(serve.config);
  if (port === null) return null;
  const dnsName = await getDnsName();
  return { port, httpsUrl: `https://${dnsName}` };
}
