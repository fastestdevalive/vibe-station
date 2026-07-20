import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { printJson, die } from "../../lib/output.js";

interface UsageInfo {
  totalTokens: number;
  contextWindow?: number;
  costUsd?: number;
  model: string;
}

interface SessionMeta {
  sessionId: string;
  channel: string;
  cli: string;
  model?: string;
  modeName?: string;
  turnState: string;
  queueDepth: number;
  usage?: UsageInfo;
}

export function registerSessionMeta(session: Command): void {
  session
    .command("meta <id>")
    .description("Print a JSON session's cross-harness meta (usage/model/turn-state)")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<SessionMeta>(`/sessions/${id}/meta`);
      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      const meta = result.data;
      if (opts.json) {
        printJson(meta);
      }

      console.log(`Session:   ${meta.sessionId}`);
      console.log(`Channel:   ${meta.channel}`);
      console.log(`CLI:       ${meta.cli}`);
      if (meta.model) console.log(`Model:     ${meta.model}`);
      if (meta.modeName) console.log(`Mode:      ${meta.modeName}`);
      console.log(`Turn:      ${meta.turnState}`);
      console.log(`Queue:     ${meta.queueDepth}`);
      if (meta.usage) {
        const u = meta.usage;
        const ctx = u.contextWindow ? ` / ${u.contextWindow}` : "";
        console.log(`Tokens:    ${u.totalTokens}${ctx}`);
        if (u.costUsd != null) console.log(`Cost:      $${u.costUsd.toFixed(4)}`);
      }
    });
}
