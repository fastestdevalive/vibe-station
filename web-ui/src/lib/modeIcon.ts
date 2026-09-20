import type { CliId, Session } from "@/api/types";

/**
 * Client-side preview of the icon key the daemon assigns to a mode
 * (`AgentPlugin::default_mode_icon` in rust/vst-agents). Used ONLY to preview
 * an icon before a mode exists (e.g. in the New mode dialog); every saved mode
 * carries its authoritative `icon` from the daemon — keep this rule in sync.
 */
export function deriveModeIcon(cli: CliId | "", model?: string | null): string | null {
  if (!cli) return null;
  if (cli === "opencode") {
    return model && model.toLowerCase().includes("deepseek") ? "deepseek" : "opencode";
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
