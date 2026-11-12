import { useEffect, useRef, useState, type Ref } from "react";
import type { ApiInstance } from "@/api";
import type { AccountSummary, Session } from "@/api/types";
import {
  ACCOUNT_WORDS,
  accountOf,
  accountsForCli,
  alternativeAccount,
  isAccountRemoved,
  isUsable,
  sessionCli,
} from "@/lib/accounts";
import { useServerStore } from "@/hooks/useServerStore";
import { useModesStore } from "@/store/modesStore";
import { resetCountdown, windowLabel } from "@/components/limits/limitsModel";
import { Toast } from "@/components/ui/Toast";
import { SignInDialog } from "./SignInDialog";
import { AccountChip } from "./AccountChip";
import { SwitchAccountMenu } from "./SwitchAccountMenu";
import { useAccountSwitch } from "./useAccountSwitch";
import "./accounts.css";

type SwitchCaps = "native" | "transcript" | "none";

interface AccountBannerProps {
  api: Pick<ApiInstance, "switchSessionAccount" | "restartAccountSignIn" | "getSupportedClis" | "refreshAccount">;
  /** The agent session whose account is limited or signed out. */
  session: Session;
  /** One-line variant for the tabs strip (no buttons). */
  compact?: boolean;
}

/** Human window label: the agy-style label when the harness defines one, else
 *  the window id with underscores spelled out (`five_hour` → "five hour"). */
function windowWord(cli: string, windowId: string): string {
  return windowLabel(cli, windowId) ?? windowId.replace(/_/g, " ");
}

/** "Resets in 2h." / "Resets now." / "" when no reset time is known. */
function resetsSentence(resetsAt: string | null, nowMs: number): string {
  const countdown = resetCountdown(resetsAt, nowMs);
  if (countdown === "reset") return "Resets now.";
  if (countdown === "—") return "";
  return `${countdown.charAt(0).toUpperCase()}${countdown.slice(1)}.`;
}

/** What a switch keeps, from the CLI's capability data (R3 — no harness name). */
function handoverHint(caps: SwitchCaps, name: string): string | null {
  if (caps === "native") {
    return `The agent keeps its context on ${name} where the CLI can hand it over; otherwise it first reads a transcript of this chat.`;
  }
  if (caps === "transcript") {
    return `The agent restarts on ${name} and first reads a transcript of this chat (one short turn).`;
  }
  return null;
}

function LimitedBody({
  name,
  windowId,
  resetsAt,
  nowMs,
  alternative,
  caps,
  compact,
  onWait,
  onSwitch,
}: {
  name: string;
  windowId: string;
  resetsAt: string | null;
  nowMs: number;
  alternative: AccountSummary | undefined;
  caps: SwitchCaps;
  compact?: boolean;
  onWait: () => void;
  onSwitch: () => void;
}) {
  const sentence = `${name} reached its ${windowId} limit. ${resetsSentence(resetsAt, nowMs)}`.trim();
  return (
    <>
      <span className="account-banner__text">{sentence}</span>
      {alternative && !compact ? (
        <span className="account-banner__hint">{handoverHint(caps, alternative.displayName)}</span>
      ) : null}
      <div className="account-banner__actions">
        <button type="button" className="account-banner__btn" onClick={onWait}>
          Wait
        </button>
        {alternative ? (
          <button type="button" className="account-banner__btn" onClick={onSwitch}>
            Switch this session to {alternative.displayName}
          </button>
        ) : null}
      </div>
    </>
  );
}

function SignedOutBody({
  account,
  compact,
  canSwitch,
  onSignIn,
  onSwitch,
  switchRef,
}: {
  account: AccountSummary;
  compact?: boolean;
  canSwitch: boolean;
  onSignIn: () => void;
  onSwitch: () => void;
  switchRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <>
      <span className="account-banner__text">
        <AccountChip variant="inline" account={account} /> is signed out
      </span>
      {compact ? null : (
        <span className="account-banner__hint">
          This agent is paused until you sign in. It never switches accounts on its own.
        </span>
      )}
      <div className="account-banner__actions">
        <button type="button" className="account-banner__btn" onClick={onSignIn}>
          {ACCOUNT_WORDS.signIn}
        </button>
        {canSwitch ? (
          <button type="button" ref={switchRef} className="account-banner__btn" onClick={onSwitch}>
            Switch account…
          </button>
        ) : null}
      </div>
    </>
  );
}

function RemovedBody({
  compact,
  onSwitch,
  switchRef,
}: {
  compact?: boolean;
  onSwitch: () => void;
  switchRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <>
      <span className="account-banner__text">
        <AccountChip variant="inline" removed />
      </span>
      {compact ? null : (
        <span className="account-banner__hint">
          This agent's account no longer exists. Pick another account to continue.
        </span>
      )}
      <div className="account-banner__actions">
        <button type="button" ref={switchRef} className="account-banner__btn" onClick={onSwitch}>
          Switch account…
        </button>
      </div>
    </>
  );
}

/**
 * The session account banner (plan B3.5), driven entirely by server data:
 *
 * - **Limited** (`account.limited` from `account:limited`, R4): names the
 *   window and its reset, offers `Wait` (dismisses this limit instance, keyed
 *   by its reset time) and `Switch this session to <other>`, with the
 *   hand-over caveat taken from the CLI's `accountSwitch` capability.
 * - **Signed out** (`account.auth === "signed_out"`, decided by the daemon's
 *   identity check only — Decision 12): the agent is paused, no silent fallback;
 *   offers `Sign in` (the shared sign-in dialog) and
 *   `Switch account…`.
 *
 * - **Removed** (the session's stored account id is no longer listed): the
 *   agent can't resume; offers `Switch account…`.
 *
 * A switch is exactly `api.switchSessionAccount` and nothing else: the
 * `session:updated{supersededBy}` handler already follows the replacement. A
 * Terminal session gets no break card, so its outcome is toasted from the
 * response instead.
 */
