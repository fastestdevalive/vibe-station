//! Pre-download checks: asset present, targets writable, enough disk,
//! signed checksum manifest verified. Nothing is downloaded until all pass.

use std::io;
use std::path::{Path, PathBuf};

use vst_types::rest::update::{InstallMethod, UpdateError, UpdateReason, UpdateTarget};

use super::download::fetch_verified_manifest;
use super::manifest::Manifest;
use super::{asset_for_target, install_err, tmp_dir, InstallCtx};

pub(crate) const INSTALL_SH: &str =
    "https://raw.githubusercontent.com/fastestdevalive/vibe-station/main/scripts/install.sh";

/// Directory holding the file a target replaces.
pub(crate) fn target_dir(t: &UpdateTarget) -> Option<PathBuf> {
    Path::new(&t.path).parent().map(Path::to_path_buf)
}

/// Probe the directory a target replaces (create + remove a file). `None` when
/// writable (or when the target has no parent dir); else the
/// `permission_denied` error, with the sudo hint for curl copies.
pub(crate) fn writability_error(t: &UpdateTarget) -> Option<UpdateError> {
    let dir = target_dir(t)?;
    let probe = dir.join(format!(".{}.probe", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            None
        }
        Err(e) => {
            let hint = if t.method == InstallMethod::Curl {
                format!(" Run: {}", sudo_install_command(&dir))
            } else {
                String::new()
            };
            Some(install_err(
                UpdateReason::PermissionDenied,
                format!("cannot write to {}: {e}.{hint}", dir.display()),
            ))
        }
    }
}

/// The privileged re-install command for a curl copy in `dir`.
pub(crate) fn sudo_install_command(dir: &Path) -> String {
    format!(
        "curl -fsSL {INSTALL_SH} | sudo sh -s -- --install-dir {}",
        dir.display()
    )
}

/// Run every preflight check with the real `statvfs`.
/// Returns the verified manifest when any asset must be downloaded.
pub async fn preflight(
    ctx: &InstallCtx,
    client: &reqwest::Client,
) -> Result<Option<Manifest>, UpdateError> {
    preflight_with(ctx, client, &vst_proc::posix::free_bytes).await
}

