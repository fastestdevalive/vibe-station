#!/bin/sh
# vibe-station installer
#
#   curl -fsSL https://raw.githubusercontent.com/fastestdevalive/vibe-station/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version v0.2.0
#   wget -qO-  .../install.sh | sh          # e.g. Alpine (busybox wget, no curl)
#
# Installs the `vst` CLI (+ desktop app on Linux) into ~/.local/bin /
# ~/.local/share/vibe-station, and adds the CLI's dir to PATH via the user's
# shell rc files. No sudo, ever. Safe to re-run: upgrades in place and never
# duplicates PATH entries.
#
# Linux: installs both, unconditionally — the CLI, and the .AppImage (with a
# `vibe-station` launcher symlink + .desktop menu entry). The one exception is
# a musl system (e.g. Alpine): the AppImage needs glibc, so there only the CLI
# installs, with a warning. (.deb is intentionally NOT handled here; use
# apt/dpkg yourself if you prefer a system package.)
#
# macOS: installs the merged `vst` CLI to ~/.local/bin. The desktop app (.dmg)
# is NOT downloaded or installed by this script — curl downloads do not receive
# the com.apple.quarantine attribute, so an automated download would bypass
# Gatekeeper checks. Download the .dmg from the Releases page and install it
# the normal way instead.
#
# The CLI tarball also carries claude-acp and codex-acp (self-contained ACP adapters for
# Rich Chat, no bun/node needed), installed beside vst. Both are self-contained Rust binaries (static on Linux, whose tarballs are musl).
#
# Every download is verified against the release's signed manifest: SHA256SUMS
# + SHA256SUMS.minisig (minisign/Ed25519, pinned public key below). Requires
# minisign or OpenSSL >= 3 to verify the signature; fails closed otherwise.
# macOS only: if neither is installed (stock macOS ships LibreSSL, which cannot
# verify Ed25519), the manifest signature cannot be checked, so trust moves to
# the Apple code signature instead: every executable in the tarball must be
# signed by the pinned Developer ID team (APPLE_TEAM_ID below) or nothing is
# installed. The minisign/OpenSSL path is always preferred when available.
#
# Release assets consumed (GitHub Release of fastestdevalive/vibe-station):
#   SHA256SUMS + SHA256SUMS.minisig  signed manifest (always fetched first)
#   vst-<triple>.tar.gz
#   vibe-station-<triple>.AppImage   (glibc Linux only)
# where <triple> is:
#   x86_64-unknown-linux-musl / aarch64-unknown-linux-musl  (Linux CLI, static)
#   aarch64-apple-darwin                                    (macOS CLI, Apple Silicon only --
#                                                             Intel isn't published, see detect_platform())
#   x86_64-unknown-linux-gnu / aarch64-unknown-linux-gnu    (Linux AppImage)
#
# Options (each also settable via env var):
#   --version <tag>     VST_VERSION        release tag, default: latest
#   --install-dir <d>   VST_INSTALL_DIR    default: ~/.local/bin
#   --no-modify-path    VST_NO_MODIFY_PATH=1
#   -h, --help
# Testing/mirrors:  VST_DOWNLOAD_BASE (default https://github.com/<repo>/releases)
#                   VST_API_BASE      (default https://api.github.com/repos/<repo>)
#
# The whole script is wrapped in main() and only invoked on the last line, so a
# truncated download can never execute a half-script.

set -eu

REPO="fastestdevalive/vibe-station"
APP_NAME="vibe-station"

# Release signing public key(s); must equal rust/vst-daemon/release-keys/vst-release.pub line 2 (space-separated for rotation).
# Production key, minisign key id 862C62A9DEFD74A8 (docs/UPDATE.md). Release CI
# refuses to publish while the throwaway placeholder key is pinned here.
PINNED_PUBKEYS="RWSodP3eqWIshjqVwU5lxHUF8jsaNvFkroYz+YENSWL9jPCYUpq1Qj3w"

