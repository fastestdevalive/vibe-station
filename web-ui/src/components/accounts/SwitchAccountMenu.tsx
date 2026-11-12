import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { accountsForCli, isPending } from "@/lib/accounts";
import { useServerStore } from "@/hooks/useServerStore";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { useEventTargets, usePortalRoot, useViewportWidth } from "@/context/DemoEnv";
import { startAlignedPopupPosition } from "@/lib/popupPosition";
import { AccountChip } from "./AccountChip";
import "./accounts.css";

const SWITCH_CAPTION =
  "Switch this agent to another account. It restarts there; its context is handed over where the CLI supports it, otherwise it starts from a transcript.";

interface SwitchAccountMenuProps {
  /** CLI whose accounts are listed (server data, never a harness-name check). */
  cli: string;
  /** The session's current account id; `"system"`/absent = the System login. */
  currentAccountId?: string | null;
  /** Picks an account (`"system"` for the System login). */
  onPick: (accountId: string) => void;
  onClose: () => void;
  /** The element that opened the menu — clicks on it must not count as
   *  "outside" (otherwise the trigger's own click would close it again). */
  anchorRef: RefObject<HTMLElement | null>;
}

/**
 * The account switch menu (plan B3.6): a `menuitemradio` list of the session's
 * CLI accounts — the current one checked, signed-out rows disabled — opened by
 * the account banner and by the composer's account label.
 *
 * Phones render it as a bottom sheet (the `LimitsPopup` pattern) with 44px
 * targets; desktop renders a portaled, `position: fixed` popover placed from
 * the trigger's rect (left edges aligned, below when it fits and above
 * otherwise, clamped inside the viewport), so no pane can clip it. Keyboard: arrow
 * keys via `useRovingListNav`, Enter/Space picks, Escape closes, and the caller
 * returns focus to its trigger on close.
 */
export function SwitchAccountMenu({
  cli,
  currentAccountId,
  onPick,
  onClose,
  anchorRef,
}: SwitchAccountMenuProps) {
  const accounts = useServerStore((s) => s.accounts);
  const isMobile = useIsMobile();
  const { doc } = useEventTargets();
  const portalRoot = usePortalRoot();
  const envWidth = useViewportWidth();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rows = accountsForCli(accounts, cli).filter((a) => !isPending(a));
  const currentId = !currentAccountId || currentAccountId === "system" ? "system" : currentAccountId;

  // Only signed-in accounts are navigable/activatable; a signed-out row is
  // visible (with its word) but `aria-disabled`.
  const navRows = rows.filter((a) => a.auth !== "signed_out").map((a) => ({ path: a.id }));
  // The current account is not a switch target: picking it just closes.
  const pick = (id: string) => {
    if (id === currentId) onClose();
    else onPick(id);
  };
  const nav = useRovingListNav(navRows, {
    onOpen: (id) => {
      const acct = rows.find((a) => a.id === id);
      if (!acct || acct.auth === "signed_out") return;
      pick(acct.id);
    },
    // A signed-out or removed current account has no navigable row.
    initialCursor: navRows.some((r) => r.path === currentId) ? currentId : navRows[0]?.path,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // Desktop placement: measure the menu and its trigger, then fix the menu to the viewport.
  useLayoutEffect(() => {
    if (isMobile) return;
    const menuEl = rootRef.current;
    const trigger = anchorRef.current;
    if (!menuEl || !trigger) return;
    const box = menuEl.getBoundingClientRect();
    const next = startAlignedPopupPosition(
      trigger.getBoundingClientRect(),
      box.width,
      box.height,
      envWidth,
      portalRoot.ownerDocument.documentElement.clientHeight,
    );
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  }, [isMobile, anchorRef, envWidth, portalRoot, rows.length]);

  // Focus the checked row when the menu opens, and follow the roving cursor.
  useEffect(() => {
    if (!nav.cursorPath) return;
    rowRefs.current.get(nav.cursorPath)?.focus();
  }, [nav.cursorPath]);

  // With no usable row nothing takes focus: focus the menu itself so Escape works.
  useEffect(() => {
    if (navRows.length === 0) rootRef.current?.focus();
  }, [navRows.length]);

  // Outside mousedown closes (the trigger itself is not "outside").
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    doc.addEventListener("mousedown", onDocMouseDown);
    return () => doc.removeEventListener("mousedown", onDocMouseDown);
  }, [doc, onClose, anchorRef]);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      onClose();
      return;
    }
    nav.handleKeyDown(e);
  }

  const menu = (
    <div
      ref={rootRef}
      className="account-menu"
      role="menu"
      tabIndex={-1}
      aria-label="Switch account"
      style={isMobile ? undefined : { top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
    >
      <p className="account-menu__caption" role="presentation">
        {SWITCH_CAPTION}
      </p>
      {rows.map((acct) => {
        const checked = acct.id === currentId;
        const signedOut = acct.auth === "signed_out";
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
            className="account-menu__row"
            onClick={() => {
              if (signedOut) return;
              pick(acct.id);
            }}
            onFocus={() => nav.setCursorPath(acct.id)}
          >
            <AccountChip variant="row" account={acct} showPlan trailing={checked ? "Current" : null} />
          </button>
        );
      })}
    </div>
  );

  return createPortal(
    isMobile ? (
      <>
        <div className="limits-popup-backdrop" role="presentation" onClick={onClose} />
        {menu}
      </>
    ) : (
      menu
    ),
    portalRoot,
  );
}
