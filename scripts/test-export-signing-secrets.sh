#!/usr/bin/env bash
# Regression test for scripts/macos-export-signing-secrets.sh --dry-run when the
# exported identity has NO intermediate certificate (empty chain_args array).
# On stock macOS bash 3.2 that used to abort with "unbound variable".
# Uses a throwaway self-signed identity, a stub `security` and a stub `gh` on
# PATH; touches no keychain and no secret. Run with both /bin/bash and newer bash.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(uname -s)" = Darwin ] || { echo "skip: macOS only"; exit 0; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
PIN="$(sed -n 's/^APPLE_TEAM_ID="\([A-Z0-9]\{10\}\)"$/\1/p' "$ROOT/scripts/install.sh")"
CN="Developer ID Application: Test ($PIN)"
OSSL=/usr/bin/openssl
"$OSSL" req -x509 -newkey rsa:2048 -nodes -keyout "$T/k.pem" -out "$T/c.pem" -days 1 -subj "/CN=$CN" 2>/dev/null
"$OSSL" pkcs12 -export -inkey "$T/k.pem" -in "$T/c.pem" -passout pass:stubpw -out "$T/all.p12"
: >"$T/fake.keychain-db"
cat >"$T/bin/security" <<STUB
#!/bin/bash
case "\$1" in
  find-identity) echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "$CN"' ;;
  export) # -P <pw> -o <out>: ignore pw, emit the prebuilt p12 re-encrypted with it
    while [ \$# -gt 0 ]; do case "\$1" in -P) pw="\$2";; -o) out="\$2";; esac; shift; done
    $OSSL pkcs12 -in "$T/all.p12" -passin pass:stubpw -nodes -out "$T/x.pem" 2>/dev/null
    $OSSL pkcs12 -export -inkey "$T/k.pem" -in "$T/c.pem" -passout pass:"\$pw" -out "\$out" ;;
esac
STUB
printf '#!/bin/bash\necho "gh stub called: $*" >&2; exit 99\n' >"$T/bin/gh"
chmod +x "$T/bin/security" "$T/bin/gh"
printf 'FAKE-P8\n' >"$T/key.p8"
for sh in /bin/bash "$(command -v bash)"; do
  out="$(printf 'pw\npw\n%s\nKEYID12345\nissuer-uuid\n' "$T/key.p8" |
    PATH="$T/bin:$PATH" VST_EXPORT_KEYCHAIN="$T/fake.keychain-db" "$sh" "${EXPORT_SCRIPT:-$ROOT/scripts/macos-export-signing-secrets.sh}" --dry-run 2>&1)" ||
    { echo "FAIL ($sh): $out" >&2; exit 1; }
  for n in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER; do
    printf '%s\n' "$out" | grep -q "would set $n " || { echo "FAIL ($sh): $n not reported: $out" >&2; exit 1; }
  done
  echo "ok  $sh --dry-run with an empty chain"
done
echo "PASS"
