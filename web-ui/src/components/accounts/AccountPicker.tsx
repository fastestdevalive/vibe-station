import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AccountSummary } from "@/api/types";
import { alternativeAccount, accountOf, accountsForCli, defaultAccountFor, isPending } from "@/lib/accounts";
import { useLimits } from "@/hooks/useLimits";
import { useServerStore } from "@/hooks/useServerStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { useEventTargets } from "@/context/DemoEnv";
import { AccountChip } from "./AccountChip";
import { AccountLimitMeter } from "./AccountLimitMeter";
import "./accounts.css";

/** Roving-list sentinel for the footer "+ Add account…" button. */
const ADD_ROW = "__add__";

interface AccountPickerProps {
  /** CLI whose accounts are listed (server data, never a harness-name check). */
  cli: string;
  /** The picked account id (`"system"` or `acc_…`); absent = the CLI default. */
  value?: string | null;
  onChange: (accountId: string) => void;
  disabled?: boolean;
  /** Footer "+ Add account…": closes the list, then opens the add dialog. */
  onAddAccount?: () => void;
}

/**
 * The draft composer's account chip (plan B3.1): a chip beside the mode
 * popover that opens a `menuitemradio` list of the CLI's accounts. Each row
 * carries the name, email, "Default", the auth word and the account's tightest
 * limit; a signed-out row is `aria-disabled` and says how to fix it, and a row
 * at >= 90% names an account that still has room.
 *
 * Renders nothing for a CLI with fewer than 2 accounts (Requirement 14), so a
 * single-login CLI never grows new UI. Phones use a bottom sheet.
 */
export function AccountPicker({ cli, value, onChange, disabled, onAddAccount }: AccountPickerProps) {
  const accounts = useServerStore((s) => s.accounts);
  const { resultFor } = useLimits();
  const isMobile = useIsMobile();
  const { doc } = useEventTargets();

  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // A pending ("Waiting for sign-in") account is never listed (isUsable).
  const rows = accountsForCli(accounts, cli).filter((a) => !isPending(a));
  const current = accountOf(accounts, cli, value) ?? defaultAccountFor(accounts, cli);

  const usable = rows.filter((a) => a.auth !== "signed_out");
  const navRows = [...usable.map((a) => ({ path: a.id })), ...(onAddAccount ? [{ path: ADD_ROW }] : [])];
  const nav = useRovingListNav(
    navRows,
    {
      // Wrap at both ends so the footer row is reachable from either direction.
      onBoundary: (edge) => {
        const target = edge === "bottom" ? navRows[0] : navRows[navRows.length - 1];
        if (target) nav.setCursorPath(target.path);
      },
      onOpen: (id) => {
        if (id === ADD_ROW) {
          setOpen(false);
          onAddAccount?.();
          return;
        }
        const acct = rows.find((a) => a.id === id);
        if (!acct || acct.auth === "signed_out") return;
        onChange(acct.id);
        setOpen(false);
        chipRef.current?.focus();
      },
      initialCursor: current?.id ?? null,
    },
  );

  // Focus the selected row (or the first usable one) when the list opens, and
  // follow the roving cursor as it moves.
  useEffect(() => {
    if (!open || !nav.cursorPath) return;
    rowRefs.current.get(nav.cursorPath)?.focus();
  }, [open, nav.cursorPath]);

  // Outside mousedown closes (the chip is inside the same anchor, so its own
  // click still toggles instead of closing twice).
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    doc.addEventListener("mousedown", onDocMouseDown);
    return () => doc.removeEventListener("mousedown", onDocMouseDown);
  }, [open, doc]);

  if (rows.length < 2 || !current) return null;

  function closeAndRefocus() {
    setOpen(false);
    chipRef.current?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      closeAndRefocus();
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    nav.handleKeyDown(e);
  }

  function rowHint(acct: AccountSummary): string | null {
    const used = (resultFor(cli, acct.id)?.windows ?? []).reduce(
      (max, w) => (w.usedPct !== null && w.usedPct > max ? w.usedPct : max),
      -1,
    );
    if (used < 90) return null;
    const other = alternativeAccount(accounts, acct);
    return other ? `${acct.displayName} is close to its limit. ${other.displayName} has room.` : null;
  }

  const list = (
    <div
      className="account-picker__popover"
      role="menu"
      aria-label="Account"
      onKeyDown={onKeyDown}
    >
      {rows.map((acct) => {
        const signedOut = acct.auth === "signed_out";
        const checked = acct.id === current.id;
        const hint = rowHint(acct);
        return (
          <button
            key={acct.id}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            aria-disabled={signedOut || undefined}
            tabIndex={nav.isTabbable(acct.id) ? 0 : -1}
            ref={(el) => {
              if (el) rowRefs.current.set(acct.id, el);
              else rowRefs.current.delete(acct.id);
            }}
            className="account-picker__row"
            onClick={() => {
              if (signedOut) return;
              onChange(acct.id);
              setOpen(false);
              chipRef.current?.focus();
            }}
            onFocus={() => nav.setCursorPath(acct.id)}
          >
            <span className="account-picker__body">
              <AccountChip
                variant="row"
                account={acct}
                showPlan
                trailing={checked ? <Check size={13} aria-hidden className="account-picker__check" /> : null}
              />
            </span>
            <span className="account-picker__meter">
              <AccountLimitMeter cli={cli} accountId={acct.id} compact />
            </span>
            {hint ? <span className="account-picker__hint">{hint}</span> : null}
            {signedOut ? (
              <span className="account-picker__help">Sign in to {acct.displayName} from Settings.</span>
            ) : null}
          </button>
        );
      })}
      {onAddAccount ? (
        <button
          type="button"
          role="menuitem"
          className="account-picker__add"
          tabIndex={nav.isTabbable(ADD_ROW) ? 0 : -1}
          ref={(el) => {
            if (el) rowRefs.current.set(ADD_ROW, el);
            else rowRefs.current.delete(ADD_ROW);
          }}
          onFocus={() => nav.setCursorPath(ADD_ROW)}
          onClick={() => {
            setOpen(false);
            onAddAccount();
          }}
        >
          + Add account…
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="account-picker" ref={rootRef}>
      <button
        type="button"
        ref={chipRef}
        className="account-picker__chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${current.displayName}`}
        title={current.displayName}
        disabled={disabled}
        onClick={() => (open ? closeAndRefocus() : setOpen(true))}
        onKeyDown={onKeyDown}
      >
        <AccountChip variant="inline" account={current} />
        <ChevronDown size={12} aria-hidden />
      </button>

      {open && !isMobile ? list : null}
      {open && isMobile ? (
        <>
          <div className="limits-popup-backdrop" role="presentation" onClick={closeAndRefocus} />
          {list}
        </>
      ) : null}
    </div>
  );
}
