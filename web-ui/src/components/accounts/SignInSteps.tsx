import { useEffect, useRef, useState } from "react";
import type { AccountSummary } from "@/api/types";
import { apiErrorText } from "@/lib/apiErrorText";
import "./accounts.css";

interface SignInStepsProps {
  account: AccountSummary;
  /** False for CLIs with no identity command (pi/omp): the check reads "I've signed in". */
  verifiesIdentity: boolean;
  /** Re-checks the account and resolves with its refreshed summary. */
  onCheck: () => Promise<AccountSummary>;
  onOpenTerminal: () => void;
  onCancel?: () => void;
  /** False when no worktree can host a sign-in Terminal: the button is not
   *  rendered (the steps still work in any terminal). Default true. */
  canOpenTerminal?: boolean;
}

type CopyState = "idle" | "copied" | "select";

const COPIED_MS = 2000;

/** Whether a checked summary still needs the user to finish signing in. */
function stillSignedOut(acct: AccountSummary): boolean {
  return acct.pending === true || acct.auth === "signed_out";
}

/**
 * The three-step sign-in guide for an account whose folder is waiting for a
 * login (plan B2a.1). Every word and the command come from the daemon's
 * `account.signIn`; this component never builds a command or names a harness.
 */
export function SignInSteps({
  account,
  verifiesIdentity,
  onCheck,
  onOpenTerminal,
  onCancel,
  canOpenTerminal = true,
}: SignInStepsProps) {
  const steps = account.signIn ?? { command: null, hint: null };
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [checking, setChecking] = useState(false);
  const [stillPending, setStillPending] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const commandRef = useRef<HTMLElement>(null);

  // "Copied" is a 2 s confirmation on the button itself, then it reads "Copy" again.
  useEffect(() => {
    if (copyState !== "copied") return undefined;
    const timer = setTimeout(() => setCopyState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  // Clipboard refused (insecure context, permission): select the text so the
  // user can finish with Ctrl+C instead of getting no feedback at all.
  async function copyCommand() {
    const command = steps.command;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      const node = commandRef.current;
      if (node && typeof window.getSelection === "function") {
        window.getSelection()?.selectAllChildren(node);
      }
      setCopyState("select");
    }
  }

  async function check() {
    if (busyRef.current) return;
    busyRef.current = true;
    setChecking(true);
    setError("");
    setStillPending(false);
    try {
      const next = await onCheck();
      setStillPending(stillSignedOut(next));
    } catch (e) {
      setError(apiErrorText(e, "Couldn't check the sign-in."));
    } finally {
      busyRef.current = false;
      setChecking(false);
    }
  }

  return (
    <div className="sign-in-steps">
      {account.signIn ? (
        <ol className="sign-in-steps__list">
          <li className="sign-in-steps__step">
            <span className="sign-in-steps__label">Open a terminal on this machine</span>
          </li>
          <li className="sign-in-steps__step">
            <span className="sign-in-steps__label">{steps.hint ?? "Run this command"}</span>
            {steps.command ? (
              <div className="sign-in-steps__command">
                <code ref={commandRef} className="sign-in-steps__code">
                  {steps.command}
                </code>
                <button
                  type="button"
                  className="sign-in-steps__copy"
                  aria-live="polite"
                  onClick={() => void copyCommand()}
                >
                  {copyState === "copied" ? "Copied" : "Copy"}
                </button>
              </div>
            ) : null}
          </li>
          <li className="sign-in-steps__step">
            <span className="sign-in-steps__label">Finish in your browser</span>
          </li>
        </ol>
      ) : (
        <p className="sign-in-steps__label">
          Sign in with this CLI&apos;s own login in a terminal, then press Check again.
        </p>
      )}
      <div className="sign-in-steps__actions">
        <button type="button" disabled={checking} onClick={() => void check()}>
          {verifiesIdentity ? "Check again" : "I've signed in"}
        </button>
        {canOpenTerminal ? (
          <button type="button" onClick={onOpenTerminal}>
            Open in a terminal tab
          </button>
        ) : null}
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <div className="sign-in-steps__feedback">
        {copyState === "select" ? <p className="sign-in-steps__hint">Press Ctrl+C (⌘C on a Mac) to copy.</p> : null}
        {stillPending ? (
          <p className="sign-in-steps__status" role="status">
            Still not signed in.
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="sign-in-steps__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