# Apple Developer Team ID that signs the macOS release binaries (macOS codesign
# fallback verifier only; see verify_codesign). Single source of truth for
# install.sh; release CI (scripts/macos-verify-signed.sh) reads THIS line, so
# a CI signing identity from any other team fails the release.
# Team NK3G6CGZ96 = "Developer ID Application: Gaurav bhola (NK3G6CGZ96)", the
# certificate created in the maintainer's Apple Developer account (portal team
# NK3G6CGZ96). Change this line only together with the CI signing identity.
APPLE_TEAM_ID="NK3G6CGZ96"

# Signed-release floor for "latest" installs (replay/downgrade defence). A signed but
# OLDER release served as "latest" (API/redirect tampering) is refused below this.
# Bump in the same PR as any security release. Never above the next release's tag.
MIN_RELEASE="v0.0.3-beta"

# Only these executables are ever installed from the CLI tarball (both trust modes);
# anything else in the archive is ignored. Codesign mode additionally pins the code
# identifier of each to its own name (CI signs with `--identifier <file name>`).
ALLOWED_BINS="vst claude-acp codex-acp"

# True ("0") if $1 (v<semver>) is strictly older than $2 per semver precedence on the
# MAJOR.MINOR.PATCH core; with an equal core a prerelease ranks below the release.
version_lt() {
	awk -v a="$1" -v b="$2" '
		function parse(v, o,   i, pre, p) {
			sub(/^v/, "", v); sub(/\+.*/, "", v); pre = ""
			i = index(v, "-")
			if (i) { pre = substr(v, i + 1); v = substr(v, 1, i - 1) }
			split(v, p, ".")
			o[1] = p[1] + 0; o[2] = p[2] + 0; o[3] = p[3] + 0; o[4] = pre
		}
		BEGIN {
			parse(a, x); parse(b, y)
			for (k = 1; k <= 3; k++) { if (x[k] < y[k]) exit 0; if (x[k] > y[k]) exit 1 }
			if (x[4] != "" && y[4] == "") exit 0
			exit 1
		}'
}

# is_allowed_bin <file name>
is_allowed_bin() {
	for _a in $ALLOWED_BINS; do [ "$1" = "$_a" ] && return 0; done
	return 1
}

# Code identifier CI assigns to the signed binary <name> (macos-ci-sign.sh: --identifier).
expected_identifier() { printf '%s' "$1"; }

# How the release was authenticated: "manifest" (minisign/OpenSSL verified the
# signed SHA256SUMS) or "codesign" (macOS fallback, see verify_manifest_sig).
TRUST_MODE="manifest"

