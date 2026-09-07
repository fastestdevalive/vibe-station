# Report: Auth redesign — unified stateless token, options

**Date:** 2026-09-06 · **Commit:** cd70e5c · **Scope:** options only, no implementation · **Method:** read `docs/AUTH.md`, `daemon/src/auth.ts`, `daemon/src/routes/auth.ts`, `daemon/src/routes/mobileAuth.ts`, `daemon/src/server.ts`, `daemon/src/state/auth-session-store.ts`, `daemon/src/services/dbSchema.ts`, `cli/src/lib/daemon-url.ts`

## Goal

Replace the nonce + SQLite `auth_sessions` model with a single stateless token format that all three auth paths (CLI, Tauri desktop, browser/mobile-via-QR) mint and verify through the *same* `mintToken` / `verifyToken` code path. Per-path differences become **policy** (a scope table), not separate mechanisms. `browser` is the only revocable scope — revocation via one bumped epoch integer, not per-session rows. No per-request DB lookup for any scope; the `auth_sessions` table goes away.

## Ground truth (what exists today)

- Cookie = `issuedAt.nonce.HMAC(issuedAt.nonce, daemonToken)` — `daemon/src/auth.ts:63-128`. 7-day TTL, *sliding* (`needsBump`/`bump` re-issues on request, `daemon/src/server.ts:169-177`).
- Revocation = `sessionStore.isLive(nonce)` against SQLite + LRU (`daemon/src/state/auth-session-store.ts`); table at `daemon/src/services/dbSchema.ts:110-123`.
- **CLI does not use the cookie at all today** — it reads `config.token` off disk (`cli/src/lib/daemon-url.ts:39-48`) and sends `Authorization: Bearer <daemonToken>`, matched raw in the guard (`daemon/src/server.ts:144-155`) and in the WS handshake (`daemon/src/ws/server.ts:41-56`). This is the "special case" the redesign removes.
- **Loopback bypasses auth entirely** unless `CF-Connecting-IP` is present (`daemon/src/server.ts:135-137`) — so on the desktop, the Tauri/browser token path is currently belt-and-braces.
- **QR flow today:** desktop-only `POST /auth/local-qr` or `/auth/mobile-qr` mints a 32-byte hex one-time code held in an **in-memory `Map`** (30s TTL, single-use, bound to `tunnel` vs `local` origin). Phone hits `GET /mobile-auth?code=` (AUTH_EXEMPT), which marks the code consumed and issues the normal session cookie (`daemon/src/routes/mobileAuth.ts:146-260`). **The code exchange is already stateless-friendly — the only DB touch is the session row it creates at the end.** Folding QR into the new scheme means changing only that last step; the pairing UX/transport is untouched.

## Options

### Option A — Signed payload + scope policy table (the sketched design)

Token = `base64url({iat, exp, scope, epoch})` + `.` + `HMAC-SHA256(payload, daemonToken)`. One `mintToken(scope, opts)`, one `verifyToken(token)`; a policy table says whether a scope's `epoch` is checked at all.

- **+** Single verify function; scope is explicit and auditable in the token; `cli`/`tauri` are unrevocable *by construction* (verify literally never reads epoch for them) rather than by omission.
- **+** Deletes the table, the LRU, the sliding-bump path, and the raw-Bearer branch in one move; CLI stops reading the master secret for every request.
- **−** Adds a policy indirection for exactly one revocable scope today — arguably over-general until a second one appears.
- **−** Scope is attacker-visible and attacker-*claimed*: the mint side must be the only place scope is chosen (never echoed from request body), or a browser token could claim `scope:"cli"` and dodge the epoch check. Worth making structurally impossible, not just careful.
- **Cost to change later:** low. Adding a field means bumping a version byte in the payload; adding per-device revocation later means widening `epoch` to a per-device map — verify signature is unchanged.

### Option B — Two key derivations, no scope field

