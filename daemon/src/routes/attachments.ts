/**
 * Attachment upload route (Decision 5, N5).
 *
 * `POST /sessions/:id/attachments` (multipart/form-data) saves each file under
 * `sessionDataDir/uploads/<uploadId>/<sanitized name>` (worktree) or
 * `directSessionDataDir/uploads/...` (direct) — under `~/.vibe-station/`, NOT
 * the checkout, so it is auto-cleaned with the session and never pollutes the
 * branch. Filenames are sanitized, traversal is rejected, and files are size-
 * capped (413).
 *
 * We hand-roll a tiny multipart parser (no `@fastify/multipart` dependency): a
 * raw-buffer content-type parser collects the body, then we split on the
 * boundary. Uploads are small; this keeps the dependency surface minimal.
 *
 * json-mode-followups item 3: the same route also serves terminal-channel
 * (tmux/pty) agent sessions. For those, the handler ALSO writes a
 * pending-upload reference file into the worktree-local (or direct-session
 * checkout-local) `.vibe-station/pending-uploads/<sessionId>/` directory —
 * the SOLE store a claude `UserPromptSubmit` hook reads on the next prompt
 * (`agent-plugins/claude.ts` `setupWorkspaceHooks`, Decision 8). This is a
 * generic, CLI-agnostic filesystem mechanism (no `if (cli === "claude")`
 * branch here) — only claude's hook happens to read it today.
 */

import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { findJsonSessionContext } from "../services/jsonAgentChat.js";
import { sessionChannel } from "../services/channel.js";
import { sessionDataDir, directSessionDataDir, worktreePath } from "../services/paths.js";
import { registerAttachment, removeAttachment } from "../state/attachmentRegistry.js";
import type { Attachment } from "../types.js";
import type { ProjectRecord, WorktreeRecord } from "../types.js";

/** Absolute checkout path a session's hooks run against (worktree or direct-project). */
function checkoutPathFor(project: ProjectRecord, worktree: WorktreeRecord | null): string {
  return worktree ? worktreePath(project.id, worktree.id) : project.absolutePath;
}

/** `<checkout>/.vibe-station/pending-uploads/<sessionId>/<uploadId>-<name>` (Decision 8). */
function pendingUploadRefPath(
  project: ProjectRecord,
  worktree: WorktreeRecord | null,
  sessionId: string,
  uploadId: string,
  name: string,
): string {
  return join(checkoutPathFor(project, worktree), ".vibe-station", "pending-uploads", sessionId, `${uploadId}-${name}`);
}

/** Per-file size cap. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Whole-request cap (a little above per-file so we can 413 cleanly). */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Extract the boundary token from a multipart content-type header. */
function boundaryFrom(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b ? b.trim() : null;
}

/** Minimal multipart/form-data parser over a raw Buffer. */
function parseMultipart(buf: Buffer, boundary: string): ParsedPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: ParsedPart[] = [];
  let index = buf.indexOf(delimiter);
  if (index === -1) return parts;
  index += delimiter.length;

  while (index < buf.length) {
    // "--" after the delimiter → closing boundary.
    if (buf[index] === 0x2d && buf[index + 1] === 0x2d) break;
    // Skip the CRLF after the boundary.
    if (buf[index] === 0x0d && buf[index + 1] === 0x0a) index += 2;

    const headerEnd = buf.indexOf("\r\n\r\n", index);
    if (headerEnd === -1) break;
    const headerText = buf.slice(index, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;

    const next = buf.indexOf(delimiter, bodyStart);
    if (next === -1) break;
    // Body ends 2 bytes (CRLF) before the next delimiter.
    const body = buf.slice(bodyStart, next - 2);

    const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? "";
    const nameMatch = /name="([^"]*)"/i.exec(disposition);
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();

    parts.push({
      name: nameMatch?.[1] ?? "",
      ...(filenameMatch ? { filename: filenameMatch[1] } : {}),
      ...(contentType ? { contentType } : {}),
      data: body,
    });

    index = next + delimiter.length;
  }
  return parts;
}

/**
 * Sanitize an uploaded filename: strip any path components, reject traversal /
 * empty names, and cap length. Returns a safe basename.
 */
function sanitizeFilename(raw: string | undefined): string | null {
  if (!raw) return null;
  const base = basename(raw.replace(/\\/g, "/"));
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\0")) {
    return null;
  }
  return base.slice(0, 255);
}