say() { printf 'vst-install: %s\n' "$*"; }
warn() { printf 'vst-install: warning: %s\n' "$*" >&2; }
err() { printf 'vst-install: error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "required command '$1' not found"; }

usage() {
	# Printed from here, not read back out of "$0": when piped (`curl … | sh -s -- --help`)
	# $0 is the shell, not this file.
	cat <<EOF
vibe-station installer

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sh
  curl -fsSL .../install.sh | sh -s -- --version v0.2.0
  wget -qO-  .../install.sh | sh          # e.g. Alpine (busybox wget, no curl)

Installs the vst CLI (+ desktop app on Linux x86_64 glibc) into ~/.local/bin and
~/.local/share/vibe-station, and adds the CLI dir to PATH via your shell rc files.
No sudo. Safe to re-run: upgrades in place and never duplicates PATH entries.

Options (each also settable via env var):
  --version <tag>     VST_VERSION        release tag, default: latest
  --install-dir <d>   VST_INSTALL_DIR    default: ~/.local/bin
  --no-modify-path    VST_NO_MODIFY_PATH=1
  -h, --help
Testing/mirrors:  VST_DOWNLOAD_BASE (default https://github.com/$REPO/releases)
                  VST_API_BASE      (default https://api.github.com/repos/$REPO)

See https://github.com/$REPO for usage.
EOF
}

# ── download helpers ──────────────────────────────────────────────────────────

DL=""
pick_downloader() {
	if command -v curl >/dev/null 2>&1; then DL=curl
	elif command -v wget >/dev/null 2>&1; then DL=wget
	else err "need curl or wget"; fi
}

# fetch <url> <dest>   (fails on HTTP errors; follows redirects)
fetch() {
	if [ "$DL" = curl ]; then
		curl --proto '=https,http' -fsSL --retry 3 -o "$2" "$1"
	else
		wget -q -O "$2" "$1"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'
	else err "no sha256 tool (sha256sum/shasum/openssl) found"; fi
}

# verify_manifest_sig: fetch SHA256SUMS + SHA256SUMS.minisig, verify the
# signature against PINNED_PUBKEYS (minisign, else OpenSSL >= 3), then bind the
# signed tag to the requested version. Fails closed; no bypass.
verify_manifest_sig() {
	say "verifying signed release manifest"
	fetch "$(asset_url SHA256SUMS.minisig)" "$TMP/SHA256SUMS.minisig" ||
		err "release $VERSION has no SHA256SUMS.minisig - it predates release signing or was tampered with; download manually from $DOWNLOAD_BASE"
	fetch "$(asset_url SHA256SUMS)" "$TMP/SHA256SUMS" ||
		err "release $VERSION has no SHA256SUMS; download manually from $DOWNLOAD_BASE"
	[ "$(wc -c <"$TMP/SHA256SUMS.minisig" | tr -d ' ')" -le 4096 ] || err "signature file is too large"
	[ "$(wc -c <"$TMP/SHA256SUMS" | tr -d ' ')" -le 65536 ] || err "manifest is too large"

	# Only the non-prehashed "Ed" algorithm is accepted (base64 of "Ed.." starts "RW").
	case "$(sed -n 2p "$TMP/SHA256SUMS.minisig")" in RW*) ;; *) err "unsupported or malformed signature" ;; esac

	_ok=0
	if command -v minisign >/dev/null 2>&1; then
		for _k in $PINNED_PUBKEYS; do
			if minisign -V -q -m "$TMP/SHA256SUMS" -x "$TMP/SHA256SUMS.minisig" -P "$_k" >/dev/null 2>&1; then
				_ok=1
				break
			fi
		done
	elif command -v openssl >/dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q rawin; then
		_ok="$(openssl_verify_manifest)"
	elif [ "$OS" = darwin ] && [ -x /usr/bin/codesign ]; then
		# Fail-closed fallback: the manifest is NOT authenticated here, so its
		# hashes only detect corruption. Authenticity is enforced on the
		# extracted binaries in install_cli (verify_codesign) BEFORE anything
		# is installed. Not defended in this mode: replay of an older (but
		# genuinely signed) release; install minisign to get tag binding.
		TRUST_MODE="codesign"
		warn "minisign / OpenSSL 3 not found: the release manifest signature cannot be verified"
		warn "falling back to the Apple code signature (Team ID $APPLE_TEAM_ID) of the downloaded binaries; for full verification: brew install minisign"
	else
		err "cannot verify release signature: install minisign (apt install minisign / brew install minisign) or OpenSSL 3 and re-run"
	fi
	if [ "$TRUST_MODE" = manifest ]; then
		[ "$_ok" = 1 ] || err "bad signature on SHA256SUMS (refusing to install)"
		say "signature ok"
	fi

	# Tag binding: the signed manifest must be for the release being installed.
	[ "$(sed -n 1p "$TMP/SHA256SUMS")" = "# vibe-station release manifest v1" ] || err "unrecognised manifest format"
	[ "$(awk '/^# tag=/ {c++} END {print c+0}' "$TMP/SHA256SUMS")" = 1 ] || err "manifest must carry exactly one tag line"
	_tag="$(sed -n 's/^# tag=//p' "$TMP/SHA256SUMS")"
	if [ "$VERSION" = latest ]; then
		printf '%s' "$_tag" | awk '/^v[0-9A-Za-z.+-]+$/ {ok=1} END {exit !ok}' || err "manifest carries an invalid tag"
		VERSION="$_tag"
		say "latest release: $VERSION"
	else
		[ "$_tag" = "$VERSION" ] || err "signed manifest is for $_tag, not $VERSION"
	fi
	# "latest" must not be an older signed release than the floor (replay/downgrade).
	if [ "$REQUESTED_LATEST" = 1 ] && version_lt "$VERSION" "$MIN_RELEASE"; then
		err "latest resolved to $VERSION, which is older than the minimum $MIN_RELEASE (possible replay of an old release); refusing to install. Pin a version with --version if this is intended"
	fi
}

# openssl_verify_manifest: prints 1 if the file + global signature verify under
# any pinned key, else 0. openssl's base64 prints nothing and exits 0 on
# garbage, so every length check is mandatory. Octal printf escapes only.
openssl_verify_manifest() {
	_m="$TMP/SHA256SUMS.minisig"
	b64d() { openssl base64 -d -A; }
	[ "$(wc -l <"$_m" | tr -d ' ')" -eq 4 ] || { echo 0; return 0; }
	sed -n 2p "$_m" | b64d >"$TMP/sigline.bin" 2>/dev/null
	[ "$(wc -c <"$TMP/sigline.bin" | tr -d ' ')" -eq 74 ] && [ "$(head -c2 "$TMP/sigline.bin")" = Ed ] || { echo 0; return 0; }
	_sig_kid="$(od -An -tx1 -j2 -N8 "$TMP/sigline.bin" | tr -d ' \n')"
	tail -c 64 "$TMP/sigline.bin" >"$TMP/sig.bin"
	case "$(sed -n 3p "$_m")" in "trusted comment: "*) ;; *) echo 0; return 0 ;; esac
	sed -n 4p "$_m" | b64d >"$TMP/g.sig" 2>/dev/null
	[ "$(wc -c <"$TMP/g.sig" | tr -d ' ')" -eq 64 ] || { echo 0; return 0; }
	cp "$TMP/sig.bin" "$TMP/g.in"
	sed -n 3p "$_m" | sed 's/^trusted comment: //' | tr -d '\n' >>"$TMP/g.in"
	for _pub_b64 in $PINNED_PUBKEYS; do
		printf '%s' "$_pub_b64" | b64d >"$TMP/pub.bin" 2>/dev/null
		[ "$(wc -c <"$TMP/pub.bin" | tr -d ' ')" -eq 42 ] && [ "$(head -c2 "$TMP/pub.bin")" = Ed ] || continue
		[ "$(od -An -tx1 -j2 -N8 "$TMP/pub.bin" | tr -d ' \n')" = "$_sig_kid" ] || continue
		# DER SPKI for Ed25519 = 12-byte prefix + 32-byte key.
		printf '\060\052\060\005\006\003\053\145\160\003\041\000' >"$TMP/pk.der"
		tail -c 32 "$TMP/pub.bin" >>"$TMP/pk.der"
		openssl pkeyutl -verify -pubin -inkey "$TMP/pk.der" -keyform DER -rawin -in "$TMP/SHA256SUMS" -sigfile "$TMP/sig.bin" >/dev/null 2>&1 || continue
		openssl pkeyutl -verify -pubin -inkey "$TMP/pk.der" -keyform DER -rawin -in "$TMP/g.in" -sigfile "$TMP/g.sig" >/dev/null 2>&1 || continue
		echo 1
		return 0
	done
	echo 0
}

