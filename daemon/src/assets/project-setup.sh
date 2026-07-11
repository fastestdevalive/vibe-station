#!/usr/bin/env bash
set -euo pipefail
dir="$1"; cd "$dir"
[ -d .git ] || git init -q

gitignore() { # $1 = section
  case "$1" in
  os) cat <<'EOF'
# OS / editors / IDEs
.DS_Store
Thumbs.db
.idea/
.vscode/
.fleet/
*.iml
*.swp
EOF
  ;;
  node) cat <<'EOF'

# Node / JS / TS
node_modules/
dist/
build/
coverage/
.next/
.turbo/
.cache/
*.log
.env
.env.*
!.env.example
EOF
  ;;
  gradle) cat <<'EOF'

# Gradle / JVM / Android / KMP
.gradle/
build/
local.properties
!gradle/wrapper/gradle-wrapper.jar
*.apk
*.aab
*.dex
captures/
.cxx/
.kotlin/
kotlin-js-store/
xcuserdata/
DerivedData/
EOF
  ;;
  python) cat <<'EOF'

# Python
__pycache__/
*.py[cod]
.venv/
venv/
*.egg-info/
.pytest_cache/
EOF
  ;;
  rust) printf '\n# Rust\ntarget/\n' ;;
  go)   printf '\n# Go\nbin/\n*.exe\n' ;;
  esac
}

# True if ANY of the given marker files exists. Using per-file `[ -e ]` instead
# of `ls a b c` is deliberate: `ls` with multiple operands exits non-zero when
# *any* operand is missing, so `ls package.json pnpm-lock.yaml yarn.lock` is
# false for a project that has only package.json — the detection almost never
# fired and every project fell through to the generic node+gradle dump.
have() { for f in "$@"; do [ -e "$f" ] && return 0; done; return 1; }

if [ ! -f .gitignore ]; then
  { gitignore os
    det=0
    if have package.json pnpm-lock.yaml yarn.lock; then gitignore node; det=1; fi
    if have build.gradle build.gradle.kts settings.gradle settings.gradle.kts || [ -d gradle ]; then gitignore gradle; det=1; fi
    if have pyproject.toml requirements.txt setup.py; then gitignore python; det=1; fi
    [ -f Cargo.toml ] && { gitignore rust; det=1; }
    [ -f go.mod ] && { gitignore go; det=1; }
    if [ "$det" -eq 0 ]; then gitignore node; gitignore gradle; fi
  } > .gitignore
fi

# Establish `main` with an initial commit so worktrees can branch off it and
# actually contain the code. The HEAD guard makes this a no-op for any repo that
# already has commits — so an existing `master` repo is never renamed. `git add
# -A` stages everything the (just-written) .gitignore permits: for a brand-new
# empty dir that's just .gitignore; for an add-existing dir it commits the user's
# files so a worktree created off `main` isn't code-less. --allow-empty keeps an
# empty dir working (main still gets created).
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git config user.email >/dev/null 2>&1 || git config user.email "agent@vibe-station.local"
  git config user.name  >/dev/null 2>&1 || git config user.name  "vibe-station"
  git add -A
  git commit -q --allow-empty -m "Initial commit"
  git branch -M main
fi
