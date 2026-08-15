import type { ApiInstance } from "@/api";

/**
 * Run the first turn of a freshly-created JSON agent AFTER its session exists.
 *
 * The create-dialog JSON path DOES include `prompt` in the create body now
 * (so the daemon can derive the auto name / `initialPrompt` from it — see
 * `skipAutoTurn` on `CreateWorktreeBody`/`CreateSessionBody`), but passes
 * `skipAutoTurn: true` so the daemon does NOT also auto-enqueue it as turn 1.
 * This helper is what actually delivers turn 1: it uploads any staged files
 * against the new session, then sends the prompt + resolved attachment ids
 * via the chat queue. A blank prompt with no files is a no-op — the agent
 * stays idle awaiting the user's first message.
 *
 * This keeps turn-1 *delivery* single-sourced: the prompt is still only ever
 * enqueued as a turn from one place — the create body's auto-enqueue for the
 * CLI/terminal path, or this chat send for the UI JSON path — never both.
 */
export async function sendJsonFirstTurn(
  api: ApiInstance,
  sessionId: string,
  prompt: string,
  files: File[],
): Promise<void> {
  let attachmentIds: string[] = [];
  if (files.length > 0) {
    const { attachments } = await api.uploadAttachments(sessionId, files);
    attachmentIds = attachments.map((a) => a.id);
  }
  const trimmed = prompt.trim();
  if (trimmed.length > 0 || attachmentIds.length > 0) {
    await api.sendChat(sessionId, trimmed, attachmentIds);
  }
}
