import { Command } from "commander";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { daemonPost } from "../lib/daemon-client.js";
import { getDaemonUrlOrThrow, getDaemonToken } from "../lib/daemon-url.js";
import { daemonGet } from "../lib/daemon-client.js";
import { preflight } from "../lib/preflight.js";
import { die } from "../lib/output.js";
import ora from "ora";

interface Attachment {
  id: string;
  name: string;
}

interface SendChatResponse {
  turnId: string;
  queuePosition: number;
}

interface NormalizedEvent {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  toolName?: string;
  turnId?: string;
  toolResult?: { content?: string; isError?: boolean };
}

interface TranscriptResponse {
  events: NormalizedEvent[];
}

/** Upload a single file via multipart → returns its Attachment id. */
async function uploadFile(sessionId: string, path: string): Promise<Attachment> {
  const url = getDaemonUrlOrThrow();
  const token = getDaemonToken();
  const buf = readFileSync(path);
  const form = new FormData();
  form.append("files", new Blob([buf]), basename(path));
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    die(body.error ?? `Upload failed (HTTP ${res.status})`, res.status === 413 ? 1 : 1);
  }
  const data = (await res.json()) as { attachments: Attachment[] };
  const att = data.attachments[0];
  if (!att) die("Upload returned no attachment", 1);
  return att;
}

/** Poll the transcript until a `result`/`error` event for `turnId` appears. */
async function waitForTurn(sessionId: string, turnId: string): Promise<void> {
  const printed = new Set<string>();
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min safety cap
  for (;;) {
    const result = await daemonGet<TranscriptResponse>(`/sessions/${sessionId}/transcript`);
    if (!result.ok) {
      die(result.error, result.status === 404 ? 2 : 1);
    }
    for (const ev of result.data.events) {
      if (printed.has(ev.id)) continue;
      printed.add(ev.id);
      // Only surface events for the turn we're waiting on.
      if (ev.turnId && ev.turnId !== turnId) continue;
      const who = ev.role ? `${ev.kind}/${ev.role}` : ev.kind;
      const body = (ev.text ?? ev.toolName ?? ev.toolResult?.content ?? "").replace(/\s+/g, " ").slice(0, 200);
      if (body || ev.kind === "result" || ev.kind === "error") {
        console.log(`[${who}] ${body}`);
      }
      if ((ev.kind === "result" || ev.kind === "error") && ev.turnId === turnId) {
        return;
      }
    }
    if (Date.now() > deadline) {
      die("Timed out waiting for turn to finish", 1);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

export function registerChat(program: Command): void {
  const chat = program
    .command("chat")
    .description("Talk to a JSON agent-chat session");

  chat
    .command("stop <session>")
    .description("Abort the active turn (keeps queued turns)")
    .action(async (sessionId: string) => {
      await preflight();
      const result = await daemonPost<{ ok: true }>(`/sessions/${sessionId}/chat/stop`);
      if (!result.ok) {
        die(result.error, result.status === 404 ? 2 : 1);
      }
      console.log("ok");
    });

  chat
    .argument("<session>", "JSON agent session id")
    .argument("[message]", "Message to send")
    .option("--file <path>", "Attach a file (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--wait", "Stream the transcript until the turn finishes")
    .description("Send a message to a JSON agent session")
    .action(
      async (
        sessionId: string,
        message: string | undefined,
        opts: { file: string[]; wait?: boolean },
      ) => {
        await preflight();

        const msg = message ?? "";
        if (!msg.trim() && opts.file.length === 0) {
          die("Provide a message or at least one --file", 1);
        }

        const attachmentIds: string[] = [];
        if (opts.file.length > 0) {
          const spinner = ora("Uploading attachments...").start();
          try {
            for (const f of opts.file) {
              const att = await uploadFile(sessionId, f);
              attachmentIds.push(att.id);
            }
            spinner.stop();
          } catch (err) {
            spinner.fail();
            throw err;
          }
        }

        const result = await daemonPost<SendChatResponse>(`/sessions/${sessionId}/chat`, {
          message: msg,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        if (!result.ok) {
          die(result.error, result.status === 404 ? 2 : 1);
        }

        const { turnId, queuePosition } = result.data;
        if (queuePosition > 0) {
          console.log(`Queued (position ${queuePosition}): ${turnId}`);
        } else {
          console.log(turnId);
        }

        if (opts.wait) {
          await waitForTurn(sessionId, turnId);
        }
      },
    );
}
