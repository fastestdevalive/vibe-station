import type { ApiInstance } from "@/api";

/**
 * Run the first turn of a freshly-created JSON agent AFTER its session exists.
 *
 * The create-dialog JSON path deliberately omits the prompt from the create body
 * (so the daemon does NOT auto-enqueue turn 1). This helper closes that gap: it
 * uploads any staged files against the new session, then sends the prompt +
 * resolved attachment ids as turn 1 via the chat queue. A blank prompt with no
 * files is a no-op — the agent stays idle awaiting the user's first message.
 *
 * This keeps turn 1 single-sourced: the prompt travels either in the create body
 * (CLI / terminal path) OR through this chat send (UI JSON path), never both.
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