# download_verified <asset-name> <dest>  (hash comes from the signed manifest)
download_verified() {
	_url="$(asset_url "$1")"
	say "downloading $_url"
	fetch "$_url" "$2" || err "download failed: $_url"
	_want="$(awk -v n="$1" 'NF==2 && $2==n {print $1; c++} END {exit c!=1}' "$TMP/SHA256SUMS")" ||
		err "$1 is not listed exactly once in the signed manifest"
	printf '%s' "$_want" | awk 'length($0)==64 && $0 !~ /[^0-9a-f]/ {ok=1} END {exit !ok}' || err "malformed manifest entry for $1"
	_got="$(sha256_of "$2")"
	[ "$_want" = "$_got" ] || err "checksum mismatch for $1 (expected $_want, got $_got)"
	say "checksum ok ($_got)"
}

# verify_codesign <file>: macOS fallback verifier. Fail closed (err exits) unless
# the file carries a valid, untampered Apple code signature AND the leaf is a
# "Developer ID Application" certificate (OID 1.2.840.113635.100.6.1.13) issued
# by the Developer ID CA (OID ...100.6.2.6), chained to the Apple root, whose
# subject OU is APPLE_TEAM_ID. Ad-hoc, self-signed, other-team and
# Apple-development certificates all fail the requirement. codesign is called
# by absolute path so a planted PATH entry cannot shadow it.
# Notarization is deliberately NOT checked here: bare binaries cannot carry a
# stapled ticket and a ticket lookup needs the network (release CI asserts
# notarization acceptance; see docs/UPDATE.md).
verify_codesign() {
	_cs=/usr/bin/codesign
	_f="$1"
	_n="$(basename "$_f")"
	"$_cs" --verify --strict "$_f" >/dev/null 2>&1 ||
		err "$_n is unsigned, has an invalid code signature, or was modified after signing (refusing to install)"
	_req="anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\""
	"$_cs" --verify --strict -R "=$_req" "$_f" >/dev/null 2>&1 ||
		err "$_n is not signed by Apple Developer ID team $APPLE_TEAM_ID (refusing to install)"
	_id="$(expected_identifier "$_n")"
	"$_cs" --verify --strict -R "=identifier \"$_id\"" "$_f" >/dev/null 2>&1 ||
		err "$_n does not carry the expected code identifier \"$_id\" (refusing to install)"
}

