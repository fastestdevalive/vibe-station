#!/usr/bin/env bash
# Failure matrix for install.sh's macOS codesign fallback verifier
# (verify_codesign / TRUST_MODE=codesign). Darwin only. Runs a patched COPY of
# install.sh against a local http server with NO minisign/openssl on PATH, so
# the manifest signature is unverifiable and trust rests on Apple code
# signatures alone.
#
# Negative cases need nothing but the OS: unsigned, ad-hoc, a throwaway
# self-signed cert FORGING the pinned team's OU (skipped if codesign refuses
# the untrusted cert). Positive/wrong-team/tampered/partial cases use a
# genuinely Developer-ID-signed Mach-O copied from an installed third-party
# app (no private key, password or signing identity of ours is involved).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)" in Darwin) ;; *) echo "SKIP: macOS only"; exit 0 ;; esac
case "$(uname -m)" in arm64) ARCH=aarch64 ;; *) echo "SKIP: install.sh publishes Apple Silicon only"; exit 0 ;; esac
for t in python3 curl /usr/bin/codesign shasum; do
  command -v "$t" >/dev/null 2>&1 || { echo "SKIP: $t not found"; exit 0; }
done
CLI="vst-$ARCH-apple-darwin.tar.gz"

W="$(mktemp -d)"
SERVER_PID=""
KC=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  [ -n "$KC" ] && security delete-keychain "$KC" >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT
FAILS=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
# VST_CI=1 (set by rust-ci.yml): a skipped case is a FAILURE, so the matrix cannot silently shrink.
skip() {
  if [ "${VST_CI:-0}" = 1 ]; then echo "FAIL (skipped under VST_CI=1) $1"; FAILS=$((FAILS + 1)); else echo "SKIP $1"; fi
}
# A case that needs the OS to trust a throwaway signing identity: some CI runners cannot do that, and
# the case must not turn the whole job red for an environment limit. It warns loudly instead.
skip_soft() {
  echo "SKIP $1"
  [ "${VST_CI:-0}" = 1 ] && echo "::warning::codesign case skipped: $1"
  return 0
}

# ── identities / fixtures ────────────────────────────────────────────────────
PINNED="$(sed -n 's/^APPLE_TEAM_ID="\([A-Z0-9]*\)"$/\1/p' "$ROOT/scripts/install.sh")"
[ -n "$PINNED" ] || { echo "cannot read pinned APPLE_TEAM_ID"; exit 1; }

# A genuinely Developer-ID-signed standalone Mach-O to use as a fixture: any
# third-party app helper already installed (Docker, Chrome, ...). We never need
# a private key: the copied file keeps its original (valid) signature, which is
# exactly what a real release tarball member looks like to install.sh.
REF=""; REF_TEAM=""; REF_ID=""
find_reference() {
  local f info n=0
  for f in /Applications/*.app/Contents/MacOS/* /Applications/*.app/Contents/Helpers/*; do
    [ -f "$f" ] && [ -x "$f" ] || continue
    [ "$(wc -c <"$f")" -lt 80000000 ] || continue
    info="$(/usr/bin/codesign -dvv "$f" 2>&1 || true)"
    printf '%s' "$info" | grep -q '^Authority=Developer ID Application' || continue
    n=$((n + 1)); [ "$n" -le 40 ] || break
    cp "$f" "$W/refcand"
    /usr/bin/codesign --verify --strict "$W/refcand" >/dev/null 2>&1 || continue
    REF_TEAM="$(printf '%s' "$info" | sed -n 's/^TeamIdentifier=//p' | head -n1)"
    [ -n "$REF_TEAM" ] || continue
    REF_ID="$(printf '%s' "$info" | sed -n 's/^Identifier=//p' | head -n1)"
    [ -n "$REF_ID" ] || continue
    REF="$W/refbin"; mv "$W/refcand" "$REF"; return 0
  done
  return 1
}

# Throwaway self-signed cert whose subject OU forges the pinned team. A
# self-signed cert is untrusted, so codesign refuses it unless the user has
# trusted it (we never touch trust settings): the case SKIPs in that situation.
make_forged_identity() {
  KC="$W/forged.keychain-db"
  local pw="throwaway-$$"
  cat >"$W/forged.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = vst-test-forged-$$
OU = $PINNED
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  # Apple's LibreSSL: its PKCS#12 output is importable by `security`.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$W/forged.cnf" \
    -keyout "$W/forged.key" -out "$W/forged.crt" >/dev/null 2>&1
  /usr/bin/openssl pkcs12 -export -inkey "$W/forged.key" -in "$W/forged.crt" \
    -out "$W/forged.p12" -passout pass:throwaway >/dev/null 2>&1
  security create-keychain -p "$pw" "$KC" >/dev/null
  security unlock-keychain -p "$pw" "$KC" >/dev/null
  security import "$W/forged.p12" -k "$KC" -P throwaway -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pw" "$KC" >/dev/null 2>&1 || true
  # An untrusted self-signed identity is not listed by `find-identity -v -p
  # codesigning`, but codesign signs with it when addressed by its SHA-1 hash.
  FORGED_HASH="$(security find-identity "$KC" | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) .*/\1/p' | head -n1)"
  [ -n "$FORGED_HASH" ]
}

