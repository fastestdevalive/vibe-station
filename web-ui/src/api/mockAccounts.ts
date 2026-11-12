import { ApiError } from "./errors";
import type {
  AccountErrorCode,
  AccountFolderBody,
  AccountLink,
  AccountSummary,
  AccountUsage,
  AddFolderAccountResponse,
  CreateApiKeyAccountBody,
  FinishSignInBody,
  LimitsResult,
  RemoveAccountResponse,
  SignInState,
  SignInSteps,
  StartSignInBody,
  StartSignInResponse,
  ValidateAccountPathResponse,
  WSEvent,
} from "./types";

/**
 * In-memory accounts API for mock mode and the dev state simulator (precedent:
 * `mockArtifacts.ts`). Every fixture and every account mutation lives here;
 * `mock.ts` only delegates to it.
 *
 * Fixture (plan B1.3):
 *   claude: System "me@personal.dev" Max (default), "Work" gaurav@acme.io Team
 *           (limited on five_hour), "gb@side.dev" Pro (email-named), "Client B"
 *           signed out
 *   codex:  System only
 *   cursor: System + an api_key account "Key"
 *   opencode / omp / pi: System only
 *   agy:    supportsAccounts:false with a visible reason (the one allowed
 *           shortfall — see docs/MULTI-ACCOUNT.md)
 */

/** Stable fixture ids (the module-level `mockLimits` fixture refers to them). */
const CLAUDE_WORK_ID = "acc_1a2b3c4d";
const CLAUDE_SIDE_ID = "acc_2b3c4d5e";
const CLAUDE_CLIENT_B_ID = "acc_3c4d5e6f";
const CURSOR_KEY_ID = "acc_4d5e6f70";
const CLAUDE_CLIENT_B_DIR = "~/.vibe-station/accounts/claude/client-b";

/** How long the mock's simulated vendor login takes before `account:signin`
 *  turns `done` (the real flow waits for the login Terminal to exit). */
const SIGN_IN_DONE_MS = 600;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Account capabilities the mock reports on `GET /supported-clis` (R3: the UI
 *  reads these flags, never a harness name). Mirrors the plugin table. */
export interface MockAccountCapabilities {
  supportsAccounts: boolean;
  accountSwitch: "native" | "transcript" | "none";
  accountsNote: string | null;
  accountLink: AccountLink | null;
}

const CLAUDE_FIRST_RUN_NOTE =
  "The first Terminal agent in a new Claude folder opens Claude's own first-run setup (theme, folder trust). Answer it once in the terminal. Rich Chat agents skip it.";

const XDG_NOTE =
  "This is an XDG root: tools such as gh and git read their config from it, so a new folder hides that from the agent.";

/** Folder-field copy per harness (A1a.5 table, mirrored here as data only). */
function accountLinkFor(
  fieldLabel: string,
  fieldNote: string | null,
  exampleDir: string,
  systemDir: string,
  supportsApiKey: boolean,
  verifiesIdentity: boolean,
  firstRunNote: string | null = null,
): AccountLink {
  return { fieldLabel, fieldNote, exampleDir, systemDir, supportsApiKey, verifiesIdentity, firstRunNote };
}