asset_url() {
	if [ "$VERSION" = latest ]; then
		printf '%s/latest/download/%s' "$DOWNLOAD_BASE" "$1"
	else
		printf '%s/download/%s/%s' "$DOWNLOAD_BASE" "$VERSION" "$1"
	fi
}

# /releases/latest ignores prereleases; while only -beta tags exist it 404s.
# Fall back to the newest release of any kind via the API.
REQUESTED_LATEST=0
resolve_version() {
	[ "$VERSION" = latest ] || return 0
	REQUESTED_LATEST=1
	_probe="$TMP/latest.json"
	if fetch "$API_BASE/releases/latest" "$_probe" 2>/dev/null; then
		_tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_probe" | head -n1)"
		[ -n "$_tag" ] && { VERSION="$_tag"; say "latest release: $VERSION"; return 0; }
	fi
	if fetch "$API_BASE/releases?per_page=1" "$_probe" 2>/dev/null; then
		_tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_probe" | head -n1)"
		[ -n "$_tag" ] && { VERSION="$_tag"; say "no stable release yet; using newest prerelease: $VERSION"; return 0; }
	fi
	# API unreachable/rate-limited: rely on the /latest/download redirect.
	warn "could not query $API_BASE; falling back to the 'latest' download redirect"
}

# ── platform detection ────────────────────────────────────────────────────────

OS="" ARCH=""
detect_platform() {
	case "$(uname -s)" in
		Linux) OS=linux ;;
		Darwin) OS=darwin ;;
		MINGW* | MSYS* | CYGWIN*) err "Windows is not supported by this script; download the installer from the Releases page" ;;
		*) err "unsupported OS: $(uname -s)" ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) ARCH=x86_64 ;;
		arm64 | aarch64) ARCH=aarch64 ;;
		*) err "unsupported architecture: $(uname -m)" ;;
	esac
	# Intel macOS: no vst-x86_64-apple-darwin.tar.gz is published (GitHub's
	# only remaining hosted Intel Mac runner is a paid "larger runners" tier
	# this project doesn't use) -- fail clearly here instead of a bare
	# download-404 further down.
	if [ "$OS" = darwin ] && [ "$ARCH" = x86_64 ]; then
		err "Intel macOS isn't published (only Apple Silicon / aarch64); download the .dmg from https://github.com/$REPO/releases if one exists for your platform, or build vst from source"
	fi
}