# ── fake release server ──────────────────────────────────────────────────────
WWW="$W/www"; mkdir -p "$WWW"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# build_case <case> : stages vst + claude-acp (copies of /bin/echo), returns via $WWW/<case>
# The caller signs/mangles $WWW/<case>/pkg/* then calls finish_case.
begin_case() {
  local d="$WWW/$1"
  mkdir -p "$d/pkg" "$d/releases/download/v9.9.9"
  cp /bin/echo "$d/pkg/vst"; cp /bin/echo "$d/pkg/claude-acp"
  chmod 755 "$d/pkg/vst" "$d/pkg/claude-acp"
  codesign --remove-signature "$d/pkg/vst" "$d/pkg/claude-acp" 2>/dev/null || true
}
finish_case() {
  local d="$WWW/$1" rel="$WWW/$1/releases/download/v9.9.9"
  (cd "$d/pkg" && COPYFILE_DISABLE=1 tar -czf "$rel/$CLI" vst claude-acp)
  printf '# vibe-station release manifest v1\n# tag=v9.9.9\n%s  %s\n' "$(sha "$rel/$CLI")" "$CLI" >"$rel/SHA256SUMS"
  # Present but never verified in codesign mode (shape-checked only).
  printf 'untrusted comment: dummy\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\ntrusted comment: x\nAAAA\n' >"$rel/SHA256SUMS.minisig"
}
adhoc() { codesign --force -s - "$@" >/dev/null 2>&1; }

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
for _ in $(seq 1 40); do [ -s "$PORT_FILE" ] && break; sleep 0.25; done
PORT="$(cat "$PORT_FILE")"

# PATH without minisign/openssl: forces the codesign fallback.
TOOLDIR="$W/tools"; mkdir -p "$TOOLDIR"
for t in sh curl tar mkdir chmod uname sed awk od wc head tail tr cut shasum mktemp cp rm mv ln cat basename dirname ls grep find date id gzip; do
  p="$(command -v "$t" 2>/dev/null || true)"
  [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" "$TOOLDIR/$t"
done

# run_install <case> <pinned-team> -> RC, OUT, BIN
run_install() {
  local c="$1" team="$2" h
  h="$W/run-$c"; BIN="$h/bin"; mkdir -p "$h/home" "$h/tmp"
  sed "s|^APPLE_TEAM_ID=.*|APPLE_TEAM_ID=\"$team\"|" "$ROOT/scripts/install.sh" >"$h/install.sh"
  # ID_OVERRIDE (optional): the third-party fixture's own code identifier stands in for what
  # CI assigns (`--identifier <file name>`); without it the real file-name pin is exercised.
  if [ -n "${ID_OVERRIDE:-}" ]; then
    sed "s|^expected_identifier() .*|expected_identifier() { printf '%s' \"$ID_OVERRIDE\"; }|" "$h/install.sh" >"$h/install.sh.new" && mv "$h/install.sh.new" "$h/install.sh"
  fi
  RC=0
  OUT="$(env -i HOME="$h/home" TMPDIR="$h/tmp" PATH="$TOOLDIR" \
    VST_DOWNLOAD_BASE="http://127.0.0.1:$PORT/$c/releases" \
    VST_API_BASE="http://127.0.0.1:$PORT/$c/api" \
    VST_INSTALL_DIR="$BIN" VST_NO_MODIFY_PATH=1 VST_VERSION=v9.9.9 \
    /bin/sh "$h/install.sh" 2>&1)" || RC=$?
}
bin_empty() { [ -z "$(ls -A "$BIN" 2>/dev/null)" ]; }
expect_fail() { # case team message
  run_install "$1" "$2"
  if [ "$RC" -ne 0 ] && bin_empty && printf '%s' "$OUT" | grep -qF -- "$3" &&
    ! printf '%s' "$OUT" | grep -q 'signature ok'; then pass "$1"
  else fail "$1 (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
}

# ── negative cases (no real identity needed) ─────────────────────────────────
begin_case unsigned; finish_case unsigned
expect_fail unsigned "$PINNED" "unsigned, has an invalid code signature"

begin_case adhoc; adhoc "$WWW/adhoc/pkg/vst" "$WWW/adhoc/pkg/claude-acp"; finish_case adhoc
expect_fail adhoc "$PINNED" "not signed by Apple Developer ID team $PINNED"

