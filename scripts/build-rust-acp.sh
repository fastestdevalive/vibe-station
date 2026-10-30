#!/usr/bin/env bash
# build-rust-acp.sh — build a pinned Rust ACP adapter (claude | codex) in
# isolation and print its absolute path on stdout.
#
#   scripts/build-rust-acp.sh <claude|codex> [--target <rust-triple>] [--docker] [--use-worktree-as-is] [--print-src]
#
# Pin: vendor/rust-acp/pins.toml (repo, rev, mirrored npm level). Nothing from
# the ports enters the Cargo workspace; like agy-acp this is a standalone
# manifest built with its own --target-dir, so vst-agents only ever depends on a
# binary PATH (rust/vst-agents/src/{claude,codex}.rs).
#
# Source: always an isolated clone at the pinned `rev` (~/.cache/vibe-station/
# rust-acp-src/<name>-<rev>), never a working tree — the ports are developed in live worktrees
# whose uncommitted WIP must not leak into a build that claims to be the pin.
# $VST_CLAUDE_ACP_REPO / $VST_CODEX_ACP_REPO override `repo` (a local path is
# fine and may hold unpushed commits). --print-src prints the clone dir and
# exits (used by scripts/parity/). --use-worktree-as-is builds that working tree
# directly for iterating on a port (NOT the pin; loudly labelled).
#
# --docker builds inside rust:1-bookworm (glibc, matches dev.Dockerfile's
# node:24-slim) so a macOS host can produce the Linux binary for the dev sandbox:
# output rust/target/rust-acp/<name>/linux-<arch>/<name>-acp.
#
# After building, `<bin> --version` MUST contain `+upstream.<pins upstream>`.
# Output contract: ONLY the binary path on stdout; logs on stderr.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$REPO_ROOT/vendor/rust-acp/pins.toml"
NAME="${1:-}"; [[ "$NAME" == claude || "$NAME" == codex ]] || { echo "usage: $0 <claude|codex> [--target T] [--docker] [--use-worktree-as-is] [--print-src]" >&2; exit 1; }
shift
TRIPLE=""; DOCKER=0; USE_WORKTREE=0; PRINT_SRC=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || { echo "Error: --target needs a value" >&2; exit 1; }; TRIPLE="$2"; shift 2 ;;
    --target=*) TRIPLE="${1#*=}"; shift ;;
    --docker) DOCKER=1; shift ;;
    --use-worktree-as-is) USE_WORKTREE=1; shift ;;
    --print-src) PRINT_SRC=1; shift ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