cli_triple() {
	case "$OS" in
		linux)
			# Static musl binary: runs on glibc and musl (Alpine) alike.
			echo "$ARCH-unknown-linux-musl"
			;;
		darwin)
			echo "$ARCH-apple-darwin"
			;;
	esac
}

# The desktop AppImage needs glibc; a musl system (e.g. Alpine) can't run it.
is_musl() {
	[ "$OS" = linux ] || return 1
	ls /lib*/ld-linux* /lib*/*/ld-linux* >/dev/null 2>&1 && return 1
	ldd --version 2>&1 | grep -qi musl && return 0
	ls /lib/ld-musl-* >/dev/null 2>&1
}

# ── PATH setup ────────────────────────────────────────────────────────────────

# Path as it should be written into rc files ($HOME kept symbolic).
portable_path() {
	# shellcheck disable=SC2016 # a literal $HOME is intended
	case "$1" in
		"$HOME"/*) printf '$HOME/%s' "${1#"$HOME"/}" ;;
		*) printf '%s' "$1" ;;
	esac
}

# add_source_line <rc-file> <line>   (idempotent)
add_source_line() {
	if [ -f "$1" ] && grep -qF "$2" "$1"; then
		say "PATH already configured in $1"
		return 0
	fi
	mkdir -p "$(dirname "$1")"
	# Ensure we start on a fresh line even if the file lacks a trailing newline.
	if [ -s "$1" ] && [ "$(tail -c1 "$1" | od -An -c | tr -d ' ')" != '\n' ]; then
		printf '\n' >>"$1"
	fi
	printf '\n# added by the vibe-station installer\n%s\n' "$2" >>"$1"
	say "updated $1"
}

setup_path() {
	_pdir="$(portable_path "$INSTALL_DIR")"
	_envdir="${XDG_CONFIG_HOME:-$HOME/.config}/vibe-station"
	_env="$_envdir/env"
	mkdir -p "$_envdir"
	# Guarded prepend: sourcing it any number of times adds the dir once.
	cat >"$_env" <<EOF
# vibe-station: put the vst CLI on PATH (sourced from your shell rc files)
case ":\${PATH}:" in
    *:"$_pdir":*) ;;
    *) export PATH="$_pdir:\$PATH" ;;
esac
EOF
	_line=". \"$(portable_path "$_env")\""
	_login="$(basename "${SHELL:-sh}")"

	# POSIX sh / dash / ash login shells, and bash login shells that have no
	# ~/.bash_profile or ~/.bash_login.
	add_source_line "$HOME/.profile" "$_line"
	# bash reads the first of these that exists *instead of* ~/.profile.
	for _f in "$HOME/.bash_profile" "$HOME/.bash_login"; do
		[ -f "$_f" ] && add_source_line "$_f" "$_line"
	done
	# Interactive non-login bash (the usual Linux terminal).
	if [ -f "$HOME/.bashrc" ] || [ "$_login" = bash ]; then
		add_source_line "$HOME/.bashrc" "$_line"
	fi
	# zsh never reads ~/.profile. .zshenv (not .zshrc) because it is the only
	# file every zsh reads, including non-interactive `zsh -lc`/`ssh host vst
	# ...` (rustup does the same); the guard in the env file stops re-adds
	# from nested shells.
	_zrc="${ZDOTDIR:-$HOME}/.zshenv"
	if [ -f "$_zrc" ] || [ "$_login" = zsh ]; then
		add_source_line "$_zrc" "$_line"
	fi
	# fish cannot source POSIX sh; give it its own conf.d snippet.
	if [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/fish" ] || [ "$_login" = fish ]; then
		_fish="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/vibe-station.fish"
		mkdir -p "$(dirname "$_fish")"
		# shellcheck disable=SC2016 # literal $PATH is fish syntax
		printf '# added by the vibe-station installer\ncontains "%s" $PATH; or set -gx PATH "%s" $PATH\n' \
			"$INSTALL_DIR" "$INSTALL_DIR" >"$_fish"
		say "wrote $_fish"
	fi
	ENV_FILE="$_env"
}

# ── installers ────────────────────────────────────────────────────────────────

install_cli() {
	_triple="$(cli_triple)"
	_asset="vst-$_triple.tar.gz"
	download_verified "$_asset" "$TMP/$_asset"
	mkdir -p "$TMP/cli"
	tar -xzf "$TMP/$_asset" -C "$TMP/cli" || err "failed to extract $_asset"
	mkdir -p "$INSTALL_DIR"
	# macOS codesign fallback: authenticate EVERY executable we are about to
	# install before touching INSTALL_DIR (all-or-nothing).
	if [ "$TRUST_MODE" = codesign ]; then
		_v=0
		for _src in "$TMP/cli"/* "$TMP/cli"/*/*; do
			[ -f "$_src" ] && [ -x "$_src" ] || continue
			is_allowed_bin "$(basename "$_src")" || continue
			verify_codesign "$_src"
			_v=$((_v + 1))
		done
		[ "$_v" -gt 0 ] || err "no executables found in $_asset"
		say "code signatures ok ($_v executables, Team ID $APPLE_TEAM_ID)"
	fi
	_n=0
	# Accept either a flat archive or one wrapping directory (cargo-dist style).
	for _src in "$TMP/cli"/* "$TMP/cli"/*/*; do
		[ -f "$_src" ] && [ -x "$_src" ] || continue
		_name="$(basename "$_src")"
		is_allowed_bin "$_name" || { warn "ignoring unexpected file in archive: $_name"; continue; }
		# Copy to a temp name then rename: atomic, and works even if the old
		# binary is currently running ("text file busy").
		cp "$_src" "$INSTALL_DIR/.$_name.new"
		chmod 755 "$INSTALL_DIR/.$_name.new"
		mv -f "$INSTALL_DIR/.$_name.new" "$INSTALL_DIR/$_name"
		say "installed $INSTALL_DIR/$_name"
		_n=$((_n + 1))
	done
	[ "$_n" -gt 0 ] || err "no executables found in $_asset"
	[ -x "$INSTALL_DIR/vst" ] || err "archive did not contain a 'vst' binary"
	say "if the vst daemon is already running, restart it to pick up the new version and adapters"
	"$INSTALL_DIR/vst" --version >/dev/null 2>&1 ||
		warn "$INSTALL_DIR/vst was installed but failed to run on this system"
}