# codesign only signs with an identity it considers valid, and a self-signed cert is untrusted.
# Locally this case SKIPs (we never touch trust settings). Under VST_CI=1 (ephemeral CI runner,
# passwordless sudo) the throwaway cert is trusted for code signing in the System keychain for the
# duration of the case and untrusted again afterwards. UNVERIFIED on a real runner as of this writing;
# if it fails there the case reports FAIL rather than skipping.
TRUSTED_CRT=""
trust_forged_for_ci() {
  [ "${VST_CI:-0}" = 1 ] || return 1
  sudo -n security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$W/forged.crt" >/dev/null 2>&1 || return 1
  TRUSTED_CRT="$W/forged.crt"
}
untrust_forged() {
  [ -n "$TRUSTED_CRT" ] && sudo -n security remove-trusted-cert -d "$TRUSTED_CRT" >/dev/null 2>&1 || true
  TRUSTED_CRT=""
}
sign_forged() { # <files...>
  codesign --force --options runtime -s "$FORGED_HASH" --keychain "$KC" "$@" >/dev/null 2>&1
}
if make_forged_identity 2>/dev/null && begin_case forged_ou &&
  { sign_forged "$WWW/forged_ou/pkg/vst" "$WWW/forged_ou/pkg/claude-acp" ||
    { trust_forged_for_ci && sign_forged "$WWW/forged_ou/pkg/vst" "$WWW/forged_ou/pkg/claude-acp"; }; }; then
  untrust_forged
  finish_case forged_ou
  expect_fail forged_ou "$PINNED" "not signed by Apple Developer ID team $PINNED"
else
  untrust_forged
  skip_soft "forged_ou (could not create or trust a throwaway signing identity)"
fi

# ── cases using a real Developer-ID-signed fixture ──────────────────────────
if ! find_reference; then
  skip "good/wrong_team/tampered/partial (no Developer-ID-signed app found under /Applications)"
else
  echo "reference fixture signed by team $REF_TEAM"
  begin_case good; cp "$REF" "$WWW/good/pkg/vst"; cp "$REF" "$WWW/good/pkg/claude-acp"; finish_case good
  ID_OVERRIDE="$REF_ID" run_install good "$REF_TEAM"
  if [ "$RC" -eq 0 ] && [ -x "$BIN/vst" ] && [ -x "$BIN/claude-acp" ] &&
    printf '%s' "$OUT" | grep -q "code signatures ok (2 executables"; then pass good
  else fail "good (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi

  # Valid signatures, but the installer pins a different team.
  cp -R "$WWW/good" "$WWW/wrong_team"
  ID_OVERRIDE="$REF_ID" expect_fail wrong_team "AAAAAAAAAA" "not signed by Apple Developer ID team AAAAAAAAAA"

  # right team, valid signature, but the code identifier is not the file name
  # (a different Developer-ID binary of the same team renamed to vst).
  cp -R "$WWW/good" "$WWW/wrong_identifier"
  expect_fail wrong_identifier "$REF_TEAM" "expected code identifier"

  # extra files in the archive (here a team-signed copy named `git`) are never installed.
  begin_case extra_name; cp "$REF" "$WWW/extra_name/pkg/vst"; cp "$REF" "$WWW/extra_name/pkg/claude-acp"; cp "$REF" "$WWW/extra_name/pkg/git"
  finish_extra() {
    local d="$WWW/$1" rel="$WWW/$1/releases/download/v9.9.9"
    (cd "$d/pkg" && COPYFILE_DISABLE=1 tar -czf "$rel/$CLI" vst claude-acp git)
    printf '# vibe-station release manifest v1\n# tag=v9.9.9\n%s  %s\n' "$(sha "$rel/$CLI")" "$CLI" >"$rel/SHA256SUMS"
    cp "$WWW/good/releases/download/v9.9.9/SHA256SUMS.minisig" "$rel/SHA256SUMS.minisig"
  }
  finish_extra extra_name
  ID_OVERRIDE="$REF_ID" run_install extra_name "$REF_TEAM"
  if [ "$RC" -eq 0 ] && [ -x "$BIN/vst" ] && [ ! -e "$BIN/git" ]; then pass extra_name_not_installed
  else fail "extra_name_not_installed (rc=$RC)"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi

  begin_case tampered; cp "$REF" "$WWW/tampered/pkg/vst"; cp "$REF" "$WWW/tampered/pkg/claude-acp"
  printf 'x' >>"$WWW/tampered/pkg/vst"; finish_case tampered
  ID_OVERRIDE="$REF_ID" expect_fail tampered "$REF_TEAM" "invalid code signature, or was modified"

  # One good + one ad-hoc: nothing may be installed (all-or-nothing).
  begin_case partial; cp "$REF" "$WWW/partial/pkg/vst"; adhoc "$WWW/partial/pkg/claude-acp"; finish_case partial
  ID_OVERRIDE="$REF_ID" expect_fail partial "$REF_TEAM" "not signed by Apple Developer ID team $REF_TEAM"
fi

[ "$FAILS" -eq 0 ] || { echo "$FAILS failure(s)"; exit 1; }
echo "all passed"
