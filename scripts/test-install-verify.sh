#!/usr/bin/env bash
# Failure-matrix tests for install.sh signature verification. Builds a fake
# release tree signed with a THROWAWAY key, serves it from a local http.server,
# and runs a patched COPY of install.sh (the real script has no bypass flag or
# env var for pins; only this copy's PINNED_PUBKEYS is rewritten with sed).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)" in Linux) ;; *) echo "SKIP: Linux only"; exit 0 ;; esac
for t in openssl python3 curl; do
  command -v "$t" >/dev/null 2>&1 || { echo "SKIP: $t not installed"; exit 0; }
done
if ! openssl pkeyutl -help 2>&1 | grep -q rawin; then
  echo "SKIP: openssl lacks -rawin (needs OpenSSL >= 3)"
  exit 0
fi
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) echo "SKIP: unsupported arch"; exit 0 ;;
esac
CLI="vst-$ARCH-unknown-linux-musl.tar.gz"
GUI="vibe-station-$ARCH-unknown-linux-gnu.AppImage"

W="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$W"
}
trap cleanup EXIT
FAILS=0

# ── tool dirs (PATH control) ─────────────────────────────────────────────────
TOOLS="sh curl tar mkdir chmod uname sed awk od wc head tail tr cut sha256sum mktemp cp rm mv ln cat basename dirname ls grep find ldd date id gzip"
mk_tooldir() { # dir, extra tools...
  local d="$1"; shift
  mkdir -p "$d"
  local t p
  for t in $TOOLS "$@"; do
    p="$(command -v "$t" 2>/dev/null || true)"
    [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" "$d/$t"
  done
}
mk_tooldir "$W/bin_openssl" openssl
mk_tooldir "$W/bin_none"
HAVE_MINISIGN=0
if command -v minisign >/dev/null 2>&1; then
  HAVE_MINISIGN=1
  mk_tooldir "$W/bin_minisign" minisign
fi

# ── signing helpers (minisign-shaped files via openssl) ──────────────────────
KID="$(printf '\001\002\003\004\005\006\007\010')"
gen_key() { openssl genpkey -algorithm ed25519 -out "$1" 2>/dev/null; }
pub_raw() { openssl pkey -in "$1" -pubout -outform DER 2>/dev/null | tail -c 32; }
b64() { openssl base64 -A; }
sign_raw() { # keyfile, infile -> 64 raw bytes on stdout
  openssl pkeyutl -sign -inkey "$1" -rawin -in "$2" 2>/dev/null
}
pub_line() { { printf 'Ed%s' "$KID"; pub_raw "$1"; } | b64; }
# write_minisig <key> <manifest> <out> [alg] [trusted-comment-in-file]
write_minisig() {
  local key="$1" man="$2" out="$3" alg="${4:-Ed}" tc="vibe-station signed" tcfile="${5:-}"
  [ -n "$tcfile" ] || tcfile="$tc"
  sign_raw "$key" "$man" >"$W/f.sig"
  { printf '%s%s' "$alg" "$KID"; cat "$W/f.sig"; } | b64 >"$W/line2"
  { cat "$W/f.sig"; printf '%s' "$tc"; } >"$W/g.in"
  sign_raw "$key" "$W/g.in" | b64 >"$W/line4"
  {
    printf 'untrusted comment: test signature\n'
    cat "$W/line2"; printf '\n'
    printf 'trusted comment: %s\n' "$tcfile"
    cat "$W/line4"; printf '\n'
  } >"$out"
}

gen_key "$W/good.pem"
gen_key "$W/other.pem"
GOOD_PUB="$(pub_line "$W/good.pem")"

# ── fake release tree + server ───────────────────────────────────────────────
WWW="$W/www"; mkdir -p "$WWW"
mk_payloads() { # dir
  mkdir -p "$1/pkg"
  printf '#!/bin/sh\necho 9.9.9\n' >"$1/pkg/vst"
  chmod 755 "$1/pkg/vst"
  (cd "$1/pkg" && tar -czf "../$CLI" vst)
  printf '#!/bin/sh\nexit 0\n' >"$1/$GUI"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

# build <case> [tag]  -> $WWW/<case>/releases/{download/<tag>,latest/download}
build() {
  local c="$1" tag="${2:-v9.9.9}" d="$WWW/$1"
  mkdir -p "$d/stage" "$d/releases/download/$tag" "$d/api/releases"
  mk_payloads "$d/stage"
  cp "$d/stage/$CLI" "$d/stage/$GUI" "$d/releases/download/$tag/"
  {
    printf '# vibe-station release manifest v1\n# tag=%s\n' "$tag"
    printf '%s  %s\n' "$(sha "$d/stage/$GUI")" "$GUI"
    printf '%s  %s\n' "$(sha "$d/stage/$CLI")" "$CLI"
  } >"$d/releases/download/$tag/SHA256SUMS"
  write_minisig "$W/good.pem" "$d/releases/download/$tag/SHA256SUMS" "$d/releases/download/$tag/SHA256SUMS.minisig"
  printf '{"tag_name": "%s"}\n' "$tag" >"$d/api/releases/latest"
}
publish_latest() { # case, tag: mirror download/<tag> to latest/download
  local d="$WWW/$1"
  mkdir -p "$d/releases/latest"
  rm -rf "$d/releases/latest/download"
  cp -r "$d/releases/download/$2" "$d/releases/latest/download"
}
rel() { echo "$WWW/$1/releases/download/${2:-v9.9.9}"; }

PORT_FILE="$W/port"
python3 -I - "$WWW" "$PORT_FILE" >"$W/server.log" 2>&1 <<'PY' &
import http.server, sys, functools, socketserver
root, portfile = sys.argv[1], sys.argv[2]
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    open(portfile, "w").write(str(s.server_address[1]))
    s.serve_forever()
PY
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$PORT_FILE" ] && break
  sleep 0.25
done
PORT="$(cat "$PORT_FILE")"

# ── runner ───────────────────────────────────────────────────────────────────
run_install() { # case shell tooldir [version]  -> sets RC, OUT, BIN
  local c="$1" sh_bin="$2" tools="$3" ver="${4:-v9.9.9}"
  BIN="$W/run-$c-$$-$RANDOM/bin"
  local h; h="$(dirname "$BIN")"; mkdir -p "$h/home" "$h/tmp"
  sed "s|^PINNED_PUBKEYS=.*|PINNED_PUBKEYS=\"$PUBKEYS\"|" "$ROOT/scripts/install.sh" >"$h/install.sh"
  # MINREL (optional): override the MIN_RELEASE floor in the patched copy only.
  if [ -n "${MINREL:-}" ]; then
    sed "s|^MIN_RELEASE=.*|MIN_RELEASE=\"$MINREL\"|" "$h/install.sh" >"$h/install.sh.new" && mv "$h/install.sh.new" "$h/install.sh"
  fi
  RC=0
  OUT="$(env -i HOME="$h/home" TMPDIR="$h/tmp" PATH="$tools" \
    VST_DOWNLOAD_BASE="http://127.0.0.1:$PORT/$c/releases" \
    VST_API_BASE="http://127.0.0.1:$PORT/$c/api" \
    VST_INSTALL_DIR="$BIN" VST_NO_MODIFY_PATH=1 VST_VERSION="$ver" \
    XDG_DATA_HOME="$h/data" \
    "$sh_bin" "$h/install.sh" 2>&1)" || RC=$?
}
PUBKEYS="$GOOD_PUB"

SHELLS="/bin/sh"
command -v dash >/dev/null 2>&1 && SHELLS="$SHELLS $(command -v dash)"
TOOLSETS="$W/bin_openssl"
[ "$HAVE_MINISIGN" = 1 ] && TOOLSETS="$TOOLSETS $W/bin_minisign"

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
bin_empty() { [ -z "$(ls -A "$BIN" 2>/dev/null)" ]; }

expect_fail() { # case [message-substring]
  local c="$1" want="${2:-}" sh_bin tools label
  for sh_bin in $SHELLS; do
    for tools in $TOOLSETS; do
      run_install "$c" "$sh_bin" "$tools"
      label="$c [$(basename "$sh_bin"),$(basename "$tools")]"
      if [ "$RC" -ne 0 ] && bin_empty && { [ -z "$want" ] || printf '%s' "$OUT" | grep -qF -- "$want"; }; then
        pass "$label"
      else
        fail "$label (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'
      fi
    done
  done
}

# ── cases ────────────────────────────────────────────────────────────────────
# good
build good; publish_latest good v9.9.9
for sh_bin in $SHELLS; do
  for tools in $TOOLSETS; do
    run_install good "$sh_bin" "$tools"
    label="good [$(basename "$sh_bin"),$(basename "$tools")]"
    if [ "$RC" -eq 0 ] && [ -x "$BIN/vst" ]; then pass "$label"
    else fail "$label (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
  done
done

build missing_sig; rm -f "$(rel missing_sig)/SHA256SUMS.minisig"
expect_fail missing_sig "predates release signing"

build bad_sig
{ printf '# vibe-station release manifest v1\n# tag=v9.9.9\n%s  other\n' "$(printf x | sha256sum | cut -d' ' -f1)"; } >"$W/other.man"
write_minisig "$W/good.pem" "$W/other.man" "$(rel bad_sig)/SHA256SUMS.minisig"
expect_fail bad_sig "bad signature"

build bad_global_sig
write_minisig "$W/good.pem" "$(rel bad_global_sig)/SHA256SUMS" "$(rel bad_global_sig)/SHA256SUMS.minisig" Ed "tampered comment"
expect_fail bad_global_sig "bad signature"

build wrong_key
write_minisig "$W/other.pem" "$(rel wrong_key)/SHA256SUMS" "$(rel wrong_key)/SHA256SUMS.minisig"
expect_fail wrong_key "bad signature"

build prehashed_ED
write_minisig "$W/good.pem" "$(rel prehashed_ED)/SHA256SUMS" "$(rel prehashed_ED)/SHA256SUMS.minisig" ED
expect_fail prehashed_ED "unsupported or malformed"

build truncated_sig_line
f="$(rel truncated_sig_line)/SHA256SUMS.minisig"
{ sed -n 1p "$f"; sed -n 2p "$f" | cut -c1-96; sed -n 3,4p "$f"; } >"$f.new"; mv "$f.new" "$f"
expect_fail truncated_sig_line

build garbage_base64
f="$(rel garbage_base64)/SHA256SUMS.minisig"
{ sed -n 1p "$f"; echo '!!!!not-base64!!!!'; sed -n 3,4p "$f"; } >"$f.new"; mv "$f.new" "$f"
expect_fail garbage_base64

build tampered_manifest
f="$(rel tampered_manifest)/SHA256SUMS"
sed "s/^[0-9a-f]\{4\}/0000/" "$f" >"$f.new"; mv "$f.new" "$f"
expect_fail tampered_manifest "bad signature"

build hash_mismatch
printf 'evil\n' >>"$(rel hash_mismatch)/$CLI"
expect_fail hash_mismatch "checksum mismatch"

build asset_not_listed
f="$(rel asset_not_listed)/SHA256SUMS"
grep -v " $CLI\$" "$f" >"$f.new"; mv "$f.new" "$f"
write_minisig "$W/good.pem" "$f" "$f.minisig"
expect_fail asset_not_listed "not listed exactly once"

build asset_listed_twice
f="$(rel asset_listed_twice)/SHA256SUMS"
grep " $CLI\$" "$f" >"$f.dup"; cat "$f.dup" >>"$f"; rm -f "$f.dup"
write_minisig "$W/good.pem" "$f" "$f.minisig"
expect_fail asset_listed_twice "not listed exactly once"

build tag_mismatch v9.9.8
mkdir -p "$WWW/tag_mismatch/releases/download/v9.9.9"
cp "$(rel tag_mismatch v9.9.8)"/* "$WWW/tag_mismatch/releases/download/v9.9.9/"
expect_fail tag_mismatch "signed manifest is for"

# no_tools: neither minisign nor openssl
build no_tools
for sh_bin in $SHELLS; do
  run_install no_tools "$sh_bin" "$W/bin_none"
  label="no_tools [$(basename "$sh_bin")]"
  if [ "$RC" -ne 0 ] && bin_empty && printf '%s' "$OUT" | grep -q "install minisign"; then pass "$label"
  else fail "$label (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
done

# latest_fallback: API 404 -> manifest tag adopted, assets from /download/<tag>/
build latest_fallback v9.9.9
publish_latest latest_fallback v9.9.9
rm -rf "$WWW/latest_fallback/api"
: >"$W/server.log"
for sh_bin in $SHELLS; do
  for tools in $TOOLSETS; do
    run_install latest_fallback "$sh_bin" "$tools" latest
    label="latest_fallback [$(basename "$sh_bin"),$(basename "$tools")]"
    if [ "$RC" -eq 0 ] && [ -x "$BIN/vst" ] && grep -q "/latest_fallback/releases/download/v9.9.9/$CLI" "$W/server.log"; then pass "$label"
    else fail "$label (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
  done
done

# latest_replay_old: a genuinely signed OLDER release served as "latest" with the
# API unreachable (manifest tag adopted) must be refused below MIN_RELEASE.
build latest_replay_old v9.9.7
publish_latest latest_replay_old v9.9.7
rm -rf "$WWW/latest_replay_old/api"
for sh_bin in $SHELLS; do
  for tools in $TOOLSETS; do
    MINREL=v9.9.8 run_install latest_replay_old "$sh_bin" "$tools" latest
    label="latest_replay_old [$(basename "$sh_bin"),$(basename "$tools")]"
    if [ "$RC" -ne 0 ] && bin_empty && printf '%s' "$OUT" | grep -qF "older than the minimum"; then pass "$label"
    else fail "$label (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
  done
done
# Same release with the floor at/below it installs fine (floor is not off-by-one).
for sh_bin in $SHELLS; do
  for tools in $TOOLSETS; do
    MINREL=v9.9.7 run_install latest_replay_old "$sh_bin" "$tools" latest
    label="latest_at_floor [$(basename "$sh_bin"),$(basename "$tools")]"
    if [ "$RC" -eq 0 ] && [ -x "$BIN/vst" ]; then pass "$label"
    else fail "$label (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
  done
done

[ "$FAILS" -eq 0 ] || { echo "$FAILS failure(s)"; exit 1; }
echo "all passed"
