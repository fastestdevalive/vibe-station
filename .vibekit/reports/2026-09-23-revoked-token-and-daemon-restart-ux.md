# Revoked-token hard-refresh error page & daemon-restart session state

## Bugs

1. **Hard refresh after a token revocation shows a raw `{"error":"Not authenticated."}` JSON blob instead of the login/session-ended screen, at the same URL.** Mid-session revocation already works correctly (WS closes with code 4401, client shows `<LoginScreen>` in place). Only a hard reload while on a deep-linked URL is broken.
2. **A daemon crash/restart leaves already-open sessions in an ambiguous UI state** — not clearly "reconnecting", not clearly "session ended" — instead of one of those two deterministic outcomes.

## Root cause

**Bug 1 — daemon-side routing gap, not a frontend rendering bug.**
- `auth_middleware` only exempts `GET /`, `/index.html`, and `/assets/*` from token verification (`rust/vst-daemon/src/server.rs:843-848`).
- Any other SPA deep link (`/worktree/<id>`, `/session/...`, `/settings`, etc.) is routed through token verification. A revoked token fails, and the middleware returns `401 {"error":"Not authenticated."}` directly (`server.rs:869-886`) — the SPA fallback (`handle_fallback`, `server.rs:3277-3306`) that would otherwise serve `index.html` never runs, so no JS loads and the browser just renders the raw daemon response.
- This is why refreshing at `/` "works" (Express/axum serves the HTML unconditionally there) but refreshing at any deep link doesn't — nothing to do with the client's `useAuth`/`LoginScreen` logic, which is already correct once JS actually loads (`web-ui/src/hooks/useAuth.ts:50-53`, `web-ui/src/App.tsx:52-68`).
- Side finding: the `POST /api/auth/logout` exemption at `server.rs:837` never matches either — the path was rewritten from `/api/*` to `/*` at `server.rs:732`, so the middleware is comparing against `POST /auth/logout`, not the string it's checking.

**Bug 2 — no distinct terminal "give up" state, and a false "connected" flash on restart.**
- WS reconnect backoff grows 1s→15s and retries forever (`web-ui/src/api/client.ts:135-136, 181-190, 392`) — there is no eventual "disconnected, give up" state, only ever "trying".
- The only visible signal today is a small TopBar "Reconnecting…" pill (`ConnectionStatus.tsx:29-49`); individual panes don't reflect it. `TerminalPane`'s own "Reconnecting…" overlay only appears on the `online` transition (`TerminalPane.tsx:175-177, 643-661`), so while the daemon is actually down the pane shows frozen, stale content with no indication anything is wrong.
- On restart the daemon mints a fresh `daemon_token` (`rust/vst-daemon/src/main.rs:280-283`), invalidating every existing remote token. But the WS upgrade succeeds before the token check runs, so `onopen` fires first (`client.ts:321, 369`), briefly flashing "Connected" and triggering REST refetches (`useServerSync.ts:196-199`, `TabsStrip.tsx:559`) that all then 401 — followed a moment later by the real 4401 close. Net effect: "connected → errors → login", a confusing, non-deterministic sequence rather than a clean transition straight to the login/session-ended state.

## Action items

1. In `auth_middleware` (`server.rs`), exempt every `GET` request that isn't under `/api/`, `/ws`, or `/mobile-auth` — not just `/`, `/index.html`, `/assets/*` — so any SPA deep link falls through to `handle_fallback` and serves `index.html`. The client's existing `checkAuth()` (`client.ts:1452-1459`) then gets its 401 from a real API call after JS has loaded and renders `<LoginScreen>` in place, matching the working mid-session path exactly (same URL, same screen).
2. Fix the now-dead `POST /api/auth/logout` exemption at `server.rs:837` to match the post-rewrite path (`/auth/logout`), while touching this middleware.
3. Add a terminal `"disconnected"` connection state: after N retries or ~60s of failed reconnects, stop retrying and show a clear "Daemon unavailable — Retry" screen instead of looping indefinitely.
4. Wire `api.subscribeConnection` state into `TerminalPane`/`ChatPane` so each pane (not just the TopBar pill) shows a "Reconnecting…" overlay whenever the connection isn't `online`, instead of displaying stale frozen content.
5. Eliminate the false "connected" flash on restart: don't emit `ws:open` (or trigger its REST refetches) until the client has confirmed the token is still valid post-reconnect — either have the daemon reject the WS upgrade with 401 before completing it for a bad token, or have the client call `checkAuth()` immediately after reconnect before treating the socket as live. Either fix sends a post-restart client straight to the login screen instead of the current connected→error→login flicker.

## Notes

- Per-token revocation currently lives only in an in-memory `HashSet` (`auth.rs:57`) — harmless today only because a full daemon restart already invalidates all tokens via the fresh `daemon_token`. Not an action item now, but worth knowing if revocation semantics change (e.g. persisted daemon token) since that would resurrect a "revoked but daemon didn't restart" case that isn't covered by item 1 alone (it is — item 1's fix is generic to any 401, revoked or otherwise — noted only for context).
- Investigation performed by a delegated Opus subagent; no code was changed as part of this report.
