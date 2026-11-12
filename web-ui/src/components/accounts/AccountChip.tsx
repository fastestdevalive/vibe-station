import type { ReactNode } from "react";
import type { AccountSummary } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import {
  ACCOUNT_WORDS,
  accountInitials,
  accountName,
  accountSecondary,
  accountState,
  accountStateWord,
  planLabel,
} from "@/lib/accounts";
import "./accounts.css";

export type AccountChipVariant = "mark" | "inline" | "row";

interface AccountChipProps {
  /** The account to draw. Absent (or `removed`) draws the "Account removed" chip. */
  account?: AccountSummary | null;
  /** The session's account was removed: monogram "?", dashed border. */
  removed?: boolean;
  variant: AccountChipVariant;
  /** Row only: the plan as a neutral chip. */
  showPlan?: boolean;
  /** Row only: the Default chip. */
  showDefault?: boolean;
  /** Row only: the caller's folder line, appended to the secondary line. */
  detail?: string | null;
  /** Row only: extra content at the right edge (a "Current" tag, a check mark). */
  trailing?: ReactNode;
  /** A bare name for a chip with no `account` (the break card only has names). With an `account` the name is `accountName(account)`. */
  name?: string;
  /** Row only: omit the state word (the caller draws it with `AccountStateTag`). */
  hideState?: boolean;
}

/** The state word ("Signed out", "Waiting for sign-in") on its own, for a row that places it beside its actions. */
export function AccountStateTag({ account }: { account: AccountSummary }) {
  const word = accountStateWord(account);
  if (!word) return null;
  return (
    <span className="account-chip__state" data-state-word={accountState(account)}>
      {word}
    </span>
  );
}

/**
 * The one component that draws an account (R1F-06): a neutral monogram plus,
 * per variant, its name, email, plan and state word. Every word comes from
 * `ACCOUNT_WORDS`; the monogram has no hue so it can never be read as a
 * status colour. Signed out / waiting / removed use a dashed border instead.
 */
export function AccountChip({
  account,
  removed = false,
  variant,
  showPlan = false,
  showDefault = false,
  detail,
  trailing,
  name,
  hideState = false,
}: AccountChipProps) {
  const acct = removed ? null : (account ?? null);
  const gone = acct === null;
  const displayName = name ?? (acct ? accountName(acct) : ACCOUNT_WORDS.removed);
  // A bare `name` (the break card only has names) is a normal chip, not a removed one.
  const state = acct ? accountState(acct) : removed || !name ? "removed" : "ok";
  const stateWord = acct ? accountStateWord(acct) : null;
  const initials = gone && !name ? "?" : accountInitials(displayName);
  const mark = (
    <span className="account-chip__mark" aria-hidden="true">
      {initials}
    </span>
  );

  if (variant === "mark") {
    const label = `Account: ${displayName}${stateWord ? `, ${stateWord}` : ""}`;
    return (
      <span
        className="account-chip account-chip--mark"
        data-state={state}
        role="img"
        aria-label={label}
        title={label}
      >
        {mark}
      </span>
    );
  }

  if (variant === "inline") {
    return (
      <span className="account-chip account-chip--inline" data-state={state}>
        {mark}
        <span className="account-chip__name" title={displayName}>
          {displayName}
        </span>
      </span>
    );
  }

  const isSystem = acct?.id === "system";
  const secondary = [
    isSystem && displayName.toLowerCase() !== ACCOUNT_WORDS.system.toLowerCase() ? ACCOUNT_WORDS.system : null,
    acct ? accountSecondary(acct) : null,
    acct ? detail : null,
  ].filter((part): part is string => !!part);
  const plan = acct && showPlan ? planLabel(acct.plan) : null;
  const apiKey = !!acct && showPlan && acct.method === "api_key";

  return (
    <span className="account-chip account-chip--row" data-state={state}>
      {mark}
      <span className="account-chip__text">
        <span className="account-chip__line">
          <span className="account-chip__name" title={displayName}>
            {displayName}
          </span>
          {plan ? (
            <Chip size="sm" tone="neutral">
              {plan}
            </Chip>
          ) : null}
          {apiKey ? (
            <Chip size="sm" tone="neutral">
              {ACCOUNT_WORDS.apiKey}
            </Chip>
          ) : null}
          {acct && showDefault && acct.isDefault ? (
            <Chip size="sm" tone="neutral">
              {ACCOUNT_WORDS.isDefault}
            </Chip>
          ) : null}
        </span>
        {secondary.length > 0 ? (
          <span className="account-chip__secondary" title={secondary.join(" · ")}>
            {secondary.join(" · ")}
          </span>
        ) : null}
      </span>
      {stateWord && !hideState ? (
        <span className="account-chip__state" data-state-word={state}>
          {stateWord}
        </span>
      ) : null}
      {trailing ? <span className="account-chip__trailing">{trailing}</span> : null}
    </span>
  );
}