pin() { # pin <key>
  awk -v sec="[$NAME]" -v key="$1" '
    /^\[/ { cur = $0; next }
    cur == sec && $1 == key { sub(/^[^=]*=[ \t]*"/, ""); sub(/"[ \t]*$/, ""); print; exit }' "$PINS"
}
REPO="$(pin repo)"; REV="$(pin rev)"; MANIFEST="$(pin manifest)"; PKG="$(pin package)"; BIN_NAME="$(pin bin)"; UPSTREAM="$(pin upstream)"
for v in REV MANIFEST PKG BIN_NAME UPSTREAM; do [[ -n "${!v}" ]] || { echo "Error: $v missing for [$NAME] in $PINS" >&2; exit 1; }; done

# ── source ────────────────────────────────────────────────────────────────
# ALWAYS an isolated clone checked out at the pinned rev, never a working tree:
# the ports are actively developed in their own worktrees (uncommitted WIP would
# otherwise leak into a build that claims to be the pin). $VST_<NAME>_ACP_REPO
# replaces `repo` (a local path works and may hold unpushed commits).
# --use-worktree-as-is builds $VST_<NAME>_ACP_REPO's working tree directly, for
# iterating on a port; the result is NOT the pin and is labelled as such.
REPO_ENV="VST_$(echo "$NAME" | tr a-z A-Z)_ACP_REPO"
REPO="${!REPO_ENV:-$REPO}"
[[ -n "$REPO" ]] || { echo "Error: [$NAME] has no repo in pins.toml yet; set $REPO_ENV to a local clone (it may hold unpushed commits)" >&2; exit 1; }
if [[ "$USE_WORKTREE" == 1 ]]; then
  [[ -n "${!REPO_ENV:-}" && -f "${!REPO_ENV}/$MANIFEST" ]] || { echo "Error: --use-worktree-as-is needs $REPO_ENV=<port working tree>" >&2; exit 1; }
  SRC="${!REPO_ENV}"
  echo "WARNING: building the port's working tree as-is ($SRC @ $(git -C "$SRC" rev-parse --short HEAD), dirty=$([[ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]] && echo yes || echo no)); this is NOT the pinned rev $REV" >&2
else
  SRC="${XDG_CACHE_HOME:-$HOME/.cache}/vibe-station/rust-acp-src/$NAME-$REV"  # outside rust/: cargo would treat a clone there as a stray workspace member
  if [[ "$(git -C "$SRC" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$REV" ]]; then
    echo "==> Cloning $REPO @ $REV ..." >&2
    rm -rf "$SRC"; mkdir -p "$SRC"; git -C "$SRC" init -q; git -C "$SRC" remote add origin "$REPO"
    git -C "$SRC" fetch -q origin "$REV" && git -C "$SRC" checkout -q FETCH_HEAD || {
      rm -rf "$SRC"; echo "Error: cannot fetch $REV from $REPO (unpushed? point $REPO_ENV at a local clone that has it)" >&2; exit 1; }
  fi
fi

[[ "$PRINT_SRC" == 1 ]] && { echo "$SRC"; exit 0; }

# ── build ─────────────────────────────────────────────────────────────────
OUT_ROOT="$REPO_ROOT/rust/target/rust-acp/$NAME"
if [[ "$DOCKER" == 1 ]]; then
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
  OUT_DIR="$OUT_ROOT/linux-$ARCH"; mkdir -p "$OUT_DIR"
  echo "==> docker build ($NAME, linux/$ARCH, rust:1-bookworm) ..." >&2
  docker run --rm --platform "linux/$ARCH" \
    -v "$SRC:/src:ro" -v "$OUT_DIR:/out" \
    -v vst-rust-acp-cargo:/usr/local/cargo/registry -v "vst-rust-acp-target-$NAME-$ARCH:/target" \
    -e CARGO_TARGET_DIR=/target -w /src rust:1-bookworm \
    sh -c "cargo build --release --locked --manifest-path $MANIFEST -p $PKG >&2 && cp /target/release/$BIN_NAME /out/${NAME}-acp" >&2
  BIN="$OUT_DIR/${NAME}-acp"
else
  TARGET_ARGS=(); REL=release
  if [[ -n "$TRIPLE" ]]; then TARGET_ARGS=(--target "$TRIPLE"); REL="$TRIPLE/release"; fi
  OUT_DIR="$OUT_ROOT/${TRIPLE:-host}"; mkdir -p "$OUT_DIR"
  echo "==> cargo build ($NAME, ${TRIPLE:-host}) ..." >&2
  cargo build --release --locked --manifest-path "$SRC/$MANIFEST" -p "$PKG" \
    --target-dir "$OUT_ROOT/cargo-target" ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} >&2
  cp "$OUT_ROOT/cargo-target/$REL/$BIN_NAME" "$OUT_DIR/${NAME}-acp"
  BIN="$OUT_DIR/${NAME}-acp"
fi
[[ -x "$BIN" ]] || { echo "Error: expected $BIN after build" >&2; exit 1; }

# ── assert the mirrored upstream level ────────────────────────────────────
# Skipped only when the binary can't execute here (a foreign --target);
# --docker binaries are run inside the build image.
if [[ "$DOCKER" == 1 ]]; then
  VER="$(docker run --rm --platform "linux/$ARCH" -v "$BIN:/x:ro" rust:1-bookworm /x --version 2>&1 | head -n1)" || VER=""
else
  VER="$("$BIN" --version 2>&1 | head -n1)" || VER=""
fi
if [[ -z "$VER" ]]; then
  echo "==> $NAME-acp version not checked (binary not runnable on this host)" >&2
else
  case "$VER" in
    *"+upstream.$UPSTREAM"*) echo "==> $NAME-acp reports: $VER" >&2 ;;
    *) echo "Error: $NAME-acp reports '$VER' but pins.toml says upstream=$UPSTREAM" >&2; exit 1 ;;
  esac
fi
echo "$BIN"
