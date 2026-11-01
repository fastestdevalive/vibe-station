#!/usr/bin/env bash
# build-rust-acp.sh — fetch (default) or build (--from-source) a pinned Rust ACP adapter
# (claude | codex) and print its absolute path on stdout.
#
#   scripts/build-rust-acp.sh <claude|codex> [--target <rust-triple>] [--docker] [--from-source] [--use-worktree-as-is] [--print-src]
#
# Pin: vendor/rust-acp/pins.toml (release url + per-target sha256, repo/rev, mirrored upstream level).
# Nothing from the ports enters the Cargo workspace, so vst-agents only ever depends on a binary PATH
# (rust/vst-agents/src/{claude,codex}.rs).
#
# Default: DOWNLOAD the prebuilt binary the pin names (the ports are private repos; the prebuilts are
# public release assets) and verify its sha256 against the pin before using it. No credentials needed.
# --from-source (implied by $VST_<NAME>_ACP_REPO, --use-worktree-as-is and --print-src) builds the port
# instead; that needs access to the port repo and is for maintainers cutting a new prebuilt.
#
# Source builds: always an isolated clone at the pinned `rev` (~/.cache/vibe-station/
# rust-acp-src/<name>-<rev>), never a working tree — the ports are developed in live worktrees
# whose uncommitted WIP must not leak into a build that claims to be the pin.
# $VST_CLAUDE_ACP_REPO / $VST_CODEX_ACP_REPO override `repo` (a local path is
# fine and may hold unpushed commits). --print-src prints the clone dir and
# exits (used by scripts/parity/). --use-worktree-as-is builds that working tree
# directly for iterating on a port (NOT the pin; loudly labelled).
#
# --docker yields the Linux glibc binary for this machine's CPU (the dev sandbox runs Linux even on a
# macOS host): the pinned prebuilt for <arch>-unknown-linux-gnu, or with --from-source a build inside
# rust:1-bookworm. Output rust/target/rust-acp/<name>/linux-<arch>/<name>-acp.
#
# After building, `<bin> --version` MUST contain `+upstream.<pins upstream>`.
# Output contract: ONLY the binary path on stdout; logs on stderr.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$REPO_ROOT/vendor/rust-acp/pins.toml"
NAME="${1:-}"; [[ "$NAME" == claude || "$NAME" == codex ]] || { echo "usage: $0 <claude|codex> [--target T] [--docker] [--from-source] [--use-worktree-as-is] [--print-src]" >&2; exit 1; }
shift
TRIPLE=""; DOCKER=0; FROM_SOURCE=0; USE_WORKTREE=0; PRINT_SRC=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || { echo "Error: --target needs a value" >&2; exit 1; }; TRIPLE="$2"; shift 2 ;;
    --target=*) TRIPLE="${1#*=}"; shift ;;
    --docker) DOCKER=1; shift ;;
    --from-source) FROM_SOURCE=1; shift ;;
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
REPO="$(pin repo)"; REV="$(pin rev)"; MANIFEST="$(pin manifest)"; PKG="$(pin package)"; BIN_NAME="$(pin bin)"; UPSTREAM="$(pin upstream)"; PROFILE="$(pin profile)"; RELEASE="$(pin release)"
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] || { echo "Error: [$NAME] rev must be a full 40-char lowercase commit sha, got '$REV' (a branch/short sha is not a pin)" >&2; exit 1; }
PROFILE_ENV=()   # CARGO_PROFILE_RELEASE_<KEY>=<value> overrides from pins.toml `profile`
for kv in $PROFILE; do k="${kv%%=*}"; PROFILE_ENV+=("CARGO_PROFILE_RELEASE_$(echo "$k" | tr 'a-z-' 'A-Z_')=${kv#*=}"); done
for v in REV MANIFEST PKG BIN_NAME UPSTREAM; do [[ -n "${!v}" ]] || { echo "Error: $v missing for [$NAME] in $PINS" >&2; exit 1; }; done

REPO_ENV="VST_$(echo "$NAME" | tr a-z A-Z)_ACP_REPO"
# Download the published prebuilt unless the caller asked for (or implied) a source build.
DOWNLOAD=0
[[ -n "$RELEASE" && "$FROM_SOURCE" == 0 && "$USE_WORKTREE" == 0 && "$PRINT_SRC" == 0 && -z "${!REPO_ENV:-}" ]] && DOWNLOAD=1

