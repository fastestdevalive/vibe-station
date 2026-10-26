//! How the running binary was installed, inferred from its path and file magic.
//!
//! Runs at boot, on every check and at install start (the user may have reinstalled) — NOT on every
//! snapshot build. `detect()` is the only place the ELF/Mach-O magic check
//! is applied; install tests construct `UpdateTarget`s directly so shell-script
//! fakes are accepted.

use std::path::{Path, PathBuf};

use vst_types::rest::update::{InstallMethod, UpdateTarget};

use super::install::replace::KNOWN_NAMES;

/// Environment abstraction so `detect()` is unit-testable without a real FS.
pub trait DetectEnv {
    fn var(&self, k: &str) -> Option<String>;
    fn home(&self) -> PathBuf;
    /// Read the first 4 bytes of `p` (magic), or `None` if unreadable.
    fn read_magic(&self, p: &Path) -> Option<[u8; 4]>;
    fn is_file(&self, p: &Path) -> bool;
    /// True when `dir` lives on a read-only mount (e.g. an AppImage squashfs).
    fn is_read_only(&self, dir: &Path) -> bool;
    /// Run `prog` with `args` (2 s timeout); `None` on failure, else the
    /// first line of stdout.
    fn run(&self, prog: &Path, args: &[&str]) -> Option<String>;
}

/// The real environment.
pub struct RealEnv;

impl DetectEnv for RealEnv {
    fn var(&self, k: &str) -> Option<String> {
        std::env::var(k).ok()
    }
    fn home(&self) -> PathBuf {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
    }
    fn read_magic(&self, p: &Path) -> Option<[u8; 4]> {
        use std::io::Read;
        let mut f = std::fs::File::open(p).ok()?;
        let mut buf = [0u8; 4];
        f.read_exact(&mut buf).ok()?;
        Some(buf)
    }
    fn is_file(&self, p: &Path) -> bool {
        p.is_file()
    }
    fn is_read_only(&self, dir: &Path) -> bool {
        vst_proc::posix::is_read_only(dir)
    }
    fn run(&self, prog: &Path, args: &[&str]) -> Option<String> {
        super::exec::run_first_line(prog, args, RUN_TIMEOUT)
    }
}

/// Hermetic environment for tests: env vars come from an injected lookup; the
/// filesystem and process probes see nothing (no files, no `$HOME`, no commands), so
/// `detect()` reports `Unknown` with no targets and never touches the host.
#[cfg(any(test, feature = "test-seams"))]
pub struct StubEnv(VarFn);

#[cfg(any(test, feature = "test-seams"))]
type VarFn = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[cfg(any(test, feature = "test-seams"))]
impl StubEnv {
    pub fn new(f: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        StubEnv(Box::new(f))
    }
}

#[cfg(any(test, feature = "test-seams"))]
impl DetectEnv for StubEnv {
    fn var(&self, k: &str) -> Option<String> {
        (self.0)(k)
    }
    fn home(&self) -> PathBuf {
        PathBuf::from("/nonexistent-vst-test-home")
    }
    fn read_magic(&self, _p: &Path) -> Option<[u8; 4]> {
        None
    }
    fn is_file(&self, _p: &Path) -> bool {
        false
    }
    fn is_read_only(&self, _dir: &Path) -> bool {
        false
    }
    fn run(&self, _prog: &Path, _args: &[&str]) -> Option<String> {
        None
    }
}

/// Upper bound for every probe `detect()` runs (`--version`, `dpkg -S`).
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

fn is_elf(magic: &[u8; 4]) -> bool {
    magic == b"\x7fELF"
}

fn is_macho(magic: &[u8; 4]) -> bool {
    matches!(
        *magic,
        [0xfe, 0xed, 0xfa, 0xce]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xca, 0xfe, 0xba, 0xbe]
            | [0xbe, 0xba, 0xfe, 0xca]
    )
}

fn is_binary(magic: &[u8; 4]) -> bool {
    is_elf(magic) || is_macho(magic)
}

pub(crate) fn is_inside_app_bundle(p: &Path) -> bool {
    p.to_string_lossy().contains(".app/Contents/")
        || p.ancestors().any(|a| {
            a.extension()
                .and_then(|e| e.to_str())
                .map(|s| s.eq_ignore_ascii_case("app"))
                .unwrap_or(false)
        })
}

