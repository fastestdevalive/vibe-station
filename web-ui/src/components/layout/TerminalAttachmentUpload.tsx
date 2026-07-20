import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Attachment, CliId, Session } from "@/api/types";
import { AttachmentPicker } from "@/components/chat/AttachmentPicker";
import { AttachmentChip } from "@/components/chat/AttachmentChip";

/**
 * CLIs with a `UserPromptSubmit` hook that consumes the pending-uploads
 * reference (json-mode-followups item 3, Decision 5). Claude-only at launch —
 * no fallback UX for cursor/opencode/agy, hard-gated: the control simply does
 * not render for them (same shape as `TerminalChannelToggle`'s
 * `CHANNEL_TOGGLE_CLIS`).
 */
const TERMINAL_UPLOAD_CLIS = new Set<CliId>(["claude"]);

interface TerminalAttachmentUploadProps {
  api: ApiInstance;
  /** The tmux/pty agent session rendered in this terminal pane. */
  session: Session;
}

/**
 * Terminal-mode file upload control (item 3, CUJ 2). Unlike JSON-channel
 * attachments (staged as a draft, injected at send time), a terminal session
 * has no composer/send step: the file is uploaded immediately and the daemon
 * writes a pending-uploads reference a claude `UserPromptSubmit` hook reads
 * (and deletes) on the next prompt submitted in the terminal.
 *
 * Reuses `AttachmentPicker` (button + drop zone) and `AttachmentChip` (the
 * pending list) as-is — no new picker/chip UI (Decision 7). `AttachmentPicker`
 * is driven with an always-empty `files` prop so it never renders its own
 * (blank-path, upload-not-yet-happened) previews; this component renders the
 * REAL uploaded `Attachment`s via `AttachmentChip`, with `onRemove` wired to
 * the new `DELETE /sessions/:id/attachments/:uploadId` route (Decision 8) —
 * a real server-side delete, since the pending-uploads reference is written
 * the instant the upload succeeds (no draft phase to just drop client-side).
 *
 * Explicitly a SEPARATE control from the channel-toggle overlay (Decision 6) —
 * it does not touch `TerminalPane`'s tree position, only adds a sibling.
 */
export function TerminalAttachmentUpload({ api, session }: TerminalAttachmentUploadProps) {
  const [cli, setCli] = useState<CliId | null>(null);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channel = session.channel ?? "tmux";
  // Agent sessions only (a plain terminal has no CLI to read the file);
  // terminal (non-json) channel only — JSON sessions keep their own composer
  // attachment flow untouched.
  const eligible = session.type === "agent" && channel !== "json" && session.modeId != null;

  // Session carries only `modeId`; the upload gate is per-CLI, so resolve the
  // mode's CLI. Skipped entirely when structurally ineligible.
  useEffect(() => {
    if (!eligible) return undefined;
    // Reset immediately, before the fetch resolves — see the identical
    // comment in `TerminalChannelToggle` (same stale-CLI-across-tab-switch
    // hazard: this pane slot isn't keyed by session id).
    setCli(null);
    let live = true;
    void api.listModes().then((modes) => {
      if (!live) return;
      const mode = modes.find((m) => m.id === session.modeId);
      setCli(mode?.cli ?? null);
    });
    return () => {
      live = false;
    };
  }, [api, session.modeId, eligible]);

  if (!eligible || !cli || !TERMINAL_UPLOAD_CLIS.has(cli)) return null;

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const { attachments } = await api.uploadAttachments(session.id, files);
      setPending((prev) => [...prev, ...attachments]);
    } catch {
      setError("Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function remove(uploadId: string) {
    // Optimistic removal — a stale chip (if the DELETE fails) is a smaller
    // cost than a stuck one; the reference is harmless if it lingers and gets
    // consumed by the hook on the next prompt instead.
    setPending((prev) => prev.filter((a) => a.id !== uploadId));
    try {
      await api.deleteAttachment(session.id, uploadId);
    } catch {
      /* best-effort — see comment above */
    }
  }

  return (
    <div className="terminal-attachment-upload">
      {pending.length > 0 ? (
        <div className="terminal-attachment-upload__chips">
          {pending.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={() => void remove(a.id)} />
          ))}
        </div>
      ) : null}
      {error ? <div className="terminal-attachment-upload__error">{error}</div> : null}
      <AttachmentPicker files={[]} onChange={(files) => void upload(files)} disabled={uploading} />
    </div>
  );
}
