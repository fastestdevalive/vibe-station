import { useState } from "react";
import type { ApiInstance } from "@/api";
import type { AccountSummary, SupportedCli } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { useServerStore } from "@/hooks/useServerStore";
import { cliDisplayName } from "@/lib/cliNames";
import { isPending } from "@/lib/accounts";
import { AddAccountDialog } from "./AddAccountDialog";
import { AccountRow } from "./AccountRow";
import { RemoveAccountDialog } from "./RemoveAccountDialog";
import { RenameAccountDialog } from "./RenameAccountDialog";
import { SignInDialog } from "./SignInDialog";
import "./accounts.css";

interface AccountsBlockProps {
  api: ApiInstance;
  cli: SupportedCli;
}

/**
 * Settings → a harness tab → Accounts (plan B2.1).
 *
 * Reads the CLI's rows from `useServerStore` (one source of server state) and
 * owns the add/rename/remove dialogs. Renders nothing for an undetected CLI or
 * one with neither account support nor a visible reason; a CLI without account
 * support gets only the header plus the plugin's reason (no rows, no Add).
 *
 * R3: every capability comes from `SupportedCli` data, never a harness name.
 */
export function AccountsBlock({ api, cli }: AccountsBlockProps) {
  const accounts = useServerStore((s) => s.accounts);
  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState<AccountSummary | null>(null);
  const [removing, setRemoving] = useState<AccountSummary | null>(null);
  const [signingIn, setSigningIn] = useState<AccountSummary | null>(null);
  const [blockError, setBlockError] = useState("");

  const supportsAccounts = cli.supportsAccounts === true;
  if (!cli.detected || (!supportsAccounts && !cli.accountsNote)) return null;

  const cliName = cliDisplayName(cli.id);
  const rows = accounts.filter((a) => a.cli === cli.id);

  return (
    <section className="accounts-block" aria-label={`${cliName} accounts`}>
      <div className="accounts-block__head">
        <span className="accounts-block__title">Accounts</span>
        {supportsAccounts ? (
          <span className="accounts-block__count">
            {cliName} · {rows.filter((a) => !isPending(a)).length}
          </span>
        ) : null}
        <span className="accounts-block__spacer" />
        {supportsAccounts ? (
          <Button type="button" onClick={() => setAddOpen(true)}>
            Add account
          </Button>
        ) : null}
      </div>

      {!supportsAccounts ? (
        <p className="accounts-block__note">{cli.accountsNote}</p>
      ) : (
        <>
          <div className="accounts-block__rows">
            {rows.map((account) => (
              <AccountRow
                key={account.id}
                api={api}
                cli={cli.id}
                account={account}
                systemDir={cli.accountLink?.systemDir ?? null}
                onRename={() => setRenaming(account)}
                onRemove={() => setRemoving(account)}
                onGone={(message) => {
                  useServerStore.getState().applyAccountRemoved(account.cli, account.id);
                  setBlockError(message);
                }}
                onSignIn={() => setSigningIn(account)}
              />
            ))}
          </div>
          {rows.length <= 1 ? (
            <div className="accounts-block__empty">
              <p className="accounts-block__note">
                Only this machine&apos;s login so far. Add another to choose an account per agent.
              </p>
            </div>
          ) : null}
          {blockError ? (
            <div className="accounts-block__error" role="alert">
              {blockError}
            </div>
          ) : null}
        </>
      )}

      {supportsAccounts ? (
        <>
          <AddAccountDialog open={addOpen} api={api} cli={cli} onClose={() => setAddOpen(false)} />
          {renaming ? (
            <RenameAccountDialog
              open
              api={api}
              cli={cli.id}
              cliName={cliName}
              account={renaming}
              onClose={() => setRenaming(null)}
            />
          ) : null}
          {signingIn ? (
            <SignInDialog
              open
              api={api}
              cli={cli.id}
              account={accounts.find((a) => a.cli === cli.id && a.id === signingIn.id) ?? signingIn}
              verifiesIdentity={cli.accountLink?.verifiesIdentity !== false}
              firstRunNote={cli.accountLink?.firstRunNote ?? null}
              onGone={setBlockError}
              onClose={() => setSigningIn(null)}
            />
          ) : null}
          {removing ? (
            <RemoveAccountDialog
              open
              api={api}
              cli={cli.id}
              account={removing}
              onClose={() => setRemoving(null)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
