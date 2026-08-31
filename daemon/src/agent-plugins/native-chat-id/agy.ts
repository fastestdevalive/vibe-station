/**
 * agy — NATIVE chat-id resolution (`native-chat-id/` — see the block comment
 * above `AgentPlugin.captureNativeChatId` in `daemon/src/services/spawn.ts`
 * for the two-identity model, and `docs/AGENT-CHAT-ID-CAPTURE.md` for the
 * per-CLI strategy matrix).
 *
 * agy's strategy is **bridged**: the ACP `session/new` id and agy's own native
 * `conversationId` are DIFFERENT values, but a reliable, session-keyed mapping
 * between them exists on disk, so `agy.ts`'s `captureNativeChatId` can convert
 * one into the other. Both readers below are pure, best-effort file reads:
 * every failure mode returns `null` rather than throwing.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Path to agy's per-cwd conversation index (`cwd → latest conversation_id`). */
function agyLastConversationsPath(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
}

/**
 * Read the latest agy conversation id for a given workspace cwd (best-effort).
 * NOTE: only reliable as a LAST-RESORT fallback (`getRestoreCommand`, and the
 * tail of `captureNativeChatId`) — see the chat-id capture block comment in
 * `agy.ts` for why this cannot be trusted as a primary signal.
 */
export async function readLatestAgyConversationId(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(agyLastConversationsPath(), "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const id = map[cwd];
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Path to the `antigravity-acp` npm adapter's OWN persistent session-binding
 * store (verified live 2026-08-30 by reading the adapter's source at
 * `src/store/sessionStore.ts` / `src/constants/index.ts` in the published
 * `antigravity-acp@1.1.0` tarball, then reproducing the bind live). The
 * adapter — NOT agy itself — writes this file, keyed by the exact ACP
 * `session/new` id, each entry carrying agy's own native `conversationId`.
 */
function agyAcpSessionsPath(): string {
  return join(homedir(), ".agy-acp", "sessions.json");
}

/**
 * The ACP-id → native-id BRIDGE for agy (Decision 6 Option B, superseding the
 * original cwd-keyed fallback for `captureNativeChatId`): read the
 * `antigravity-acp` adapter's own `~/.agy-acp/sessions.json`, keyed by ACP
 * `sessionId`, and return the `conversationId` it recorded for THIS session.
 *
 * Mechanism (verified live 2026-08-30 against a real `bunx antigravity-acp@1.1.0`
 * + real `agy` binary): the adapter's `SessionManager`/`SessionStore` persist
 * `{ sessions: { <acpSessionId>: { conversationId, cwd, ... } } }` to this file
 * after every turn that binds a conversation (`src/acp/agent.ts`'s `prompt()`
 * handler calls `sessions.persist()` once `outcome.conversationId !== null`).
 * The adapter itself derives `conversationId` by diffing agy's own
 * `~/.gemini/antigravity-cli/conversations/*.db` directory before/after the
 * first prompt (`src/conversation/scan.ts`'s `newConversationId`) — i.e. it is
 * agy's real, native conversation id, the exact same value agy's own
 * `--conversation` flag accepts.
 *
 * This is STRICTLY more reliable than `readLatestAgyConversationId` (cwd-keyed,
 * ambiguous on a reused cwd): it is keyed by the unique ACP session id, so
 * there is no cross-session ambiguity at all, regardless of cwd reuse.
 *
 * Live verification (2026-08-30, real `bunx antigravity-acp@1.1.0` + real
 * `agy`): spawned ACP `session/new` → `session/prompt "say PINGSPIKE"` →
 * `~/.agy-acp/sessions.json[<acpSessionId>].conversationId` was a DIFFERENT
 * uuid than the ACP session id (confirming the ids diverge, Option B) → ran
 * `agy --conversation <conversationId> --dangerously-skip-permissions -p "what
 * did you say a moment ago?"` in a plain terminal → agy correctly answered
 * "PINGSPIKE" — the native resume genuinely works with this id.
 */
export async function readAgyAcpSessionConversationId(
  acpSessionId: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(agyAcpSessionsPath(), "utf8");
    const parsed = JSON.parse(raw) as { sessions?: Record<string, { conversationId?: unknown }> };
    const entry = parsed.sessions?.[acpSessionId];
    const id = entry?.conversationId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
