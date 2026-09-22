# Attachment upload broken on both channels — root cause + fix plan

**Branch/worktree:** `acp-even-itnegration` / `vs-165`
**Sandbox used:** container `vs-165-vst-dev-1`, web-ui at `http://localhost:7165`, daemon at `127.0.0.1:7421` inside the container (proxied from `/api` by Vite — see `web-ui/vite.config.ts` proxy block, `target: "http://127.0.0.1:7421"`)
**Verdict:** genuine product bug introduced by the Node→Rust daemon port. Not a dev-sandbox-environment issue.

---

## Summary

Both reported symptoms —

1. agy Rich Chat (`json` channel): "content type application/json required"
2. Claude terminal (`tty` channel): generic "upload failed"

— come from the **same shared route**, `POST /sessions/:id/attachments`, and the **same single defect**: the web-ui client sends the upload as `multipart/form-data`, but the Rust daemon handler that replaced the old Node route expects a JSON body instead. Axum's `Json<T>` extractor rejects any non-`application/json` request before it ever reaches the route's business logic, so this breaks uploads on *every* channel, not just one.

---

## Evidence

### 1. Client sends multipart/form-data, no Content-Type override

`web-ui/src/api/client.ts:1256-1267`:

```ts
/** Upload files (multipart) → saved under sessionDataDir/uploads, returns Attachment[]. */
async uploadAttachments(sessionId: string, files: File[]): Promise<UploadAttachmentsResponse> {
  const root = baseUrl();
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  // Do NOT set Content-Type — the browser sets the multipart boundary.
  const res = await apiFetch(`${root}/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: "POST",
    body: form,
  });
  return parseJson<UploadAttachmentsResponse>(res);
},
```

This is the single call site used for uploads; both `Composer.tsx` (json/Rich Chat) and `TerminalAttachmentUpload.tsx` (tty/terminal) route through it (confirmed via `grep -rn "uploadAttachments" web-ui/src`).

### 2. Server handler expects a JSON body with base64 data, not multipart

`rust/vst-daemon/src/server.rs:2421-2434`:

```rust
#[derive(Deserialize)]
struct UploadPartRaw {
    filename: String,
    content_type: Option<String>,
    data: String, // base64 or text
}

