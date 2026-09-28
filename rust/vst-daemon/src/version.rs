#![forbid(unsafe_code)]

//! Single source of truth for the daemon/CLI version string.
//!
//! `VST_VERSION` is set at *build* time (via `option_env!`, not `std::env::var`)
//! by release CI from the git tag — see `scripts/install.sh`/the release
//! workflow. A local `cargo build` with no override falls back to
//! `CARGO_PKG_VERSION` (the workspace's static `0.1.0`), same as before this
//! module existed.

/// Returns the effective version string for this build.
pub fn current() -> &'static str {
    option_env!("VST_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_cargo_pkg_version_when_unset() {
        // VST_VERSION is not set in the test build environment, so this
        // exercises the fallback branch.
        assert_eq!(current(), env!("CARGO_PKG_VERSION"));
    }
}