install_gui_linux() {
	_asset="$APP_NAME-$ARCH-unknown-linux-gnu.AppImage"
	_appdir="${XDG_DATA_HOME:-$HOME/.local/share}/$APP_NAME"
	_app="$_appdir/$APP_NAME.AppImage"
	download_verified "$_asset" "$TMP/$_asset"
	mkdir -p "$_appdir" "$INSTALL_DIR"
	chmod 755 "$TMP/$_asset"
	mv -f "$TMP/$_asset" "$_app"
	ln -sf "$_app" "$INSTALL_DIR/$APP_NAME"
	say "installed $_app (launcher: $INSTALL_DIR/$APP_NAME)"

	# Menu entry + icon. Icon extraction is best-effort (needs no FUSE).
	_icon="$APP_NAME"
	if (cd "$TMP" && "$_app" --appimage-extract '*.png' >/dev/null 2>&1); then
		_png="$(find "$TMP/squashfs-root" -maxdepth 1 -name '*.png' 2>/dev/null | head -n1)"
		if [ -n "$_png" ]; then
			_icon="$_appdir/icon.png"
			cp "$_png" "$_icon"
		fi
	fi
	_apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
	mkdir -p "$_apps"
	cat >"$_apps/$APP_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=vibe-station
Comment=Orchestrate parallel AI coding agents
Exec="$_app" %U
Icon=$_icon
Terminal=false
Categories=Development;
EOF
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$_apps" >/dev/null 2>&1 || true
	say "wrote $_apps/$APP_NAME.desktop"

	# Type-2 AppImages need libfuse2 unless extracted; Ubuntu 22.04+ lacks it.
	if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; }; then
		warn "libfuse2 not found: the AppImage may not start. Install it (Ubuntu 24.04: 'sudo apt install libfuse2t64'), or run with APPIMAGE_EXTRACT_AND_RUN=1."
	fi
	say "prefer a system package? download $APP_NAME-$ARCH-unknown-linux-gnu.deb from the Releases page and run 'sudo apt install ./<file>.deb'"
}