const CAPABILITIES: Record<string, MockAccountCapabilities> = {
  claude: {
    supportsAccounts: true,
    accountSwitch: "native",
    accountsNote: null,
    accountLink: accountLinkFor("Claude config folder", null, "~/.claude-work", "~/.claude", true, true, CLAUDE_FIRST_RUN_NOTE),
  },
  codex: {
    supportsAccounts: true,
    accountSwitch: "native",
    accountsNote: null,
    accountLink: accountLinkFor("Codex home folder", null, "~/.codex-work", "~/.codex", true, true),
  },
  cursor: {
    supportsAccounts: true,
    accountSwitch: "transcript",
    accountsNote: null,
    accountLink: accountLinkFor("XDG root folder", XDG_NOTE, "~/cursor-work-config", "~/.config", true, true),
  },
  opencode: {
    supportsAccounts: true,
    accountSwitch: "transcript",
    accountsNote: null,
    accountLink: accountLinkFor("XDG root folder", XDG_NOTE, "~/opencode-work-data", "~/.local/share", false, true),
  },
  omp: {
    supportsAccounts: true,
    accountSwitch: "native",
    accountsNote: null,
    accountLink: accountLinkFor("Agent folder", null, "~/.omp-work", "~/.omp/agent", false, false),
  },
  pi: {
    supportsAccounts: true,
    accountSwitch: "native",
    accountsNote: null,
    accountLink: accountLinkFor("Agent folder", null, "~/.pi-work", "~/.pi/agent", false, false),
  },
  agy: {
    supportsAccounts: false,
    accountSwitch: "none",
    accountsNote:
      "agy keeps its login under the whole home directory; a separate login would hide your ssh and git setup from the agent, so multiple agy accounts are not supported yet.",
    accountLink: null,
  },
};

/** Capabilities for a CLI id; unknown ids support nothing (fixture data only). */
export function accountCapabilitiesFor(cli: string): MockAccountCapabilities {
  return CAPABILITIES[cli] ?? { supportsAccounts: false, accountSwitch: "none", accountsNote: null, accountLink: null };
}

/** Mock-only: the env var that points a harness at its account folder, and
 *  the login command shown in sign-in steps. Lives here, not in the UI. */
const MOCK_HARNESS_LOGIN: Record<string, { env: string; login: string }> = {
  claude: { env: "CLAUDE_CONFIG_DIR", login: "claude auth login" },
  codex: { env: "CODEX_HOME", login: "codex login" },
  cursor: { env: "XDG_CONFIG_HOME", login: "cursor-agent login" },
  opencode: { env: "XDG_DATA_HOME", login: "opencode auth login" },
  omp: { env: "PI_CODING_AGENT_DIR", login: "omp" },
  pi: { env: "PI_CODING_AGENT_DIR", login: "pi" },
};

/** Where vibe-station creates managed account folders (display form). */
const ACCOUNTS_ROOT = "~/.vibe-station/accounts";

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** System login = virtual, one per CLI (`id: "system"`, no folder). */
function systemRow(cli: string, over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "system",
    cli,
    label: null,
    displayName: "System login",
    email: null,
    plan: null,
    method: "system",
    auth: "unknown",
    isDefault: true,
    limited: null,
    createdAt: null,
    dir: null,
    createdByUs: false,
    ...over,
  };
}

/** Server-computed display name: label ?? email ?? folder name ?? id; System
 *  => "System login" unless labelled. */
function displayNameFor(a: Pick<AccountSummary, "id" | "label" | "email" | "dir">): string {
  if (a.label) return a.label;
  if (a.id === "system") return "System login";
  return a.email ?? ((a.dir ? lastSegment(a.dir) : "") || a.id);
}

/** `"system"` / `""` / absent => null (the CLI's System login). */
function normalizeAccountId(id: string | null | undefined): string | null {
  if (!id || id === "system") return null;
  return id;
}

