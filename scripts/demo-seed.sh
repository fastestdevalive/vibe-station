#!/usr/bin/env bash
# demo-seed.sh — Seeds realistic demo data for README screenshots.
#
# Creates 3 git repos, 9 worktrees across them, 14 sessions in various states,
# a populated worktree checkout (for the file-tree screenshot), and tmux
# sessions pre-loaded with fake agent transcripts.
#
# Runs once inside the container before the daemon starts.

set -euo pipefail

HOME_DIR="${HOME:-/home/vst}"
VST="$HOME_DIR/.vibe-station"
PROJECTS="$HOME_DIR/projects"
TRANSCRIPTS="$HOME_DIR/.transcripts"

# Idempotency guard so a restart doesn't double-seed.
if [ -f "$VST/.seeded" ]; then
  echo "[seed] already seeded, skipping data init"
else
  echo "[seed] seeding demo data..."

  mkdir -p "$VST/projects" "$VST/logs" "$PROJECTS" "$TRANSCRIPTS"

  # ─── 1. Stub CLIs (claude, cursor-agent) ────────────────────────────────────
  # If host hasn't mounted real binaries, drop in stubs so modes.json validates.
  for bin in claude cursor-agent; do
    if [ ! -x "/usr/local/bin/$bin" ]; then
      cat >"/usr/local/bin/$bin" <<'STUB'
#!/usr/bin/env bash
# vibe-station screenshot stub — never invoked, just satisfies PATH lookup.
exec sleep infinity
STUB
      chmod +x "/usr/local/bin/$bin"
    fi
  done

  # ─── 2. Fake git repos ──────────────────────────────────────────────────────
  init_repo() {
    local name=$1
    local dir="$PROJECTS/$name"
    rm -rf "$dir"
    mkdir -p "$dir"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email "demo@vibe-station.dev"
    git -C "$dir" config user.name "Demo"
    echo "# $name" >"$dir/README.md"
    git -C "$dir" add . >/dev/null
    git -C "$dir" commit -q -m "init"
  }
  init_repo northstar-api
  init_repo atlas-dashboard
  init_repo forge-cli

  NAPI_SHA=$(git -C "$PROJECTS/northstar-api" rev-parse HEAD)
  ATLS_SHA=$(git -C "$PROJECTS/atlas-dashboard" rev-parse HEAD)
  FRGE_SHA=$(git -C "$PROJECTS/forge-cli" rev-parse HEAD)

  # ─── 3. modes.json ──────────────────────────────────────────────────────────
  cat >"$VST/modes.json" <<'JSON'
