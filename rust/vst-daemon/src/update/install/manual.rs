//! Manual installation flows: DMG and DEB.
//!
//! DMG is manual: the browser downloads the `.dmg` (keeping macOS quarantine)
//! and user drags to `/Applications`. No assets downloaded by daemon.
//!
//! DEB is semi-manual: downloaded + verified via `download_verified` into
//! `~/Downloads/` (or `<vst_home>/downloads/`), mode 0644, command step
//! `sudo apt install <path>`.

use super::cancel::CancelToken;
use std::path::PathBuf;
use std::sync::Arc;

use vst_types::rest::update::{
    InstallStage, ManualStep, ManualStepKind, UpdateError, UpdateReason,
};

use super::download::{download_verified, MANIFEST_NAME};
use super::manifest::Manifest;
use super::{install_err, InstallCtx};
use crate::update::state::AssetRef;

/// Emit manual instructions for a macOS `.dmg` install.
/// No network requests are made.
pub fn dmg_steps(asset: &AssetRef, assets: &[AssetRef]) -> Vec<ManualStep> {
    let mut steps = vec![
        ManualStep {
            kind: ManualStepKind::OpenUrl,
            text: format!("Download {}", asset.name),
            url: Some(asset.url.clone()),
        },
        ManualStep {
            kind: ManualStepKind::Text,
            text: "1. Quit vibe-station.app (Cmd+Q)".to_string(),
            url: None,
        },
        ManualStep {
            kind: ManualStepKind::Text,
            text: "2. Open the downloaded .dmg and drag the app to /Applications (Replace)".to_string(),
            url: None,
        },
        ManualStep {
            kind: ManualStepKind::Text,
            text: "3. Relaunch vibe-station (if macOS blocks it: System Settings → Privacy & Security → Open Anyway)".to_string(),
            url: None,
        },
    ];
    if let Some(sums) = assets.iter().find(|a| a.name == MANIFEST_NAME) {
        steps.push(ManualStep {
            kind: ManualStepKind::OpenUrl,
            text: "Checksums (signed SHA256SUMS, optional)".to_string(),
            url: Some(sums.url.clone()),
        });
    }
    steps
}