function fixtureAccounts(): AccountSummary[] {
  return [
    systemRow("claude", { email: "me@personal.dev", plan: "Max", auth: "signed_in" }),
    {
      id: CLAUDE_WORK_ID,
      cli: "claude",
      label: "Work",
      displayName: "Work",
      email: "gaurav@acme.io",
      plan: "Team",
      method: "sign_in",
      auth: "signed_in",
      isDefault: false,
      limited: { windowId: "five_hour", resetsAt: inMs(2 * HOUR), source: "poller" },
      createdAt: ago(60 * DAY),
      dir: `${ACCOUNTS_ROOT}/claude/work`,
      createdByUs: true,
    },
    {
      id: CLAUDE_SIDE_ID,
      cli: "claude",
      label: null,
      displayName: "gb@side.dev",
      email: "gb@side.dev",
      plan: "Pro",
      method: "sign_in",
      auth: "signed_in",
      isDefault: false,
      limited: null,
      createdAt: ago(30 * DAY),
      dir: "~/.claude-side",
      createdByUs: false,
    },
    {
      id: CLAUDE_CLIENT_B_ID,
      cli: "claude",
      label: "Client B",
      displayName: "Client B",
      email: null,
      plan: null,
      method: "sign_in",
      auth: "signed_out",
      isDefault: false,
      limited: null,
      createdAt: ago(10 * DAY),
      dir: CLAUDE_CLIENT_B_DIR,
      createdByUs: true,
      signIn: { command: `CLAUDE_CONFIG_DIR=${CLAUDE_CLIENT_B_DIR} claude auth login`, hint: null },
    },
    systemRow("codex", { auth: "signed_in" }),
    systemRow("cursor", { auth: "signed_in" }),
    {
      id: CURSOR_KEY_ID,
      cli: "cursor",
      label: "Key",
      displayName: "Key",
      email: null,
      plan: null,
      method: "api_key",
      auth: "signed_in",
      isDefault: false,
      limited: null,
      createdAt: ago(20 * DAY),
      dir: `${ACCOUNTS_ROOT}/cursor/key`,
      createdByUs: true,
    },
    systemRow("opencode"),
    systemRow("omp"),
    systemRow("pi"),
  ];
}

/**
 * Per-account harness-limits results appended to the mock's `limits` snapshot
 * (mirrors what the daemon sends: one result per account, System first within
 * a harness). `Work` is at its five-hour limit so the banner/switch surfaces
 * have data in mock mode.
 */
export function mockAccountLimitResults(): LimitsResult[] {
  const now = new Date().toISOString();
  return [
    {
      harness: "claude",
      accountId: CLAUDE_WORK_ID,
      status: "ok",
      message: null,
      asOf: now,
      windows: [
        {
          harness: "claude",
          accountId: CLAUDE_WORK_ID,
          windowId: "five_hour",
          cadenceMinutes: 300,
          usedPct: 100,
          resetsAt: inMs(2 * HOUR),
          asOf: now,
          status: "ok",
        },
        {
          harness: "claude",
          accountId: CLAUDE_WORK_ID,
          windowId: "seven_day",
          cadenceMinutes: 10080,
          usedPct: 88,
          resetsAt: inMs(2 * DAY),
          asOf: now,
          status: "ok",
        },
      ],
    },
    {
      harness: "claude",
      accountId: CLAUDE_SIDE_ID,
      status: "ok",
      message: null,
      asOf: now,
      windows: [
        {
          harness: "claude",
          accountId: CLAUDE_SIDE_ID,
          windowId: "five_hour",
          cadenceMinutes: 300,
          usedPct: 12,
          resetsAt: inMs(2 * HOUR),
          asOf: now,
          status: "ok",
        },
      ],
    },
  ];
}

/** Deterministic `acc_` + 8 lowercase hex (the wire contract's id shape). */
function nextAccountId(seq: number): string {
  return `acc_${(0x5a5a0000 + seq).toString(16).padStart(8, "0")}`;
}

/** The account part of a reset/switch, resolved from the session + request body
 *  (plan Decision 7). Throws the daemon's 400 `already_on_account`. Lives here
 *  so `mock.ts` only applies the plan — no accounts logic in that file. */
export interface MockAccountSwitchPlan {
  fromAccountId: string | null;
  toAccountId: string | null;
  /** True when the request carried an explicit `accountId` (an account switch). */
  explicit: boolean;
  /** The mock's hand-over choice: Rich Chat carries the transcript, Terminal
   *  starts fresh (the real daemon decides per plugin). */
  handover: "native" | "transcript" | "fresh" | null;
}

