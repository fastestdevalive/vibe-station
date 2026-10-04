#!/bin/sh
# Stand-in for `codex app-server` used by release.yml's codex-acp smoke tests (CODEX_PATH).
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
done
