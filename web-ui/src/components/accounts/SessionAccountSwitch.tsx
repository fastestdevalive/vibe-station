import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ApiInstance } from "@/api";
import { accountOf, sessionAccountName, showsAccount, isAccountRemoved } from "@/lib/accounts";
import { useServerStore } from "@/hooks/useServerStore";
import { AccountChip } from "./AccountChip";
import { SwitchAccountMenu } from "./SwitchAccountMenu";
import { SwitchRefusal } from "./SwitchRefusal";
import { useAccountSwitch, type SwitchSession } from "./useAccountSwitch";
import "./accounts.css";

interface SessionAccountSwitchProps {
  api: Pick<ApiInstance, "switchSessionAccount">;
  session: SwitchSession & { accountId?: string | null };
  /** The session's CLI (from its mode / meta; server data, never a harness name). */
  cli: string | null | undefined;
}

/**
 * The one account control of an agent pane (R1F-12): the inline account chip
 * plus a chevron, opening the switch menu. Chat and Terminal panes mount the
 * same component. Hidden for a single-account CLI unless the session's own
 * account was removed.
 */
export function SessionAccountSwitch({ api, session, cli }: SessionAccountSwitchProps) {
  const accounts = useServerStore((s) => s.accounts);
  const accountsLoaded = useServerStore((s) => s.accountsLoaded);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { switchTo, error, fallback, clearError } = useAccountSwitch(api, session);

  if (!cli || !showsAccount(accounts, accountsLoaded, cli, session.accountId)) return null;
  const acct = accountOf(accounts, cli, session.accountId);
  const removed = isAccountRemoved(accounts, accountsLoaded, cli, session.accountId);
  const name = sessionAccountName(accounts, cli, session.accountId);
  if (!name) return null;

  const close = () => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <span className="session-account">
      <span className="session-account__anchor">
        <button
          ref={triggerRef}
          type="button"
          className="session-account__btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Account: ${name}`}
          onClick={() => (menuOpen ? close() : setMenuOpen(true))}
        >
          <AccountChip variant="inline" account={acct} removed={removed} />
          <ChevronDown size={10} aria-hidden />
        </button>
        {menuOpen ? (
          <SwitchAccountMenu
            cli={cli}
            currentAccountId={session.accountId}
            anchorRef={triggerRef}
            onPick={(id) => {
              setMenuOpen(false);
              const target = accountOf(accounts, cli, id);
              if (target) void switchTo(target);
            }}
            onClose={close}
          />
        ) : null}
        {error ? <SwitchRefusal message={error} fallback={fallback} anchorRef={triggerRef} onClose={clearError} /> : null}
      </span>
    </span>
  );
}
