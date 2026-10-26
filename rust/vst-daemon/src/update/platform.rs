//! Platform key → asset-name mapping; must match what release.yml uploads.

/// The platform key for the running machine, used to look up assets.
pub fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("macos", "aarch64") => "macos-aarch64",
        _ => "other",
    }
}

/// The asset names for a platform key.
pub struct PlatformAssets {
    pub cli: Option<&'static str>,
    pub appimage: Option<&'static str>,
    pub deb: Option<&'static str>,
    pub dmg: Option<&'static str>,
}

/// Map a platform key to the asset names that platform can install
/// (must match what release.yml uploads). `None` for every field ⇒ `noAsset=true`
/// (the UI then offers only "View release").
pub fn assets_for(key: &str) -> PlatformAssets {
    match key {
        "linux-x86_64" => PlatformAssets {
            cli: Some("vst-x86_64-unknown-linux-musl.tar.gz"),
            appimage: Some("vibe-station-x86_64-unknown-linux-gnu.AppImage"),
            deb: Some("vibe-station-x86_64-unknown-linux-gnu.deb"),
            dmg: None,
        },
        "linux-aarch64" => PlatformAssets {
            cli: Some("vst-aarch64-unknown-linux-musl.tar.gz"),
            appimage: None,
            deb: None,
            dmg: None,
        },
        "macos-aarch64" => PlatformAssets {
            cli: Some("vst-aarch64-apple-darwin.tar.gz"),
            appimage: None,
            deb: None,
            dmg: Some("vibe-station-aarch64-apple-darwin.dmg"),
        },
        _ => PlatformAssets {
            cli: None,
            appimage: None,
            deb: None,
            dmg: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_x86_64_has_cli_appimage_deb() {
        let a = assets_for("linux-x86_64");
        assert_eq!(a.cli, Some("vst-x86_64-unknown-linux-musl.tar.gz"));
        assert_eq!(
            a.appimage,
            Some("vibe-station-x86_64-unknown-linux-gnu.AppImage")
        );
        assert_eq!(a.deb, Some("vibe-station-x86_64-unknown-linux-gnu.deb"));
        assert_eq!(a.dmg, None);
    }

    #[test]
    fn linux_aarch64_cli_only() {
        let a = assets_for("linux-aarch64");
        assert_eq!(a.cli, Some("vst-aarch64-unknown-linux-musl.tar.gz"));
        assert_eq!(a.appimage, None);
        assert_eq!(a.deb, None);
        assert_eq!(a.dmg, None);
    }

    #[test]
    fn macos_aarch64_cli_and_dmg() {
        let a = assets_for("macos-aarch64");
        assert_eq!(a.cli, Some("vst-aarch64-apple-darwin.tar.gz"));
        assert_eq!(a.dmg, Some("vibe-station-aarch64-apple-darwin.dmg"));
        assert_eq!(a.appimage, None);
        assert_eq!(a.deb, None);
    }

    #[test]
    fn other_has_nothing() {
        let a = assets_for("windows-x86_64");
        assert_eq!(a.cli, None);
        assert_eq!(a.appimage, None);
        assert_eq!(a.deb, None);
        assert_eq!(a.dmg, None);
    }
}
