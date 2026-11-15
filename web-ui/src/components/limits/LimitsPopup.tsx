import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { LimitSlotRef, LimitWindow, LimitsResult } from "@/api/types";
import { ACCOUNT_WORDS, accountOf } from "@/lib/accounts";
import { AccountChip } from "@/components/accounts/AccountChip";
import { useServerStore } from "@/hooks/useServerStore";
import { useRovingListNav } from "@/hooks/useRovingListNav";
import { LimitChip } from "./LimitChip";
import {
  formatLocalResetTime,
  groupByAccount,
  harnessLabel,
  resetCountdown,
  sameRef,
  slotKey,
  statusReason,
  windowLabel,
  dollarsText,
  type SlotIndex,
} from "./limitsModel";

interface LimitsPopupProps {
  slotIndex: SlotIndex;
  slots: [LimitSlotRef, LimitSlotRef];
  harnesses: LimitsResult[];
  host: string;
  nowMs: number;
  refreshing: boolean;
  cooldownUntil: number | null;
  error: string | null;
  onPick: (ref: LimitSlotRef) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function isNodata(win: LimitWindow | undefined): boolean {
  return !win || win.usedPct === null;
}

/** Human wait label for the refresh cooldown. */
function cooldownLabel(remainingMs: number): string {
  return `Wait ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

/** One pickable window row (a full `LimitSlotRef`, account included). */
function PopupRow({
  harness,
  window,
  message,
  nowMs,
  checked,
  inOtherSlot,
  otherSlotNumber,
  tabbable,
  setRowRef,
  onFocusRow,
  onPick,
}: {
  harness: string;
  window: LimitWindow;
  message?: string | null;
  nowMs: number;
  checked: boolean;
  inOtherSlot: boolean;
  otherSlotNumber: number;
  tabbable: boolean;
  setRowRef: (el: HTMLDivElement | null) => void;
  onFocusRow: () => void;
  onPick: () => void;
}) {
  const label = windowLabel(harness, window.windowId, window.label);
  const money = dollarsText(window.dollars);
  const countdown = resetCountdown(window.resetsAt, nowMs);
  const exactTime = formatLocalResetTime(window.resetsAt, nowMs);
  return (
    <div
      ref={setRowRef}
      className="limits-popup__row"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={tabbable ? 0 : -1}
      onClick={onPick}
      onFocus={onFocusRow}
    >
      <LimitChip harness={harness} window={window} nowMs={nowMs} variant="row" />
      {isNodata(window) ? (
        <span className="limits-popup__text">
          <span className="limits-popup__main">
            {label ? `${label} — ` : ""}
            {statusReason(window.status, message ?? null) ?? "—"}
          </span>
        </span>
      ) : (
        <span className="limits-popup__text">
          <span className="limits-popup__main">
            {label ? `${label} — ` : ""}
            {countdown}
          </span>
          {money || exactTime ? (
            <span className="limits-popup__sub">{[money, exactTime].filter(Boolean).join(" · ")}</span>
          ) : null}
        </span>
      )}
      {inOtherSlot ? <span>slot {otherSlotNumber}</span> : <span />}
    </div>
  );
}

/** Rows of one account group, headed "Claude · Work" when the harness has more
 *  than one account (plan B3.9); a single-account harness keeps its bare label. */
function AccountGroupRows({
  harness,
  accountId,
  results,
  multipleAccounts,
  slotIndex,
  slots,
  nowMs,
  rowRefs,
  nav,
  onPick,
}: {
  harness: string;
  accountId?: string;
  results: LimitsResult[];
  multipleAccounts: boolean;
  slotIndex: SlotIndex;
  slots: [LimitSlotRef, LimitSlotRef];
  nowMs: number;
  rowRefs: RefObject<Map<string, HTMLDivElement>>;
  nav: ReturnType<typeof useRovingListNav>;
  onPick: (ref: LimitSlotRef) => void;
}) {
  const accounts = useServerStore((s) => s.accounts);
  const other = slotIndex === 0 ? 1 : 0;
  const account = accountOf(accounts, harness, accountId);
  const heading = multipleAccounts ? (
    <>
      {harnessLabel(harness)} ·{" "}
      {account ? (
        <>
          <AccountChip variant="inline" account={account} />
          {account.id === "system" ? <span className="limits-popup__tag">{ACCOUNT_WORDS.system}</span> : null}
        </>
      ) : (
        accountId ? <AccountChip variant="inline" removed /> : ACCOUNT_WORDS.system
      )}
    </>
  ) : (
    harnessLabel(harness)
  );
  const empty = results.every((r) => r.windows.length === 0);
  return (
    <div>
      <div className="limits-popup__group-title">{heading}</div>
      {results.map((result) =>
        result.windows.map((w) => {
          const ref: LimitSlotRef = {
            harness,
            windowId: w.windowId,
            ...(accountId ? { accountId } : {}),
          };
          const path = slotKey(ref);
          return (
            <PopupRow
              key={path}
              harness={harness}
              window={w}
              message={result.message}
              nowMs={nowMs}
              checked={sameRef(slots[slotIndex], ref)}
              inOtherSlot={sameRef(slots[other], ref)}
              otherSlotNumber={other + 1}
              tabbable={nav.isTabbable(path)}
              setRowRef={(el) => {
                if (el) rowRefs.current.set(path, el);
                else rowRefs.current.delete(path);
              }}
              onFocusRow={() => nav.setCursorPath(path)}
              onPick={() => onPick(ref)}
            />
          );
        }),
      )}
      {empty && results[0] && results[0].status !== "ok" ? (
        <div className="limits-popup__reason">{statusReason(results[0].status, results[0].message)}</div>
      ) : null}
    </div>
  );
}

export function LimitsPopup({
  slotIndex,
  slots,
  harnesses,
  host,
  nowMs,
  refreshing,
  cooldownUntil,
  error,
  onPick,
  onRefresh,
  onClose,
}: LimitsPopupProps) {
  const groups = groupByAccount(harnesses);
  const n = slotIndex + 1;

  // One navigable row per (harness, account, window), keyed by the full slot.
  const refByPath = new Map<string, LimitSlotRef>();
  const rows = groups.flatMap((g) =>
    g.accounts.flatMap((a) =>
      a.results.flatMap((r) =>
        r.windows.map((w) => {
          const ref: LimitSlotRef = {
            harness: g.harness,
            windowId: w.windowId,
            ...(a.accountId ? { accountId: a.accountId } : {}),
          };
          const path = slotKey(ref);
          refByPath.set(path, ref);
          return { path };
        }),
      ),
    ),
  );

  const nav = useRovingListNav(rows, {
    onOpen: (path) => {
      const ref = refByPath.get(path);
      if (ref) onPick(ref);
    },
    initialCursor: slotKey(slots[slotIndex]),
  });

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A pinned limit may have vanished (no cursor) — fall back to the first row so the popup stays keyboard-reachable.
    const target = nav.cursorPath ?? rows[0]?.path;
    if (!target) {
      dialogRef.current?.focus();
      return;
    }
    rowRefs.current.get(target)?.focus();
  }, [nav.cursorPath]);

  const inCooldown = cooldownUntil != null && nowMs < cooldownUntil;
  const refreshDisabled = refreshing || inCooldown;
  const refreshLabel = refreshing ? "Refreshing…" : inCooldown ? cooldownLabel(cooldownUntil! - nowMs) : "Refresh ↻";

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    nav.handleKeyDown(e);
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="limits-popup"
      role="dialog"
      aria-label={`Replace slot ${n}`}
      onKeyDown={onKeyDown}
    >
      <div className="limits-popup__group-title">
        Replace slot {n} · {host}
      </div>
      {groups.map((g) => (
        <div key={g.harness}>
          {g.accounts.map((a) => (
            <AccountGroupRows
              key={a.accountId ?? "system"}
              harness={g.harness}
              {...(a.accountId ? { accountId: a.accountId } : {})}
              results={a.results}
              multipleAccounts={g.accounts.length > 1}
              slotIndex={slotIndex}
              slots={slots}
              nowMs={nowMs}
              rowRefs={rowRefs}
              nav={nav}
              onPick={onPick}
            />
          ))}
        </div>
      ))}
      {error ? <div className="limits-popup__reason">{error}</div> : null}
      <div className="limits-popup__footer">
        <button
          type="button"
          className="limit-chip"
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          {refreshLabel}
        </button>
      </div>
    </div>
  );
}
