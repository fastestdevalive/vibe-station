//! Install pipeline: primitives (download, extract) and orchestration
//! (preflight, replace, [`run_install`]). `run_install` never writes the state
//! file, so the pipeline is testable without a service: it returns an [`InstallOutcome`] the caller persists.
//!
//! Disk layout: `<vst_home>/update-tmp/dl/<asset name>` (verified downloads)
//! and `<vst_home>/update-tmp/cli/` (extracted CLI set, 0700). The whole
//! `update-tmp` dir is wiped before an install and removed afterwards.

pub mod cancel;
pub mod download;
pub mod extract;
pub mod manifest;
pub mod manual;
pub mod preflight;
pub mod replace;
pub mod signature;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use self::cancel::CancelToken;

use vst_types::rest::update::{
    InstallMethod, InstallResult, InstallStage, ManualStep, ManualStepKind, UpdateError,
    UpdateReason, UpdateTarget,
};

use super::platform::{assets_for, platform_key};
use super::state::{self, AssetRef, RestartKind};

/// Build an install-kind [`UpdateError`] (shared by every install submodule).
pub(crate) fn install_err(reason: UpdateReason, message: impl Into<String>) -> UpdateError {
    UpdateError {
        kind: vst_types::rest::update::UpdateErrorKind::Install,
        reason,
        message: message.into(),
        retry_after: None,
    }
}

/// Everything `run_install` needs; built by the service / CLI fallback.
#[derive(Clone, Debug)]
pub struct InstallCtx {
    pub vst_home: PathBuf,
    /// target version, no "v"
    pub latest: String,
    /// running version, no "v" (downgrade/replay defence)
    pub current: String,
    /// release keys the manifest signature must verify against
    pub trusted_keys: Vec<signature::PinnedKey>,
    /// the release's assets (name, url, size)
    pub assets: Vec<AssetRef>,
    pub targets: Vec<UpdateTarget>,
    /// boot-captured exe of the running daemon
    pub boot_exe: PathBuf,
    /// `$APPIMAGE` when hosted by the desktop app
    pub appimage_env: Option<PathBuf>,
    /// A restart is still pending from an earlier install: the CLI
    /// files on disk have not booted yet, so their `.prev` set must survive.
    pub keep_prev: bool,
}

/// Result of a completed install.
#[derive(Clone, Debug)]
pub struct InstallOutcome {
    pub result: InstallResult,
    /// `Some` only if the running daemon's / app's own binary was replaced
    pub pending_restart: Option<state::PendingRestart>,
}

/// Scratch root for downloads and extraction.
pub(crate) fn tmp_dir(vst_home: &Path) -> PathBuf {
    vst_home.join("update-tmp")
}

/// The release asset an auto target is updated from (None for manual targets
/// or when the release lacks it).
pub(crate) fn asset_for_target<'a>(
    t: &UpdateTarget,
    assets: &'a [AssetRef],
) -> Option<&'a AssetRef> {
    let names = assets_for(platform_key());
    let want = match t.method {
        InstallMethod::Curl => names.cli?,
        InstallMethod::CurlAppImage | InstallMethod::AppImage => names.appimage?,
        _ => return None,
    };
    assets.iter().find(|a| a.name == want)
}

pub(crate) fn dmg_asset(assets: &[AssetRef]) -> Option<&AssetRef> {
    if let Some(name) = assets_for(platform_key()).dmg {
        if let Some(a) = assets.iter().find(|a| a.name == name) {
            return Some(a);
        }
    }
    assets.iter().find(|a| a.name.ends_with(".dmg"))
}

pub(crate) fn deb_asset(assets: &[AssetRef]) -> Option<&AssetRef> {
    if let Some(name) = assets_for(platform_key()).deb {
        if let Some(a) = assets.iter().find(|a| a.name == name) {
            return Some(a);
        }
    }
    assets.iter().find(|a| a.name.ends_with(".deb"))
}