cleanup() {
	[ -n "${TMP:-}" ] && rm -rf "$TMP"
}

# ── main ──────────────────────────────────────────────────────────────────────

main() {
	VERSION="${VST_VERSION:-latest}"
	INSTALL_DIR="${VST_INSTALL_DIR:-$HOME/.local/bin}"
	MODIFY_PATH=1
	[ "${VST_NO_MODIFY_PATH:-0}" = 1 ] && MODIFY_PATH=0
	DOWNLOAD_BASE="${VST_DOWNLOAD_BASE:-https://github.com/$REPO/releases}"
	API_BASE="${VST_API_BASE:-https://api.github.com/repos/$REPO}"

	while [ $# -gt 0 ]; do
		case "$1" in
			--version) [ $# -ge 2 ] || err "--version needs a value"; VERSION="$2"; shift ;;
			--version=*) VERSION="${1#*=}" ;;
			--install-dir) [ $# -ge 2 ] || err "--install-dir needs a value"; INSTALL_DIR="$2"; shift ;;
			--install-dir=*) INSTALL_DIR="${1#*=}" ;;
			--no-modify-path) MODIFY_PATH=0 ;;
			-h | --help) usage; exit 0 ;;
			*) err "unknown option: $1 (try --help)" ;;
		esac
		shift
	done
	[ -n "${HOME:-}" ] || err "\$HOME is not set"
	case "$VERSION" in latest | v*) ;; *) VERSION="v$VERSION" ;; esac

	need uname; need tar; need mkdir; need chmod
	pick_downloader
	detect_platform
	say "platform: $OS/$ARCH"

	TMP="$(mktemp -d 2>/dev/null || mktemp -d -t vst-install)"
	trap cleanup EXIT
	trap 'exit 1' INT TERM HUP

	resolve_version
	verify_manifest_sig
	install_cli
	if [ "$OS" = linux ]; then
		if is_musl; then
			warn "musl system detected (e.g. Alpine): the desktop AppImage needs glibc and was skipped. The CLI is installed."
		elif [ "$ARCH" != x86_64 ]; then
			warn "Desktop AppImage is currently only published for x86_64; skipping GUI install for $ARCH. The CLI is installed."
		else
			install_gui_linux
		fi
	elif [ "$OS" = darwin ]; then
		say "macOS GUI desktop app is not installed via curl (preserves Gatekeeper security)."
		say "Download the .dmg from https://github.com/$REPO/releases to install the desktop app manually."
	fi

	ENV_FILE=""
	if [ "$MODIFY_PATH" = 1 ]; then
		setup_path
	fi

	echo
	say "done."
	case ":$PATH:" in
		*":$INSTALL_DIR:"*) ;;
		*)
			if [ -n "$ENV_FILE" ]; then
				say "open a new terminal, or run this to use vst in the current one:"
				echo "    . \"$ENV_FILE\""
			else
				say "add $INSTALL_DIR to your PATH to use vst"
			fi
			;;
	esac
	say "vst includes the CLI and background daemon. Run 'vst --help' to get started."
}

main "$@"