[
  {
    "id": "mode-claude-001",
    "name": "Claude Code",
    "cli": "claude",
    "context": "You are an expert full-stack TypeScript engineer. Write clean, well-tested code and explain your changes succinctly.",
    "createdAt": "2025-05-01T09:00:00.000Z"
  },
  {
    "id": "mode-cursor-001",
    "name": "Cursor Agent",
    "cli": "cursor",
    "context": "You are a senior engineer focused on code quality and performance. Prefer small, surgical changes.",
    "createdAt": "2025-05-01T09:05:00.000Z"
  }
]
JSON

  # ─── 4. Project manifests ───────────────────────────────────────────────────
  write_manifest() {
    local id=$1
    local prefix=$2
    local sha=$3
    local manifest=$4
    mkdir -p "$VST/projects/$id"
    printf '%s' "$manifest" >"$VST/projects/$id/manifest.json"
  }

  ts() { echo "2025-05-06T${1}.000Z"; }

  # northstar-api ─────────────────────────────────────
  read -r -d '' NAPI_MANIFEST <<JSON || true
{
  "id": "northstar-api",
  "absolutePath": "$PROJECTS/northstar-api",
  "prefix": "napi",
  "defaultBranch": "main",
  "createdAt": "2025-05-01T09:00:00.000Z",
  "worktrees": [
    {
      "id": "napi-1",
      "branch": "feat/auth-middleware",
      "baseBranch": "main",
      "baseSha": "$NAPI_SHA",
      "createdAt": "$(ts 09:30:00)",
      "sessions": [
        { "id": "napi-1-m",  "slot": "m",  "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-napi-1-m",  "useTmux": true,  "lifecycle": { "state": "idle",    "lastTransitionAt": "$(ts 10:14:00)" } },
        { "id": "napi-1-a1", "slot": "a1", "type": "agent", "modeId": "mode-cursor-001", "tmuxName": "vr-napi-1-a1", "useTmux": true,  "lifecycle": { "state": "idle",    "lastTransitionAt": "$(ts 10:18:00)" } },
        { "id": "napi-1-a2", "slot": "a2", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-napi-1-a2", "useTmux": true,  "lifecycle": { "state": "working", "lastTransitionAt": "$(ts 10:22:00)" } }
      ]
    },
    {
      "id": "napi-2",
      "branch": "feat/rate-limiting",
      "baseBranch": "main",
      "baseSha": "$NAPI_SHA",
      "createdAt": "$(ts 09:40:00)",
      "sessions": [
        { "id": "napi-2-m", "slot": "m", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-napi-2-m", "useTmux": true, "lifecycle": { "state": "working", "lastTransitionAt": "$(ts 10:05:00)" } }
      ]
    },
    {
      "id": "napi-3",
      "branch": "fix/db-connection-pool",
      "baseBranch": "main",
      "baseSha": "$NAPI_SHA",
      "createdAt": "$(ts 09:50:00)",
      "sessions": [
        { "id": "napi-3-m", "slot": "m", "type": "agent", "modeId": "mode-cursor-001", "tmuxName": "vr-napi-3-m", "useTmux": true, "lifecycle": { "state": "idle", "lastTransitionAt": "$(ts 10:02:00)" } }
      ]
    },
    {
      "id": "napi-4",
      "branch": "feat/webhooks",
      "baseBranch": "main",
      "baseSha": "$NAPI_SHA",
      "createdAt": "$(ts 08:55:00)",
      "sessions": [
        { "id": "napi-4-m", "slot": "m", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-napi-4-m", "useTmux": true, "lifecycle": { "state": "done", "lastTransitionAt": "$(ts 09:35:00)" } }
      ]
    }
  ]
}
JSON
  write_manifest northstar-api napi "$NAPI_SHA" "$NAPI_MANIFEST"

  # atlas-dashboard ───────────────────────────────────
  read -r -d '' ATLS_MANIFEST <<JSON || true
{
  "id": "atlas-dashboard",
  "absolutePath": "$PROJECTS/atlas-dashboard",
  "prefix": "atls",
  "defaultBranch": "main",
  "createdAt": "2025-05-01T09:10:00.000Z",
  "worktrees": [
    {
      "id": "atls-1",
      "branch": "feat/data-visualization",
      "baseBranch": "main",
      "baseSha": "$ATLS_SHA",
      "createdAt": "$(ts 09:20:00)",
      "sessions": [
        { "id": "atls-1-m", "slot": "m", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-atls-1-m", "useTmux": true, "lifecycle": { "state": "working", "lastTransitionAt": "$(ts 10:00:00)" } }
      ]
    },
    {
      "id": "atls-2",
      "branch": "refactor/component-library",
      "baseBranch": "main",
      "baseSha": "$ATLS_SHA",
      "createdAt": "$(ts 09:25:00)",
      "sessions": [
        { "id": "atls-2-m", "slot": "m", "type": "agent", "modeId": "mode-cursor-001", "tmuxName": "vr-atls-2-m", "useTmux": true, "lifecycle": { "state": "idle", "lastTransitionAt": "$(ts 09:50:00)" } }
      ]
    },
    {
      "id": "atls-3",
      "branch": "feat/export-pipeline",
      "baseBranch": "main",
      "baseSha": "$ATLS_SHA",
      "createdAt": "$(ts 08:30:00)",
      "sessions": [
        { "id": "atls-3-m", "slot": "m", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-atls-3-m", "useTmux": true, "lifecycle": { "state": "done", "lastTransitionAt": "$(ts 09:10:00)" } }
      ]
    }
  ]
}
JSON
  write_manifest atlas-dashboard atls "$ATLS_SHA" "$ATLS_MANIFEST"

  # forge-cli ─────────────────────────────────────────
  read -r -d '' FRGE_MANIFEST <<JSON || true
{
  "id": "forge-cli",
  "absolutePath": "$PROJECTS/forge-cli",
  "prefix": "frge",
  "defaultBranch": "main",
  "createdAt": "2025-05-01T09:15:00.000Z",
  "worktrees": [
    {
      "id": "frge-1",
      "branch": "feat/plugin-system",
      "baseBranch": "main",
      "baseSha": "$FRGE_SHA",
      "createdAt": "$(ts 09:35:00)",
      "sessions": [
        { "id": "frge-1-m", "slot": "m", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-frge-1-m", "useTmux": true, "lifecycle": { "state": "working", "lastTransitionAt": "$(ts 10:08:00)" } }
      ]
    },
    {
      "id": "frge-2",
      "branch": "docs/api-reference",
      "baseBranch": "main",
      "baseSha": "$FRGE_SHA",
      "createdAt": "$(ts 08:15:00)",
      "sessions": [
        { "id": "frge-2-m", "slot": "m", "type": "agent", "modeId": "mode-claude-001", "tmuxName": "vr-frge-2-m", "useTmux": true, "lifecycle": { "state": "done", "lastTransitionAt": "$(ts 08:50:00)" } }
      ]
    }
  ]
}
JSON
  write_manifest forge-cli frge "$FRGE_SHA" "$FRGE_MANIFEST"

  # ─── 5. Populate napi-1 worktree checkout (file tree + preview) ────────────
  WT="$VST/projects/northstar-api/worktrees/napi-1"
  mkdir -p "$WT/src/routes" "$WT/src/middleware" "$WT/src/db/migrations" \
           "$WT/src/models" "$WT/src/utils" "$WT/docs" "$WT/tests"

  cat >"$WT/package.json" <<'JSON'
{
  "name": "northstar-api",
  "version": "0.4.0",
  "description": "Northstar REST API — auth, rate limiting, webhooks",
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "jest",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "fastify": "^4.27.0",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.11.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^20.12.12",
    "jest": "^29.7.0",
    "tsx": "^4.10.0",
    "typescript": "^5.4.5"
  }
}
JSON

  cat >"$WT/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
JSON

  cat >"$WT/.env.example" <<'ENV'
PORT=3000
DATABASE_URL=postgres://localhost:5432/northstar
JWT_SECRET=change-me-in-prod
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
RATE_LIMIT_WINDOW=60
RATE_LIMIT_MAX=100
ENV

  cat >"$WT/README.md" <<'MD'
# northstar-api

REST API for the Northstar product. Built with Fastify, Postgres, and JWT auth.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Routes

- `POST /auth/login`   — issue access + refresh tokens
- `POST /auth/refresh` — exchange refresh token
- `GET  /users/me`     — return current user (auth required)
- `GET  /health`       — liveness probe
MD

  cat >"$WT/src/server.ts" <<'TS'
import Fastify from "fastify";
import { registerRoutes } from "./app.js";

const app = Fastify({ logger: true });
registerRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
TS

  cat >"$WT/src/app.ts" <<'TS'
import type { FastifyInstance } from "fastify";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { healthRoutes } from "./routes/health.js";

export function registerRoutes(app: FastifyInstance): void {
  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/auth" });
  app.register(userRoutes, { prefix: "/users" });
}
TS

  cat >"$WT/src/routes/auth.ts" <<'TS'
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { signAccess, signRefresh, verifyRefresh } from "../utils/jwt.js";
import { findUserByEmail } from "../models/User.ts";
import { verifyPassword } from "../utils/crypto.js";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", async (req, reply) => {
    const { email, password } = LoginBody.parse(req.body);
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }
    return {
      accessToken: signAccess({ sub: user.id, roles: user.roles }),
      refreshToken: signRefresh({ sub: user.id }),
    };
  });

  app.post("/refresh", async (req, reply) => {
    const { token } = req.body as { token: string };
    const payload = verifyRefresh(token);
    if (!payload) return reply.status(401).send({ error: "Invalid token" });
    return { accessToken: signAccess({ sub: payload.sub, roles: [] }) };
  });
}
TS

  cat >"$WT/src/routes/users.ts" <<'TS'
import type { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { findUserById } from "../models/User.ts";

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  app.get("/me", async (req) => {
    const user = await findUserById(req.user!.sub);
    return { id: user.id, email: user.email, roles: user.roles };
  });
}
TS

  cat >"$WT/src/routes/health.ts" <<'TS'
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));
}
TS

  cat >"$WT/src/middleware/authMiddleware.ts" <<'TS'