/// Download and verify a `.deb` package.
/// Saves to `~/Downloads/` if it exists as a directory, else `<vst_home>/downloads/`.
/// Sets file mode 0644. Returns the verified path and manual steps.
pub async fn deb_download(
    ctx: &InstallCtx,
    asset: &AssetRef,
    manifest: &Manifest,
    client: &reqwest::Client,
    progress: &(dyn Fn(InstallStage, u8) + Send + Sync),
    cancel: Arc<CancelToken>,
) -> Result<(PathBuf, Vec<ManualStep>), UpdateError> {
    let downloads_dir = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Downloads"))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| ctx.vst_home.join("downloads"));

    std::fs::create_dir_all(&downloads_dir).map_err(|e| {
        install_err(
            UpdateReason::WriteFailed,
            format!(
                "cannot create downloads directory {}: {e}",
                downloads_dir.display()
            ),
        )
    })?;

    let dest = downloads_dir.join(&asset.name);
    progress(InstallStage::Downloading, 0);
    let cb = |p: u8| progress(InstallStage::Downloading, p);
    let max_size = asset.size.saturating_add(1_000_000);

    let expected_sha256 = manifest.sha256_of(&asset.name).ok_or_else(|| {
        install_err(
            UpdateReason::MissingChecksum,
            format!("{} is not listed in the signed manifest", asset.name),
        )
    })?;

    download_verified(
        client,
        &asset.url,
        expected_sha256,
        max_size,
        &dest,
        &cancel,
        &cb,
    )
    .await?;

    progress(InstallStage::Verifying, 100);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o644));
    }

    let abs_path = if dest.is_absolute() {
        dest
    } else {
        std::fs::canonicalize(&dest).unwrap_or(dest)
    };

    let steps = vec![
        ManualStep {
            kind: ManualStepKind::Command,
            text: format!("sudo apt install {}", abs_path.display()),
            url: None,
        },
        ManualStep {
            kind: ManualStepKind::Text,
            text: "Then quit and relaunch vibe-station.".to_string(),
            url: None,
        },
    ];

    Ok((abs_path, steps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::install::cancel::CancelToken;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn dmg_flow_zero_http_requests() {
        let _m = mockito::mock("GET", "/dmg-asset").expect(0).create();
        let asset = AssetRef {
            name: "vibe-station-aarch64-apple-darwin.dmg".to_string(),
            url: format!("{}/dmg-asset", mockito::server_url()),
            size: 12345,
        };

        let sums = AssetRef {
            name: "SHA256SUMS".to_string(),
            url: format!("{}/SHA256SUMS", mockito::server_url()),
            size: 10,
        };
        assert_eq!(dmg_steps(&asset, &[]).len(), 4);
        let steps = dmg_steps(&asset, std::slice::from_ref(&sums));
        assert_eq!(steps.len(), 5);
        assert_eq!(steps[4].url.as_deref(), Some(sums.url.as_str()));
        assert_eq!(steps[0].kind, ManualStepKind::OpenUrl);
        assert_eq!(steps[0].url.as_deref(), Some(asset.url.as_str()));
        assert_eq!(steps[1].kind, ManualStepKind::Text);
        assert_eq!(steps[2].kind, ManualStepKind::Text);
        assert_eq!(steps[3].kind, ManualStepKind::Text);
        assert_eq!(steps[4].kind, ManualStepKind::OpenUrl);
        assert!(steps[4].text.contains("SHA256SUMS"));
    }

    #[tokio::test]
    async fn deb_flow_downloads_verifies_0644() {
        use crate::update::install::signature::test_support::{
            keypair_from_seed, manifest_bytes, sign_minisig,
        };
        let body = b"fake-deb-content";
        let kid = [1u8; 8];
        let (key, kp) = keypair_from_seed([7u8; 32], kid);
        let man = manifest_bytes("v1.2.3", &[("test-pkg.deb", body)]);
        let sig = sign_minisig(&kp, kid, &man, "vibe-station v1.2.3");

        let _m_asset = mockito::mock("GET", "/test-pkg.deb")
            .with_body(body)
            .create();
        let _m_sums = mockito::mock("GET", "/SHA256SUMS").with_body(man).create();
        let _m_sig = mockito::mock("GET", "/SHA256SUMS.minisig")
            .with_body(sig)
            .create();
        let base = mockito::server_url();
        let mk = |name: &str| AssetRef {
            name: name.to_string(),
            url: format!("{base}/{name}"),
            size: 10,
        };

        let t = tempdir().unwrap();
        let vst_home = t.path().join("vst_home");
        fs::create_dir_all(&vst_home).unwrap();

        let ctx = InstallCtx {
            vst_home: vst_home.clone(),
            latest: "1.2.3".to_string(),
            current: "0.0.1".to_string(),
            trusted_keys: vec![key],
            assets: vec![mk("SHA256SUMS"), mk("SHA256SUMS.minisig")],
            targets: vec![],
            boot_exe: PathBuf::from("/bin/vst"),
            appimage_env: None,
            keep_prev: false,
        };

        let asset = AssetRef {
            name: "test-pkg.deb".to_string(),
            url: format!("{base}/test-pkg.deb"),
            size: body.len() as u64,
        };

        let cancel = Arc::new(CancelToken::new());
        let progress = |_stage: InstallStage, _pct: u8| {};

        let client = reqwest::Client::new();
        let manifest = super::super::download::fetch_verified_manifest(
            &client,
            &ctx.assets,
            &ctx.latest,
            &ctx.current,
            &ctx.trusted_keys,
        )
        .await
        .unwrap();
        let (path, steps) = deb_download(&ctx, &asset, &manifest, &client, &progress, cancel)
            .await
            .unwrap();
        assert!(path.exists());
        let content = fs::read(&path).unwrap();
        assert_eq!(content, body);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o644);
        }

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].kind, ManualStepKind::Command);
        let expected_cmd = format!("sudo apt install {}", path.display());
        assert_eq!(steps[0].text, expected_cmd);
        assert_eq!(steps[1].kind, ManualStepKind::Text);
    }
}
