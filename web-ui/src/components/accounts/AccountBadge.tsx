import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { accountOf, accountState, defaultAccountFor, isAccountRemoved, sessionCli, showsAccount } from "@/lib/accounts";
import { useServerStore } from "@/hooks/useServerStore";
import { useModesStore, useModesSync } from "@/store/modesStore";
import { AccountChip } from "./AccountChip";

/**
 * A session's account mark: the 16px monogram (never truncated, never text)
 * whose title and accessible name carry the full account name and state, or
 * the removed mark when the stored account id is no longer listed. Hidden
 * entirely for a CLI with a single account (unless its own account was
 * removed) (Requirement 14).
 *
 * Reads the one server source (`useServerStore.accounts`) and resolves the
 * session's CLI from the modes cache; no harness-name checks (R3).
 */
export function AccountBadge({
  session,
  api,
  hideDefault = false,
}: {
  session: Pick<Session, "modeId" | "draftConfig" | "accountId">;
  /** Loads the modes cache when nothing else on the route has. */
  api?: ApiInstance;
  /** Draw nothing for a session on its CLI's default account, so only
   *  non-default accounts get a mark (the left sidebar). A removed account
   *  or one needing attention (signed out, waiting, limited) still shows its mark. */
  hideDefault?: boolean;
}) {
  useModesSync(api);
  const accounts = useServerStore((s) => s.accounts);
  const accountsLoaded = useServerStore((s) => s.accountsLoaded);
  const modes = useModesStore((s) => s.modes);
  const cli = sessionCli(session, modes);
  if (!cli || !showsAccount(accounts, accountsLoaded, cli, session.accountId)) return null;
  const acct = accountOf(accounts, cli, session.accountId);
  if (acct) {
    if (hideDefault && accountState(acct) === "ok" && defaultAccountFor(accounts, cli)?.id === acct.id) return null;
    return <AccountChip variant="mark" account={acct} />;
  }
  if (!isAccountRemoved(accounts, accountsLoaded, cli, session.accountId)) return null;
  return <AccountChip variant="mark" removed />;
}