export function AccountBanner({ api, session, compact }: AccountBannerProps) {
  const accounts = useServerStore((s) => s.accounts);
  const modes = useModesStore((s) => s.modes);
  const cli = sessionCli(session, modes);
  const accountsLoaded = useServerStore((s) => s.accountsLoaded);
  const acct = cli ? accountOf(accounts, cli, session.accountId) : undefined;
  const removed = !!cli && isAccountRemoved(accounts, accountsLoaded, cli, session.accountId);
  const limited = acct?.limited ?? null;
  const alternative = acct ? alternativeAccount(accounts, acct) : undefined;

  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [caps, setCaps] = useState<SwitchCaps>("none");
  const [menuOpen, setMenuOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [verifiesIdentity, setVerifiesIdentity] = useState(true);
  const [firstRunNote, setFirstRunNote] = useState<string | null>(null);
  const { switchTo: runSwitch, error: errorText, fallback, notice, clearError, dismissNotice } = useAccountSwitch(api, session);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  const nowMs = Date.now();

  // The hand-over caveat comes from capability data, fetched only while a
  // limited account actually has somewhere to switch to.
  const needsSteps = acct?.auth === "signed_out";
  useEffect(() => {
    if (!cli || !((limited && alternative) || needsSteps)) return;
    let live = true;
    void api
      .getSupportedClis()
      .then((clis) => {
        const found = clis.find((c) => c.id === cli);
        if (!live) return;
        setCaps(found?.accountSwitch ?? "none");
        setVerifiesIdentity(found?.accountLink?.verifiesIdentity !== false);
        setFirstRunNote(found?.accountLink?.firstRunNote ?? null);
      })
      .catch(() => {
        /* the banner still renders without the caveat line */
      });
    return () => {
      live = false;
    };
  }, [api, cli, limited, alternative, needsSteps]);

  // A failed action's message belongs to the session it was shown for.
  useEffect(() => {
    clearError();
  }, [session.id, clearError]);

  if (!cli || (!acct && !removed)) return null;
  // Narrowed once for the closures and JSX below.
  const cliId = cli;

  function switchTo(target: AccountSummary) {
    setMenuOpen(false);
    void runSwitch(target);
  }

  const canSwitch = acct
    ? accountsForCli(accounts, cliId).some((a) => a.id !== acct.id && isUsable(a))
    : true;

  const closeMenu = () => {
    setMenuOpen(false);
    switchTriggerRef.current?.focus();
  };

  const signedOut = removed || acct?.auth === "signed_out";
  const dismissKey = limited ? (limited.resetsAt ?? limited.windowId) : null;
  const hidden = !signedOut && (!limited || dismissedKey === dismissKey);

  return (
    <>
      {!hidden ? (
        <div
          className={`account-banner${compact ? " account-banner--compact" : ""}${
            signedOut ? " account-banner--signed-out" : " account-banner--limited"
          }`}
          role={signedOut ? "alert" : "status"}
          data-testid="account-banner"
        >
          {removed || !acct ? (
            <RemovedBody
              {...(compact ? { compact } : {})}
              onSwitch={() => setMenuOpen(true)}
              switchRef={switchTriggerRef}
            />
          ) : signedOut ? (
            <SignedOutBody
              account={acct}
              canSwitch={canSwitch}
              {...(compact ? { compact } : {})}
              onSignIn={() => setStepsOpen(true)}
              onSwitch={() => setMenuOpen(true)}
              switchRef={switchTriggerRef}
            />
          ) : (
            <LimitedBody
              name={acct.displayName}
              windowId={windowWord(cliId, limited!.windowId)}
              resetsAt={limited!.resetsAt}
              nowMs={nowMs}
              alternative={alternative}
              caps={caps}
              {...(compact ? { compact } : {})}
              onWait={() => setDismissedKey(dismissKey)}
              onSwitch={() => {
                if (alternative) switchTo(alternative);
              }}
            />
          )}
          {menuOpen ? (
            <SwitchAccountMenu
              cli={cliId}
              currentAccountId={session.accountId}
              anchorRef={switchTriggerRef}
              onPick={(id) => {
                const target = accountOf(accounts, cliId, id);
                if (target) switchTo(target);
              }}
              onClose={closeMenu}
            />
          ) : null}
        </div>
      ) : null}
      {acct && stepsOpen ? (
        <SignInDialog
          open
          api={api}
          cli={cliId}
          account={acct}
          verifiesIdentity={verifiesIdentity}
          firstRunNote={firstRunNote}
          onClose={() => setStepsOpen(false)}
        />
      ) : null}
      {notice ? (
        <Toast
          className="account-banner__toast"
          {...(notice.sticky ? {} : { autoDismissMs: 8000 })}
          onDismiss={dismissNotice}
        >
          {notice.text}
        </Toast>
      ) : null}
      {errorText && !hidden ? (
        <div className="account-banner__error-wrap">
          <p className="account-banner__error" role="alert">
            {errorText}
          </p>
          {fallback ? (
            <button type="button" className="account-banner__btn" onClick={fallback.run}>
              {fallback.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
