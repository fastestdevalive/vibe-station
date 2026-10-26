#!/usr/bin/env bash
# Verify and unpack the data produced by macos-pack-unsigned.sh. Runs in the sign-macos job,
# from a FRESH checkout of the tagged commit; installs nothing and executes nothing it unpacks.
#
#   macos-unpack-unsigned.sh cli     <artifact-dir> <out-dir>   -> <out-dir>/{vst,claude-acp,codex-acp}
#   macos-unpack-unsigned.sh desktop <artifact-dir> <out-dir>   -> <out-dir>/app/<Name>.app, <out-dir>/unsigned.dmg
#
# Fails closed unless: the artifact holds exactly the expected regular files; MANIFEST.sha256
# lists exactly those with matching sha256 (transport integrity, NOT proof against a
# compromised build); and the tar holds exactly the expected members, with no absolute or ".."
# paths. Member TYPES are checked before extraction (regular files and directories only; the
# app may also hold symlinks, which after extraction must be relative and resolve inside the
# bundle; hardlinks, devices and fifos are refused). Extraction passes explicit safe flags
# (no owner, no stored permissions, no ACLs / xattrs / file flags / AppleDouble where the tar
# supports them) instead of relying on defaults, then masks group/other write. The hashes are
# printed so they appear in the job log next to the build job's.
set -euo pipefail
die() { echo "::error::macos-unpack-unsigned: $*" >&2; exit 1; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
[ $# -eq 3 ] || die "usage: $0 cli|desktop <artifact-dir> <out-dir>"
kind="$1"; in="$2"; out="$3"
[ -d "$in" ] && [ ! -L "$in" ] || die "$in is not a directory"
case "$kind" in
  cli) files="unsigned-cli.tar" ;;
  desktop) files="unsigned-app.tar unsigned.dmg" ;;
  *) die "usage: $0 cli|desktop <artifact-dir> <out-dir>" ;;
esac

# exactly the expected regular files
want="$(printf '%s\n' MANIFEST.sha256 $files | sort)"
have="$(cd "$in" && find . -mindepth 1 | sed 's|^\./||' | sort)"
[ "$want" = "$have" ] || die "unexpected artifact contents. expected: $(echo $want) found: $(echo $have)"
for f in MANIFEST.sha256 $files; do [ -f "$in/$f" ] && [ ! -L "$in/$f" ] || die "$f is not a regular file"; done

