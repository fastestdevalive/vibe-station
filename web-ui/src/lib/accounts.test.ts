import { describe, expect, it } from "vitest";
import type { AccountSummary, Mode, Session } from "@/api/types";
import {
  ACCOUNT_WORDS,
  accountInitials,
  accountName,
  accountOf,
  accountSecondary,
  accountState,
  accountStateWord,
  planLabel,
  alternativeAccount,
  defaultAccountFor,
  hasMultipleAccounts,
  initialAccountFor,
  isAccountRemoved,
  isUsable,
  removeVerb,
  showsAccount,
} from "./accounts";

function acct(over: Partial<AccountSummary> & Pick<AccountSummary, "id" | "cli">): AccountSummary {
  return {
    label: null,
    displayName: over.id,
    email: null,
    plan: null,
    method: "sign_in",
    auth: "signed_in",
    isDefault: false,
    limited: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const SYSTEM = acct({ id: "system", cli: "claude", method: "system", displayName: "System login", isDefault: true, createdAt: null });
const WORK = acct({ id: "acc_1a2b3c4d", cli: "claude", label: "Work", displayName: "Work", email: "gaurav@acme.io" });
const SIDE = acct({ id: "acc_2b3c4d5e", cli: "claude", email: "gb@side.dev", displayName: "gb@side.dev" });
const CLIENT_B = acct({ id: "acc_3c4d5e6f", cli: "claude", label: "Client B", displayName: "Client B", auth: "signed_out" });
const CURSOR_SYSTEM = acct({ id: "system", cli: "cursor", method: "system", displayName: "System login", isDefault: true, createdAt: null });
const CURSOR_KEY = acct({ id: "acc_4d5e6f70", cli: "cursor", label: "Key", displayName: "Key", method: "api_key" });

const ALL = [SYSTEM, WORK, SIDE, CLIENT_B, CURSOR_SYSTEM, CURSOR_KEY];

function parent(accountId: string | null | undefined): Session {
  return {
    id: "sess-parent",
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: "mode-1",
    type: "agent",
    isMain: false,
    state: "working",
    lifecycleState: "working",
    tmuxName: "sess-parent",
    createdAt: "2026-01-01T00:00:00.000Z",
    accountId,
  };
}

const CLAUDE_MODE: Pick<Mode, "cli"> = { cli: "claude" };

describe("hasMultipleAccounts", () => {
  it("is false for a single account and true for two", () => {
    expect(hasMultipleAccounts([SYSTEM], "claude")).toBe(false);
    expect(hasMultipleAccounts(ALL, "claude")).toBe(true);
    expect(hasMultipleAccounts(ALL, "cursor")).toBe(true);
    // A CLI with no rows at all is not "multiple".
    expect(hasMultipleAccounts(ALL, "codex")).toBe(false);
  });
});

describe("accountOf", () => {
  it("returns the CLI's System row for null / undefined / \"system\"", () => {
    expect(accountOf(ALL, "claude", null)).toBe(SYSTEM);
    expect(accountOf(ALL, "claude", undefined)).toBe(SYSTEM);
    expect(accountOf(ALL, "claude", "system")).toBe(SYSTEM);
  });

  it("resolves a named account by id, scoped to the CLI", () => {
    expect(accountOf(ALL, "claude", "acc_1a2b3c4d")).toBe(WORK);
    // Same id on another CLI is not the same account.
    expect(accountOf(ALL, "cursor", "acc_1a2b3c4d")).toBeUndefined();
    expect(accountOf(ALL, "claude", "acc_missing")).toBeUndefined();
  });
});

describe("initialAccountFor", () => {
  it("prefers the parent's account over the CLI default", () => {
    expect(defaultAccountFor(ALL, "claude")).toBe(SYSTEM);
    expect(initialAccountFor(ALL, "claude", parent("acc_1a2b3c4d"))).toBe(WORK);
  });

  it("ignores a parent whose account belongs to another CLI", () => {
    expect(initialAccountFor(ALL, "claude", parent("acc_4d5e6f70"))).toBe(SYSTEM);
  });

  it("ignores a signed-out parent account", () => {
    expect(initialAccountFor(ALL, "claude", parent("acc_3c4d5e6f"))).toBe(SYSTEM);
  });

  it("falls back to the default for no parent / a System parent", () => {
    expect(initialAccountFor(ALL, "claude", undefined)).toBe(SYSTEM);
    expect(initialAccountFor(ALL, "claude", parent(null))).toBe(SYSTEM);
  });
});

describe("alternativeAccount", () => {
  it("skips limited and signed-out accounts", () => {
    const limitedSystem: AccountSummary = { ...SYSTEM, limited: { windowId: "five_hour", resetsAt: null, source: "poller" } };
    // Work is the current account; System is limited, Client B signed out →
    // only gb@side.dev remains.
    expect(alternativeAccount([limitedSystem, WORK, SIDE, CLIENT_B], WORK)).toBe(SIDE);
  });

  it("prefers the CLI default among the usable accounts", () => {
    // System is signed in, not limited and is the default → it wins even
    // though SIDE comes later in the list.
    expect(alternativeAccount(ALL, WORK)).toBe(SYSTEM);
  });

  it("returns undefined when the current account is the only usable one", () => {
    expect(alternativeAccount([WORK], WORK)).toBeUndefined();
    expect(alternativeAccount([SYSTEM, WORK], WORK)).toBe(SYSTEM);
  });
});

describe("auth-unknown accounts (API-key)", () => {
  const KEY = acct({ id: "acc_key", cli: "claude", method: "api_key", displayName: "Key", auth: "unknown" });

  it("alternativeAccount offers an API-key (auth unknown) account", () => {
    expect(alternativeAccount([WORK, KEY], WORK)).toBe(KEY);
    expect(alternativeAccount([WORK, CLIENT_B], WORK)).toBeUndefined();
  });

  it("initialAccountFor inherits a parent on an auth-unknown account", () => {
    expect(initialAccountFor([SYSTEM, KEY], "claude", parent("acc_key"))).toBe(KEY);
    expect(initialAccountFor([SYSTEM, CLIENT_B], "claude", parent("acc_3c4d5e6f"))).toBe(SYSTEM);
  });
});

describe("isAccountRemoved / showsAccount", () => {
  it("is removed only for a loaded store missing a named id", () => {
    expect(isAccountRemoved([SYSTEM], true, "claude", "acc_gone")).toBe(true);
    expect(isAccountRemoved([SYSTEM], false, "claude", "acc_gone")).toBe(false);
    expect(isAccountRemoved([SYSTEM], true, "claude", null)).toBe(false);
    expect(isAccountRemoved([SYSTEM], true, "claude", "system")).toBe(false);
    expect(isAccountRemoved([SYSTEM, WORK], true, "claude", "acc_1a2b3c4d")).toBe(false);
  });

  it("shows for 2+ accounts or a removed account", () => {
    expect(showsAccount([SYSTEM], true, "claude", "acc_gone")).toBe(true);
    expect(showsAccount([SYSTEM], true, "claude", null)).toBe(false);
    expect(showsAccount([SYSTEM, WORK], true, "claude", null)).toBe(true);
  });
});

describe("pending folder accounts (B1.T5)", () => {
  const PENDING = acct({
    id: "acc_9f8e7d6c",
    cli: "claude",
    label: "Client C",
    displayName: "Client C",
    auth: "unknown",
    pending: true,
    createdByUs: true,
  });

  it("pending_is_not_usable", () => {
    expect(isUsable(PENDING)).toBe(false);
    expect(isUsable(WORK)).toBe(true);
  });

  it("pending_not_counted_for_multiple_accounts", () => {
    expect(hasMultipleAccounts([SYSTEM, PENDING], "claude")).toBe(false);
    expect(hasMultipleAccounts([SYSTEM, WORK, PENDING], "claude")).toBe(true);
  });

  it("remove_verb_by_created_by_us", () => {
    expect(removeVerb({ ...WORK, createdByUs: true })).toBe("Remove");
    expect(removeVerb({ ...SIDE, createdByUs: false })).toBe("Unlink");
    expect(removeVerb(SIDE)).toBe("Unlink");
  });
});

describe("account display helpers (R1F-06)", () => {
  it("accountInitials takes two alphanumerics, first upper, second lower", () => {
    expect(accountInitials("jitoram007@gmail.com")).toBe("Ji");
    expect(accountInitials("Work")).toBe("Wo");
    expect(accountInitials("System login")).toBe("Sy");
    expect(accountInitials("  --")).toBe("?");
    expect(accountInitials("x")).toBe("X");
  });

  it("planLabel capitalises only the first letter", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("Max")).toBe("Max");
    expect(planLabel(null)).toBeNull();
    expect(planLabel(" ")).toBeNull();
  });

  it("accountSecondary is the email only when it differs from the name", () => {
    const a = acct({ id: "acc_1", cli: "claude", displayName: "Work", email: "w@acme.io" });
    expect(accountSecondary(a)).toBe("w@acme.io");
    expect(accountSecondary({ ...a, displayName: "W@Acme.io" })).toBeNull();
    expect(accountSecondary({ ...a, email: null })).toBeNull();
  });

  it("accountState follows pending > signed out > limited > not verified > ok", () => {
    const base = acct({ id: "acc_1", cli: "claude" });
    const limited = { windowId: "five_hour", resetsAt: null, source: "poller" as const };
    expect(accountState({ ...base, pending: true, auth: "signed_out" })).toBe("pending");
    expect(accountState({ ...base, auth: "signed_out", limited })).toBe("signed_out");
    expect(accountState({ ...base, limited })).toBe("limited");
    expect(accountState({ ...base, auth: "unknown" })).toBe("unverified");
    expect(accountState({ ...base, auth: "unknown", method: "api_key" })).toBe("ok");
    expect(accountState(base)).toBe("ok");
  });

  it("accountStateWord uses the shared vocabulary and is null when ok", () => {
    const base = acct({ id: "acc_1", cli: "claude" });
    expect(accountStateWord(base)).toBeNull();
    expect(accountStateWord({ ...base, auth: "signed_out" })).toBe(ACCOUNT_WORDS.signedOut);
    expect(accountStateWord({ ...base, pending: true })).toBe(ACCOUNT_WORDS.pending);
    expect(accountStateWord({ ...base, auth: "unknown" })).toBe(ACCOUNT_WORDS.unverified);
  });
});

describe("accountName", () => {
  it("names a waiting account with no label or email 'New account'", () => {
    const pending = acct({ id: "acc_bdefbb56", cli: "claude", pending: true });
    expect(accountName(pending)).toBe("New account");
  });

  it("keeps a waiting account's label or email", () => {
    expect(accountName(acct({ id: "acc_a", cli: "claude", pending: true, label: "Work", displayName: "Work" }))).toBe("Work");
    expect(accountName(acct({ id: "acc_b", cli: "claude", pending: true, email: "a@b.dev", displayName: "a@b.dev" }))).toBe("a@b.dev");
  });

  it("uses the display name for a normal account", () => {
    expect(accountName(WORK)).toBe("Work");
  });
});
