use std::env;

/// Read `VST_PROJECT` environment variable.
pub fn get_vst_project() -> Option<String> {
    env::var("VST_PROJECT").ok()
}

/// Read `VST_WORKTREE` environment variable.
pub fn get_vst_worktree() -> Option<String> {
    env::var("VST_WORKTREE").ok()
}

/// Read `VST_SESSION` environment variable.
pub fn get_vst_session() -> Option<String> {
    env::var("VST_SESSION").ok()
}

/// Read `VST_DAEMON_URL` environment variable.
pub fn get_vst_daemon_url() -> Option<String> {
    env::var("VST_DAEMON_URL").ok()
}