import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccess } from "../utils/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: { sub: string; roles: string[] };
  }
}

/**
 * JWT bearer auth. Reads `Authorization: Bearer <token>`, verifies the
 * signature + expiry, and attaches the decoded payload to `req.user`.
 */
export async function authMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Missing bearer token" });
  }
  const token = header.slice("Bearer ".length);
  const payload = verifyAccess(token);
  if (!payload) {
    return reply.status(401).send({ error: "Invalid or expired token" });
  }
  req.user = { sub: payload.sub, roles: payload.roles ?? [] };
}

/** Role-based access guard — use as a per-route preHandler. */
export function requireRole(role: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user?.roles.includes(role)) {
      return reply.status(403).send({ error: `Requires role '${role}'` });
    }
  };
}
TS

  cat >"$WT/src/middleware/cors.ts" <<'TS'
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export async function registerCors(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
    credentials: true,
  });
}
TS

  cat >"$WT/src/middleware/rateLimiter.ts" <<'TS'
import type { FastifyRequest, FastifyReply } from "fastify";

const buckets = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 60_000;
const MAX = Number(process.env.RATE_LIMIT_MAX ?? 100);

export async function rateLimiter(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.ip;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    buckets.set(key, { count: 1, reset: now + WINDOW_MS });
    return;
  }
  bucket.count += 1;
  if (bucket.count > MAX) {
    return reply.status(429).send({ error: "Too many requests" });
  }
}
TS

  cat >"$WT/src/db/pool.ts" <<'TS'
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
TS

  cat >"$WT/src/db/migrations/001_create_users.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  roles         TEXT[] NOT NULL DEFAULT ARRAY['user'],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX users_email_idx ON users (email);