/// The curl-installed AppImage path: `$XDG_DATA_HOME` or `~/.local/share`
/// then `/vibe-station/vibe-station.AppImage` (as `install.sh:283-284`).
fn curl_appimage_path(env: &dyn DetectEnv) -> PathBuf {
    let base = env
        .var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| env.home().join(".local/share"));
    base.join("vibe-station/vibe-station.AppImage")
}

/// Adapter binaries that may sit next to `vst` in a curl install: every name
/// the archive ever shipped (`KNOWN_NAMES`) except `vst` itself, so an old
/// install (a musl one has only `vst` + `agy-acp`) is still recognised.
fn adapters() -> impl Iterator<Item = &'static str> {
    KNOWN_NAMES.into_iter().filter(|n| *n != "vst")
}

fn make_target(
    path: &Path,
    method: InstallMethod,
    auto: bool,
    version: Option<String>,
) -> UpdateTarget {
    UpdateTarget {
        method,
        path: path.to_string_lossy().into_owned(),
        version,
        auto,
    }
}

/// Candidate paths to inspect, in priority order. Every copy is listed (e.g. a Linux curl install puts the CLI and an AppImage side by side).
fn candidates(boot_exe: &Path, env: &dyn DetectEnv) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(boot_exe.to_path_buf());

    let home = env.home();
    let local_bin_vst = home.join(".local/bin/vst");
    out.push(local_bin_vst);

    if let Some(path) = env.var("PATH") {
        for dir in std::env::split_paths(&path) {
            out.push(dir.join("vst"));
        }
    }

    out.push(curl_appimage_path(env));

    if let Some(ap) = env.var("APPIMAGE") {
        out.push(PathBuf::from(ap));
    }

    // The bundle's main binary (a directory is never classified); Tauri names
    // it after `productName` or the cargo bin, depending on version.
    for bin in ["vibe-station", "vibe-station-desktop"] {
        out.push(PathBuf::from("/Applications/vibe-station.app/Contents/MacOS").join(bin));
    }
    out
}

/// Classify a single candidate into a method + targets, or `None` if it is
/// not a real install the daemon can reason about.
fn classify(path: &Path, env: &dyn DetectEnv) -> Option<(InstallMethod, Vec<UpdateTarget>)> {
    if !env.is_file(path) {
        return None;
    }
    let magic = env.read_magic(path)?;
    // Shell shims (#!/bin/sh) are rejected — not a real binary.
    if !is_binary(&magic) {
        return None;
    }

    // A copy inside the running AppImage's squashfs mount is the bundled
    // sidecar, not an install the updater can write; `$APPIMAGE` itself is the
    // real target.
    if is_inside_appdir(path, env) {
        return None;
    }

    let s = path.to_string_lossy().into_owned();

    // dmg: path inside a *.app/Contents/MacOS/ bundle.
    if is_macho(&magic) && s.contains(".app/Contents/MacOS/") {
        return Some((
            InstallMethod::Dmg,
            vec![make_target(path, InstallMethod::Dmg, false, None)],
        ));
    }

    // deb (Linux only): `dpkg -S <path>` succeeds.
    if is_elf(&magic) && cfg!(target_os = "linux") {
        if env.run(Path::new("dpkg"), &["-S", &s]).is_some() {
            return Some((
                InstallMethod::Deb,
                vec![make_target(path, InstallMethod::Deb, false, None)],
            ));
        }
    }

    // appimage vs curl-appimage.
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.ends_with(".AppImage") {
            let curl_path = curl_appimage_path(env);
            let method = if path == curl_path {
                InstallMethod::CurlAppImage
            } else {
                InstallMethod::AppImage
            };
            return Some((method.clone(), vec![make_target(path, method, true, None)]));
        }
    }

    // curl: an ELF/Mach-O named `vst` (the tarball only ships `vst` +
    // adapters, so e.g. a `vst-daemon` beside adapters is not a curl copy)
    // whose dir holds >=1 sibling adapter OR is ~/.local/bin.
    if is_binary(&magic) && path.file_name().is_some_and(|n| n == "vst") {
        let dir = path.parent()?;
        // A read-only mount can never be updated, not even with sudo.
        if env.is_read_only(dir) {
            return None;
        }
        let is_local_bin = dir == &env.home().join(".local/bin");
        let has_adapter = adapters().any(|a| env.is_file(&dir.join(a)));
        if is_local_bin || has_adapter {
            let version = env.run(path, &["--version"]);
            return Some((
                InstallMethod::Curl,
                vec![make_target(path, InstallMethod::Curl, true, version)],
            ));
        }
    }

    None
}