Derive a per-scope signing key: `key_scope = HKDF(daemonToken, scope || epoch_for_scope)`. Token carries only `{iat, exp}`; verify tries the key(s) it accepts for that entry point.

- **+** Revocation is free and unforgeable — bumping `browserEpoch` changes the key, so old browser tokens fail the HMAC itself. No policy branch, no epoch comparison, no way to claim the wrong scope.
- **+** Smallest token, smallest verify.
- **−** Verify must know which scope(s) an entry point accepts, so the policy moves from a table into route wiring — less centralized, easier to get subtly wrong.
- **−** Harder to debug/observe: a rejected token gives no signal about *which* scope it claimed.
- **Cost to change later:** medium — changing the derivation input invalidates every outstanding token of that scope (which is exactly the revocation lever, so mostly fine).

### Option C — Keep it minimal: single format, epoch always present, no policy table

Same token as A, but `verifyToken` *always* compares `payload.epoch` to `config.epochFor(scope)`; `cli` and `tauri` simply have epochs that nothing in the product ever bumps.

- **+** Simplest possible verify — one code path, zero branches, no "structurally unrevocable" concept to explain.
- **+** Still zero DB reads (epochs are integers in `config.json`, already loaded in memory).
- **−** Loses the guarantee the user asked for: "nobody bumped it yet" is not the same as "cannot be revoked", and someone could later wire a bump for `cli` by accident.
- **−** Config gains three counters instead of one, for no current use.
- **Cost to change later:** trivial to harden into A (add the table, skip the check).

## Decision point: `exp` for `cli` / `tauri`

Independent of which option is picked.

- **`exp: Infinity` (never expires).** Only killable by rotating `daemonToken`, which also nukes browser sessions. Simplest, honest about the threat model (both credentials already imply machine access). Risk: a `cli` token copied off the machine is valid forever, and a stale token in a script keeps working past any intended change.
- **Long finite TTL, silently re-minted** (e.g. 90 days, re-issued on use — the sliding-bump behaviour that already exists at `daemon/src/server.ts:169-177`). Bounds the damage of an exfiltrated token; costs a re-mint + `Set-Cookie`/header path on the CLI side, which reintroduces a small amount of the "sliding" machinery the redesign is trying to delete.
- **Middle ground worth considering:** long finite TTL with **no** silent re-mint — CLI and Tauri both re-login trivially and non-interactively (Tauri re-injects at spawn; CLI re-reads config), so an expired token is a one-request hiccup, not a user-visible logout. This gets the bound without the sliding-refresh code.

## Recommendation (override freely)

- **Option A**, for the reason the user gave: the value is in `cli`/`tauri` being unrevocable *structurally*, and A is the only option that encodes that as a readable rule. Make scope un-forgeable by having each login route pass a compile-time-constant scope into `mintToken` — never a value read from the request.
- Consider Option B's key derivation as an implementation detail *inside* A later: it would make browser revocation cryptographic rather than a comparison, without changing A's shape.
- On expiry: **long finite TTL (~90 days) with no silent re-mint** for `cli`/`tauri`. `exp: Infinity` is defensible but leaves no lever short of rotating the master secret, and re-login on these two paths is genuinely invisible to the user.
- Sequencing note: the loopback bypass (`daemon/src/server.ts:137`) means the desktop paths keep working throughout, so this can land as (1) new mint/verify alongside the old, (2) cut QR + Tauri + CLI over, (3) drop `auth_sessions`, the LRU, and the raw-Bearer branch.

## Open / not covered

- `GET /auth/sessions` and `DELETE /auth/sessions/:nonce` (`docs/AUTH.md:116-117`) are per-session UI backed by the table being deleted — they become "revoke all browser sessions" (one button) under this design. Confirm that's acceptable UX.
- WS auth (`daemon/src/ws/server.ts:41-56`) has its own Bearer branch and stores `conn.nonce` for revocation-driven disconnects; it needs the same cutover and loses the ability to close one specific connection.