# manifest: exactly one "<64 hex>  <name>" line per file, hashes match
[ "$(wc -l <"$in/MANIFEST.sha256" | tr -d ' ')" = "$(echo $files | wc -w | tr -d ' ')" ] || die "MANIFEST.sha256 has the wrong number of lines"
for f in $files; do
  line="$(grep -E "^[0-9a-f]{64}  $f\$" "$in/MANIFEST.sha256" || true)"
  [ -n "$line" ] && [ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" = 1 ] || die "MANIFEST.sha256 has no single entry for $f"
  [ "${line%% *}" = "$(sha256_of "$in/$f")" ] || die "sha256 mismatch for $f"
  echo "verified $f ${line%% *}"
done

mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || die "$out is not empty"

# no member may be absolute or contain a ".." component
safe_members() { # <tar>
  local t="$1" m
  tar -tf "$t" >/dev/null || die "cannot list $t"
  while IFS= read -r m; do
    case "$m" in /*|..|../*|*/..|*/../*) die "unsafe path in $t: $m" ;; esac
  done < <(tar -tf "$t")
}

# every member is a regular file or directory (or, for the app, a symlink checked after extraction)
member_types() { # <tar> <allowed type chars, e.g. -d or -dl>
  local t="$1" ok="$2" line c
  while IFS= read -r line; do
    c="${line%"${line#?}"}"
    case "$ok" in *"$c"*) ;; *) die "$t holds a member of type '$c' (allowed: $ok): $line" ;; esac
  done < <(tar -tvf "$t")
}

# explicit extraction flags. The first two are mandatory; the rest are used where this tar knows them.
EXTRACT_FLAGS=(-o --no-same-owner --no-same-permissions)
probe="$(mktemp -d)"; trap 'rm -rf "$probe"' EXIT
: >"$probe/e"; tar -cf "$probe/p.tar" -C "$probe" e
for fl in --no-same-owner --no-same-permissions; do
  tar -xf "$probe/p.tar" -C "$probe" "$fl" 2>/dev/null || die "this tar does not support $fl"
done
for fl in --no-acls --no-xattrs --no-fflags --no-mac-metadata; do
  if tar -xf "$probe/p.tar" -C "$probe" "$fl" 2>/dev/null; then EXTRACT_FLAGS+=("$fl"); fi
done
extract() { ( umask 022; tar -x "${EXTRACT_FLAGS[@]}" -f "$1" -C "$2" ); }

# link_inside <bundle-root> <symlink>: relative target whose lexical resolution stays in the bundle
link_inside() {
  local root="$1" l="$2" tgt rel d depth=0 c
  local -a comps
  tgt="$(readlink "$l")"
  case "$tgt" in /* | '') return 1 ;; esac
  rel="${l#"$root"/}"; d="$(dirname "$rel")"
  [ "$d" = . ] && d=""
  IFS=/ read -r -a comps <<<"$d/$tgt"
  for c in "${comps[@]}"; do
    case "$c" in '' | .) ;; ..) depth=$((depth - 1)); [ "$depth" -ge 0 ] || return 1 ;; *) depth=$((depth + 1)) ;; esac
  done
  return 0
}

case "$kind" in
  cli)
    safe_members "$in/unsigned-cli.tar"
    members="$(tar -tf "$in/unsigned-cli.tar" | sort)"
    [ "$members" = "$(printf '%s\n' claude-acp codex-acp vst)" ] || die "unexpected members in unsigned-cli.tar: $(echo $members)"
    member_types "$in/unsigned-cli.tar" -
    extract "$in/unsigned-cli.tar" "$out"
    for b in vst claude-acp codex-acp; do
      [ -f "$out/$b" ] && [ ! -L "$out/$b" ] || die "$b is not a regular file"
      chmod 755 "$out/$b"
    done
    ;;
  desktop)
    safe_members "$in/unsigned-app.tar"
    tops="$(tar -tf "$in/unsigned-app.tar" | cut -d/ -f1 | sort -u)"
    [ "$(printf '%s\n' "$tops" | wc -l | tr -d ' ')" = 1 ] && printf '%s' "$tops" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9 ._-]*\.app$' \
      || die "unsigned-app.tar must hold exactly one top-level <Name>.app (found: $(echo $tops))"
    member_types "$in/unsigned-app.tar" -dl
    mkdir "$out/app"
    extract "$in/unsigned-app.tar" "$out/app"
    bad() { rm -rf "$out/app"; die "$*"; }
    [ -d "$out/app/$tops/Contents" ] && [ ! -L "$out/app/$tops" ] && [ ! -L "$out/app/$tops/Contents" ] || bad "$tops has no real Contents/ directory"
    [ -z "$(find "$out/app" ! -type f ! -type d ! -type l -print -quit)" ] || bad "non-regular entry in the app"
    [ -z "$(find "$out/app" -type f -links +1 -print -quit)" ] || bad "hardlinked file in the app"
    while IFS= read -r -d '' l; do
      link_inside "$out/app/$tops" "$l" || bad "symlink leaves the bundle or is absolute: ${l#"$out/app/"} -> $(readlink "$l")"
    done < <(find "$out/app" -type l -print0)
    chmod -R go-w,a-s "$out/app"
    cp "$in/unsigned.dmg" "$out/unsigned.dmg"
    ;;
esac
echo "unpacked $kind into $out"
