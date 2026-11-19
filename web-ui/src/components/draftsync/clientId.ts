import { randomId } from "@/lib/uuid";

let clientId: string | null = null;

/** One draft-sync client id per page load. The daemon echoes it on the PUT reply
 *  and in `draft-text:changed`, so a client can tell its own writes from other
 *  clients' without comparing text. `randomId` (not `crypto.randomUUID`) so a
 *  plain-HTTP LAN origin cannot throw. */
export function getClientId(): string {
  if (clientId === null) clientId = randomId();
  return clientId;
}
