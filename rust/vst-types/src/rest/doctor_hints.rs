//! The single owner of every doctor / onboarding corrective-hint string.
//!
//! One `HintSpec` per check name: a one-line *why*, per-OS copyable commands,
//! an optional docs link, and an optional in-app action. Three consumers read
//! it, so they cannot drift:
//!
//! - the daemon (`GET /api/doctor`) via [`hint_dto`] → `DoctorCheckDto.hint`
//! - `vst doctor` (CLI) and the legacy `installHint` via [`hint_for`]
//! - onboarding step 2 via [`classify_spawn_error`] + [`enoexec_hint`]
//!
//! The web UI never hard-codes hint text. Windows commands are copied verbatim
//! from the pre-table strings (they point at WSL / winget).
//!
//! Vendor commands (codex, pi, tailscale, gh apt repo, `brew install gh`) were
//! authored for this table and need a pass against each vendor's docs before a
//! release — see the ui-polish plan, Risk 3.

use super::doctor::{DoctorAction, DoctorHintDto, HintCommandDto, HintOs};

/// Static description of how to fix one failing check.
#[derive(Debug)]
pub struct HintSpec {
    /// One line: what this check is for / why it matters.
    pub why: &'static str,
    /// Per-OS commands. `HintOs::Any` applies on every OS without a specific entry.
    pub commands: &'static [(HintOs, &'static str)],
    pub docs_url: Option<&'static str>,
    pub action: Option<DoctorAction>,
    /// Plain text `hint_for` returns when no command matches the OS (used where
    /// the only legacy hint was a docs pointer, not a command).
    pub fallback_text: Option<&'static str>,
}

const TMUX_WINDOWS: &str = "tmux has no native Windows build — install it inside WSL (wsl --install, then apt install tmux)";
const GIT_WINDOWS: &str =
    "winget install --id Git.Git -e  (or install WSL and apt install git inside it)";
const CLAUDE_ANY: &str = "curl -fsSL claude.ai/install.sh | sh";
const CLAUDE_WINDOWS: &str =
    "curl -fsSL claude.ai/install.sh | sh  (run inside WSL — there is no native Windows installer)";
const CURSOR_ANY: &str = "curl https://cursor.com/install -fsS | bash";
const CURSOR_WINDOWS: &str = "curl https://cursor.com/install -fsS | bash  (run inside WSL — there is no native Windows installer)";
const OPENCODE_ANY: &str = "curl -fsSL https://opencode.ai/install | bash";
const OPENCODE_WINDOWS: &str = "curl -fsSL https://opencode.ai/install | bash  (run inside WSL — there is no native Windows installer)";

/// GitHub's official apt repo for `gh` (the distro package is often older than 2.40).
const GH_LINUX_APT: &str = "sudo mkdir -p -m 755 /etc/apt/keyrings \\\n&& wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \\\n | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \\\n&& echo \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" \\\n | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \\\n&& sudo apt update && sudo apt install gh -y";

const AGY_TEXT: &str = "Install the agy CLI itself — see AGENTS.md or docs/RICH-CHAT-ACP.md";