fn is_cli_target(t: &UpdateTarget) -> bool {
    t.method == InstallMethod::Curl
}

fn method_label(m: &InstallMethod) -> &'static str {
    match m {
        InstallMethod::Curl => "curl",
        InstallMethod::CurlAppImage => "curl AppImage",
        InstallMethod::AppImage => "AppImage",
        InstallMethod::Dmg => ".dmg app",
        InstallMethod::Deb => ".deb package",
        InstallMethod::Unknown => "unrecognised install",
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    norm(a) == norm(b)
}

/// Run the whole install: clean stale `.new` -> preflight -> download
/// each asset once (shared across targets) -> verify -> extract -> replace
/// every `auto` target.
pub async fn run_install(
    ctx: InstallCtx,
    progress: &(dyn Fn(InstallStage, u8) + Send + Sync),
    cancel: Arc<CancelToken>,
) -> Result<InstallOutcome, UpdateError> {
    let tmp = tmp_dir(&ctx.vst_home);
    let out = run_inner(&ctx, progress, &cancel).await;
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

/// An `auto` copy whose directory is not writable cannot be updated
/// here; it becomes a manual step while the writable ones still install. The
/// install fails with `permission_denied` only when nothing writable remains
/// and there is no deb/dmg flow to carry on with.
fn demote_unwritable(ctx: &InstallCtx) -> Result<InstallCtx, UpdateError> {
    let mut out = ctx.clone();
    let mut first_err = None;
    for t in out.targets.iter_mut().filter(|t| t.auto) {
        if let Some(e) = preflight::writability_error(t) {
            first_err.get_or_insert(e);
            t.auto = false;
        }
    }
    if let Some(e) = first_err {
        let any_auto = out.targets.iter().any(|t| t.auto);
        let has_package_flow = out
            .targets
            .iter()
            .any(|t| matches!(t.method, InstallMethod::Dmg | InstallMethod::Deb));
        if !any_auto && !has_package_flow {
            return Err(e);
        }
    }
    Ok(out)
}

/// Removes any still-staged `.new` files if the install bails out between
/// staging and commit (idempotent after a successful commit).
struct StagedGuard(Vec<replace::StagedCliSet>);

impl Drop for StagedGuard {
    fn drop(&mut self) {
        for s in &self.0 {
            s.discard();
        }
    }
}

async fn run_inner(
    ctx: &InstallCtx,
    progress: &(dyn Fn(InstallStage, u8) + Send + Sync),
    cancel: &Arc<CancelToken>,
) -> Result<InstallOutcome, UpdateError> {
    let demoted = demote_unwritable(ctx)?;
    let ctx = &demoted;
    let auto: Vec<&UpdateTarget> = ctx.targets.iter().filter(|t| t.auto).collect();
    let tmp = tmp_dir(&ctx.vst_home);

    progress(InstallStage::Preflight, 0);
    let _ = std::fs::remove_dir_all(&tmp);
    for t in auto.iter().filter(|t| is_cli_target(t)) {
        if let Some(dir) = preflight::target_dir(t) {
            replace::clean_stale_new(&dir);
        }
    }
    let client = crate::update::http::release_client().map_err(|e| {
        install_err(
            UpdateReason::Offline,
            format!("cannot build HTTP client: {e}"),
        )
    })?;
    let mut manifest = preflight::preflight(ctx, &client).await?;

    // Download each distinct asset once.
    let mut wanted: Vec<&AssetRef> = Vec::new();
    for t in &auto {
        if let Some(a) = asset_for_target(t, &ctx.assets) {
            if !wanted.iter().any(|w| w.name == a.name) {
                wanted.push(a);
            }
        }
    }
    let dl_dir = tmp.join("dl");
    let n = wanted.len().max(1);
    for (i, asset) in wanted.iter().enumerate() {
        let dest = dl_dir.join(&asset.name);
        let base = u8::try_from(i * 100 / n).unwrap_or(100);
        let cb = move |p: u8| {
            progress(
                InstallStage::Downloading,
                base.saturating_add(p / u8::try_from(n).unwrap_or(1))
                    .min(100),
            )
        };
        progress(InstallStage::Downloading, base);
        let expected_sha256 = manifest
            .as_ref()
            .and_then(|m| m.sha256_of(&asset.name))
            .ok_or_else(|| {
                install_err(
                    UpdateReason::MissingChecksum,
                    format!("{} is not listed in the signed manifest", asset.name),
                )
            })?;
        download::download_verified(
            &client,
            &asset.url,
            expected_sha256,
            asset.size.saturating_add(1_000_000),
            &dest,
            cancel,
            &cb,
        )
        .await?;
    }
    // Download and smoke-test everything before touching any live file, so a
    // failure leaves the installed version unchanged: fetch the .deb with the
    // other downloads, BEFORE anything live is replaced, so a network/checksum
    // failure leaves the install untouched
    // ("your current version is unchanged") and the stage order stays
    // downloading -> verifying -> installing.
    let mut deb_download: Option<(PathBuf, Vec<ManualStep>)> = None;
    if ctx
        .targets
        .iter()
        .any(|t| !t.auto && t.method == InstallMethod::Deb)
    {
        if let Some(asset) = deb_asset(&ctx.assets) {
            // Preflight verifies the manifest only when an auto target needs
            // a download; a deb-only install fetches it here, once.
            if manifest.is_none() {
                manifest = Some(
                    download::fetch_verified_manifest(
                        &client,
                        &ctx.assets,
                        &ctx.latest,
                        &ctx.current,
                        &ctx.trusted_keys,
                    )
                    .await?,
                );
            }
            if let Some(m) = &manifest {
                deb_download = Some(
                    manual::deb_download(ctx, asset, m, &client, progress, cancel.clone()).await?,
                );
            }
        }
    }
    progress(InstallStage::Verifying, 100);

    // Extract the CLI archive once if any curl target needs it.
    let cli_files: Vec<PathBuf> = match auto
        .iter()
        .find(|t| is_cli_target(t))
        .and_then(|t| asset_for_target(t, &ctx.assets))
    {
        Some(a) => {
            let (archive, out) = (dl_dir.join(&a.name), tmp.join("cli"));
            tokio::task::spawn_blocking(move || extract::extract_archive(&archive, &out))
                .await
                .map_err(|e| {
                    install_err(
                        UpdateReason::WriteFailed,
                        format!("extract task failed: {e}"),
                    )
                })??
        }
        None => Vec::new(),
    };

    // Stage + smoke-test every CLI set while still `Verifying`, so a
    // `smoke_failed` is reported before anything live is touched.
    let mut staged_sets = StagedGuard(Vec::new());
    for t in auto.iter().filter(|t| is_cli_target(t)) {
        let dir = preflight::target_dir(t).unwrap_or_default();
        let (files, latest) = (cli_files.clone(), ctx.latest.clone());
        let staged =
            tokio::task::spawn_blocking(move || replace::stage_cli_set(&dir, &files, &latest))
                .await
                .map_err(|e| {
                    install_err(
                        UpdateReason::WriteFailed,
                        format!("install task failed: {e}"),
                    )
                })??;
        staged_sets.0.push(staged);
    }

    // Replace every auto target.
    progress(InstallStage::Installing, 100);
    let mut updated = Vec::new();
    let mut pending: Option<state::PendingRestart> = None;
    for (i, t) in auto.iter().enumerate() {
        let target_path = PathBuf::from(&t.path);
        if is_cli_target(t) {
            let dir = preflight::target_dir(t).unwrap_or_default();
            let Some(staged) = staged_sets.0.iter().find(|s| s.dir == dir).cloned() else {
                return Err(install_err(
                    UpdateReason::WriteFailed,
                    "internal error: CLI set was not staged",
                ));
            };
            // The pending restart only ever covers the boot exe's directory.
            let keep_prev =
                ctx.keep_prev && ctx.boot_exe.parent().is_some_and(|p| same_dir(p, &dir));
            tokio::task::spawn_blocking(move || replace::commit_cli_set(&staged, keep_prev))
                .await
                .map_err(|e| {
                    install_err(
                        UpdateReason::WriteFailed,
                        format!("install task failed: {e}"),
                    )
                })??;
            if ctx.boot_exe.parent().is_some_and(|p| same_dir(p, &dir)) && pending.is_none() {
                let is_app = crate::update::detect::is_inside_app_bundle(&ctx.boot_exe);
                pending = Some(state::PendingRestart {
                    version: ctx.latest.clone(),
                    exe_path: ctx.boot_exe.to_string_lossy().into_owned(),
                    kind: if is_app {
                        RestartKind::App
                    } else {
                        RestartKind::Daemon
                    },
                });
            }
        } else if let Some(a) = asset_for_target(t, &ctx.assets) {
            let (p, src) = (target_path.clone(), dl_dir.join(&a.name));
            tokio::task::spawn_blocking(move || replace::replace_single(&p, &src))
                .await
                .map_err(|e| {
                    install_err(
                        UpdateReason::WriteFailed,
                        format!("install task failed: {e}"),
                    )
                })??;
            if ctx
                .appimage_env
                .as_deref()
                .is_some_and(|e| e == target_path)
            {
                // The app restart covers its sidecar daemon, so `app` wins.
                pending = Some(state::PendingRestart {
                    version: ctx.latest.clone(),
                    exe_path: t.path.clone(),
                    kind: RestartKind::App,
                });
            }
        }
        updated.push(t.path.clone());
        progress(
            InstallStage::Installing,
            u8::try_from((i + 1) * 100 / auto.len()).unwrap_or(100),
        );
    }

    let manual_targets: Vec<&UpdateTarget> = ctx.targets.iter().filter(|t| !t.auto).collect();
    let mut manual_steps = Vec::new();
    let mut deb_path = None;
    let mut handled_dmg = false;
    let mut handled_deb = false;

    for t in &manual_targets {
        match t.method {
            InstallMethod::Dmg => {
                if !handled_dmg {
                    if let Some(asset) = dmg_asset(&ctx.assets) {
                        manual_steps.extend(manual::dmg_steps(asset, &ctx.assets));
                        handled_dmg = true;
                    } else {
                        manual_steps.push(ManualStep {
                            kind: ManualStepKind::Text,
                            text: format!(
                                "Update {} ({}) manually.",
                                t.path,
                                method_label(&t.method)
                            ),
                            url: None,
                        });
                    }
                }
            }
            InstallMethod::Deb => {
                if !handled_deb {
                    if let Some((path, steps)) = deb_download.take() {
                        deb_path = Some(path.to_string_lossy().into_owned());
                        manual_steps.extend(steps);
                        handled_deb = true;
                    } else {
                        manual_steps.push(ManualStep {
                            kind: ManualStepKind::Text,
                            text: format!(
                                "Update {} ({}) manually.",
                                t.path,
                                method_label(&t.method)
                            ),
                            url: None,
                        });
                    }
                }
            }
            // A curl copy only reaches the manual list when its directory is
            // not writable by this user: hand over the privileged command.
            InstallMethod::Curl => {
                let dir = preflight::target_dir(t).unwrap_or_default();
                manual_steps.push(ManualStep {
                    kind: ManualStepKind::Command,
                    text: preflight::sudo_install_command(&dir),
                    url: None,
                });
            }
            _ => {
                manual_steps.push(ManualStep {
                    kind: ManualStepKind::Text,
                    text: format!("Update {} ({}) manually.", t.path, method_label(&t.method)),
                    url: None,
                });
            }
        }
    }

    Ok(InstallOutcome {
        result: InstallResult {
            version: ctx.latest.clone(),
            updated,
            manual: manual_steps,
            deb_path,
        },
        pending_restart: pending,
    })
}
