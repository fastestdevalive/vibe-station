#!/usr/bin/env bash
# Stub pi-acp adapter for Docker/API smoke tests (prints sentinel then blocks on stdin).
set -euo pipefail
echo "╭─ Fake Pi ACP ─╮"
echo "Ready."
cat
