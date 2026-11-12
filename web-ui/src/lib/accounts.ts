import type { AccountSummary, Mode, Session } from "@/api/types";
import { sessionModeId } from "@/lib/modeIcon";

/**
 * Pure account helpers for the UI (R3: no harness-name branching — every fact
 * comes from the `AccountSummary` data the server sends).
 *
 * The server is the authority for resolving an account; these functions only
 * decide what to DISPLAY and which default to offer, mirroring Decision 11's
 * precedence (parent > CLI default > System).
 */

/** Every account word the UI prints, in one place (one word per fact; the same
 *  words the wire uses: `auth: "signed_out"`, code `account_signed_out`). */
export const ACCOUNT_WORDS = {
  signedOut: "Signed out",
  pending: "Waiting for sign-in",
  unverified: "Not verified",
  limited: "Limited",
  apiKey: "API key",
  removed: "Account removed",
  signIn: "Sign in",
  finishSignIn: "Finish sign-in",
  isDefault: "Default",
  system: "System login",
  newAccount: "New account",
} as const;

/** The one name an account goes by on every surface: a waiting account with
 *  no label and no email is "New account" (never the server's id fallback). */
export function accountName(a: AccountSummary): string {
  return a.pending === true && !a.label && !a.email ? ACCOUNT_WORDS.newAccount : a.displayName;
}

/** What an account's state is, in precedence order: pending, signed out,
 *  limited, not verified (no identity result and not an API key), else ok. */
export type AccountState = "pending" | "signed_out" | "limited" | "unverified" | "ok";

export function accountState(a: AccountSummary): AccountState {
  if (a.pending === true) return "pending";
  if (a.auth === "signed_out") return "signed_out";
  if (a.limited) return "limited";
  if (a.auth === "unknown" && a.method !== "api_key") return "unverified";
  return "ok";
}

/** The plain word for a state; null for `ok` (the normal state needs no label). */
export function accountStateWord(a: AccountSummary): string | null {
  switch (accountState(a)) {
    case "pending":
      return ACCOUNT_WORDS.pending;
    case "signed_out":
      return ACCOUNT_WORDS.signedOut;
    case "limited":
      return ACCOUNT_WORDS.limited;
    case "unverified":
      return ACCOUNT_WORDS.unverified;
    default:
      return null;
  }
}

/** Monogram letters: the first two letters/digits of the name, the first
 *  upper-cased and the second lower-cased ("Ji", "Wo", "Sy"); "?" when none. */
export function accountInitials(name: string): string {
  const chars = name.match(/[\p{L}\p{N}]/gu) ?? [];
  if (chars.length === 0) return "?";
  const first = chars[0]!.toUpperCase();
  const second = chars[1]?.toLowerCase() ?? "";
  return `${first}${second}`;
}

