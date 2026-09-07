#!/usr/bin/env bash
# versionbump.sh — semver release helper for vibe-station
# Usage: ./versionbump.sh [major|minor|patch] [--beta] [--dry-run] [--yes] [--release]
#
# --release  : strip -beta suffix from current version, produce X.Y.Z final; no increment
# --beta     : append -beta to the new version (NOTE: Linux/AppImage only; WiX/MSI and
#              macOS .app bundles reject pre-release version strings)
# --dry-run  : print the plan and exit 0, no writes, no git
# --yes / -y : skip interactive confirmation prompt (for CI)

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die()  { echo "ERROR: $*" >&2; exit 1; }
warn() { echo -e "\033[33mWARN: $*\033[0m" >&2; }
info() { echo "  $*"; }

# ---------------------------------------------------------------------------
# Locate repo root
# ---------------------------------------------------------------------------
ROOT="$(git rev-parse --show-toplevel)"

# ---------------------------------------------------------------------------
# Files to version-bump
# To include cli/ or web-ui/ when they graduate from 0.0.0 placeholders, append here.
# ---------------------------------------------------------------------------
JSON_FILES=(
  "desktop/src-tauri/tauri.conf.json"
  "desktop/package.json"
)
CARGO_TOML="desktop/src-tauri/Cargo.toml"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
BUMP=""
BETA=false
DRY_RUN=false
YES=false
RELEASE=false

for arg in "$@"; do
  case "$arg" in
    major|minor|patch) BUMP="$arg" ;;
    --beta)            BETA=true ;;
    --dry-run)         DRY_RUN=true ;;
    --yes|-y)          YES=true ;;
    --release)         RELEASE=true ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

if $RELEASE && [[ -n "$BUMP" ]]; then
  die "--release strips the -beta suffix; don't pass a bump component with it"
fi
if ! $RELEASE && [[ -z "$BUMP" ]]; then
  die "Bump component required (major|minor|patch) unless --release is used"
fi

# ---------------------------------------------------------------------------
# Read current version from canonical source
# ---------------------------------------------------------------------------
CANONICAL="$ROOT/$( echo "${JSON_FILES[0]}" )"
CURRENT_VER="$(perl -ne 'if (/"version":\s*"([^"]+)"/) { print $1; exit }' "$CANONICAL")"
[[ -n "$CURRENT_VER" ]] || die "Could not read current version from $CANONICAL"

# ---------------------------------------------------------------------------
# Compute new version
# ---------------------------------------------------------------------------
# Strip any existing -beta suffix before arithmetic
BASE_VER="${CURRENT_VER%-beta}"
IFS='.' read -r MAJ MIN PAT <<< "$BASE_VER"

if $RELEASE; then
  # Just drop the -beta suffix
  NEW_VER="$BASE_VER"
else
  case "$BUMP" in
    major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
    minor) MIN=$((MIN + 1)); PAT=0 ;;
    patch) PAT=$((PAT + 1)) ;;
  esac
  NEW_VER="$MAJ.$MIN.$PAT"
fi

if $BETA; then
  NEW_VER="${NEW_VER}-beta"
fi

TAG="v$NEW_VER"

# ---------------------------------------------------------------------------
# Dry-run: print plan and exit
# ---------------------------------------------------------------------------
if $DRY_RUN; then
  echo "=== DRY RUN — no files written, no git changes ==="
  echo "  Current version : $CURRENT_VER"
  echo "  New version     : $NEW_VER"
  echo "  Tag             : $TAG"
  echo "  JSON files      : ${JSON_FILES[*]}"
  echo "  Cargo.toml      : $CARGO_TOML"
  if $BETA; then
    echo "  NOTE: -beta tag is Linux/AppImage only; WiX/MSI and macOS .app reject pre-release strings"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Pre-flight checks (all before writing anything)
# ---------------------------------------------------------------------------

# 1. Tag collision
if git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists — choose a different version"
fi

# 2. Dirty index
if ! git -C "$ROOT" diff --cached --quiet; then
  die "staged changes present; commit or reset first"
fi

# 3. Dirty worktree for target files
for f in "${JSON_FILES[@]}" "$CARGO_TOML"; do
  if ! git -C "$ROOT" diff --quiet -- "$f" 2>/dev/null; then
    die "uncommitted changes in $f — commit or stash first"
  fi
done

# 4. Branch warning (non-blocking)
CURRENT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  warn "Not on main (current branch: $CURRENT_BRANCH). Continuing anyway."
fi

# ---------------------------------------------------------------------------
# Confirm with user
# ---------------------------------------------------------------------------
echo ""
echo "Version bump plan:"
echo "  $CURRENT_VER  →  $NEW_VER  (tag: $TAG)"
if $BETA; then
  echo "  NOTE: -beta tag is Linux/AppImage only; WiX/MSI and macOS .app reject pre-release strings"
fi
echo ""

if $YES; then
  info "Skipping prompt (--yes)"
elif [[ -t 0 ]]; then
  read -rp "Proceed? [y/N] " CONFIRM
  [[ "${CONFIRM,,}" == "y" ]] || { echo "Aborted."; exit 0; }
else
  die "Non-interactive shell detected and --yes not passed. Pass --yes for non-interactive use."
fi

# ---------------------------------------------------------------------------
# Write new version to all files
# ---------------------------------------------------------------------------
echo ""
echo "Writing version $NEW_VER ..."

for file in "${JSON_FILES[@]}"; do
  perl -i -0pe 's/"version":\s*"[^"]*"/"version": "'"$NEW_VER"'"/' "$ROOT/$file"
  info "Updated $file"
done

# Cargo.toml: only the version line inside [package], not dependency version lines
sed -i '/^\[package\]/,/^\[/{s/^version = "[^"]*"/version = "'"$NEW_VER"'"/}' "$ROOT/$CARGO_TOML"
info "Updated $CARGO_TOML"

# ---------------------------------------------------------------------------
# Refresh Cargo.lock
# ---------------------------------------------------------------------------
CARGO_BIN="$(command -v cargo 2>/dev/null || echo "/home/gb/.cargo/bin/cargo")"
if [[ -x "$CARGO_BIN" ]]; then
  info "Refreshing Cargo.lock ..."
  "$CARGO_BIN" metadata --no-deps --manifest-path "$ROOT/$CARGO_TOML" --format-version 1 > /dev/null
else
  warn "cargo not found; Cargo.lock not refreshed"
fi

# ---------------------------------------------------------------------------
# Git: stage, commit, tag
# ---------------------------------------------------------------------------
STAGE_FILES=()
for f in "${JSON_FILES[@]}"; do
  STAGE_FILES+=("$f")
done
STAGE_FILES+=("$CARGO_TOML")

# Include Cargo.lock if it changed
CARGO_LOCK="desktop/src-tauri/Cargo.lock"
if ! git -C "$ROOT" diff --quiet -- "$CARGO_LOCK" 2>/dev/null; then
  STAGE_FILES+=("$CARGO_LOCK")
fi

git -C "$ROOT" add -- "${STAGE_FILES[@]}"
git -C "$ROOT" commit -m "chore(version): bump to $NEW_VER" -- "${STAGE_FILES[@]}"
info "Committed version bump"

git -C "$ROOT" tag -a "$TAG" -m "Release $NEW_VER"
info "Created annotated tag $TAG"

# ---------------------------------------------------------------------------
# Done — remind to push
# ---------------------------------------------------------------------------
echo ""
echo "Done! To publish:"
echo "  git push && git push origin $TAG"
