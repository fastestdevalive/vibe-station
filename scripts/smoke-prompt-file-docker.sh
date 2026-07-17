#!/usr/bin/env bash
# E2E: prove `vst worktree create --prompt-file` actually delivers the prompt to the agent.
#
# Runs INSIDE the dev sandbox container:
#   docker compose -f docker-compose.dev.yml up --build -d
#   docker compose -f docker-compose.dev.yml exec -T vst-dev bash /app/scripts/smoke-prompt-file-docker.sh
#
# Why gemini: its plugin uses promptDelivery:"inline" and passes the task prompt as
# `-i <prompt>` in argv (daemon/src/agent-plugins/gemini.ts). We install a stub `gemini`
# that echoes its own argv into the pane, so the prompt text reaching the agent process is
# directly observable via the session-output API. That exercises the real path end to end:
#   CLI --prompt-file → POST /worktrees → promptBuilder → spawn → agent argv.
set -euo pipefail

BASE="${VST_SMOKE_URL:-http://127.0.0.1:7421}"
VST="node /app/cli/dist/main.js"
export VST_DAEMON_URL="$BASE"

need_bin() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
need_bin curl
need_bin jq

fail() { echo "FAIL: $*" >&2; exit 1; }

# A prompt distinctive enough that it cannot collide with incidental pane text.
MARKER="VSTPROMPTFILE-$$-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PROMPT_FILE="/tmp/task-${MARKER}.md"
cat > "$PROMPT_FILE" <<EOF
${MARKER}
Second line of the prompt file, to prove multi-line survives.
EOF

echo "== Install stub gemini that echoes its argv"
cat > /usr/local/bin/gemini <<'STUB'
#!/usr/bin/env bash
# Stub gemini: print argv so the task prompt delivered by the daemon is observable.
echo "STUB-GEMINI-ARGV: $*"
echo "Ready."
cat
STUB
chmod +x /usr/local/bin/gemini

echo "== Wait for daemon"
until curl -sf "$BASE/health" >/dev/null 2>&1; do sleep 0.5; done

echo "== Create gemini mode"
MID="$(curl -sf -X POST "$BASE/modes" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg n "promptfile-smoke-$$" '{name:$n,cli:"gemini",context:"Smoke."}')" | jq -r .id)"
[[ -n "$MID" && "$MID" != "null" ]] || fail "could not create mode"

echo "== Seed a git repo to host the worktree (worktrees require git)"
REPO="${VST_SMOKE_REPO:-/home/vst/projects/promptfile-smoke}"
if [[ ! -d "$REPO/.git" ]]; then
  mkdir -p "$REPO"
  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email smoke@example.com
  git -C "$REPO" config user.name "Smoke Test"
  echo "# promptfile smoke repo" > "$REPO/README.md"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "init"
fi

echo "== Resolve project id for $REPO"
PID="$(curl -sf "$BASE/projects" | jq -r --arg p "$REPO" '(first(.[] | select(.path == $p)) // empty).id')"
if [[ -z "$PID" || "$PID" == "null" ]]; then
  PID="$(curl -sf -X POST "$BASE/projects" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg p "$REPO" '{path:$p}')" | jq -r .id)"
fi
[[ -n "$PID" && "$PID" != "null" ]] || fail "could not resolve project"

BRANCH="smoke/prompt-file-$$"
echo "== vst worktree create --prompt-file=$PROMPT_FILE"
OUT="$($VST worktree create "$PID" --mode="$MID" --branch="$BRANCH" --prompt-file="$PROMPT_FILE" 2>&1)" \
  || fail "worktree create exited non-zero:\n$OUT"
echo "$OUT"
WTID="$(echo "$OUT" | tail -1 | tr -d '[:space:]')"
[[ -n "$WTID" ]] || fail "no worktree id returned"

echo "== Find main agent session"
SID=""
for _ in $(seq 1 60); do
  SID="$(curl -sf "$BASE/sessions?worktree=${WTID}" | jq -r '(.[] | select(.slot=="m") | .id) // empty' | head -1)"
  [[ -n "$SID" ]] && break
  sleep 0.5
done
[[ -n "$SID" ]] || fail "main session never appeared for worktree $WTID"

echo "== Assert the prompt-file contents reached the agent process (session $SID)"
for _ in $(seq 1 60); do
  PANE="$($VST session output "$SID" --lines=200 2>/dev/null || true)"
  if grep -q "$MARKER" <<<"$PANE"; then
    echo "PASS: prompt-file contents delivered to agent argv"
    grep -o "STUB-GEMINI-ARGV.*" <<<"$PANE" | head -1 || true
    exit 0
  fi
  sleep 0.5
done

echo "---- last pane output ----" >&2
$VST session output "$SID" --lines=200 >&2 || true
fail "marker '$MARKER' never reached the agent — prompt-file was dropped"