if [[ "$DOWNLOAD" == 0 ]]; then
# ── source ────────────────────────────────────────────────────────────────
# ALWAYS an isolated clone checked out at the pinned rev, never a working tree:
# the ports are actively developed in their own worktrees (uncommitted WIP would
# otherwise leak into a build that claims to be the pin). $VST_<NAME>_ACP_REPO
# replaces `repo` (a local path works and may hold unpushed commits).
# --use-worktree-as-is builds $VST_<NAME>_ACP_REPO's working tree directly, for
# iterating on a port; the result is NOT the pin and is labelled as such.
REPO="${!REPO_ENV:-$REPO}"
[[ -n "$REPO" ]] || { echo "Error: [$NAME] has no repo in pins.toml yet; set $REPO_ENV to a local clone (it may hold unpushed commits)" >&2; exit 1; }
if [[ "$USE_WORKTREE" == 1 ]]; then
  [[ -n "${!REPO_ENV:-}" && -f "${!REPO_ENV}/$MANIFEST" ]] || { echo "Error: --use-worktree-as-is needs $REPO_ENV=<port working tree>" >&2; exit 1; }
  SRC="${!REPO_ENV}"
  echo "WARNING: building the port's working tree as-is ($SRC @ $(git -C "$SRC" rev-parse --short HEAD), dirty=$([[ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]] && echo yes || echo no)); this is NOT the pinned rev $REV" >&2
else
  SRC="${XDG_CACHE_HOME:-$HOME/.cache}/vibe-station/rust-acp-src/$NAME-$REV"  # outside rust/: cargo would treat a clone there as a stray workspace member
  # Reuse the cached clone only if it is exactly the pin AND has no tracked-file edits; otherwise
  # re-clone into a temp dir and move it into place (two concurrent first-time builds never share a dir).
  if [[ "$(git -C "$SRC" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$REV" || -n "$(git -C "$SRC" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    echo "==> Cloning $REPO @ $REV ..." >&2
    TMP="$SRC.tmp.$$"; rm -rf "$TMP"; mkdir -p "$TMP"; git -C "$TMP" init -q; git -C "$TMP" remote add origin "$REPO"
    git -C "$TMP" fetch -q origin "$REV" && git -C "$TMP" checkout -q FETCH_HEAD || {
      rm -rf "$TMP"; echo "Error: cannot fetch $REV from $REPO (unpushed? point $REPO_ENV at a local clone that has it)" >&2; exit 1; }
    rm -rf "$SRC"; mv "$TMP" "$SRC"
  fi
fi

[[ "$PRINT_SRC" == 1 ]] && { echo "$SRC"; exit 0; }
fi

# ── build ─────────────────────────────────────────────────────────────────
OUT_ROOT="$REPO_ROOT/rust/target/rust-acp/$NAME"
if [[ "$DOWNLOAD" == 1 ]]; then
  # A prebuilt exists only for the targets the pin lists a sha256 for; --docker means "the Linux (glibc)
  # binary for this machine's CPU", as in the source path.
  if [[ "$DOCKER" == 1 ]]; then
    [[ -z "$TRIPLE" ]] || { echo "Error: --docker and --target are mutually exclusive (--docker means the glibc Linux binary for this CPU)" >&2; exit 1; }
    case "$(uname -m)" in arm64|aarch64) ARCH=arm64; TRIPLE=aarch64-unknown-linux-gnu ;; *) ARCH=amd64; TRIPLE=x86_64-unknown-linux-gnu ;; esac
    OUT_DIR="$OUT_ROOT/linux-$ARCH"
  else
    # Same output dir as a source build (host/ unless --target was given): the dev-checkout lookup in
    # vst-agents (claude.rs / codex.rs) finds the adapter there.
    OUT_DIR="$OUT_ROOT/${TRIPLE:-host}"
    [[ -n "$TRIPLE" ]] || TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  fi
  SHA="$(pin "sha256.$TRIPLE")"
  [[ -n "$SHA" ]] || { echo "Error: no prebuilt $NAME-acp is pinned for $TRIPLE in $PINS; build it from source with --from-source (needs $REPO_ENV or access to the port repo)" >&2; exit 1; }
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/vibe-station/rust-acp-bin/$NAME-$REV"; mkdir -p "$CACHE" "$OUT_DIR"
  ARCHIVE="$CACHE/$NAME-acp-$TRIPLE.tar.gz"
  sha_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
  if [[ ! -f "$ARCHIVE" || "$(sha_of "$ARCHIVE")" != "$SHA" ]]; then
    echo "==> Downloading $RELEASE/$NAME-acp-$TRIPLE.tar.gz ..." >&2
    curl -fsSL --retry 3 -o "$ARCHIVE.tmp.$$" "$RELEASE/$NAME-acp-$TRIPLE.tar.gz" || { rm -f "$ARCHIVE.tmp.$$"; echo "Error: download failed" >&2; exit 1; }
    mv "$ARCHIVE.tmp.$$" "$ARCHIVE"
  fi
  [[ "$(sha_of "$ARCHIVE")" == "$SHA" ]] || { rm -f "$ARCHIVE"; echo "Error: sha256 of $NAME-acp-$TRIPLE.tar.gz does not match the pin in $PINS" >&2; exit 1; }
  tar -xzf "$ARCHIVE" -C "$OUT_DIR"
  BIN="$OUT_DIR/${NAME}-acp"
