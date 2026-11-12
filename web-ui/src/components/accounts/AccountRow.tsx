import { MoreHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ApiInstance } from "@/api";
import { isAccountError } from "@/api/errors";
import type { AccountSummary } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { apiErrorText } from "@/lib/apiErrorText";
import { clampPopupPosition, usablePopupHeight } from "@/lib/popupPosition";
import { ACCOUNT_WORDS, accountName, accountState, isPending, removeVerb } from "@/lib/accounts";
import { AccountChip, AccountStateTag } from "./AccountChip";
import { AccountLimitMeter } from "./AccountLimitMeter";
import "./accounts.css";

interface AccountRowProps {
  api: Pick<ApiInstance, "refreshAccount" | "setDefaultAccount">;
  /** CLI id of the account (data, never a harness-name check). */
  cli: string;
  account: AccountSummary;
  onRename: () => void;
  /** Opens the confirm dialog (every row, a pending one included). */
  onRemove: () => void;
  /** The daemon deleted this pending row on a refresh (duplicate identity / not found); shows why. */
  onGone?: (message: string) => void;
  /** Opens the sign-in dialog ("Sign in" / "Finish sign-in"). */
  onSignIn: () => void;
  /** Display path of the harness's own folder; shown on the System row. */
  systemDir?: string | null;
}

/** One entry of the row's "⋯" menu. */
interface RowAction {
  key: string;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  /** True while the action's work is in flight (blocks a double click). */
  disabled?: boolean;
}

/** The folder line: the System row shows the harness's own folder; a chosen
 *  folder shows its path; a folder vibe-station made says so. */
function folderLine(acct: AccountSummary, systemDir: string | null | undefined): string | null {
  if (acct.id === "system") return systemDir ?? null;
  if (!acct.dir) return null;
  return acct.createdByUs ? `${acct.dir} · managed by vibe-station` : acct.dir;
}

/**
 * One account in Settings: the shared `AccountChip` row (monogram, name, plan
 * and Default chips, email · folder, state word), at most one contextual
 * button ("Sign in" / "Finish sign-in"), one "⋯" menu for everything else, and
 * a slim limits meter. The row owns "Make default" and "Check again"; rename,
 * remove and the sign-in dialog are handed to the block.
 */
export function AccountRow({ api, cli, account, onRename, onRemove, onGone, onSignIn, systemDir }: AccountRowProps) {
  const [refreshed, setRefreshed] = useState<AccountSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Place the fixed menu under the button, flipping above when the bottom bar is in the way.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setPos(null);
      return;
    }
    const btn = menuBtnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const m = menu.getBoundingClientRect();
    setPos(
      clampPopupPosition(
        btn.getBoundingClientRect(),
        m.width,
        m.height,
        document.documentElement.clientWidth,
        usablePopupHeight(document),
        4,
      ),
    );
  }, [menuOpen]);

  // Outside mousedown closes the menu (same pattern as SwitchAccountMenu).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const close = () => setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    menuWrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuOpen]);

  // A "Check again" result is shown immediately; the store upsert that follows
  // replaces it with the same values (the row's props are the server truth).
  const acct = refreshed && refreshed.id === account.id ? refreshed : account;

  useEffect(() => {
    setRefreshed(null);
    setError("");
  }, [account]);

  const isSystem = acct.id === "system";
  const pending = isPending(acct);
  const state = accountState(acct);
  const signedOut = acct.auth === "signed_out" && !pending;
  const canCheck = acct.method !== "api_key" && !pending && (signedOut || state === "unverified");
  const canSignIn = (pending || signedOut) && acct.method !== "api_key";
  const name = accountName(acct);

  async function makeDefault() {
    setError("");
    try {
      const rows = await api.setDefaultAccount(cli, acct.id);
      const apply = useServerStore.getState().applyAccountUpdated;
      rows.forEach((row) => apply(row));
    } catch (e) {
      setError(apiErrorText(e, "Something went wrong."));
    }
  }

  async function checkAgain() {
    setChecking(true);
    setError("");
    try {
      const next = await api.refreshAccount(cli, acct.id);
      setRefreshed(next);
      useServerStore.getState().applyAccountUpdated(next);
    } catch (e) {
      if (isAccountError(e, "duplicate_account") || isAccountError(e, "account_not_found")) {
        onGone?.(apiErrorText(e, "Something went wrong."));
      }
      setError(apiErrorText(e, "Something went wrong."));
    } finally {
      setChecking(false);
    }
  }

  const actions: RowAction[] = [];
  if (!pending && !acct.isDefault && !signedOut) {
    actions.push({ key: "default", label: "Make default", onClick: () => void makeDefault() });
  }
  if (!pending) actions.push({ key: "rename", label: "Rename", onClick: onRename });
  if (canCheck) {
    actions.push({
      key: "check",
      label: checking ? "Checking…" : "Check again",
      onClick: () => void checkAgain(),
      disabled: checking,
    });
  }
  if (!isSystem) {
    actions.push({
      key: "remove",
      label: removeVerb(acct),
      onClick: onRemove,
      destructive: acct.createdByUs === true,
    });
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!menuOpen) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      setMenuOpen(false);
      menuBtnRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      menuWrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }

  return (
    <div className={canSignIn ? "accounts-row accounts-row--action" : "accounts-row"} data-testid={`account-row-${acct.id}`}>
      <div className="accounts-row__main">
        <AccountChip account={acct} variant="row" hideState showPlan showDefault detail={folderLine(acct, systemDir)} />
        <div className="accounts-row__meter">
          <AccountLimitMeter cli={cli} accountId={acct.id} />
        </div>
        {error ? (
          <div className="accounts-row__error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <div className="accounts-row__actions">
        <AccountStateTag account={acct} />
        {canSignIn ? (
          <button type="button" className="accounts-row__action" onClick={onSignIn}>
            {pending ? ACCOUNT_WORDS.finishSignIn : ACCOUNT_WORDS.signIn}
          </button>
        ) : null}
        <div className="accounts-row__menu-wrap" ref={menuWrapRef} onKeyDown={onMenuKeyDown}>
          <button
            ref={menuBtnRef}
            type="button"
            className="accounts-row__menu-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${name}`}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div
              ref={menuRef}
              className="accounts-row__menu"
              role="menu"
              aria-label={`Actions for ${name}`}
              style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
            >
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  className={
                    action.destructive
                      ? "accounts-row__menu-item accounts-row__menu-item--destructive"
                      : "accounts-row__menu-item"
                  }
                  disabled={action.disabled}
                  onClick={() => {
                    setMenuOpen(false);
                    action.onClick();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
