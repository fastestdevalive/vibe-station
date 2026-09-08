#!/usr/bin/env bash
# build-daemon-binary.sh — Bundle the vibe-station daemon into a standalone binary.
#
# Usage:
#   scripts/build-daemon-binary.sh --target <triple>
#
# Examples:
#   scripts/build-daemon-binary.sh --target aarch64-apple-darwin
#   scripts/build-daemon-binary.sh --target x86_64-apple-darwin
#   scripts/build-daemon-binary.sh --target x86_64-unknown-linux-gnu
#
# Output:
#   dist/vst-daemon-<triple>  (executable)
#   dist/vst-daemon-<triple>.node  (native addons alongside, if any)
#
# Prerequisites:
#   - Node.js 24 (or whichever version pkg targets)
#   - @yao-pkg/pkg installed (pnpm exec pkg)
#   - esbuild installed (pnpm exec esbuild)
#   - TypeScript already compiled: cli/dist/daemon/main.js must exist
#     Run `pnpm --filter cli build` first if not.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Error: --target <triple> is required" >&2
  echo "  e.g. --target x86_64-unknown-linux-gnu" >&2
  exit 1
fi

# Map target triple to pkg's platform/arch notation.
# pkg uses: node24-linux-x64, node24-macos-arm64, etc.
case "$TARGET" in
  x86_64-unknown-linux-gnu)
    PKG_TARGET="node24-linux-x64"
    ;;
  aarch64-apple-darwin)
    PKG_TARGET="node24-macos-arm64"
    ;;
  x86_64-apple-darwin)
    PKG_TARGET="node24-macos-x64"
    ;;
  *)
    echo "Error: unsupported target triple: $TARGET" >&2
    echo "  Supported: x86_64-unknown-linux-gnu, aarch64-apple-darwin, x86_64-apple-darwin" >&2
    exit 1
    ;;
esac

ENTRY="$REPO_ROOT/cli/dist/daemon/main.js"
BUNDLE_FILE="/tmp/vst-daemon.bundle.cjs"
DIST_DIR="$REPO_ROOT/dist"
OUT_BIN="$DIST_DIR/vst-daemon-$TARGET"

echo "==> Building daemon binary for $TARGET (pkg target: $PKG_TARGET)"
echo "    Entry:  $ENTRY"
echo "    Bundle: $BUNDLE_FILE"
echo "    Output: $OUT_BIN"

# 1. Ensure cli/dist/daemon/main.js exists (TypeScript must have been compiled).
if [[ ! -f "$ENTRY" ]]; then
  echo "Error: $ENTRY not found." >&2
  echo "  Run: pnpm --filter cli build   (or: cd cli && pnpm build)" >&2
  exit 1
fi

# 2. Bundle with esbuild — externalise *.node addons (pkg will snapshot them separately).
echo ""
echo "==> Step 1/3: esbuild bundle..."
pnpm exec esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --format=cjs \
  --external:"*.node" \
  --outfile="$BUNDLE_FILE"

echo "    Bundle written to $BUNDLE_FILE ($(du -h "$BUNDLE_FILE" | cut -f1))"

# 3. Package with @yao-pkg/pkg.
mkdir -p "$DIST_DIR"
echo ""
echo "==> Step 2/3: pkg → $OUT_BIN ..."
pnpm exec pkg "$BUNDLE_FILE" \
  --target "$PKG_TARGET" \
  --output "$OUT_BIN"

# 4. Copy any *.node prebuilts alongside the binary.
# pkg snapshots asset files listed in the bundle at pkg-time; native addons that
# are required at runtime via `bindings()` / `node-pre-gyp` need to sit next to
# the binary so they can be found via __dirname-relative resolution at startup.
echo ""
echo "==> Step 3/3: copying native addons (*.node) alongside binary..."
ADDON_COUNT=0
# Walk node_modules for pre-built addons
while IFS= read -r -d '' node_file; do
  BASE="$(basename "$node_file")"
  DEST="$DIST_DIR/$BASE"
  cp "$node_file" "$DEST"
  echo "    copied: $BASE"
  (( ADDON_COUNT++ ))
done < <(find "$REPO_ROOT" -name "*.node" -not -path "*/\.*" -print0 2>/dev/null)

if [[ $ADDON_COUNT -eq 0 ]]; then
  echo "    (no *.node addons found)"
fi

echo ""
echo "==> Done!"
echo "    Binary: $OUT_BIN ($(du -h "$OUT_BIN" | cut -f1))"
echo ""
echo "    Smoke-test:"
echo "      VST_HOME=\$(mktemp -d) $OUT_BIN daemon start --port 7422"
