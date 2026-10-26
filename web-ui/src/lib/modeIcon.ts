import type { CliId, Session } from "@/api/types";

/**
 * Client-side preview of the icon key the daemon assigns to a mode
 * (`AgentPlugin::default_mode_icon` in rust/vst-agents). Used ONLY to preview
 * an icon before a mode exists (e.g. in the New mode dialog); every saved mode
 * carries its authoritative `icon` from the daemon — keep this rule in sync.
 */
export function deriveModeIcon(cli: CliId | "", model?: string | null): string | null {
  if (!cli) return null;
  // Multi-provider CLIs: a DeepSeek model shows the DeepSeek mark.
  if (cli === "opencode" || cli === "omp") {
    return model && model.toLowerCase().includes("deepseek") ? "deepseek" : cli;
  }
  return cli;
}

/**
 * The mode a session runs (or, for a not-yet-promoted draft, will run).
 * `session:updated` never clears a draft's `draftConfig` on the client, so its
 * chosen mode stays readable after promotion until the record is refetched —
 * this keeps the icon correct in that window on every connected client.
 */
export function sessionModeId(s: Pick<Session, "modeId" | "draftConfig">): string | null {
  return s.modeId ?? s.draftConfig?.modeId ?? null;
}

/**
 * True when an agent session has no mode (`modeId == null`) or its `modeId`
 * cannot be resolved in the provided modes lookup (e.g. Map<string, Mode>).
 * Uses `session.modeId` directly (not draftConfig fallback). Drafts never reach
 * this — `AgentPaneSlot` renders `DraftComposer` for them, so the toggle only
 * ever sees a real agent session.
 */
export function isSessionModeMissing(
  session: Pick<Session, "modeId">,
  modes: ReadonlyMap<string, unknown>,
): boolean {
  return !session.modeId || !modes.has(session.modeId);
}