/// True when `path` is inside the running AppImage's mount (`$APPDIR`, set by
/// the AppImage runtime alongside `$APPIMAGE`).
fn is_inside_appdir(path: &Path, env: &dyn DetectEnv) -> bool {
    env.var("APPIMAGE").is_some_and(|a| !a.is_empty())
        && env
            .var("APPDIR")
            .filter(|d| !d.is_empty())
            .is_some_and(|d| path.starts_with(d))
}

/// The install method of the RUNNING binary only: the boot exe's own
/// classification, `AppImage`/`CurlAppImage` when it runs inside the mounted
/// `$APPIMAGE`, else `Unknown`. Never derived from other install copies.
type Classified = Option<(InstallMethod, Vec<UpdateTarget>)>;

fn running_method(
    boot_exe: &Path,
    env: &dyn DetectEnv,
    classify: &mut dyn FnMut(&Path) -> Classified,
) -> InstallMethod {
    if is_inside_appdir(boot_exe, env) {
        let ap = env.var("APPIMAGE").map(PathBuf::from);
        return ap
            .and_then(|p| classify(&p))
            .map(|(m, _)| m)
            .unwrap_or(InstallMethod::AppImage);
    }
    classify(boot_exe)
        .map(|(m, _)| m)
        .unwrap_or(InstallMethod::Unknown)
}

