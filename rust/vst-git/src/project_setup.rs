//! Ports `projectSetup.ts` — runs the bundled `project-setup.sh` script to make
//! a project directory git-ready.
//!
//! The TS `projectSetup.ts` shells out to `daemon/src/assets/project-setup.sh`.
//! That asset is part-08 scope and isn't shipped with the Rust binary, so this
//! crate embeds the script content and materialises it to a temp file at
//! runtime before invoking `bash`. On `bash` being unavailable it falls back to
//! the minimal `git init` + `.gitignore` pair, exactly like the TS.

use std::io::Write;

use crate::git::{create_gitignore, git_init, GitError};

/// Embedded `project-setup.sh` — makes `dir` git-ready: `git init` (if needed),
/// a type-aware `.gitignore`, and an initial commit establishing `main`. This
/// is the byte content of `daemon/src/assets/project-setup.sh`.
const PROJECT_SETUP_SH: &str = r#"#!/usr/bin/env bash
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

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git config user.email >/dev/null 2>&1 || git config user.email "agent@vibe-station.local"
  git config user.name  >/dev/null 2>&1 || git config user.name  "vibe-station"
  git add -A
  git commit -q --allow-empty -m "Initial commit"
  git branch -M main
fi
"#;

/// Make `dir` git-ready via the embedded `project-setup.sh`. Falls back to the
/// simpler `git init` + `create_gitignore` pair if `bash` isn't available.
pub async fn run_project_setup(dir: &str) -> Result<(), GitError> {
    match run_bash_script(dir).await {
        Ok(()) => Ok(()),
        Err(e) if is_bash_missing(&e) => {
            // bash not available — fall back to the minimal existing behavior.
            git_init(dir).await?;
            create_gitignore(dir).await?;
            Ok(())
        }
        Err(e) => Err(GitError::Command {
            args: "project-setup.sh".to_string(),
            stderr: e.to_string(),
        }),
    }
}

async fn run_bash_script(dir: &str) -> Result<(), std::io::Error> {
    let script_dir = std::env::temp_dir().join(format!("vst-project-setup-{}", std::process::id()));
    std::fs::create_dir_all(&script_dir)?;
    let script_path = script_dir.join("project-setup.sh");
    let mut f = std::fs::File::create(&script_path)?;
    f.write_all(PROJECT_SETUP_SH.as_bytes())?;
    f.flush()?;

    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg(&script_path).arg(dir);
    let out = cmd.output().await?;
    let _ = std::fs::remove_dir_all(&script_dir);
    if !out.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "project-setup failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ));
    }
    Ok(())
}

fn is_bash_missing(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
}
