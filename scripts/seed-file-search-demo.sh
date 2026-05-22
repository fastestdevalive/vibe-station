#!/usr/bin/env bash
# seed-file-search-demo.sh — creates a sample git repo and registers it with
# the daemon so Quick Open has files to search inside the dev docker container.
#
# Idempotent: if the project is already registered, this script does nothing.

set -euo pipefail

REPO_PATH="${REPO_PATH:-/home/vst/projects/file-search-demo}"
DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:7421}"

# 1. Create the git repo with a variety of files across subdirectories.
if [ ! -d "$REPO_PATH/.git" ]; then
  echo "[seed-file-search] creating sample repo at $REPO_PATH"
  mkdir -p "$REPO_PATH"
  cd "$REPO_PATH"
  git init -q -b main
  git config user.email "demo@vibe-station.dev"
  git config user.name "Demo"

  # .gitignore — proves the endpoint respects it
  cat > .gitignore <<'EOF'
node_modules/
dist/
*.log
secrets/
EOF

  # Root
  cat > README.md <<'EOF'
# File Search Demo

Try Quick Open (Cmd-P / Ctrl-P) and search for:
  - "user" — matches src/auth/UserService.ts, src/auth/UserController.ts, etc.
  - "config" — matches several config files
  - "test" — matches multiple test files
  - "comp" — matches src/components/*
  - "readme" — root README

Files in .gitignore (node_modules/, dist/, *.log, secrets/) MUST NOT appear.
EOF
  cat > package.json <<'EOF'
{ "name": "file-search-demo", "version": "0.0.1" }
EOF
  cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "target": "ES2022" } }
EOF
  cat > .env.example <<'EOF'
API_KEY=replace-me
EOF

  # src/auth
  mkdir -p src/auth
  for f in UserService UserController UserRepository AuthService AuthMiddleware SessionStore TokenManager; do
    cat > "src/auth/${f}.ts" <<EOF
export class ${f} {
  // demo
}
EOF
  done

  # src/components
  mkdir -p src/components
  for f in Button Modal Dialog Sidebar Header Footer Spinner Toast; do
    cat > "src/components/${f}.tsx" <<EOF
export function ${f}() {
  return null;
}
EOF
  done

  # src/utils
  mkdir -p src/utils
  for f in stringHelpers numberFormat dateFormat arrayUtils objectUtils httpClient; do
    cat > "src/utils/${f}.ts" <<EOF
export const ${f}Demo = true;
EOF
  done

  # src/config
  mkdir -p src/config
  for f in app database logging featureFlags env; do
    cat > "src/config/${f}.config.ts" <<EOF
export const ${f}Config = {};
EOF
  done

  # tests
  mkdir -p tests/unit tests/integration
  for f in UserService AuthService stringHelpers httpClient; do
    cat > "tests/unit/${f}.test.ts" <<EOF
import { describe, it } from "vitest";
describe("${f}", () => { it("works", () => {}); });
EOF
  done
  for f in login logout signup; do
    cat > "tests/integration/${f}.flow.test.ts" <<EOF
import { describe, it } from "vitest";
describe("${f} flow", () => { it("works", () => {}); });
EOF
  done

  # docs
  mkdir -p docs
  for f in architecture api-reference contributing changelog; do
    echo "# ${f}" > "docs/${f}.md"
  done

  # Ignored content — these must NOT appear in Quick Open
  mkdir -p node_modules/some-pkg dist secrets
  echo "{}" > node_modules/some-pkg/package.json
  echo "bundled" > dist/bundle.js
  echo "DO NOT SHOW" > secrets/api-key.txt
  echo "verbose log" > debug.log

  git add .
  git commit -q -m "init: file-search-demo"
  echo "[seed-file-search] repo created with $(find . -type f -not -path './.git/*' | wc -l) files (including ignored)"
fi

# 2. Wait for the daemon, then register the project.
echo "[seed-file-search] waiting for daemon at $DAEMON_URL"
until curl -sf "$DAEMON_URL/health" > /dev/null 2>&1; do
  sleep 0.5
done

# Read the daemon's bearer token from its config file.
CONFIG_PATH="${VST_CONFIG_PATH:-${HOME:-/home/vst}/.vibe-station/config.json}"
TOKEN=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_PATH" | sed 's/.*"\([^"]*\)"$/\1/')
if [ -z "$TOKEN" ]; then
  echo "[seed-file-search] WARNING: could not read daemon token from $CONFIG_PATH; skipping project registration"
  echo "[seed-file-search] Register the project manually via the UI: $REPO_PATH"
  exit 0
fi
AUTH_HEADER="Authorization: Bearer $TOKEN"

# Skip if already registered.
if curl -sf -H "$AUTH_HEADER" "$DAEMON_URL/projects" | grep -q '"file-search-demo"'; then
  echo "[seed-file-search] project already registered, skipping"
  exit 0
fi

echo "[seed-file-search] registering project with daemon"
curl -sf -X POST "$DAEMON_URL/projects" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "{\"path\": \"$REPO_PATH\"}" \
  | head -c 200 || true
echo
echo "[seed-file-search] done. Open the UI and try Cmd-P / Ctrl-P."
