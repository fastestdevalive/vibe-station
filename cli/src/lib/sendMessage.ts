/**
 * Shared implementation for `vst session send` (D6). Kept as a lib so the
 * command file stays a thin registration shim.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { daemonPost, daemonGet } from "./daemon-client.js";
import { getDaemonUrlOrThrow, getDaemonToken } from "./daemon-url.js";
import { die, warn } from "./output.js";
import ora from "ora";

interface Attachment {
  id: string;
  name: string;
}

interface SessionSummary {
  state: string;
  channel: string;
}

interface NormalizedEvent {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  toolName?: string;
  toolResult?: { content?: string; isError?: boolean };
}

export interface SendOptions {
  file?: string;
  /** Repeatable — Rich Chat (json) targets only (D5). */
  attach: string[];
  /** D8 — opt out of steering a running Rich Chat turn; always enqueue instead. */
  queue?: boolean;
  wait?: boolean;
  timeout?: string;
}

/** Upload a single file via multipart → returns its Attachment id. Shared with
 *  the removed `vst chat --file` flow (ported from the deleted chat.ts). */
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
    die(body.error ?? `Upload failed (HTTP ${res.status})`, 1);
  }
  const data = (await res.json()) as { attachments: Attachment[] };
  const att = data.attachments[0];
  if (!att) die("Upload returned no attachment", 1);
  return att;
}

/** D1 rider — `send --wait` prints the reply, unlike the pre-cleanup `vst
 *  send` which only waited for the session to settle and left reading the
 *  answer to a separate `output` call.
 *
 *  Always via `/output`, for BOTH channels. The obvious-looking alternative —
 *  read `/transcript` and print the last `kind:"text"` event — is wrong: a
 *  `text` event is one streamed CHUNK, not a whole message (one per
 *  `agent_message_chunk`/`textDelta`/content block; see
 *  `daemon/src/services/acp/normalize.ts:168`), so it prints only the trailing
 *  fragment of the answer. `/output` already groups chunks by `turnId`
 *  (`daemon/src/routes/sessions.ts:494-507`) — which is exactly why that
 *  branch exists. */
async function printReply(sessionId: string): Promise<void> {
  const id = encodeURIComponent(sessionId);
  const out = await daemonGet<{ output: string }>(`/sessions/${id}/output?lines=50`);
  if (out.ok) console.log(out.data.output);
}

export async function runSend(
  sessionId: string,
  messageParts: string[],
  opts: SendOptions,
): Promise<void> {
  let content = messageParts.join(" ");
  if (opts.file) {
    content = readFileSync(opts.file, "utf-8");
  }

  // `data` is required (min 1) on the daemon side regardless of attachments —
  // unlike `/chat`, `/send` has no files-only turn (--attach alone is not
  // enough). Check BEFORE uploading so a doomed request never uploads a file
  // it can't attach to anything.
  if (!content.trim()) {
    die("Provide a message or --file", 1);
  }

  const attachmentIds: string[] = [];
  if (opts.attach.length > 0) {
    // D5 — attachments only make sense on a Rich Chat (json) target; error
    // BEFORE uploading rather than letting the daemon accept-then-ignore it.
    const infoResult = await daemonGet<SessionSummary>(`/sessions/${encodeURIComponent(sessionId)}`);
    if (!infoResult.ok) {
      die(infoResult.error, infoResult.status === 404 ? 2 : 1);
    }
    if (infoResult.data.channel !== "json") {
      die(
        "Attachments require a Rich Chat (json) session — --attach is not supported on tmux/pty targets",
        1,
      );
    }

    const spinner = ora("Uploading attachments...").start();
    try {
      for (const f of opts.attach) {
        const att = await uploadFile(sessionId, f);
        attachmentIds.push(att.id);
      }
      spinner.stop();
    } catch (err) {
      spinner.fail();
      throw err;
    }
  }

  const result = await daemonPost<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/send`, {
    data: content,
    sendEnter: true,
    ...(attachmentIds.length ? { attachmentIds } : {}),
    ...(opts.queue ? { queue: true } : {}),
  });

  if (!result.ok) {
    die(result.error, result.status === 404 ? 2 : 1);
  }

  if (opts.wait) {
    const timeout = parseInt(opts.timeout || "60000", 10);
    const pollInterval = 500;

    // Wait at least one interval before the FIRST status check: for a
    // tmux/pty target, `state` is written by an async 1s lifecycle poller —
    // an immediate check can still read the PRE-send "idle", making this
    // look settled before the message was even processed and printing stale
    // pane text as if it were the reply. `startTime` is captured AFTER this
    // sleep so a very small --timeout still gets its one poll attempt
    // instead of the budget being consumed by the mandatory initial wait.
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const statusResult = await daemonGet<SessionSummary>(`/sessions/${encodeURIComponent(sessionId)}`);

      if (!statusResult.ok) {
        die(statusResult.error, statusResult.status === 404 ? 2 : 1);
      }

      // A tmux session settles on "idle"; a Rich Chat (json) session settles
      // on "waiting_for_human" and NEVER reports "idle", so waiting only for
      // "idle" burned the full timeout and warned on every single json send.
      if (statusResult.data.state === "idle" || statusResult.data.state === "waiting_for_human") {
        // Queued (not steered) means this message may still be sitting
        // behind an earlier turn when the session settles from THAT turn —
        // printing "the reply" here would print someone else's answer.
        if (!opts.queue) {
          await printReply(sessionId);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    warn("Session did not settle (idle / waiting_for_human) within timeout");
  }
}