static TMUX: HintSpec = HintSpec {
    why: "Required. Every agent runs inside a tmux session.",
    commands: &[
        (HintOs::Macos, "brew install tmux"),
        (HintOs::Linux, "sudo apt install tmux"),
        (HintOs::Windows, TMUX_WINDOWS),
    ],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static GIT: HintSpec = HintSpec {
    why: "Required. Worktrees, branches and diffs need git.",
    commands: &[
        (HintOs::Macos, "brew install git"),
        (HintOs::Linux, "sudo apt install git"),
        (HintOs::Windows, GIT_WINDOWS),
    ],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static DAEMON: HintSpec = HintSpec {
    why: "The app can't reach its background service.",
    commands: &[(HintOs::Any, "vst daemon run")],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static PLUGIN_CLAUDE: HintSpec = HintSpec {
    why: "Agent CLI. Install to run Claude Code agents.",
    commands: &[(HintOs::Any, CLAUDE_ANY), (HintOs::Windows, CLAUDE_WINDOWS)],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static PLUGIN_CURSOR: HintSpec = HintSpec {
    why: "Optional agent CLI for Cursor agents.",
    commands: &[(HintOs::Any, CURSOR_ANY), (HintOs::Windows, CURSOR_WINDOWS)],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static PLUGIN_OPENCODE: HintSpec = HintSpec {
    why: "Optional agent CLI for opencode agents.",
    commands: &[
        (HintOs::Any, OPENCODE_ANY),
        (HintOs::Windows, OPENCODE_WINDOWS),
    ],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static PLUGIN_AGY: HintSpec = HintSpec {
    why: "Optional agent CLI. No public installer — see AGENTS.md or docs/RICH-CHAT-ACP.md.",
    commands: &[],
    docs_url: None,
    action: None,
    fallback_text: Some(AGY_TEXT),
};
static PLUGIN_CODEX: HintSpec = HintSpec {
    why: "Optional agent CLI. Needs Node 18+.",
    commands: &[(HintOs::Any, "npm install -g @openai/codex")],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static CODEX_ACP: HintSpec = HintSpec {
    why: "Codex is installed but its Rich Chat adapter is missing, so Codex runs in Terminal only.",
    commands: &[(
        HintOs::Any,
        "export VST_CODEX_ACP_ENTRY=/path/to/codex-acp/dist/index.js",
    )],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static PLUGIN_PI: HintSpec = HintSpec {
    why: "Optional agent CLI. Needs Node 18+.",
    commands: &[(HintOs::Any, "npm install -g @mariozechner/pi-coding-agent")],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static PLUGIN_OMP: HintSpec = HintSpec {
    why: "Optional agent CLI (oh-my-pi). Rich Chat uses its built-in ACP server.",
    commands: &[
        (HintOs::Macos, "brew install can1357/tap/omp"),
        (HintOs::Linux, "curl -fsSL https://omp.sh/install | sh"),
        (HintOs::Any, "bun install -g @oh-my-pi/pi-coding-agent"),
    ],
    docs_url: Some("https://github.com/can1357/oh-my-pi"),
    action: None,
    fallback_text: None,
};
static OMP_BUN: HintSpec = HintSpec {
    why: "The installed `omp` is a bun script, but `bun` is not on the daemon PATH, so omp sessions will fail to start.",
    commands: &[
        (HintOs::Macos, "brew install oven-sh/bun/bun"),
        (HintOs::Any, "curl -fsSL https://bun.sh/install | bash"),
    ],
    docs_url: Some("https://bun.sh/docs/installation"),
    action: None,
    fallback_text: None,
};
static CLOUDFLARED: HintSpec = HintSpec {
    why: "Optional. Public share links use a Cloudflare tunnel.",
    commands: &[(HintOs::Macos, "brew install cloudflared")],
    docs_url: Some("https://developers.cloudflare.com/cloudflared/"),
    action: None,
    fallback_text: None,
};
static TAILSCALE: HintSpec = HintSpec {
    why: "Optional. Reach vibe-station from your phone over your tailnet.",
    commands: &[
        (HintOs::Macos, "brew install --cask tailscale"),
        (
            HintOs::Linux,
            "curl -fsSL https://tailscale.com/install.sh | sh",
        ),
    ],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static GITHUB_CLI: HintSpec = HintSpec {
    why: "Finds PRs for the dashboard. Distro gh is often older than 2.40.",
    commands: &[
        (HintOs::Macos, "brew install gh"),
        (HintOs::Linux, GH_LINUX_APT),
    ],
    docs_url: Some("https://github.com/cli/cli/blob/trunk/docs/install_linux.md"),
    action: None,
    fallback_text: Some("https://cli.github.com"),
};
static GITHUB_AUTH: HintSpec = HintSpec {
    why: "Sign in once so PR status can be read.",
    commands: &[(HintOs::Any, "gh auth login")],
    docs_url: None,
    action: None,
    fallback_text: None,
};
static ORPHAN_SESSIONS: HintSpec = HintSpec {
    why: "tmux sessions left behind by agents vibe-station no longer tracks.",
    commands: &[],
    docs_url: None,
    action: Some(DoctorAction::Kill),
    fallback_text: None,
};
static ORPHAN_WORKTREES: HintSpec = HintSpec {
    why: "Listed worktrees whose folders were deleted outside vibe-station. Forget removes list entries only.",
    commands: &[],
    docs_url: None,
    action: Some(DoctorAction::Forget),
    fallback_text: None,
};

/// The hint spec for a doctor check name, if it has one.
pub fn hint_spec(check_name: &str) -> Option<&'static HintSpec> {
    Some(match check_name {
        "tmux" => &TMUX,
        "git" => &GIT,
        "daemon-reachable" => &DAEMON,
        "plugin-claude" => &PLUGIN_CLAUDE,
        "plugin-cursor" => &PLUGIN_CURSOR,
        "plugin-opencode" => &PLUGIN_OPENCODE,
        "plugin-agy" => &PLUGIN_AGY,
        "plugin-codex" => &PLUGIN_CODEX,
        "codex-acp" => &CODEX_ACP,
        "plugin-pi" => &PLUGIN_PI,
        "plugin-omp" => &PLUGIN_OMP,
        "omp-bun" => &OMP_BUN,
        "cloudflared" => &CLOUDFLARED,
        "tailscale" => &TAILSCALE,
        "github-cli" => &GITHUB_CLI,
        "github-auth" => &GITHUB_AUTH,
        "orphan-sessions" => &ORPHAN_SESSIONS,
        "orphan-worktrees" => &ORPHAN_WORKTREES,
        _ => return None,
    })
}

fn os_tag(host_os: &str) -> HintOs {
    match host_os {
        "macos" => HintOs::Macos,
        "linux" => HintOs::Linux,
        "windows" => HintOs::Windows,
        _ => HintOs::Any,
    }
}

fn command_for(spec: &HintSpec, host_os: &str) -> Option<&'static str> {
    let want = os_tag(host_os);
    spec.commands
        .iter()
        .find(|(os, _)| *os == want)
        .or_else(|| spec.commands.iter().find(|(os, _)| *os == HintOs::Any))
        .map(|(_, c)| *c)
}

/// The structured hint for `check_name`, ready for the wire.
pub fn hint_dto(check_name: &str) -> Option<DoctorHintDto> {
    let spec = hint_spec(check_name)?;
    Some(DoctorHintDto {
        title: None,
        why: spec.why.to_string(),
        commands: spec
            .commands
            .iter()
            .map(|(os, c)| HintCommandDto {
                os: *os,
                command: (*c).to_string(),
            })
            .collect(),
        docs_url: spec.docs_url.map(str::to_string),
        action: spec.action,
    })
}

/// Returns the install-hint command for `check_name` on `host_os`
/// (`"linux" | "macos" | "windows"`, i.e. `std::env::consts::OS`), or `None`
/// if this check has no hint on that OS. Reads the same table as [`hint_dto`].
pub fn hint_for(check_name: &str, host_os: &str) -> Option<&'static str> {
    let spec = hint_spec(check_name)?;
    command_for(spec, host_os).or(spec.fallback_text)
}

// ── Spawn-failure classification (onboarding step 2) ────────────────────────

/// What kind of OS-level spawn failure an adapter error describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnFailureKind {
    /// `ENOEXEC` / "Exec format error": the OS found the file but won't run it.
    Enoexec,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnFailure {
    pub kind: SpawnFailureKind,
    /// The program name from `posix_spawn '<program>'`, when present.
    pub program: Option<String>,
}

/// Recognise an `ENOEXEC` spawn failure in a raw adapter error string and pull
/// out the program name. Tolerant on purpose: wording differs per platform and
/// adapter, and an unrecognised error simply yields `None` (the UI then keeps
/// showing the raw message).
pub fn classify_spawn_error(raw: &str) -> Option<SpawnFailure> {
    let hit =
        raw.contains("ENOEXEC") || raw.contains("Exec format error") || raw.contains("os error 8");
    if !hit {
        return None;
    }
    let program = raw.find("posix_spawn '").and_then(|i| {
        let rest = &raw[i + "posix_spawn '".len()..];
        let end = rest.find('\'')?;
        let p = &rest[..end];
        (!p.is_empty()).then(|| p.to_string())
    });
    Some(SpawnFailure {
        kind: SpawnFailureKind::Enoexec,
        program,
    })
}

/// The corrective hint for an ENOEXEC failure of `program`, optionally with the
/// path it resolved to on PATH. With no path the inspect command keeps a
/// `<path>` placeholder.
pub fn enoexec_hint(program: &str, resolved_path: Option<&str>) -> DoctorHintDto {
    let path = resolved_path.unwrap_or("<path>");
    let why = match resolved_path {
        Some(p) => format!(
            "Found at {p}, but the OS won't run it: usually a script missing its #! line, or a build for another CPU."
        ),
        None => format!(
            "The OS won't run {program}: usually a script missing its #! line, or a build for another CPU."
        ),
    };
    let mut commands = Vec::new();
    if let Some(reinstall) = hint_spec(&format!("plugin-{program}"))
        .and_then(|s| s.commands.iter().find(|(os, _)| *os == HintOs::Any))
    {
        commands.push(HintCommandDto {
            os: HintOs::Any,
            command: reinstall.1.to_string(),
        });
    }
    commands.push(HintCommandDto {
        os: HintOs::Any,
        command: format!("head -c 64 {path}; file -L {path}"),
    });
    DoctorHintDto {
        title: Some(format!("The system refused to run {program} (ENOEXEC)")),
        why,
        commands,
        docs_url: None,
        action: Some(DoctorAction::Retry),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: &[&str] = &[
        "tmux",
        "git",
        "daemon-reachable",
        "plugin-claude",
        "plugin-cursor",
        "plugin-opencode",
        "plugin-agy",
        "plugin-codex",
        "codex-acp",
        "plugin-pi",
        "plugin-omp",
        "omp-bun",
        "cloudflared",
        "tailscale",
        "github-cli",
        "github-auth",
        "orphan-sessions",
        "orphan-worktrees",
    ];

    #[test]
    fn every_check_has_a_spec_with_a_why() {
        for name in ALL {
            let spec = hint_spec(name).unwrap_or_else(|| panic!("no spec for {name}"));
            assert!(!spec.why.is_empty(), "{name} has an empty why");
            assert!(hint_dto(name).is_some());
        }
    }

    #[test]
    fn omp_hints_offer_an_install_command_per_os() {
        assert_eq!(
            hint_for("plugin-omp", "macos"),
            Some("brew install can1357/tap/omp")
        );
        assert_eq!(
            hint_for("plugin-omp", "linux"),
            Some("curl -fsSL https://omp.sh/install | sh")
        );
        assert_eq!(
            hint_for("plugin-omp", "windows"),
            Some("bun install -g @oh-my-pi/pi-coding-agent")
        );
        assert!(hint_for("omp-bun", "linux").is_some_and(|c| c.contains("bun.sh/install")));
    }

    #[test]
    fn unknown_check_returns_none() {
        assert_eq!(hint_for("nonexistent-check", "linux"), None);
        assert!(hint_spec("nonexistent-check").is_none());
    }

    #[test]
    fn windows_and_claude_strings_match_the_pre_table_text() {
        assert_eq!(hint_for("tmux", "windows"), Some(TMUX_WINDOWS));
        assert_eq!(
            hint_for("tmux", "windows"),
            Some("tmux has no native Windows build — install it inside WSL (wsl --install, then apt install tmux)")
        );
        assert_eq!(
            hint_for("git", "windows"),
            Some("winget install --id Git.Git -e  (or install WSL and apt install git inside it)")
        );
        assert_eq!(
            hint_for("plugin-claude", "linux"),
            Some("curl -fsSL claude.ai/install.sh | sh")
        );
        assert_eq!(
            hint_for("plugin-claude", "windows"),
            Some("curl -fsSL claude.ai/install.sh | sh  (run inside WSL — there is no native Windows installer)")
        );
        assert_eq!(
            hint_for("plugin-cursor", "macos"),
            Some("curl https://cursor.com/install -fsS | bash")
        );
        assert_eq!(
            hint_for("plugin-opencode", "linux"),
            Some("curl -fsSL https://opencode.ai/install | bash")
        );
        assert_eq!(hint_for("github-auth", "linux"), Some("gh auth login"));
        assert_eq!(
            hint_for("plugin-agy", "linux"),
            Some("Install the agy CLI itself — see AGENTS.md or docs/RICH-CHAT-ACP.md")
        );
    }

    #[test]
    fn table_wins_on_unix() {
        assert_eq!(hint_for("tmux", "linux"), Some("sudo apt install tmux"));
        assert_eq!(hint_for("tmux", "macos"), Some("brew install tmux"));
        assert_eq!(hint_for("git", "linux"), Some("sudo apt install git"));
        assert_eq!(hint_for("github-cli", "macos"), Some("brew install gh"));
        assert!(hint_for("github-cli", "linux")
            .unwrap()
            .starts_with("sudo mkdir -p -m 755 /etc/apt/keyrings"));
        assert_eq!(
            hint_for("cloudflared", "macos"),
            Some("brew install cloudflared")
        );
        assert_eq!(hint_for("cloudflared", "linux"), None);
        assert_eq!(
            hint_dto("cloudflared").unwrap().docs_url.as_deref(),
            Some("https://developers.cloudflare.com/cloudflared/")
        );
    }

    #[test]
    fn orphan_checks_carry_actions() {
        assert_eq!(
            hint_dto("orphan-sessions").unwrap().action,
            Some(DoctorAction::Kill)
        );
        assert_eq!(
            hint_dto("orphan-worktrees").unwrap().action,
            Some(DoctorAction::Forget)
        );
    }

    #[test]
    fn classifies_the_real_enoexec_string() {
        let raw = r#"claude: ACP request failed: Internal error: { "details": "ENOEXEC: unknown error, posix_spawn 'claude'" }"#;
        assert_eq!(
            classify_spawn_error(raw),
            Some(SpawnFailure {
                kind: SpawnFailureKind::Enoexec,
                program: Some("claude".into())
            })
        );
        assert_eq!(
            classify_spawn_error("Exec format error (os error 8)"),
            Some(SpawnFailure {
                kind: SpawnFailureKind::Enoexec,
                program: None
            })
        );
        assert_eq!(classify_spawn_error("ENOENT: no such file"), None);
    }

    #[test]
    fn enoexec_hint_carries_reinstall_and_inspect_commands() {
        let h = enoexec_hint("claude", Some("/usr/local/bin/claude"));
        assert_eq!(
            h.title.as_deref(),
            Some("The system refused to run claude (ENOEXEC)")
        );
        assert!(h.why.contains("Found at /usr/local/bin/claude"));
        assert!(h.commands.iter().any(
            |c| c.command == "head -c 64 /usr/local/bin/claude; file -L /usr/local/bin/claude"
        ));
        assert!(h
            .commands
            .iter()
            .any(|c| c.command == "curl -fsSL claude.ai/install.sh | sh"));
        assert_eq!(h.action, Some(DoctorAction::Retry));

        let no_path = enoexec_hint("claude", None);
        assert!(no_path
            .commands
            .iter()
            .any(|c| c.command.contains("<path>")));
    }
}
