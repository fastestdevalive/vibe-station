#!/usr/bin/env bash
# Smoke test: verifies Pi plugin is registered and a Pi mode can be created.
#
# Prerequisites:
#   scripts/dev-sandbox.sh up [worktree-name]
#
# What this tests:
#   1. GET /supported-clis includes {id:"pi"} — plugin registration is correct
#   2. POST /modes with cli:"pi" succeeds — mode validation accepts "pi"
#
# What this does NOT test (known limitation):
#   Starting a Pi session to `working` state requires a real pi-acp adapter
#   that speaks ACP JSON-RPC. The fake-pi-acp.sh stub blocks on stdin without
#   responding, so the ACP initialize would hang. A full end-to-end turn test
#   requires a real pi-acp installation and Pi credentials.
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

echo "== GET $BASE/supported-clis — expect pi to be listed"
CLIS="$(curl -sf "$BASE/supported-clis")"
echo "$CLIS" | jq -e 'map(.id) | contains(["pi"])' >/dev/null || {
  echo "FAIL: pi not found in /supported-clis" >&2
  echo "$CLIS" | jq . >&2
  exit 1
}
echo "pi present in supported-clis ✓"

echo "== GET /supported-clis — pi has supportsJson:true"
PI_ENTRY="$(echo "$CLIS" | jq 'map(select(.id=="pi")) | first')"
echo "$PI_ENTRY" | jq -e '.supportsJson == true' >/dev/null || {
  echo "FAIL: pi supportsJson is not true" >&2
  echo "$PI_ENTRY" | jq . >&2
  exit 1
}
echo "pi supportsJson:true ✓"

echo "== POST $BASE/modes — create a pi mode"
MODE_PAYLOAD="$(jq -nc --arg n "smoke-pi-$(date +%s)" \
  '{name:$n,cli:"pi",context:"Smoke test for Pi plugin."}')"
MODE_RESP="$(curl -sf -X POST "$BASE/modes" -H 'Content-Type: application/json' -d "$MODE_PAYLOAD")"
MID="$(echo "$MODE_RESP" | jq -r .id)"
if [[ -z "$MID" || "$MID" == "null" ]]; then
  echo "FAIL: POST /modes did not return a mode id" >&2
  echo "$MODE_RESP" | jq . >&2
  exit 1
fi
echo "Pi mode created id=$MID ✓"

echo "OK smoke-pi complete."