export function registerAttachmentRoutes(app: FastifyInstance): void {
  // Collect multipart bodies as a raw Buffer; we parse them ourselves.
  if (!app.hasContentTypeParser("multipart/form-data")) {
    app.addContentTypeParser(
      "multipart/form-data",
      { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );
  }

  app.post("/sessions/:id/attachments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });
    // Attachments only make sense for AGENT sessions — a plain terminal has no
    // CLI to read the file. JSON-channel sessions inject the path into the next
    // chat turn; terminal-channel (tmux/pty) sessions stage a pending-uploads
    // reference for a `UserPromptSubmit` hook to pick up (item 3).
    if (ctx.session.type !== "agent") {
      return reply.status(400).send({ error: `Session '${id}' is not an agent session` });
    }
    const channel = sessionChannel(ctx.session);

    const boundary = boundaryFrom(req.headers["content-type"]);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return reply.status(400).send({ error: "Expected multipart/form-data with files" });
    }

    const parts = parseMultipart(req.body, boundary).filter((p) => p.filename !== undefined);
    if (parts.length === 0) {
      return reply.status(400).send({ error: "No files provided" });
    }

    const uploadsRoot = ctx.worktree
      ? join(sessionDataDir(ctx.project.id, ctx.worktree.id, ctx.session.id), "uploads")
      : join(directSessionDataDir(ctx.project.id, ctx.session.id), "uploads");

    const attachments: Attachment[] = [];
    for (const part of parts) {
      if (part.data.length > MAX_FILE_BYTES) {
        return reply
          .status(413)
          .send({ error: `File '${part.filename ?? ""}' exceeds ${MAX_FILE_BYTES} bytes` });
      }
      const safeName = sanitizeFilename(part.filename);
      if (!safeName) {
        return reply.status(400).send({ error: `Invalid filename '${part.filename ?? ""}'` });
      }
      const uploadId = randomUUID();
      const dir = join(uploadsRoot, uploadId);
      mkdirSync(dir, { recursive: true });
      const abs = join(dir, safeName);
      writeFileSync(abs, part.data);

      const attachment: Attachment = {
        id: uploadId,
        name: safeName,
        path: abs,
        size: part.data.length,
        mime: part.contentType ?? "application/octet-stream",
      };
      registerAttachment(id, attachment);
      attachments.push(attachment);

      // Terminal-channel: also stage the pending-upload reference the
      // UserPromptSubmit hook reads (Decision 8). JSON-channel keeps its
      // existing draft-then-inject flow (`injectAttachments`, untouched).
      if (channel !== "json") {
        const refPath = pendingUploadRefPath(ctx.project, ctx.worktree, id, uploadId, safeName);
        mkdirSync(join(refPath, ".."), { recursive: true });
        writeFileSync(refPath, abs, "utf8");
      }
    }

    return reply.status(201).send({ attachments });
  });

  /**
   * Remove a staged-but-not-yet-consumed upload (item 3, Decision 8). Real
   * server-side delete — terminal-mode uploads are "live" the instant the
   * pending-uploads reference is written, unlike JSON-mode's client-only
   * draft removal. Removes the staged file (`sessionDataDir/uploads/<id>/`)
   * AND the pending-uploads reference if one exists; tolerates either being
   * already gone (ENOENT — e.g. a race with the hook consuming it first).
   */
  app.delete("/sessions/:id/attachments/:uploadId", async (req, reply) => {
    const { id, uploadId } = req.params as { id: string; uploadId: string };
    const ctx = findJsonSessionContext(id);
    if (!ctx) return reply.status(404).send({ error: `Session '${id}' not found` });

    const attachment = removeAttachment(id, uploadId);
    if (!attachment) return reply.status(404).send({ error: `Upload '${uploadId}' not found` });

    const uploadsRoot = ctx.worktree
      ? join(sessionDataDir(ctx.project.id, ctx.worktree.id, ctx.session.id), "uploads")
      : join(directSessionDataDir(ctx.project.id, ctx.session.id), "uploads");
    // `force: true` already tolerates ENOENT.
    rmSync(join(uploadsRoot, uploadId), { recursive: true, force: true });

    const refPath = pendingUploadRefPath(ctx.project, ctx.worktree, id, uploadId, attachment.name);
    try {
      unlinkSync(refPath);
    } catch {
      /* not a terminal-channel upload, or the hook already consumed it — tolerated */
    }

    return reply.status(200).send({ ok: true });
  });
}
