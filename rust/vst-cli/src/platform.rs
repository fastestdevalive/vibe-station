//! Platform detection for CLI self-healing (`cli-daemon-unification` Part 03):
//! is a display present (R11)? Is stdin a real TTY?

use std::io::IsTerminal;

/// Is a GUI display present? Platform-specific per R11 — a bare macOS
/// Terminal session has neither `$DISPLAY` nor `$WAYLAND_DISPLAY` set even
/// though it's a perfectly normal GUI-capable session, so the Linux
/// env-var check would misclassify every local Mac session as headless.
pub fn has_display() -> bool {
    has_display_for(cfg!(target_os = "macos"), &EnvReader)
}

/// Is stdin a real TTY? Distinguishes a human sitting at a headless Linux
/// terminal (who needs the continue-flow login URL *printed*, since there's
/// no local browser to open it into) from an agent/CI/piped invocation (who
/// needs no URL at all — nobody's there to read it). Not the same question
/// `has_display()` answers: a headless SSH session can be fully interactive
/// (a human typing at a real terminal) while having no GUI display at all.
pub fn is_interactive() -> bool {
    std::io::stdin().is_terminal()
}

/// Minimal env-var reader, abstracted so `has_display_for` is unit-testable
/// without mutating the real process environment (which would race with
/// other tests running in the same binary).
pub trait EnvLookup {
    fn get(&self, key: &str) -> Option<String>;
}

pub struct EnvReader;
impl EnvLookup for EnvReader {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// Testable core of `has_display()`. `is_macos` and `env` are injected so
/// tests can exercise both platform branches regardless of the OS actually
/// running the test.
pub fn has_display_for(is_macos: bool, env: &dyn EnvLookup) -> bool {
    if is_macos {
        env.get("SSH_CONNECTION").is_none() && env.get("SSH_TTY").is_none()
    } else {
        env.get("DISPLAY").is_some() || env.get("WAYLAND_DISPLAY").is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeEnv(HashMap<&'static str, &'static str>);
    impl EnvLookup for FakeEnv {
        fn get(&self, key: &str) -> Option<String> {
            self.0.get(key).map(|v| v.to_string())
        }
    }

    #[test]
    fn linux_display_set_is_true() {
        let env = FakeEnv(HashMap::from([("DISPLAY", ":0")]));
        assert!(has_display_for(false, &env));
    }

    #[test]
    fn linux_wayland_display_set_is_true() {
        let env = FakeEnv(HashMap::from([("WAYLAND_DISPLAY", "wayland-0")]));
        assert!(has_display_for(false, &env));
    }

    #[test]
    fn linux_no_display_is_false() {
        let env = FakeEnv(HashMap::new());
        assert!(!has_display_for(false, &env));
    }

    #[test]
    fn macos_default_is_true() {
        let env = FakeEnv(HashMap::new());
        assert!(has_display_for(true, &env));
    }

    #[test]
    fn macos_ssh_connection_is_false() {
        let env = FakeEnv(HashMap::from([("SSH_CONNECTION", "1.2.3.4 22 5.6.7.8 22")]));
        assert!(!has_display_for(true, &env));
    }

    #[test]
    fn macos_ssh_tty_is_false() {
        let env = FakeEnv(HashMap::from([("SSH_TTY", "/dev/ttys000")]));
        assert!(!has_display_for(true, &env));
    }
}
