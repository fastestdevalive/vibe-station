import type { Session } from "@/api/types";

/**
 * The display label for a session's tab/sidebar row: the custom `name` when
 * one is set, else a computed default based on `isMain`/`type`.
 *
 * This used to be a separate `label` field computed server-side and sent
 * over the wire (both in the initial fetch AND every `session:created`/
 * `session:updated` WS event). That was redundant: the fallback rule below
 * is a pure function of fields the client already has (`name`, `isMain`,
 * `type`) — no server-only state is involved. Worse, having two fields for
 * one displayed value meant a caller could correctly patch `name` on a
 * rename event while forgetting to also patch the separately-computed
 * `label`, and the UI would keep rendering the stale value until an
 * unrelated refetch recomputed it (see the `session:updated` rename bug this
 * replaced). Computing it here, always, from `name` means there is no second
 * value that can ever go stale — every renderer just calls this function.
 */
export function sessionLabel(s: Pick<Session, "name" | "isMain" | "type">): string {
  if (s.name && s.name.length > 0) return s.name;
  if (s.isMain) return "main";
  return s.type === "agent" ? "Agent" : "Terminal";
}