/// Detect the running daemon's install method and EVERY install copy (e.g. the Linux curl default installs both the CLI and an AppImage).
/// The method describes the running binary only; targets list every classified
/// copy (boot exe first) de-duplicated by resolved path (a PATH entry may
/// repeat `~/.local/bin`).
pub fn detect(boot_exe: &Path, env: &dyn DetectEnv) -> (InstallMethod, Vec<UpdateTarget>) {
    // Each distinct path is classified (and so probed) at most once.
    let mut cache: Vec<(PathBuf, Classified)> = Vec::new();
    let mut classify_cached = |p: &Path| {
        if let Some((_, r)) = cache.iter().find(|(k, _)| k == p) {
            return r.clone();
        }
        let r = classify(p, env);
        cache.push((p.to_path_buf(), r.clone()));
        r
    };
    let method = running_method(boot_exe, env, &mut classify_cached);
    let mut targets: Vec<UpdateTarget> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for candidate in candidates(boot_exe, env) {
        let Some((_, found)) = classify_cached(&candidate) else {
            continue;
        };
        for t in found {
            let key = std::fs::canonicalize(&t.path).unwrap_or_else(|_| PathBuf::from(&t.path));
            if !seen.contains(&key) {
                seen.push(key);
                targets.push(t);
            }
        }
    }
    (method, targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeEnv {
        vars: HashMap<String, String>,
        home: PathBuf,
        files: Vec<PathBuf>,
        read_only: Vec<PathBuf>,
        magics: HashMap<PathBuf, [u8; 4]>,
        run_out: HashMap<(PathBuf, String), String>,
    }

    impl FakeEnv {
        fn new(home: PathBuf) -> Self {
            FakeEnv {
                vars: HashMap::new(),
                home,
                files: Vec::new(),
                read_only: Vec::new(),
                magics: HashMap::new(),
                run_out: HashMap::new(),
            }
        }
        fn file(mut self, p: PathBuf, magic: [u8; 4]) -> Self {
            self.files.push(p.clone());
            self.magics.insert(p, magic);
            self
        }
        fn read_only(mut self, p: PathBuf) -> Self {
            self.read_only.push(p);
            self
        }
        fn var(mut self, k: &str, v: &str) -> Self {
            self.vars.insert(k.to_string(), v.to_string());
            self
        }
    }

    impl DetectEnv for FakeEnv {
        fn var(&self, k: &str) -> Option<String> {
            self.vars.get(k).cloned()
        }
        fn home(&self) -> PathBuf {
            self.home.clone()
        }
        fn read_magic(&self, p: &Path) -> Option<[u8; 4]> {
            self.magics.get(p).copied()
        }
        fn is_file(&self, p: &Path) -> bool {
            self.files.contains(&p.to_path_buf())
        }
        fn is_read_only(&self, dir: &Path) -> bool {
            self.read_only.iter().any(|r| dir.starts_with(r))
        }
        fn run(&self, prog: &Path, args: &[&str]) -> Option<String> {
            self.run_out
                .get(&(prog.to_path_buf(), args.join(" ")))
                .cloned()
        }
    }

    const ELF: [u8; 4] = *b"\x7fELF";
    const SHIM: [u8; 4] = *b"#!bi";
    const MACHO: [u8; 4] = [0xfe, 0xed, 0xfa, 0xcf];

    #[test]
    fn curl_local_bin_vst() {
        let home = PathBuf::from("/home/u");
        let vst = home.join(".local/bin/vst");
        let env = FakeEnv::new(home).file(vst.clone(), ELF);
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Curl);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, vst.to_string_lossy());
        assert!(targets[0].auto);
    }

    #[test]
    fn shim_script_rejected() {
        let home = PathBuf::from("/home/u");
        let vst = home.join(".local/bin/vst");
        let env = FakeEnv::new(home).file(vst.clone(), SHIM);
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Unknown);
        assert!(targets.is_empty());
    }

    #[test]
    fn cargo_target_unknown() {
        let home = PathBuf::from("/home/u");
        // boot exe in a cargo target dir with no adapters and not ~/.local/bin
        let vst = PathBuf::from("/home/u/project/target/debug/vst");
        let env = FakeEnv::new(home).file(vst.clone(), ELF);
        let (method, _) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Unknown);
    }

    #[test]
    fn dmg_from_app_contents() {
        let home = PathBuf::from("/home/u");
        let exe = PathBuf::from("/Applications/vibe-station.app/Contents/MacOS/vibe-station");
        let env = FakeEnv::new(home).file(exe.clone(), MACHO);
        let (method, targets) = detect(&exe, &env);
        assert_eq!(method, InstallMethod::Dmg);
        assert_eq!(targets[0].path, exe.to_string_lossy());
        assert!(!targets[0].auto);
    }

    #[test]
    fn appimage_vs_curl_appimage() {
        let home = PathBuf::from("/home/u");
        let curl_ap = home.join(".local/share/vibe-station/vibe-station.AppImage");
        let other_ap = PathBuf::from("/tmp/downloaded.AppImage");

        // curl-appimage when path == curl path
        let env = FakeEnv::new(home.clone()).file(curl_ap.clone(), ELF);
        let (m1, t1) = detect(&curl_ap, &env);
        assert_eq!(m1, InstallMethod::CurlAppImage);
        assert!(t1[0].auto);

        // plain appimage via $APPIMAGE env pointing elsewhere
        let env2 = FakeEnv::new(home)
            .var("APPIMAGE", "/tmp/downloaded.AppImage")
            .file(other_ap.clone(), ELF);
        let (m2, _) = detect(&other_ap, &env2);
        assert_eq!(m2, InstallMethod::AppImage);
    }

    #[test]
    fn curl_cli_and_curl_appimage_are_both_targets() {
        // install.sh on glibc x86_64 Linux installs both.
        let home = PathBuf::from("/home/u");
        let vst = home.join(".local/bin/vst");
        let ap = home.join(".local/share/vibe-station/vibe-station.AppImage");
        let env = FakeEnv::new(home.clone())
            .var("PATH", "/home/u/.local/bin:/usr/bin")
            .file(vst.clone(), ELF)
            .file(ap.clone(), ELF);
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Curl);
        let paths: Vec<&str> = targets.iter().map(|t| t.path.as_str()).collect();
        assert_eq!(
            paths,
            [vst.to_str().unwrap(), ap.to_str().unwrap()],
            "boot exe once (PATH duplicate dropped), then the AppImage"
        );
        assert!(targets.iter().all(|t| t.auto));
    }

    #[test]
    fn non_vst_binary_beside_adapters_is_not_a_curl_copy() {
        // e.g. the dev sandbox's /usr/local/bin/vst-daemon-rust next to claude-acp:
        // installing the tarball there would never replace it.
        let home = PathBuf::from("/home/u");
        let daemon = PathBuf::from("/usr/local/bin/vst-daemon-rust");
        let env = FakeEnv::new(home)
            .file(daemon.clone(), ELF)
            .file(PathBuf::from("/usr/local/bin/claude-acp"), ELF);
        let (method, targets) = detect(&daemon, &env);
        assert_eq!(method, InstallMethod::Unknown);
        assert!(targets.is_empty());
    }

    #[test]
    fn curl_cli_beside_dmg_app_lists_manual_dmg() {
        let home = PathBuf::from("/Users/u");
        let vst = home.join(".local/bin/vst");
        let app = PathBuf::from("/Applications/vibe-station.app/Contents/MacOS/vibe-station");
        let env = FakeEnv::new(home)
            .file(vst.clone(), MACHO)
            .file(app.clone(), MACHO);
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Curl);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[1].method, InstallMethod::Dmg);
        assert!(!targets[1].auto);
    }

    #[test]
    fn appimage_sidecar_vst_is_not_a_target_and_appimage_is() {
        let home = PathBuf::from("/home/u");
        let sidecar = PathBuf::from("/tmp/.mount_ab/usr/bin/vst");
        let ap = PathBuf::from("/home/u/Apps/vs.AppImage");
        let env = FakeEnv::new(home)
            .var("APPIMAGE", "/home/u/Apps/vs.AppImage")
            .var("APPDIR", "/tmp/.mount_ab")
            .file(sidecar.clone(), ELF)
            .file(PathBuf::from("/tmp/.mount_ab/usr/bin/claude-acp"), ELF)
            .file(ap.clone(), ELF);
        let (method, targets) = detect(&sidecar, &env);
        assert_eq!(method, InstallMethod::AppImage);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, ap.to_string_lossy());
        assert_eq!(targets[0].method, InstallMethod::AppImage);
        assert!(targets[0].auto);
    }

    #[test]
    fn read_only_mount_copy_is_skipped() {
        let home = PathBuf::from("/home/u");
        let vst = PathBuf::from("/mnt/ro/bin/vst");
        let env = FakeEnv::new(home)
            .file(vst.clone(), ELF)
            .file(PathBuf::from("/mnt/ro/bin/codex-acp"), ELF)
            .read_only(PathBuf::from("/mnt/ro"));
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Unknown);
        assert!(targets.is_empty());
    }

    #[test]
    fn vibe_station_beside_vst_is_not_a_curl_marker() {
        let home = PathBuf::from("/home/u");
        let vst = PathBuf::from("/opt/x/vst");
        let env = FakeEnv::new(home)
            .file(vst.clone(), ELF)
            .file(PathBuf::from("/opt/x/vibe-station"), ELF);
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Unknown);
        assert!(targets.is_empty());
    }

    #[test]
    fn unclassified_boot_exe_is_unknown_but_other_copies_still_listed() {
        let home = PathBuf::from("/home/u");
        let vst = PathBuf::from("/home/u/project/target/debug/vst");
        let ap = home.join(".local/share/vibe-station/vibe-station.AppImage");
        let env = FakeEnv::new(home)
            .file(vst.clone(), ELF)
            .file(ap.clone(), ELF);
        let (method, targets) = detect(&vst, &env);
        assert_eq!(method, InstallMethod::Unknown);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].method, InstallMethod::CurlAppImage);
        assert!(targets[0].auto);
    }

    /// Real-process env with a faked ELF magic so a shell script classifies.
    struct HangEnv(PathBuf);

    impl DetectEnv for HangEnv {
        fn var(&self, _: &str) -> Option<String> {
            None
        }
        fn home(&self) -> PathBuf {
            self.0.clone()
        }
        fn read_magic(&self, _: &Path) -> Option<[u8; 4]> {
            Some(ELF)
        }
        fn is_file(&self, p: &Path) -> bool {
            p.is_file()
        }
        fn is_read_only(&self, _: &Path) -> bool {
            false
        }
        fn run(&self, prog: &Path, args: &[&str]) -> Option<String> {
            RealEnv.run(prog, args)
        }
    }

    #[test]
    fn hung_vst_does_not_block_detect_d11() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let vst = bin.join("vst");
        std::fs::write(&vst, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&vst, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t0 = std::time::Instant::now();
        let (_, targets) = detect(&vst, &HangEnv(home.path().to_path_buf()));
        assert!(t0.elapsed() < std::time::Duration::from_secs(3));
        // Still classified as a curl copy, just without a version.
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].version, None);
    }
}