export function mockAccountSwitchPlan(
  sessionAccountId: string | null | undefined,
  requestedAccountId: string | undefined,
  channel: string | undefined,
): MockAccountSwitchPlan {
  const fromAccountId = sessionAccountId ?? null;
  if (requestedAccountId === undefined) {
    return { fromAccountId, toAccountId: fromAccountId, explicit: false, handover: null };
  }
  const toAccountId = normalizeAccountId(requestedAccountId);
  if (toAccountId === fromAccountId) {
    throw new ApiError(
      JSON.stringify({ error: "Already on that account", code: "already_on_account" }),
      400,
      "already_on_account",
    );
  }
  return {
    fromAccountId,
    toAccountId,
    explicit: true,
    handover: channel === "json" ? "transcript" : "fresh",
  };
}

/** Display names for a break marker's `fromAccount`/`toAccount` (System rows
 *  are per CLI, so the CLI narrows the lookup). */
export function mockAccountNames(
  accounts: AccountSummary[],
  plan: MockAccountSwitchPlan,
  fromCli: string | undefined,
  toCli: string | undefined,
): { fromAccount?: string; toAccount?: string } {
  const name = (accountId: string | null, cli: string | undefined) =>
    accounts.find((a) => a.id === (accountId ?? "system") && a.cli === cli)?.displayName ??
    accounts.find((a) => a.id === (accountId ?? "system"))?.displayName;
  const fromAccount = name(plan.fromAccountId, fromCli);
  const toAccount = name(plan.toAccountId, toCli);
  return { ...(fromAccount ? { fromAccount } : {}), ...(toAccount ? { toAccount } : {}) };
}

/** True when a string carries a C0/C1 control character (label/key hygiene). */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Label rules mirror the daemon's: trimmed, 1..=40 chars, no control chars. */
function normalizeLabel(raw: string): string {
  const label = raw.trim();
  if (label.length === 0 || label.length > 40 || hasControlChars(label)) {
    throw new ApiError(JSON.stringify({ error: "Enter a name for this account.", code: "label_required" }), 400, "label_required");
  }
  return label;
}

/** Case-insensitive, against each row's effective display name (Risk 15: the
 *  System row's "System login" is reserved unless System itself was renamed). */
function labelTaken(accounts: AccountSummary[], cli: string, label: string, exceptId?: string): boolean {
  const lower = label.toLowerCase();
  return accounts.some(
    (a) => a.cli === cli && a.id !== exceptId && displayNameFor(a).toLowerCase() === lower,
  );
}

/** A sign-in needs a worktree to host its login Terminal (assumption A3); a
 *  blank id is the contract's 404 `worktree_not_found`. */
function requireWorktree(worktreeId: string): void {
  if (!worktreeId.trim()) {
    throw new ApiError(
      JSON.stringify({ error: "Worktree not found", code: "worktree_not_found" }),
      404,
      "worktree_not_found",
    );
  }
}

interface SignInAttempt {
  attemptId: string;
  accountId: string;
  cli: string;
  sessionId: string;
  state: SignInState;
  email: string | null;
  plan: string | null;
}

/** Mirror of the daemon's `slugify` (lowercase, `[a-z0-9]`, runs to `-`, cap 40). */
function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Last path segment ("" for `~` or `/`). */
function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "";
}

/** Drops trailing slashes (keeps a lone `/`). */
function stripTrailingSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Throws the daemon's `{ error, code }` envelope (plus `accountId` for a duplicate). */
function refuse(code: AccountErrorCode, status: number, message: string, accountId?: string): never {
  const body = { error: message, code, ...(accountId ? { accountId } : {}) };
  throw new ApiError(JSON.stringify(body), status, code, accountId);
}

/** The sign-in steps a pending account shows (plugin-style hint for the CLIs
 *  that cannot verify identity). */