elif [[ "$DOCKER" == 1 ]]; then
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
  OUT_DIR="$OUT_ROOT/linux-$ARCH"; mkdir -p "$OUT_DIR"
  echo "==> docker build ($NAME, linux/$ARCH, rust:1-bookworm) ..." >&2
  docker run --rm --platform "linux/$ARCH" \
    -v "$SRC:/src:ro" -v "$OUT_DIR:/out" \
    -v vst-rust-acp-cargo:/usr/local/cargo/registry -v "vst-rust-acp-target-$NAME-$ARCH:/target" \
    -e CARGO_TARGET_DIR=/target $(for e in ${PROFILE_ENV[@]+"${PROFILE_ENV[@]}"}; do printf -- "-e %s " "$e"; done) -w /src rust:1-bookworm \
    sh -c "cargo build --release --locked --manifest-path $MANIFEST -p $PKG >&2 && cp /target/release/$BIN_NAME /out/${NAME}-acp" >&2
  BIN="$OUT_DIR/${NAME}-acp"
else
  TARGET_ARGS=(); REL=release
  if [[ -n "$TRIPLE" ]]; then TARGET_ARGS=(--target "$TRIPLE"); REL="$TRIPLE/release"; fi
  OUT_DIR="$OUT_ROOT/${TRIPLE:-host}"; mkdir -p "$OUT_DIR"
  echo "==> cargo build ($NAME, ${TRIPLE:-host}) ..." >&2
  env ${PROFILE_ENV[@]+"${PROFILE_ENV[@]}"} cargo build --release --locked --manifest-path "$SRC/$MANIFEST" -p "$PKG" \
    --target-dir "$OUT_ROOT/cargo-target" ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} >&2
  cp "$OUT_ROOT/cargo-target/$REL/$BIN_NAME" "$OUT_DIR/${NAME}-acp"
  BIN="$OUT_DIR/${NAME}-acp"
fi
[[ -x "$BIN" ]] || { echo "Error: expected $BIN after build" >&2; exit 1; }

# ── assert the mirrored upstream level ────────────────────────────────────
# Mandatory whenever the binary can run here: --docker (run inside the build image) and host or
# host-triple builds. Skipped only for a foreign --target, which cannot execute on this machine.
CAN_RUN=1
if [[ "$DOCKER" == 0 && -n "$TRIPLE" && "$TRIPLE" != "$(rustc -vV | sed -n 's/^host: //p')" ]]; then CAN_RUN=0; fi
if [[ "$CAN_RUN" == 0 ]]; then
  echo "==> $NAME-acp version not checked (foreign target $TRIPLE)" >&2
else
  if [[ "$DOCKER" == 1 ]]; then
    VER="$(docker run --rm --platform "linux/$ARCH" -v "$BIN:/x:ro" rust:1-bookworm /x --version 2>&1 | head -n1)" || true
  else
    VER="$("$BIN" --version 2>&1 | head -n1)" || true
  fi
  case "$VER" in
    *"+upstream.$UPSTREAM"*) echo "==> $NAME-acp reports: $VER" >&2 ;;
    *) echo "Error: $NAME-acp reports '${VER:-<nothing>}' but pins.toml says upstream=$UPSTREAM" >&2; exit 1 ;;
  esac
fi
echo "$BIN"
