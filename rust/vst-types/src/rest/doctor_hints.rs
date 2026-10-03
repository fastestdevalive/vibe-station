//! Shared install-hint table — the single source of truth for "how do I
//! install this" text, consumed by both `vst-cli` (`vst doctor`) and
//! `vst-daemon` (`GET /api/doctor`) so the two surfaces cannot drift.
//!
//! `cloudflared` strings below are
//! copied VERBATIM from `vst-cli/src/commands/doctor.rs`'s existing
//! `print_hint(...)` calls (lines ~317-347) — Phase 4 makes the CLI call
//! `hint_for` instead of inlining them, so wording cannot diverge.
//! `tmux`/`git`/`plugin-*` strings are AUTHORED HERE — `vst-cli`'s doctor
//! currently has no install-hint text at all for these five checks (its
//! `tmux`/`git`/4-CLI checks call `check(...)` with no `print_hint`), so
//! there is nothing to copy; this table is their first and only source.

/// Returns the install-hint command for `check_name` on `host_os`
/// (`"linux" | "macos" | "windows"`, i.e. `std::env::consts::OS`), or
/// `None` if this check has no install hint on that OS (e.g. `cloudflared`
/// when bundled, or a check with no install story).
pub fn hint_for(check_name: &str, host_os: &str) -> Option<&'static str> {
    match check_name {
        "cloudflared" => Some(
            "brew install cloudflared  OR  https://developers.cloudflare.com/cloudflared/",
        ),
        "tmux" => Some(match host_os {
            "macos" => "brew install tmux",
            "windows" => "tmux has no native Windows build — install it inside WSL (wsl --install, then apt install tmux)",
            _ => "apt install tmux  (or your distro's package manager, e.g. dnf install tmux / pacman -S tmux)",
        }),
        "git" => Some(match host_os {
            "macos" => "brew install git  (or xcode-select --install)",
            "windows" => "winget install --id Git.Git -e  (or install WSL and apt install git inside it)",
            _ => "apt install git  (or your distro's package manager, e.g. dnf install git / pacman -S git)",
        }),
        "plugin-claude" => Some(match host_os {
            "windows" => "curl -fsSL claude.ai/install.sh | sh  (run inside WSL — there is no native Windows installer)",
            _ => "curl -fsSL claude.ai/install.sh | sh",
        }),
        "plugin-cursor" => Some(match host_os {
            "windows" => "curl https://cursor.com/install -fsS | bash  (run inside WSL — there is no native Windows installer)",
            _ => "curl https://cursor.com/install -fsS | bash",
        }),
        "plugin-opencode" => Some(match host_os {
            "windows" => "curl -fsSL https://opencode.ai/install | bash  (run inside WSL — there is no native Windows installer)",
            _ => "curl -fsSL https://opencode.ai/install | bash",
        }),
        // `agy` has no standalone public install URL like claude/cursor/opencode —
        // point at the docs rather than a guessed URL.
        "plugin-agy" => Some("Install the agy CLI itself — see AGENTS.md or docs/RICH-CHAT-ACP.md"),
        "github-cli" => Some("https://cli.github.com"),
        "github-auth" => Some("gh auth login"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_check_returns_none() {
        assert_eq!(hint_for("nonexistent-check", "linux"), None);
    }
}
