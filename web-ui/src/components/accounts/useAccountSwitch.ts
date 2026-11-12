import { useCallback, useState } from "react";
import { create } from "zustand";
import type { ApiInstance } from "@/api";
import type { AccountSummary, ResetResult, Session } from "@/api/types";
import { errorCodeOf, isAccountError } from "@/api/errors";
import { apiErrorText } from "@/lib/apiErrorText";

/** The one switch call and its outcome text, shared by the session account
 *  control and the banner (R1F-12). */
export function switchErrorText(e: unknown): string {
  if (isAccountError(e, "agent_busy")) return "Wait for the agent to finish, then switch.";
  if (isAccountError(e, "handover_failed")) {
    return apiErrorText(e, "Couldn't hand the conversation over. Nothing changed: this agent stays on its current account.");
  }
  if (errorCodeOf(e) === "reset_in_progress") return "A switch is already running for this agent.";
  return apiErrorText(e, "Couldn't switch accounts.");
}

/** What the hand-over actually did, per the switch response (Decision 7). */
export function switchToast(name: string, handover: "native" | "transcript" | "fresh" | undefined): string {
  if (handover === "native") return `Switched to ${name}. The conversation was handed over.`;
  if (handover === "transcript") return `Switched to ${name}. The agent is reading a transcript of the earlier chat.`;
  return `Switched to ${name}. This agent starts a new conversation.`;
}

interface SwitchNotice {
  text: string;
  /** A fresh start stays until dismissed; a hand-over fades. */
  sticky: boolean;
}

interface NoticeStore {
  notices: Record<string, SwitchNotice>;
  put: (id: string, notice: SwitchNotice) => void;
  drop: (id: string) => void;
}

/** Terminal switch outcomes, keyed by the REPLACEMENT session's id: the
 *  superseded session's pane unmounts, so its own state would never be seen. */
export const useSwitchNotices = create<NoticeStore>((set) => ({
  notices: {},
  put: (id, notice) => set((s) => ({ notices: { ...s.notices, [id]: notice } })),
  drop: (id) =>
    set((s) => {
      if (!(id in s.notices)) return s;
      const { [id]: _gone, ...rest } = s.notices;
      return { notices: rest };
    }),
}));

export type SwitchSession = Pick<Session, "id" | "channel">;

type SwitchOpts = NonNullable<Parameters<ApiInstance["switchSessionAccount"]>[2]>;

/** The one way forward offered after a refused hand-over. */
export interface SwitchFallback {
  label: string;
  run: () => void;
}

/**
 * `useAccountSwitch(api, session)`: a switch is exactly
 * `api.switchSessionAccount`; the `session:updated{supersededBy}` handler
 * follows the replacement. A non-`json` session gets no break card, so its
 * outcome is returned as `notice` instead.
 */
export function useAccountSwitch(api: Pick<ApiInstance, "switchSessionAccount"> | undefined, session: SwitchSession) {
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<Pick<AccountSummary, "id" | "displayName"> | null>(null);
  const { id, channel } = session;
  const notice = useSwitchNotices((s) => s.notices[id] ?? null);

  const clearError = useCallback(() => {
    setError(null);
    setRefused(null);
  }, []);
  const dismissNotice = useCallback(() => useSwitchNotices.getState().drop(id), [id]);

  const switchTo = useCallback(
    async (target: Pick<AccountSummary, "id" | "displayName">, opts?: SwitchOpts) => {
      if (!api) return;
      setError(null);
      setRefused(null);
      try {
        const res: ResetResult = await (opts ? api.switchSessionAccount(id, target.id, opts) : api.switchSessionAccount(id, target.id));
        if (channel !== "json") {
          const handover = res.accountSwitch?.handover;
          useSwitchNotices.getState().put(res.newSessionId, {
            text: switchToast(target.displayName, handover),
            sticky: handover !== "native" && handover !== "transcript",
          });
        }
      } catch (e) {
        setError(switchErrorText(e));
        if (isAccountError(e, "handover_failed")) setRefused(target);
      }
    },
    [api, id, channel],
  );

  // A Rich Chat can carry a transcript; a Terminal has nothing to carry, so it starts anew.
  const fallback: SwitchFallback | null = refused
    ? channel === "json"
      ? { label: "Switch with a transcript instead", run: () => void switchTo(refused, { carryOver: "transcript" }) }
      : { label: "Switch and start a new conversation", run: () => void switchTo(refused, { carryOver: "none" }) }
    : null;

  return { switchTo, error, fallback, notice, clearError, dismissNotice };
}
