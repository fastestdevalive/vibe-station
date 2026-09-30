#!/usr/bin/env bash
# scripts/bench-daemon.sh — vibe-station daemon benchmarks.
#
# Measures a small set of real, user-facing moments against the built
# vst-daemon binary, in the spirit of px0.ai's published BENCHMARKS.md: a
# script that lives in the repo, is re-run on every release, and reports a
# median of N runs rather than one flattering sample.
#
# Metrics (matches the website's Benchmarks section table):
#   1. Cold start to ready   — process spawn -> first 200 from GET /health
#   2. Idle daemon RSS       — resident memory a few seconds after ready,
#                              nothing else happening
#   3. Worktree creation     — `git worktree add` end to end, on a small
#                              throwaway repo (proxy for "new worktree" —
#                              does NOT include an actual agent spawn; that
#                              needs a real CLI on PATH and is a stretch
#                              goal, see NOTE below)
#
# NOT measured yet (stretch goals, intentionally left out rather than faked):
#   - End-to-end "new worktree + agent spawn" via the real REST API — needs
#     a running project/session fixture and an agent CLI on PATH.
#   - Concurrent-sessions-before-degradation — needs a load-generation
#     harness, not a single-daemon timing loop.
#
# Usage:
#   scripts/bench-daemon.sh [N]      # N = runs per metric, default 5
#
# Requires: a release build already present at rust/target/release/vst-daemon
# (run `pnpm run build:rust` first if it's missing). Runs the daemon with an
# isolated $HOME so it never touches your real ~/.vibe-station or collides
# with a daemon you already have running.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_BIN="$REPO_ROOT/rust/target/release/vst-daemon"
RUNS="${1:-5}"

if [[ ! -x "$DAEMON_BIN" ]]; then
  echo "error: $DAEMON_BIN not found or not executable." >&2
  echo "Build it first: pnpm run build:rust" >&2
  exit 1
fi

command -v curl >/dev/null || { echo "error: curl is required" >&2; exit 1; }

# ---- helpers ---------------------------------------------------------------

# Median of a whitespace-separated list of numbers (integers or floats).
median() {
  local -a vals
  read -ra vals <<<"$1"
  local n=${#vals[@]}
  local sorted
  sorted=$(printf '%s\n' "${vals[@]}" | sort -n)
  local mid=$((n / 2))
  if ((n % 2 == 1)); then
    echo "$sorted" | sed -n "$((mid + 1))p"
  else
    local a b
    a=$(echo "$sorted" | sed -n "${mid}p")
    b=$(echo "$sorted" | sed -n "$((mid + 1))p")
    awk -v a="$a" -v b="$b" 'BEGIN { printf "%.1f", (a + b) / 2 }'
  fi
}

now_ms() { date +%s%3N; }

# ---- 1 & 2: cold start + idle RSS ------------------------------------------

cold_start_runs=""
idle_rss_runs=""

for i in $(seq 1 "$RUNS"); do
  fake_home="$(mktemp -d)"
  port=$((17421 + i)) # spread across runs so a slow-to-die prior daemon can't collide

  start_ms=$(now_ms)
  HOME="$fake_home" VST_PORT="$port" "$DAEMON_BIN" >"$fake_home/daemon.log" 2>&1 &
  pid=$!

  ready=0
  for _ in $(seq 1 100); do # up to ~10s
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/health" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 0.1
  done
  end_ms=$(now_ms)

  if [[ "$ready" != "1" ]]; then
    echo "run $i: daemon never became ready, skipping" >&2
    kill "$pid" 2>/dev/null || true
    rm -rf "$fake_home"
    continue
  fi

  elapsed=$((end_ms - start_ms))
  cold_start_runs="$cold_start_runs $elapsed"

  # Let it settle briefly at idle before reading RSS.
  sleep 2
  if [[ -r "/proc/$pid/status" ]]; then
    rss_kb=$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status")
    idle_rss_runs="$idle_rss_runs $rss_kb"
  fi

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$fake_home"
done

# ---- 3: worktree creation ---------------------------------------------------

worktree_runs=""
bench_repo="$(mktemp -d)"
git -C "$bench_repo" init -q
git -C "$bench_repo" -c user.email=bench@vibe-station.dev -c user.name=bench commit -q --allow-empty -m init

for i in $(seq 1 "$RUNS"); do
  wt_dir="$(mktemp -d)/wt-$i"
  start_ms=$(now_ms)
  git -C "$bench_repo" worktree add -q -b "bench-$i" "$wt_dir" >/dev/null 2>&1
  end_ms=$(now_ms)
  worktree_runs="$worktree_runs $((end_ms - start_ms))"
  git -C "$bench_repo" worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
done
rm -rf "$bench_repo"

# ---- report ------------------------------------------------------------------

echo
echo "vibe-station daemon benchmarks — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "runs per metric: $RUNS · host: $(uname -sm)"
echo
printf '%-40s %10s\n' "Metric" "Median"
printf '%-40s %10s\n' "Cold start to ready" "$(median "$cold_start_runs") ms"
printf '%-40s %10s\n' "Idle daemon memory (RSS)" "$(median "$idle_rss_runs") KB"
printf '%-40s %10s\n' "git worktree add (proxy metric)" "$(median "$worktree_runs") ms"
echo
echo "Raw samples:"
echo "  cold start (ms):  $cold_start_runs"
echo "  idle RSS (KB):    $idle_rss_runs"
echo "  worktree add (ms):$worktree_runs"