function signInStepsFor(cli: string, dir: string, verifiesIdentity: boolean): SignInSteps {
  const login = MOCK_HARNESS_LOGIN[cli] ?? { env: "HOME", login: cli };
  return {
    command: `${login.env}=${dir} ${login.login}`,
    hint: verifiesIdentity ? null : "Run the command, then use /login inside.",
  };
}

/**
 * In-memory accounts API. Mutations push the same `account:*` events the daemon
 * broadcasts. `getAccounts` lists every non-pending account of every supported
 * CLI, System row first per CLI.
 */
export function createMockAccounts(emit: (ev: WSEvent) => void) {
  const accounts: AccountSummary[] = fixtureAccounts();
  const attempts = new Map<string, SignInAttempt>();
  let attemptSeq = 0;
  let accountSeq = 0;

  function verifiesIdentityFor(cli: string): boolean {
    return CAPABILITIES[cli]?.accountLink?.verifiesIdentity ?? false;
  }

  /** Pending-refresh calls per account: a verifiable row completes on the second. */
  const refreshCalls = new Map<string, number>();

  /** The daemon's check order for a chosen folder (read-only). Five refusal
   *  codes in the mock; the real daemon also refuses unreadable folders. */
  function validateChosen(cli: string, dir: string): ValidateAccountPathResponse {
    const path = stripTrailingSlashes(dir.trim());
    if (!(path.startsWith("/") || path.startsWith("~")) || path.includes("..")) {
      refuse("path_invalid", 400, 'Enter a full path, or one starting with ~, without "..".');
    }
    const systemDir = CAPABILITIES[cli]?.accountLink?.systemDir;
    if (systemDir && path === systemDir) {
      refuse("folder_is_system", 409, "That is your system login folder; it is already the default account.");
    }
    const owner = accounts.find((a) => a.cli === cli && a.dir === path);
    if (owner) refuse("folder_duplicate", 409, `Already added as ${displayNameFor(owner)}.`, owner.id);
    if (path === ACCOUNTS_ROOT || path.startsWith(`${ACCOUNTS_ROOT}/`)) {
      const holder = accounts.find((a) => a.dir && path.startsWith(`${a.dir}/`));
      const message = holder
        ? `That folder belongs to the account "${displayNameFor(holder)}".`
        : "That folder is managed by vibe-station.";
      refuse("folder_in_accounts_root", 409, message);
    }
    if (lastSegment(path).includes("nope")) refuse("folder_not_found", 404, "Folder not found.");
    return { dir: path, exists: true, isEmpty: false, looksValid: true };
  }

  /** Planned managed folder for "create" mode: `<root>/<cli>/<slug>`. */
  function plannedCreateDir(cli: string, label: string | undefined, id: string): string {
    return `${ACCOUNTS_ROOT}/${cli}/${(label && slugify(label)) || id}`;
  }

  function requireCli(cli: string): MockAccountCapabilities {
    const caps = CAPABILITIES[cli];
    if (!caps) throw new ApiError(JSON.stringify({ error: "Unknown CLI", code: "unknown_cli" }), 404, "unknown_cli");
    if (!caps.supportsAccounts) {
      throw new ApiError(
        JSON.stringify({ error: caps.accountsNote ?? "Accounts aren't supported for this CLI.", code: "accounts_unsupported" }),
        400,
        "accounts_unsupported",
      );
    }
    return caps;
  }

  function find(cli: string, id: string): AccountSummary {
    const acct = accounts.find((a) => a.cli === cli && a.id === id);
    if (!acct) throw new ApiError(JSON.stringify({ error: "Account not found", code: "account_not_found" }), 404, "account_not_found");
    return acct;
  }

  function upsert(acct: AccountSummary): AccountSummary {
    const clone = structuredClone(acct);
    emit({ type: "account:updated", account: clone });
    return clone;
  }

  /** System row first per CLI, then that CLI's accounts by `createdAt`. */
  function listAccounts(): AccountSummary[] {
    const clis = [...new Set(accounts.map((a) => a.cli))];
    const out: AccountSummary[] = [];
    for (const cli of clis) {
      const rows = accounts.filter((a) => a.cli === cli);
      const system = rows.find((a) => a.id === "system");
      if (system) out.push(system);
      out.push(
        ...rows
          .filter((a) => a.id !== "system")
          .sort((x, y) => (x.createdAt ?? "").localeCompare(y.createdAt ?? "")),
      );
    }
    return out;
  }

  function cliAccounts(cli: string): AccountSummary[] {
    return listAccounts().filter((a) => a.cli === cli);
  }

  function pushSignin(attempt: SignInAttempt, state: SignInState, message?: string): void {
    attempt.state = state;
    emit({
      type: "account:signin",
      attemptId: attempt.attemptId,
      cli: attempt.cli,
      accountId: attempt.accountId,
      state,
      ...(attempt.email ? { email: attempt.email } : {}),
      ...(attempt.plan ? { plan: attempt.plan } : {}),
      ...(message ? { message: message.slice(0, 200) } : {}),
    });
  }

  /** Simulated vendor login: finishes after `SIGN_IN_DONE_MS` unless the
   *  attempt was cancelled first. */
  function scheduleSignInDone(attempt: SignInAttempt): void {
    setTimeout(() => {
      const live = attempts.get(attempt.attemptId);
      if (live !== attempt || live.state !== "waiting") return;
      if (!live.email) live.email = "signed-in@example.dev";
      if (!live.plan) live.plan = "Pro";
      pushSignin(live, "done");
    }, SIGN_IN_DONE_MS);
  }

  function beginAttempt(cli: string, accountId: string): SignInAttempt {
    attemptSeq += 1;
    const attempt: SignInAttempt = {
      attemptId: `att_${attemptSeq}`,
      accountId,
      cli,
      sessionId: `sess-signin-${attemptSeq}`,
      state: "waiting",
      email: null,
      plan: null,
    };
    attempts.set(attempt.attemptId, attempt);
    pushSignin(attempt, "waiting");
    scheduleSignInDone(attempt);
    return attempt;
  }

  function startResponse(attempt: SignInAttempt): StartSignInResponse {
    return { attemptId: attempt.attemptId, accountId: attempt.accountId, sessionId: attempt.sessionId };
  }

  return {
    async getAccounts(): Promise<AccountSummary[]> {
      return structuredClone(listAccounts());
    },

    async createApiKeyAccount(body: CreateApiKeyAccountBody): Promise<AccountSummary> {
      requireCli(body.cli);
      const label = normalizeLabel(body.label);
      if (labelTaken(accounts, body.cli, label)) {
        throw new ApiError(JSON.stringify({ error: "That name is taken", code: "label_taken" }), 409, "label_taken");
      }
      const key = body.apiKey.trim();
      if (key.length === 0 || key.length > 4096 || hasControlChars(key)) {
        throw new ApiError(JSON.stringify({ error: "Invalid API key", code: "invalid_key" }), 400, "invalid_key");
      }
      accountSeq += 1;
      const acct: AccountSummary = {
        id: nextAccountId(accountSeq),
        cli: body.cli,
        label,
        displayName: label,
        email: null,
        plan: null,
        method: "api_key",
        auth: "signed_in",
        isDefault: false,
        limited: null,
        createdAt: new Date().toISOString(),
      };
      accounts.push(acct);
      return upsert(acct);
    },

    async validateAccountPath(body: AccountFolderBody): Promise<ValidateAccountPathResponse> {
      requireCli(body.cli);
      if (body.mode === "create") {
        const dir = plannedCreateDir(body.cli, body.label, nextAccountId(accountSeq + 1));
        return { dir, exists: false, isEmpty: true, looksValid: true };
      }
      return validateChosen(body.cli, body.dir ?? "");
    },

    async addFolderAccount(body: AccountFolderBody): Promise<AddFolderAccountResponse> {
      requireCli(body.cli);
      const label = body.label?.trim() ? normalizeLabel(body.label) : null;
      if (label && labelTaken(accounts, body.cli, label)) {
        refuse("label_taken", 409, "That name is taken");
      }
      accountSeq += 1;
      const id = nextAccountId(accountSeq);
      const created = body.mode === "create";
      const dir = created ? plannedCreateDir(body.cli, label ?? undefined, id) : validateChosen(body.cli, body.dir ?? "").dir;
      const segment = lastSegment(dir);
      // Mock rule: a folder whose last name contains "work" signs in at once.
      const signedIn = segment.includes("work");
      const now = new Date().toISOString();
      const acct: AccountSummary = {
        id,
        cli: body.cli,
        label,
        displayName: id,
        email: signedIn ? `${segment.replace(/^\.+/, "")}@example.test` : null,
        plan: signedIn ? "Pro" : null,
        method: "sign_in",
        auth: signedIn ? "signed_in" : "unknown",
        isDefault: false,
        limited: null,
        createdAt: now,
        dir,
        createdByUs: created,
        pending: !signedIn,
        signIn: signedIn ? null : signInStepsFor(body.cli, dir, verifiesIdentityFor(body.cli)),
      };
      acct.displayName = displayNameFor(acct);
      accounts.push(acct);
      const clone = upsert(acct);
      return { account: clone, signedIn: !clone.pending };
    },

    async startAccountSignIn(body: StartSignInBody): Promise<StartSignInResponse> {
      requireCli(body.cli);
      requireWorktree(body.worktreeId);
      if (body.label !== undefined) {
        const label = normalizeLabel(body.label);
        if (labelTaken(accounts, body.cli, label)) {
          throw new ApiError(JSON.stringify({ error: "That name is taken", code: "label_taken" }), 409, "label_taken");
        }
      }
      accountSeq += 1;
      return startResponse(beginAttempt(body.cli, nextAccountId(accountSeq)));
    },

    async finishAccountSignIn(attemptId: string, body: FinishSignInBody): Promise<AccountSummary> {
      const attempt = attempts.get(attemptId);
      if (!attempt) throw new ApiError(JSON.stringify({ error: "Sign-in not found", code: "attempt_not_found" }), 404, "attempt_not_found");
      if (attempt.state !== "done") {
        throw new ApiError(JSON.stringify({ error: "Sign-in hasn't finished", code: "attempt_not_done" }), 409, "attempt_not_done");
      }
      const label = normalizeLabel(body.label ?? attempt.email ?? attempt.accountId);
      if (labelTaken(accounts, attempt.cli, label)) {
        throw new ApiError(JSON.stringify({ error: "That name is taken", code: "label_taken" }), 409, "label_taken");
      }
      if (
        attempt.email &&
        accounts.some((a) => a.cli === attempt.cli && a.email?.toLowerCase() === attempt.email?.toLowerCase())
      ) {
        attempts.delete(attemptId);
        throw new ApiError(
          JSON.stringify({ error: "This login is already added", code: "duplicate_account" }),
          409,
          "duplicate_account",
        );
      }
      const acct: AccountSummary = {
        id: attempt.accountId,
        cli: attempt.cli,
        label,
        displayName: label,
        email: attempt.email,
        plan: attempt.plan,
        method: "sign_in",
        auth: "signed_in",
        isDefault: false,
        limited: null,
        createdAt: new Date().toISOString(),
      };
      attempts.delete(attemptId);
      accounts.push(acct);
      return upsert(acct);
    },

    async cancelAccountSignIn(attemptId: string): Promise<{ ok: true }> {
      attempts.delete(attemptId);
      return { ok: true };
    },

    async restartAccountSignIn(cli: string, id: string, worktreeId: string): Promise<StartSignInResponse> {
      requireCli(cli);
      requireWorktree(worktreeId);
      const acct = find(cli, id);
      const attempt = beginAttempt(cli, acct.id);
      attempt.email = acct.email;
      attempt.plan = acct.plan;
      return startResponse(attempt);
    },

    async renameAccount(cli: string, id: string, label: string | null): Promise<AccountSummary> {
      const acct = find(cli, id);
      const next = label === null ? null : normalizeLabel(label);
      if (next !== null && labelTaken(accounts, cli, next, id)) {
        throw new ApiError(JSON.stringify({ error: "That name is taken", code: "label_taken" }), 409, "label_taken");
      }
      acct.label = next;
      acct.displayName = displayNameFor(acct);
      return upsert(acct);
    },

    async setDefaultAccount(cli: string, accountId: string): Promise<AccountSummary[]> {
      requireCli(cli);
      const target = find(cli, normalizeAccountId(accountId) ?? "system");
      if (target.pending) refuse("account_pending", 409, "Finish signing in first");
      if (target.auth === "signed_out") {
        throw new ApiError(JSON.stringify({ error: "Sign in first", code: "account_signed_out" }), 409, "account_signed_out");
      }
      const rows = accounts.filter((a) => a.cli === cli);
      const previousDefault = rows.find((a) => a.isDefault);
      for (const row of rows) row.isDefault = row.id === target.id;
      if (previousDefault && previousDefault.id !== target.id) upsert(previousDefault);
      upsert(target);
      return structuredClone(cliAccounts(cli));
    },

    async getAccountUsage(cli: string, id: string): Promise<AccountUsage> {
      find(cli, id);
      if (id === CLAUDE_WORK_ID) {
        return { running: [{ id: "sess-work-1", name: "Fix login flow" }], pastCount: 3 };
      }
      return { running: [], pastCount: 0 };
    },

    async refreshAccount(cli: string, id: string): Promise<AccountSummary> {
      const acct = find(cli, id);
      if (!acct.pending) {
        acct.auth = "signed_in";
        acct.signIn = null;
        return upsert(acct);
      }
      // Pending: a verifiable row completes on the second check; an
      // unverifiable one (pi/omp) completes on the first ("I've signed in").
      const calls = (refreshCalls.get(acct.id) ?? 0) + 1;
      const verifies = verifiesIdentityFor(acct.cli);
      if (!verifies || calls >= 2) {
        refreshCalls.delete(acct.id);
        acct.pending = false;
        acct.signIn = null;
        acct.auth = verifies ? "signed_in" : "unknown";
      } else {
        refreshCalls.set(acct.id, calls);
      }
      return upsert(acct);
    },

    async removeAccount(cli: string, id: string): Promise<RemoveAccountResponse> {
      if (id === "system") {
        throw new ApiError(JSON.stringify({ error: "The System login can't be removed", code: "cannot_remove_system" }), 400, "cannot_remove_system");
      }
      const acct = find(cli, id);
      const stoppedSessionIds = id === CLAUDE_WORK_ID ? ["sess-work-1"] : [];
      const folderDeleted = acct.createdByUs === true;
      accounts.splice(accounts.indexOf(acct), 1);
      // Risk 18: removing the default makes the CLI's System login the default.
      if (acct.isDefault) {
        const system = accounts.find((a) => a.cli === cli && a.id === "system");
        if (system) {
          system.isDefault = true;
          upsert(system);
        }
      }
      emit({ type: "account:removed", cli, accountId: id });
      return { ok: true, stoppedSessionIds, folderDeleted };
    },
  };
}

/** Exposed for tests/fixtures that need a known account id. */
export const MOCK_ACCOUNT_IDS = {
  claudeWork: CLAUDE_WORK_ID,
  claudeSide: CLAUDE_SIDE_ID,
  claudeClientB: CLAUDE_CLIENT_B_ID,
  cursorKey: CURSOR_KEY_ID,
} as const;