SQL

  cat >"$WT/src/db/migrations/002_create_sessions.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token   TEXT NOT NULL UNIQUE,
  user_agent      TEXT,
  ip_address      INET,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
SQL

  cat >"$WT/src/models/User.ts" <<'TS'
import { query } from "../db/pool.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  roles: string[];
  createdAt: Date;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const rows = await query<User>(
    "SELECT id, email, password_hash AS \"passwordHash\", roles, created_at AS \"createdAt\" FROM users WHERE email = $1",
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User> {
  const rows = await query<User>(
    "SELECT id, email, password_hash AS \"passwordHash\", roles, created_at AS \"createdAt\" FROM users WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw new Error(`User ${id} not found`);
  return rows[0];
}
TS

  cat >"$WT/src/models/Session.ts" <<'TS'
import { query } from "../db/pool.js";

export interface SessionRow {
  id: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function createSession(
  userId: string,
  refreshToken: string,
  ttlSeconds: number,
): Promise<SessionRow> {
  const rows = await query<SessionRow>(
    `INSERT INTO sessions (user_id, refresh_token, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)
     RETURNING id, user_id AS "userId", refresh_token AS "refreshToken",
               expires_at AS "expiresAt", revoked_at AS "revokedAt"`,
    [userId, refreshToken, ttlSeconds],
  );
  return rows[0]!;
}

export async function revokeSession(id: string): Promise<void> {
  await query("UPDATE sessions SET revoked_at = NOW() WHERE id = $1", [id]);
}
TS

  cat >"$WT/src/utils/jwt.ts" <<'TS'
import jwt, { type SignOptions } from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET ?? "dev-only-secret";
const ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? "15m";
const REFRESH_TTL = process.env.JWT_REFRESH_TTL ?? "7d";

export interface AccessPayload {
  sub: string;
  roles: string[];
}

export interface RefreshPayload {
  sub: string;
}

const opts = (ttl: string): SignOptions => ({ expiresIn: ttl as SignOptions["expiresIn"] });

export function signAccess(payload: AccessPayload): string {
  return jwt.sign(payload, SECRET, opts(ACCESS_TTL));
}

export function signRefresh(payload: RefreshPayload): string {
  return jwt.sign(payload, SECRET, opts(REFRESH_TTL));
}

export function verifyAccess(token: string): AccessPayload | null {
  try {
    return jwt.verify(token, SECRET) as AccessPayload;
  } catch {
    return null;
  }
}

export function verifyRefresh(token: string): RefreshPayload | null {
  try {
    return jwt.verify(token, SECRET) as RefreshPayload;
  } catch {
    return null;
  }
}
TS

  cat >"$WT/src/utils/crypto.ts" <<'TS'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(plain, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scrypt(plain, salt, 64)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
TS

  cat >"$WT/tests/auth.test.ts" <<'TS'
import { signAccess, verifyAccess } from "../src/utils/jwt";

describe("jwt", () => {
  it("round-trips a payload", () => {
    const token = signAccess({ sub: "u1", roles: ["admin"] });
    const decoded = verifyAccess(token);
    expect(decoded?.sub).toBe("u1");
    expect(decoded?.roles).toContain("admin");
  });

  it("rejects garbage", () => {
    expect(verifyAccess("nope")).toBeNull();
  });
});
TS

  cat >"$WT/tests/users.test.ts" <<'TS'
import { authMiddleware } from "../src/middleware/authMiddleware";

describe("authMiddleware", () => {
  it("rejects missing bearer", async () => {
    const req: any = { headers: {} };
    const reply: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await authMiddleware(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
TS

  cat >"$WT/docs/API.md" <<'MD'
# API Reference

## Authentication

All `/users/*` routes require a valid `Authorization: Bearer <token>` header.

### POST /auth/login

```json
{ "email": "alice@example.com", "password": "hunter22hunter22" }
```

Returns `{ accessToken, refreshToken }`.

### POST /auth/refresh

```json
{ "token": "<refresh-token>" }
```

Returns `{ accessToken }`.

## Users

### GET /users/me

Returns the authenticated user — `{ id, email, roles }`.
MD

  cat >"$WT/docs/PLAN.md" <<'MD'
# Auth Middleware — Implementation Plan

> Owner: agent-claude · Branch: `feat/auth-middleware` · Status: in progress

## Goal

Ship JWT bearer-token auth middleware for the Northstar API.
Cover token issuance, validation, role-based access, and refresh — with full test
coverage and zero changes to existing `/health` traffic.

## Phases

### Phase 1 — Token infrastructure ✅

- [x] Add `jsonwebtoken` dependency
- [x] `src/utils/jwt.ts` — `signAccess`, `signRefresh`, `verifyAccess`, `verifyRefresh`
- [x] Configurable TTLs via `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL`
- [x] Round-trip unit tests

### Phase 2 — Middleware ✅

- [x] `src/middleware/authMiddleware.ts` — Bearer extraction + verify
- [x] Attach `req.user = { sub, roles }`
- [x] 401 on missing / invalid / expired token
- [x] Wire into `userRoutes` via `addHook("preHandler", ...)`

### Phase 3 — Role-based access (in progress) ⏳

- [x] `requireRole(role)` factory
- [ ] Apply `requireRole("admin")` to admin-only routes
- [ ] Audit log for denied requests
- [ ] Tests for the matrix `{user, admin} × {allowed, denied}`

### Phase 4 — Refresh + revocation

- [ ] `POST /auth/refresh` — exchange refresh for fresh access token
- [ ] Store refresh tokens in `sessions` table
- [ ] `POST /auth/logout` — revoke current refresh token
- [ ] Background job to prune expired sessions

### Phase 5 — Hardening

- [ ] Rate-limit `/auth/login` (5 req/min/IP)
- [ ] Constant-time password compare (already using `scrypt` + `timingSafeEqual`)
- [ ] Rotate `JWT_SECRET` strategy (kid claim + verify against keyset)

## Risks

| Risk | Mitigation |
|---|---|
| Long-lived access tokens | 15m TTL + short refresh window |
| Refresh token leak | Single-use refresh tokens, revoke on use |
| Role drift | Re-fetch roles from DB on each request? Decide in Phase 3 |

## Open questions

- Do we need multi-tenant scoping in Phase 1 or can it wait?
- Redis vs Postgres for the revocation store — Postgres is simpler; Redis is faster.
- Should the access token carry the full role list or just a stable claim?

## Test plan

- Unit: jwt sign/verify, middleware happy + sad paths, requireRole matrix
- Integration: `/auth/login` → `/users/me` → `/auth/refresh` → revoked token rejected
- Load: 1000 rps against `/users/me` for 60s — p99 < 50ms
MD

  # Make the worktree a git repo so file-watcher / status calls don't error.
  git -C "$WT" init -q -b feat/auth-middleware
  git -C "$WT" config user.email "demo@vibe-station.dev"
  git -C "$WT" config user.name "Demo Agent"
  git -C "$WT" add . >/dev/null
  git -C "$WT" commit -q -m "feat(auth): scaffold middleware + tests + plan"

  # ─── 6. Fake transcripts for tmux sessions ─────────────────────────────────
  cat >"$TRANSCRIPTS/napi-1-m.txt" <<'TRANS'

╭──────────────────────────────────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                                                    │
╰──────────────────────────────────────────────────────────────────────────────╯

  cwd: ~/.vibe-station/projects/northstar-api/worktrees/napi-1
  mode: Claude Code (sonnet)

> Implement JWT auth middleware for the Northstar API. See docs/PLAN.md.

● I'll work through Phase 1 and Phase 2 of the plan. Let me start by reading the
  existing route layout.

● Read(src/routes/users.ts)
  ⎿  Read 23 lines

● Read(src/utils/jwt.ts) — file does not yet exist, will create.

● Write(src/utils/jwt.ts)
  ⎿  Wrote 41 lines · signAccess / signRefresh / verifyAccess / verifyRefresh

● Write(src/middleware/authMiddleware.ts)
  ⎿  Wrote 35 lines · Bearer extraction, attaches req.user

● Update(src/routes/users.ts)
  ⎿  Wired authMiddleware as a preHandler on the /users prefix

● Bash(pnpm test -- jwt auth)
  ⎿  PASS tests/auth.test.ts
       jwt
         ✓ round-trips a payload (4 ms)
         ✓ rejects garbage (1 ms)
       authMiddleware
         ✓ rejects missing bearer (2 ms)

     Tests:       3 passed, 3 total
     Time:        1.847 s

● Phase 1 + Phase 2 of docs/PLAN.md are complete.
  Phase 3 (role-based access) is still pending — do you want me to start that now?

>
TRANS

  cat >"$TRANSCRIPTS/napi-1-a1.txt" <<'TRANS'

  ┌─ cursor-agent ─────────────────────────────────────────────────────────────┐
  │ Branch: feat/auth-middleware  ·  Worktree: napi-1                          │
  └────────────────────────────────────────────────────────────────────────────┘

> Pair with the main agent — write integration tests for /auth/login and /auth/refresh

  Reading test scaffolding...
  ✔ found tests/auth.test.ts (unit only)
  ✔ found tests/users.test.ts

  Plan:
   1. Add tests/integration/auth.flow.test.ts
   2. Spin up an in-memory pg instance via pg-mem
   3. Cover: login → access token → /users/me → refresh → revoked refresh

  ▸ Writing tests/integration/auth.flow.test.ts (118 lines)
  ▸ Writing tests/integration/setup.ts (34 lines)
  ▸ Updating package.json — add pg-mem dev dep

  Running the new suite:
    PASS tests/integration/auth.flow.test.ts (4.2s)
      ✓ login returns access + refresh tokens
      ✓ /users/me requires bearer
      ✓ /users/me succeeds with valid bearer
      ✓ refresh issues a new access token
      ✓ revoked refresh token is rejected

  Done. 5 new integration tests, all green. Ready for review.

>
TRANS

  cat >"$TRANSCRIPTS/napi-1-a2.txt" <<'TRANS'

╭──────────────────────────────────────────────────────────────────────────────╮
│ ✻ Claude Code                                                                │
╰──────────────────────────────────────────────────────────────────────────────╯

> Add role-based access control on top of the new auth middleware (Phase 3 of PLAN.md)

● Reading current middleware to see the attached req.user shape.

● Read(src/middleware/authMiddleware.ts)
  ⎿  Read 35 lines · req.user is { sub, roles[] }

● Read(src/models/User.ts)
  ⎿  Read 24 lines · roles already on the User row

● Plan:
    1. Add `requireRole(role)` factory in authMiddleware.ts
    2. Apply to /admin/* routes
    3. Tests: user-without-role → 403, user-with-role → 200

● Update(src/middleware/authMiddleware.ts)
  ⎿  +12 lines · added requireRole

● Write(src/routes/admin.ts)
  ⎿  Wrote 28 lines · /admin/users list (admin role required)

● Bash(pnpm test -- requireRole)
  ⎿  Running...
TRANS

  # ─── 7. Mark seeded ────────────────────────────────────────────────────────
  touch "$VST/.seeded"
  echo "[seed] data init complete"
fi

# ─── 8. Tmux sessions (always reset on container start) ──────────────────────
# Every session in the manifest needs a matching tmux session — otherwise the
# 1Hz lifecycle poller marks them as "exited" and the dashboard rollup is
# wrong. Sessions backing a "working" state additionally need pane activity
# so the activity-delta heuristic doesn't flip them to "idle".
echo "[seed] resetting tmux sessions..."
ALL_TMUX=(
  vr-napi-1-m vr-napi-1-a1 vr-napi-1-a2
  vr-napi-2-m vr-napi-3-m vr-napi-4-m
  vr-atls-1-m vr-atls-2-m vr-atls-3-m
  vr-frge-1-m vr-frge-2-m
)
for name in "${ALL_TMUX[@]}"; do
  tmux kill-session -t "$name" 2>/dev/null || true
done

# Idle session: prints transcript (or banner) once, then a static prompt.
start_idle_session() {
  local name=$1
  local transcript=${2:-}
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    tmux new-session -d -s "$name" -x 200 -y 50 \
      "cat '$transcript'; export PS1='> '; exec bash --noprofile --norc -i"
  else
    tmux new-session -d -s "$name" -x 200 -y 50 \
      "printf '\n  [agent paused — waiting for input]\n\n'; export PS1='> '; exec bash --noprofile --norc -i"
  fi
}

# Working session: prints transcript + a tiny ticker so the pane hash keeps
# changing and the lifecycle poller keeps it pinned to "working".
start_working_session() {
  local name=$1
  local transcript=${2:-}
  local script="$HOME_DIR/.transcripts/_$name.sh"
  cat >"$script" <<EOF
#!/usr/bin/env bash
$([ -n "$transcript" ] && echo "cat '$transcript'" || echo "printf '\n  [agent thinking...]\n\n'")
i=0
while true; do
  i=\$((i + 1))
  printf '  · tick %d  %s\n' "\$i" "\$(date +%H:%M:%S)"
  sleep 1
done
EOF
  chmod +x "$script"
  tmux new-session -d -s "$name" -x 200 -y 50 "$script"
}

# Done session: prints transcript and exits — daemon keeps state from manifest
# (lifecycle poller skips done/exited).
start_done_session() {
  local name=$1
  tmux new-session -d -s "$name" -x 200 -y 50 \
    "printf '\n  ✓ task complete — agent has exited\n\n'; export PS1='> '; exec bash --noprofile --norc -i"
}

# napi-1 — multi-tab worktree (full transcripts)
start_idle_session    vr-napi-1-m  "$TRANSCRIPTS/napi-1-m.txt"
start_idle_session    vr-napi-1-a1 "$TRANSCRIPTS/napi-1-a1.txt"
start_working_session vr-napi-1-a2 "$TRANSCRIPTS/napi-1-a2.txt"

# Other working sessions (kept "working" by the ticker)
start_working_session vr-napi-2-m
start_working_session vr-atls-1-m
start_working_session vr-frge-1-m

# Other idle sessions
start_idle_session vr-napi-3-m
start_idle_session vr-atls-2-m

# Done sessions
start_done_session vr-napi-4-m
start_done_session vr-atls-3-m
start_done_session vr-frge-2-m

echo "[seed] tmux sessions ready: $(tmux ls 2>/dev/null | wc -l) running"
echo "[seed] done."
