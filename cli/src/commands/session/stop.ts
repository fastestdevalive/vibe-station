import { Command } from "commander";
import { daemonPost } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die } from "../../lib/output.js";

/** D1 — re-homed from `vst chat stop`. Route (`POST /sessions/:id/chat/stop`) unchanged. */
export function registerSessionStop(session: Command): void {
  session
    .command("stop <id>")
    .description("Abort the active Rich Chat turn (queued turns are kept)")
    .action(async (id: string) => {
      await preflight();
      const result = await daemonPost<{ ok: true }>(`/sessions/${encodeURIComponent(id)}/chat/stop`);
      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }
      console.log("ok");
    });
}
