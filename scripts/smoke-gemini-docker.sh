#!/usr/bin/env bash
# Smoke test against dev compose stack (daemon + Vite). Prerequisites:
#   docker compose -f docker-compose.dev.yml up --build
# Defaults target Vite proxy: http://127.0.0.1:5174/api → daemon :7421
set -euo pipefail

BASE="${VST_SMOKE_URL:-http://127.0.0.1:5174/api}"

need_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing dependency on PATH: $1" >&2
    exit 1
  }
}

need_bin curl
need_bin jq

echo "== GET $BASE/supported-clis"
curl -sf "$BASE/supported-clis" | jq -e 'map(.id) | contains(["gemini"])'

echo "== POST gemini mode (unique name)"
MODE_PAYLOAD="$(jq -nc --arg n "smoke-gemini-$(date +%s)" \
  '{name:$n,cli:"gemini",context:"Smoke test."}')"
MID="$(curl -sf -X POST "$BASE/modes" -H 'Content-Type: application/json' -d "$MODE_PAYLOAD" | jq -r .id)"

echo "== Resolve project id (/app inside compose workspace)"
PID="$(curl -sf "$BASE/projects" | jq -r '(first(.[] | select(.path == "/app")) // first(.[])).id')"
if [[ -z "$PID" || "$PID" == "null" ]]; then
  PID="$(curl -sf -X POST "$BASE/projects" -H 'Content-Type: application/json' \
    -d '{"path":"/app"}' | jq -r .id)"
fi

BRANCH="smoke/gemini-$(date +%s)"
echo "== POST worktree branch=$BRANCH mode=$MID useTmux=false"
WT_JSON="$(curl -sf -X POST "$BASE/worktrees" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg pid "$PID" --arg mid "$MID" --arg br "$BRANCH" \
    '{projectId:$pid,branch:$br,modeId:$mid,useTmux:false,prompt:"ping"}')")"
WTID="$(echo "$WT_JSON" | jq -r .id)"

poll_main_state() {
  local wt="$1"
  local i st
  for i in $(seq 1 90); do
    st="$(curl -sf "$BASE/sessions?worktree=${wt}" | jq -r '.[] | select(.slot=="m") | .state')"
    if [[ "$st" == "working" ]]; then
      echo "working"
      return 0
    fi
    if [[ "$st" == "exited" ]]; then
      echo "exited"
      return 1
    fi
    sleep 0.5
  done
  echo "timeout"
  return 1
}

echo "== Poll main agent session → working"
if ! poll_main_state "$WTID" | grep -qx working; then
  echo "Gemini worktree session did not reach working." >&2
  curl -sf "$BASE/sessions?worktree=${WTID}" | jq . >&2 || true
  exit 1
fi

echo "== Regression: claude mode worktree"
CLAUDE_MODE="$(curl -sf "$BASE/modes" | jq -r '(.[] | select(.cli=="claude") | .id) // empty' | head -1)"
if [[ -n "$CLAUDE_MODE" ]]; then
  BR2="smoke/claude-$(date +%s)"
  WT2="$(curl -sf -X POST "$BASE/worktrees" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg pid "$PID" --arg mid "$CLAUDE_MODE" --arg br "$BR2" \
      '{projectId:$pid,branch:$br,modeId:$mid,useTmux:false,prompt:"hi"}')")"
  WID2="$(echo "$WT2" | jq -r .id)"
  if poll_main_state "$WID2" | grep -qx working; then
    echo "claude session working OK"
  else
    echo "WARN: claude regression did not reach working (binary/auth may be missing in container)" >&2
  fi
else
  echo "SKIP: no claude mode in modes.json"
fi

echo "OK smoke complete."