/// [`preflight`] with an injectable free-bytes function (tests).
pub(crate) async fn preflight_with(
    ctx: &InstallCtx,
    client: &reqwest::Client,
    free_bytes: &(dyn Fn(&Path) -> io::Result<u64> + Sync),
) -> Result<Option<Manifest>, UpdateError> {
    let auto: Vec<&UpdateTarget> = ctx.targets.iter().filter(|t| t.auto).collect();
    // (target, asset) pairs; a missing asset is `no_asset`.
    let mut needed = Vec::new();
    for t in &auto {
        match asset_for_target(t, &ctx.assets) {
            Some(a) => needed.push((*t, a)),
            None => {
                return Err(install_err(
                    UpdateReason::NoAsset,
                    format!("this release has no download for {}", t.path),
                ))
            }
        }
    }
    // Writable target dirs: create + remove a probe file.
    for (t, _) in &needed {
        if let Some(e) = writability_error(t) {
            return Err(e);
        }
    }
    // Disk: 3x the largest asset must fit in each target dir and the temp dir.
    let tmp = tmp_dir(&ctx.vst_home);
    std::fs::create_dir_all(&tmp).map_err(|e| {
        install_err(
            UpdateReason::WriteFailed,
            format!("cannot create {}: {e}", tmp.display()),
        )
    })?;
    let mut places: Vec<PathBuf> = vec![tmp];
    for (t, _) in &needed {
        if let Some(d) = target_dir(t) {
            places.push(d);
        }
    }
    for (_, asset) in &needed {
        let want = asset.size.saturating_mul(3);
        for place in &places {
            // An unreadable statvfs is not a reason to block the install.
            if let Ok(free) = free_bytes(place) {
                if free < want {
                    return Err(install_err(
                        UpdateReason::DiskFull,
                        format!(
                            "not enough free space in {} (need {} MB)",
                            place.display(),
                            want / 1_000_000 + 1
                        ),
                    ));
                }
            }
        }
    }
    // Signed manifest: verified once; every asset we will download must be
    // listed in it.
    if needed.is_empty() {
        return Ok(None);
    }
    let m = fetch_verified_manifest(
        client,
        &ctx.assets,
        &ctx.latest,
        &ctx.current,
        &ctx.trusted_keys,
    )
    .await?;
    for (_, asset) in &needed {
        if m.sha256_of(&asset.name).is_none() {
            return Err(install_err(
                UpdateReason::MissingChecksum,
                format!("{} is not listed in the signed manifest", asset.name),
            ));
        }
    }
    Ok(Some(m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::install::signature::test_support::{
        keypair_from_seed, manifest_bytes, sign_minisig,
    };
    use crate::update::state::AssetRef;
    use std::os::unix::fs::PermissionsExt;

    const KID: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    /// Serve a signed manifest (tag v9.9.9) listing `listed` under `/pf/`.
    fn serve_manifest(listed: &[(&str, &[u8])]) -> Vec<mockito::Mock> {
        let (_, kp) = keypair_from_seed([7u8; 32], KID);
        let m = manifest_bytes("v9.9.9", listed);
        let s = sign_minisig(&kp, KID, &m, "vibe-station v9.9.9");
        vec![
            mockito::mock("GET", "/pf/SHA256SUMS").with_body(m).create(),
            mockito::mock("GET", "/pf/SHA256SUMS.minisig")
                .with_body(s)
                .create(),
        ]
    }

    // mockito 0.31 is process-global: serialise (distinct path prefix `/pf`).
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn ctx(dir: &Path, vst_home: &Path) -> InstallCtx {
        let name = crate::update::platform::assets_for(crate::update::platform::platform_key())
            .cli
            .unwrap_or("vst-x86_64-unknown-linux-musl.tar.gz");
        InstallCtx {
            vst_home: vst_home.to_path_buf(),
            latest: "9.9.9".into(),
            current: "0.0.1".into(),
            trusted_keys: vec![keypair_from_seed([7u8; 32], KID).0],
            assets: vec![
                AssetRef {
                    name: name.into(),
                    url: format!("{}/pf/{name}", mockito::server_url()),
                    size: 1000,
                },
                AssetRef {
                    name: "SHA256SUMS".into(),
                    url: format!("{}/pf/SHA256SUMS", mockito::server_url()),
                    size: 10,
                },
                AssetRef {
                    name: "SHA256SUMS.minisig".into(),
                    url: format!("{}/pf/SHA256SUMS.minisig", mockito::server_url()),
                    size: 10,
                },
            ],
            targets: vec![UpdateTarget {
                method: InstallMethod::Curl,
                path: dir.join("vst").to_string_lossy().into_owned(),
                version: None,
                auto: true,
            }],
            boot_exe: dir.join("vst"),
            appimage_env: None,
            keep_prev: false,
        }
    }

    #[tokio::test]
    async fn read_only_dir_is_permission_denied() {
        let _g = LOCK.lock().await;
        if vst_proc::posix::effective_uid() == 0 {
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let bin = t.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o555)).unwrap();
        let c = ctx(&bin, &t.path().join("home"));
        let m = mockito::mock("GET", mockito::Matcher::Regex("^/pf/".into()))
            .expect(0)
            .create();
        let e = preflight(&c, &reqwest::Client::new()).await.unwrap_err();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(e.reason, UpdateReason::PermissionDenied);
        assert!(
            e.message.contains("sudo sh -s -- --install-dir"),
            "{}",
            e.message
        );
        m.assert();
    }

    #[tokio::test]
    async fn low_disk_is_disk_full() {
        let _g = LOCK.lock().await;
        let t = tempfile::tempdir().unwrap();
        let bin = t.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let c = ctx(&bin, &t.path().join("home"));
        let m = mockito::mock("GET", mockito::Matcher::Regex("^/pf/".into()))
            .expect(0)
            .create();
        let e = preflight_with(&c, &reqwest::Client::new(), &|_| Ok(2999))
            .await
            .unwrap_err();
        assert_eq!(e.reason, UpdateReason::DiskFull);
        m.assert();
        // exactly 3x passes the disk check and reaches the manifest fetch
        let name = c.assets[0].name.clone();
        let _s = serve_manifest(&[(name.as_str(), b"body")]);
        let m = preflight_with(&c, &reqwest::Client::new(), &|_| Ok(3000))
            .await
            .unwrap();
        assert!(m.is_some());
    }

    #[tokio::test]
    async fn missing_checksum_and_no_asset() {
        let _g = LOCK.lock().await;
        let t = tempfile::tempdir().unwrap();
        let bin = t.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let mut c = ctx(&bin, &t.path().join("home"));
        // 2.T7: signed manifest that does not list the asset.
        let _s = serve_manifest(&[("something-else.tar.gz", b"x")]);
        let e = preflight(&c, &reqwest::Client::new()).await.unwrap_err();
        assert_eq!(e.reason, UpdateReason::MissingChecksum);
        c.assets.clear();
        let e = preflight(&c, &reqwest::Client::new()).await.unwrap_err();
        assert_eq!(e.reason, UpdateReason::NoAsset);
    }
}