/** A plan for display: the first letter capitalised ("pro" -> "Pro"). */
export function planLabel(plan: string | null | undefined): string | null {
  const text = plan?.trim();
  if (!text) return null;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The email, when it adds something the display name does not already say. */
export function accountSecondary(a: AccountSummary): string | null {
  const email = a.email?.trim();
  if (!email) return null;
  return email.toLowerCase() === a.displayName.trim().toLowerCase() ? null : email;
}

/** The CLI's accounts, in server order (System row first). */
export function accountsForCli(accounts: AccountSummary[], cli: string): AccountSummary[] {
  return accounts.filter((a) => a.cli === cli);
}

/** True iff this CLI has 2+ listed (non-pending) accounts — the only case the
 *  account surfaces (picker / badge / label) are shown (Requirement 14). */
export function hasMultipleAccounts(accounts: AccountSummary[], cli: string): boolean {
  return accountsForCli(accounts, cli).filter((a) => !isPending(a)).length >= 2;
}

/** "Waiting for sign-in": a folder account whose identity is not confirmed yet.
 *  Never selectable (the server refuses it at spawn too). */
export function isPending(a: AccountSummary): boolean {
  return a.pending === true;
}

/** The server only refuses a signed-out account (`AccountPort::resolve`), so
 *  `unknown` (API-key accounts, CLIs without an identity command) is usable.
 *  A pending account is never usable. */
export function isUsable(a: AccountSummary): boolean {
  return a.auth !== "signed_out" && !isPending(a);
}

/** The row's remove action: a folder vibe-station created is deleted ("Remove");
 *  a chosen folder is only forgotten ("Unlink"). */
export function removeVerb(a: AccountSummary): "Remove" | "Unlink" {
  return a.createdByUs === true ? "Remove" : "Unlink";
}

/** The account for an id. null/undefined/`"system"` => the CLI's System row. */
export function accountOf(
  accounts: AccountSummary[],
  cli: string,
  accountId: string | null | undefined,
): AccountSummary | undefined {
  const rows = accountsForCli(accounts, cli);
  if (!accountId || accountId === "system") return rows.find((a) => a.id === "system");
  return rows.find((a) => a.id === accountId);
}

/** The CLI's default account; falls back to its System row when the server
 *  hasn't flagged one (an older/partial payload). */
export function defaultAccountFor(accounts: AccountSummary[], cli: string): AccountSummary | undefined {
  const rows = accountsForCli(accounts, cli);
  return rows.find((a) => a.isDefault) ?? rows.find((a) => a.id === "system");
}

/**
 * The account a new session/draft of `cli` should start on (Decision 11's UI
 * mirror): the parent's account when it resolves to a listed, usable
 * account of the SAME CLI, else the CLI's default.
 *
 * A parent on the System login carries no `accountId`, so its CLI can't be
 * established here — that case falls through to the default (the server still
 * resolves the final account).
 */
export function initialAccountFor(
  accounts: AccountSummary[],
  cli: string,
  parent: Session | undefined,
): AccountSummary | undefined {
  const inherited = parent?.accountId ? accountOf(accounts, cli, parent.accountId) : undefined;
  if (inherited && isUsable(inherited)) return inherited;
  return defaultAccountFor(accounts, cli);
}

/**
 * The first usable account to switch to: usable, not limited, not the
 * current one; the CLI's default wins when it qualifies. Undefined when no
 * other account can take the session.
 */
export function alternativeAccount(
  accounts: AccountSummary[],
  current: AccountSummary | undefined,
): AccountSummary | undefined {
  if (!current) return undefined;
  const candidates = accountsForCli(accounts, current.cli).filter(
    (a) => a.id !== current.id && isUsable(a) && !a.limited,
  );
  return candidates.find((a) => a.isDefault) ?? candidates[0];
}

/**
 * The CLI a session runs on, resolved from the modes cache (`mode.cli` is
 * server data — R3: never a harness-name check). Null while the mode is unknown
 * or the cache hasn't loaded yet.
 */
export function sessionCli(
  session: Pick<Session, "modeId" | "draftConfig">,
  modes: ReadonlyMap<string, Pick<Mode, "cli">>,
): string | null {
  const modeId = sessionModeId(session);
  return modeId ? (modes.get(modeId)?.cli ?? null) : null;
}

/**
 * The name a session's account surface shows: the account's display name, or
 * "Account removed" when the session's stored id is no longer listed (the
 * daemon deletes removed accounts, so a past session keeps a dangling id).
 * Undefined when the account can't be named at all (System row not loaded yet).
 */
export function sessionAccountName(
  accounts: AccountSummary[],
  cli: string,
  accountId: string | null | undefined,
): string | undefined {
  const acct = accountOf(accounts, cli, accountId);
  if (acct) return acct.displayName;
  return accountId && accountId !== "system" ? "Account removed" : undefined;
}

/** True when the session names an account the store no longer lists (removed).
 *  `accountsLoaded` keeps this false until the first `GET /api/accounts`. */
export function isAccountRemoved(
  accounts: AccountSummary[],
  accountsLoaded: boolean,
  cli: string,
  accountId: string | null | undefined,
): boolean {
  return accountsLoaded && !!accountId && accountId !== "system" && !accountOf(accounts, cli, accountId);
}

/** Whether a session's account surface shows: the CLI has 2+ accounts, or the
 *  session's own account was removed. */
export function showsAccount(
  accounts: AccountSummary[],
  accountsLoaded: boolean,
  cli: string,
  accountId: string | null | undefined,
): boolean {
  return hasMultipleAccounts(accounts, cli) || isAccountRemoved(accounts, accountsLoaded, cli, accountId);
}

/** The worktree's main agent session — the parent a new tab/draft inherits its
 *  account from (Decision 11). Undefined when there is no worktree or no main
 *  session yet. */
export function parentSessionFor(
  sessions: Session[],
  worktreeId: string | null | undefined,
): Session | undefined {
  if (!worktreeId) return undefined;
  return sessions.find((s) => s.worktreeId === worktreeId && s.isMain && s.archivedAt == null);
}

/** The account id a draft DISPLAYS before any explicit pick: the parent's
 *  account when it resolves for this CLI, else the CLI default. */
export function draftAccountId(
  accounts: AccountSummary[],
  cli: string | null | undefined,
  parent: Session | undefined,
): string | undefined {
  return cli ? initialAccountFor(accounts, cli, parent)?.id : undefined;
}
