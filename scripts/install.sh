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
# Release assets consumed (GitHub Release of fastestdevalive/vibe-station):
#   vst-<triple>.tar.gz              + vst-<triple>.tar.gz.sha256
#   vibe-station-<triple>.AppImage   + .sha256          (glibc Linux only)
# where <triple> is:
#   x86_64-unknown-linux-musl / aarch64-unknown-linux-musl  (Linux CLI, static)
#   x86_64-apple-darwin / aarch64-apple-darwin              (macOS CLI)
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

say() { printf 'vst-install: %s\n' "$*"; }
warn() { printf 'vst-install: warning: %s\n' "$*" >&2; }
err() { printf 'vst-install: error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "required command '$1' not found"; }

usage() {
	sed -n '2,41p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
	echo "See https://github.com/$REPO for usage."
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

# download_verified <asset-name> <dest>
download_verified() {
	_url="$(asset_url "$1")"
	say "downloading $_url"
	fetch "$_url" "$2" || err "download failed: $_url"
	fetch "$_url.sha256" "$2.sha256" || err "checksum file missing: $_url.sha256 (refusing to install unverified binary)"
	_want="$(cut -d' ' -f1 <"$2.sha256" | tr -d '\r\n' | tr 'A-F' 'a-f')"
	_got="$(sha256_of "$2")"
	[ -n "$_want" ] && [ "$_want" = "$_got" ] || err "checksum mismatch for $1 (expected $_want, got $_got)"
	say "checksum ok ($_got)"
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
resolve_version() {
	[ "$VERSION" = latest ] || return 0
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
	_n=0
	# Accept either a flat archive or one wrapping directory (cargo-dist style).
	for _src in "$TMP/cli"/* "$TMP/cli"/*/*; do
		[ -f "$_src" ] && [ -x "$_src" ] || continue
		_name="$(basename "$_src")"
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
