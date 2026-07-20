import { Command } from "commander";
import { daemonGet } from "../../lib/daemon-client.js";
import { preflight } from "../../lib/preflight.js";
import { die } from "../../lib/output.js";

interface NormalizedEvent {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  toolName?: string;
  toolResult?: { content?: string; isError?: boolean };
}

interface TranscriptResponse {
  events: NormalizedEvent[];
}

export function registerSessionTranscript(session: Command): void {
  session
    .command("transcript <id>")
    .description("Print a JSON session's normalized transcript")
    .option("--json", "Output raw NDJSON events")
    .action(async (id: string, opts: { json?: boolean }) => {
      await preflight();

      const result = await daemonGet<TranscriptResponse>(`/sessions/${id}/transcript`);
      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }

      const events = result.data.events ?? [];
      if (opts.json) {
        for (const ev of events) {
          console.log(JSON.stringify(ev));
        }
        process.exit(0);
      }

      if (events.length === 0) {
        console.log("(no transcript yet)");
        return;
      }
      for (const ev of events) {
        const who = ev.role ? `${ev.kind}/${ev.role}` : ev.kind;
        const body =
          ev.text ??
          ev.toolName ??
          ev.toolResult?.content ??
          "";
        const oneLine = body.replace(/\s+/g, " ").slice(0, 200);
        console.log(`[${who}] ${oneLine}`);
      }
    });
}