async fn handle_upload_attachments(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(raw_parts): Json<Vec<UploadPartRaw>>,
) -> Result<Json<AttachmentsResult>, (StatusCode, Json<serde_json::Value>)> {
    ...
```

`Json<Vec<UploadPartRaw>>` is an axum extractor that rejects the request outright (before any app code runs) if `Content-Type` isn't `application/json`. There is no multipart parsing anywhere in `rust/vst-daemon` or `rust/vst-routes` for this route — confirmed via:

```
$ grep -rn "Multipart\|multipart" rust/vst-daemon/src/server.rs rust/vst-routes/src/attachments.rs
(no matches)
```

The route registration (`rust/vst-daemon/src/server.rs:580-583`):

```rust
.route("/sessions/:id/attachments", post(handle_upload_attachments))
.route(
    "/sessions/:id/attachments/:uploadId",
    ...
```

Note `rust/vst-routes/src/attachments.rs`'s `AttachmentRoutes::upload_attachments` (the actual business logic — sanitizing filenames, writing to `uploads/<uploadId>/`, registering in `AttachmentRegistry`, staging pending-upload refs for non-json channels) takes a channel-agnostic `Vec<UploadPart>` and is **not** the problem — the bug is entirely in the axum-layer glue in `server.rs` that decodes the wire body into that struct.

### 3. Reproduced directly against the running sandbox

Got a real session id from the live daemon:

```
$ docker exec -u vst vs-165-vst-dev-1 sh -lc 'curl -s http://127.0.0.1:7421/api/sessions -w "\n%{http_code}\n" | head -c 2000'
[{"id":"atls-1-m","worktreeId":"atls-1", ... "channel":"tmux","state":"working", ...
```

Sent the same request shape the browser sends (multipart) vs. the shape the server actually accepts (JSON):

```
$ docker exec -u vst vs-165-vst-dev-1 sh -lc '
SID=atls-1-m
echo "=== multipart (what browser sends) ==="
curl -s -X POST -F "files=@/etc/hostname" http://127.0.0.1:7421/api/sessions/$SID/attachments -w "\nHTTP:%{http_code}\n"
echo "=== JSON (what server expects) ==="
curl -s -X POST -H "Content-Type: application/json" -d "[{\"filename\":\"hostname\",\"content_type\":\"text/plain\",\"data\":\"aGVsbG8=\"}]" http://127.0.0.1:7421/api/sessions/$SID/attachments -w "\nHTTP:%{http_code}\n"
'
```

Output:

```
=== multipart (what browser sends) ===
Expected request with `Content-Type: application/json`
HTTP:415
=== JSON (what server expects) ===
{"attachments":[{"id":"5aefbbba-7f9a-4dcb-b6bf-dcfb7d3f5526","name":"hostname","path":"/home/vst/.vibe-station/projects/atlas-dashboard/session-data/atls-1/atls-1-m/uploads/5aefbbba-7f9a-4dcb-b6bf-dcfb7d3f5526/hostname","size":5,"mime":"text/plain"}]}
HTTP:200
```

The 415 body text (`Expected request with \`Content-Type: application/json\``) is axum's built-in `JsonRejection` message — it matches the user's reported "content type application/json required" almost verbatim, and it fires identically regardless of which session/channel is targeted (the rejection happens before the handler body — and therefore before any channel-specific logic — ever runs). This is why the tty-channel session in symptom 2 sees "upload failed" too: same 415, just less detail surfaced by `TerminalAttachmentUpload.tsx`'s error handling.

### 4. Confirmed this is a port regression, not a pre-existing design choice

The pre-Rust Node route explicitly hand-rolled a multipart parser to match this exact client contract:

```
$ git log --all --oneline -- daemon/src/routes/attachments.ts | tail -1
c7dadc3 feat(json-chat): complete the channel-toggle UX — all CLIs, terminal upload, real-world fixes

$ git show c7dadc3:daemon/src/routes/attachments.ts | head -20
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
 */
```

The Node daemon was hard-removed in `531ce32` ("chore: hard-remove Node daemon/ and cli/ — Rust is now the only daemon"). Whoever ported this route to Rust wrote it against a different (JSON+base64) wire contract than the client actually uses, and nothing caught the mismatch (no integration test posts real multipart to this route — confirmed no `Multipart`/`multipart` hits in `rust/vst-daemon` or `rust/vst-routes` as shown above).

---

## Why it's not a dev-sandbox issue

- The daemon binary running in the sandbox (`/usr/local/bin/vst-daemon-rust`) is the same Rust daemon that would run in any environment on this branch — there's no sandbox-specific config for this route (no multipart size/proxy limits, no missing env var).
- The Vite dev proxy (`web-ui/vite.config.ts`) passes the request through unmodified (`changeOrigin`/`xfwd` only) — confirmed by the raw `curl` reproduction talking directly to the daemon on `127.0.0.1:7421`, bypassing Vite entirely, and getting the identical 415.
- The mismatch is a straight code-level contract bug between `web-ui/src/api/client.ts` and `rust/vst-daemon/src/server.rs`; it would reproduce on any deployment of this branch, dev sandbox or otherwise.

---

## Fix plan (not yet implemented — awaiting confirmation)

1. In `rust/vst-daemon/src/server.rs`, replace the `Json<Vec<UploadPartRaw>>` extractor in `handle_upload_attachments` (`server.rs:2430`) with axum's `Multipart` extractor (`axum::extract::Multipart`). Check `rust/vst-daemon/Cargo.toml` for the `multipart` feature on the `axum` dependency; add it if absent.
2. Iterate multipart fields named `files` (matches `form.append("files", f, f.name)` in `client.ts:1260`), read each part's `file_name()` / `content_type()` / bytes, and build the existing `Vec<UploadPart>` (`rust/vst-routes/src/attachments.rs:27-31`) — that struct and `AttachmentRoutes::upload_attachments` need no changes; only the axum-layer body-decoding glue in `server.rs` is wrong.
3. Preserve existing size caps (`MAX_FILE_BYTES` = 20MB/file, `MAX_BODY_BYTES` = 25MB total, both defined in `rust/vst-routes/src/attachments.rs:22-23`) and existing error→status mapping (415/413/400/404 in `server.rs:2451-2473`). Reject early on `MAX_BODY_BYTES` overrun during multipart streaming rather than buffering unbounded.
4. Remove `UploadPartRaw` and the base64-decode step (`server.rs:2422-2426`, `2434-2444`) entirely — no other caller depends on the JSON+base64 contract; the web-ui is the only client of this route.
5. Add a `vst-daemon` (or `vst-routes`) integration test that posts a real `multipart/form-data` request (matching the client's field name `files`) to `/sessions/:id/attachments` and asserts 200 + correct `Attachment[]` — this is the same "match the actual wire contract in tests" lesson AGENTS.md calls out for `vst-cli` mock servers, just applied server-side.
6. After the fix, re-run the exact `curl -F "files=@..."` repro above (expect 200, not 415) for both a `json`-channel session and a `tmux`/terminal-channel session, then manually verify via the real UI (drag/drop and file picker) on both channels in the running sandbox.
7. Grep `docs/` for any reference to the JSON+base64 attachment contract before closing out — none found so far, but worth a final check since this is a wire-contract change.

No existing AGENTS.md invariant (CLI `/api` prefixing, terminal remount, status axes, WS session-lock, agent-plugin boundary) is implicated — the fix is contained to the axum body-extraction glue in `rust/vst-daemon/src/server.rs` plus a possible `Cargo.toml` feature flag addition.
