//! Path identity and safety: canonical keys, the two denylist functions and
//! root confinement.
//!
//! Rules (plan Decision 5):
//! - a path is only ever compared after `std::fs::canonicalize` (which yields
//!   the on-disk case and Unicode form); a lexical normaliser is never used to
//!   build a key and `..` is never collapsed before symlinks are resolved;
//! - the dedupe key is NFC and is lower-cased only on a case-insensitive
//!   volume (probed once per device); the denylist ALWAYS folds case.

use std::collections::HashMap;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use icu_normalizer::ComposingNormalizer;

/// Why a path is not inside a root.
#[derive(Debug)]
pub enum ConfineError {
    /// The target resolves outside the (canonical) root.
    Escape,
    /// The target (or the root) does not exist: callers keep their 404.
    NotFound,
    /// Any other I/O failure while resolving.
    Io(io::Error),
}

impl std::fmt::Display for ConfineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfineError::Escape => write!(f, "path resolves outside the root"),
            ConfineError::NotFound => write!(f, "path not found"),
            ConfineError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ConfineError {}

fn map_confine(e: io::Error) -> ConfineError {
    if is_not_found(&e) {
        ConfineError::NotFound
    } else {
        ConfineError::Io(e)
    }
}

/// ENOENT, or ENOTDIR (a path component is a file): the file is not there.
pub fn is_not_found(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR)
}

/// Resolve `abs` and require it to live under the canonical `root`.
///
/// Both sides are canonicalized (a project root or macOS `/var` can itself be a
/// symlink). `Err(NotFound)` when either does not exist; `Err(Escape)` when the
/// canonical target is outside the canonical root. Returns the canonical target.
pub fn confine_to_root(root: &Path, abs: &Path) -> Result<PathBuf, ConfineError> {
    let canon_root = std::fs::canonicalize(root).map_err(map_confine)?;
    let canon = std::fs::canonicalize(abs).map_err(map_confine)?;
    if canon.starts_with(&canon_root) {
        Ok(canon)
    } else {
        Err(ConfineError::Escape)
    }
}

/// Canonical path plus the dedupe key built from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonKey {
    pub canonical: PathBuf,
    pub key: String,
}

/// Answers the two volume questions the key needs. Real code uses
/// [`FsProbe`]; tests stub it to model a case-sensitive volume or two devices.
pub trait VolumeProbe: Send + Sync + 'static {
    /// Device id of the directory (`st_dev`).
    fn device_of(&self, dir: &Path) -> Option<u64>;
    /// Is the volume holding `canonical_dir` case-insensitive? Called once per
    /// device; `canonical_dir` is the artifact's parent directory.
    fn case_insensitive(&self, canonical_dir: &Path) -> bool;
}

/// Probe backed by the real file system: swapped-case `stat` of the nearest
/// ancestor component (of the parent directory) that contains a cased letter.
#[derive(Clone, Copy, Debug, Default)]
pub struct FsProbe;

fn swap_case(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_lowercase() {
                c.to_uppercase().collect::<String>()
            } else if c.is_uppercase() {
                c.to_lowercase().collect::<String>()
            } else {
                c.to_string()
            }
        })
        .collect()
}

fn has_cased_letter(s: &str) -> bool {
    s.chars().any(|c| c.is_lowercase() || c.is_uppercase())
}

impl VolumeProbe for FsProbe {
    fn device_of(&self, dir: &Path) -> Option<u64> {
        std::fs::metadata(dir).ok().map(|m| m.dev())
    }

    fn case_insensitive(&self, canonical_dir: &Path) -> bool {
        let mut cur = Some(canonical_dir);
        while let Some(dir) = cur {
            if let (Some(name), Some(parent)) = (dir.file_name(), dir.parent()) {
                if let Some(name) = name.to_str().filter(|n| has_cased_letter(n)) {
                    let swapped = swap_case(name);
                    if swapped == name {
                        return false;
                    }
                    let orig = std::fs::metadata(dir);
                    let alt = std::fs::metadata(parent.join(swapped));
                    return match (orig, alt) {
                        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
                        _ => false,
                    };
                }
            }
            cur = dir.parent();
        }
        // No cased component at all (e.g. `/`): treat as case-sensitive.
        false
    }
}

/// Builds dedupe keys. Cheap to clone; the per-device probe cache is shared.
#[derive(Clone)]
pub struct PathKeyer {
    probe: Arc<dyn VolumeProbe>,
    cache: Arc<Mutex<HashMap<u64, bool>>>,
}

impl Default for PathKeyer {
    fn default() -> Self {
        Self::new(Arc::new(FsProbe))
    }
}

impl PathKeyer {
    pub fn new(probe: Arc<dyn VolumeProbe>) -> Self {
        Self {
            probe,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn insensitive(&self, canonical: &Path) -> bool {
        let Some(dir) = canonical.parent() else {
            return false;
        };
        let Some(dev) = self.probe.device_of(dir) else {
            return false;
        };
        if let Some(v) = self.cache.lock().unwrap().get(&dev) {
            return *v;
        }
        let v = self.probe.case_insensitive(dir);
        self.cache.lock().unwrap().insert(dev, v);
        v
    }

    /// The dedupe key for an already-canonical path: NFC, lower-cased only on
    /// a case-insensitive volume.
    pub fn key_for(&self, canonical: &Path) -> String {
        let s = nfc(&canonical.to_string_lossy());
        if self.insensitive(canonical) {
            s.to_lowercase()
        } else {
            s
        }
    }

    /// `canonicalize` the path and key it. For a path that no longer exists the
    /// PARENT is canonicalized and the file name appended (a deleted or
    /// moved-away file); `Err(NotFound)` when the parent is gone too. Callers
    /// that have a stored key for the row should prefer it for a missing file.
    pub fn canonicalize_key(&self, path: &Path) -> io::Result<CanonKey> {
        let canonical = match std::fs::canonicalize(path) {
            Ok(c) => c,
            Err(e) if is_not_found(&e) => {
                let name = path
                    .file_name()
                    .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
                let parent = path.parent().unwrap_or_else(|| Path::new("/"));
                std::fs::canonicalize(parent)?.join(name)
            }
            Err(e) => return Err(e),
        };
        let key = self.key_for(&canonical);
        Ok(CanonKey { canonical, key })
    }
}

fn nfc(s: &str) -> String {
    ComposingNormalizer::new_nfc().normalize(s).into_owned()
}

/// Case- and Unicode-folded components of a path, for denylist comparison.
fn fold_components(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(n) => {
                Some(nfc(&String::from_utf8_lossy(n.as_bytes())).to_lowercase())
            }
            _ => None,
        })
        .collect()
}

fn starts_with_folded(path: &[String], prefix: &[String]) -> bool {
    !prefix.is_empty() && path.len() >= prefix.len() && path[..prefix.len()] == *prefix
}

/// `~`-relative R19 directories/files.
const HOME_DENY: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".config/gh",
    ".claude.json",
    "Library/Keychains",
    // This product's own token and other harnesses' credential stores.
    ".config/vibe-station",
    ".codex",
    ".gemini",
    ".local/share/opencode",
    ".cursor",
    ".omp",
    // Cloud / package-registry / database credentials and shell histories.
    ".config/gcloud",
    ".azure",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".pypirc",
    ".pgpass",
    ".terraform.d",
    ".zsh_history",
    ".bash_history",
    ".local/share/keyrings",
];

/// Absolute system prefixes denied for every consumer.
const SYSTEM_DENY: &[&str] = &["/etc", "/root", "/private/etc", "/proc", "/sys"];

/// Home directories to protect: the parent of `vst_home` (`Paths` seam) and
/// `$HOME`, each in raw and canonical spelling.
fn home_dirs(vst_home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(parent) = vst_home.parent() {
        cands.push(parent.to_path_buf());
    }
    if let Some(h) = std::env::var_os("HOME") {
        if !h.is_empty() {
            cands.push(PathBuf::from(h));
        }
    }
    for c in cands {
        if let Ok(canon) = std::fs::canonicalize(&c) {
            add(canon);
        }
        add(c);
    }
    out
}

/// With every spelling of `p` (raw plus canonical when it exists).
fn spellings(p: &Path) -> Vec<PathBuf> {
    let mut v = vec![p.to_path_buf()];
    if let Ok(c) = std::fs::canonicalize(p) {
        if c != p {
            v.push(c);
        }
    }
    v
}

/// R19 directory prefixes ∪ the `SYSTEM_DENY` prefixes, matched on the
/// case-folded, NFC canonical path.
///
/// `vst_home` (from `Paths`, never a cached `$HOME`) is denied as a whole,
/// except below a registered project/worktree root that lives under it. This
/// is what `vst_lsp::is_sensitive_path` calls (with no registered roots), so
/// no name patterns reach dependency files such as `id_arena/src/lib.rs`.
pub fn is_denied_prefix(canonical: &Path, vst_home: &Path, registered_roots: &[PathBuf]) -> bool {
    let sets = deny_sets(vst_home);
    denied_by(&sets, canonical, registered_roots)
}

/// The folded prefix sets of the denylist. Building them canonicalizes every
/// `HOME_DENY` entry (about 100 `realpath` calls), so they are cached briefly.
struct DenySets {
    /// `SYSTEM_DENY` plus every `HOME_DENY` spelling.
    plain: Vec<Vec<String>>,
    /// `~/.claude` spellings (only `.credentials*` below them is denied).
    claude: Vec<Vec<String>>,
    /// Spellings of the data home.
    data_homes: Vec<Vec<String>>,
}

impl DenySets {
    fn build(vst_home: &Path) -> Self {
        let mut plain: Vec<Vec<String>> = SYSTEM_DENY
            .iter()
            .map(|sys| fold_components(Path::new(sys)))
            .collect();
        let mut claude = Vec::new();
        let homes = home_dirs(vst_home);
        for home in &homes {
            for suffix in HOME_DENY {
                for base in spellings(&home.join(suffix)) {
                    plain.push(fold_components(&base));
                }
            }
            for base in spellings(&home.join(".claude")) {
                claude.push(fold_components(&base));
            }
        }
        let mut data = vec![vst_home.to_path_buf()];
        for h in &homes {
            data.push(h.join(".vibe-station"));
        }
        let data_homes = data
            .iter()
            .flat_map(|h| spellings(h))
            .map(|vh| fold_components(&vh))
            .collect();
        Self {
            plain,
            claude,
            data_homes,
        }
    }
}

type DenyCacheEntry = (
    std::time::Instant,
    PathBuf,
    Option<std::ffi::OsString>,
    Arc<DenySets>,
);

/// How long built prefix sets are reused.
const DENY_SETS_TTL: std::time::Duration = std::time::Duration::from_secs(2);

fn deny_sets(vst_home: &Path) -> Arc<DenySets> {
    static CACHE: Mutex<Vec<DenyCacheEntry>> = Mutex::new(Vec::new());
    let home_env = std::env::var_os("HOME");
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|(at, ..)| at.elapsed() < DENY_SETS_TTL);
    if let Some((_, _, _, sets)) = cache
        .iter()
        .find(|(_, h, e, _)| h == vst_home && *e == home_env)
    {
        return sets.clone();
    }
    let sets = Arc::new(DenySets::build(vst_home));
    cache.push((
        std::time::Instant::now(),
        vst_home.to_path_buf(),
        home_env,
        sets.clone(),
    ));
    sets
}

fn denied_by(sets: &DenySets, canonical: &Path, registered_roots: &[PathBuf]) -> bool {
    let path = fold_components(canonical);
    if sets.plain.iter().any(|p| starts_with_folded(&path, p)) {
        return true;
    }
    // `~/.claude/.credentials*`
    for b in &sets.claude {
        if path.len() > b.len()
            && starts_with_folded(&path, b)
            && path[b.len()].starts_with(".credentials")
        {
            return true;
        }
    }
    // The whole data home, minus registered project/worktree roots inside it.
    for vh_f in &sets.data_homes {
        if starts_with_folded(&path, vh_f) {
            let registered = registered_roots.iter().any(|r| {
                spellings(r).iter().any(|s| {
                    let rf = fold_components(s);
                    starts_with_folded(&rf, vh_f) && starts_with_folded(&path, &rf)
                })
            });
            if !registered {
                return true;
            }
        }
    }
    false
}

/// R19 file-name patterns (`id_*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `.env*`), checked on the
/// final component only.
fn name_denied(canonical: &Path) -> bool {
    let Some(name) = canonical.file_name() else {
        return false;
    };
    let n = nfc(&name.to_string_lossy()).to_lowercase();
    n.starts_with("id_")
        || [".pem", ".key", ".p12", ".pfx", ".kdbx"]
            .iter()
            .any(|ext| n.ends_with(ext))
        || n.starts_with(".env")
}

/// [`is_denied_prefix`] ∪ the R19 name patterns. Used for artifacts only.
pub fn is_denied(canonical: &Path, vst_home: &Path, registered_roots: &[PathBuf]) -> bool {
    name_denied(canonical) || is_denied_prefix(canonical, vst_home, registered_roots)
}

/// UI-only rendering of a canonical path: repo-relative inside the root,
/// otherwise absolute with `$HOME` shown as `~` and the macOS `/private`
/// aliases collapsed. Never used for access decisions.
pub fn display_path(root: Option<&Path>, canonical: &Path, home: Option<&Path>) -> String {
    if let Some(root) = root {
        if let Ok(rel) = canonical.strip_prefix(root) {
            let s = rel.to_string_lossy();
            if !s.is_empty() {
                return s.into_owned();
            }
        }
    }
    if let Some(home) = home {
        if let Ok(rel) = canonical.strip_prefix(home) {
            let s = rel.to_string_lossy();
            return if s.is_empty() {
                "~".to_string()
            } else {
                format!("~/{s}")
            };
        }
    }
    for alias in ["tmp", "var", "etc"] {
        if let Ok(rel) = canonical.strip_prefix(Path::new("/private").join(alias)) {
            let s = rel.to_string_lossy();
            return if s.is_empty() {
                format!("/{alias}")
            } else {
                format!("/{alias}/{s}")
            };
        }
    }
    canonical.to_string_lossy().into_owned()
}

/// A path is acceptable input for `vst artifact add` / effects: non-empty, no
/// NUL or control characters, and at most 4096 bytes.
pub fn is_sane_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 4096 && !p.chars().any(char::is_control)
}

#[cfg(test)]
mod deny_cache_tests {
    use super::*;

    #[test]
    fn cached_sets_give_the_same_verdicts_as_fresh_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let vst_home = tmp.path().join(".vibe-station");
        std::fs::create_dir_all(&vst_home).unwrap();
        let fresh = DenySets::build(&vst_home);
        let home = vst_home.parent().unwrap().to_path_buf();
        let reg = vec![vst_home.join("worktrees/w1")];
        for p in [
            home.join(".ssh/id_rsa"),
            home.join(".claude/.credentials.json"),
            home.join(".claude/plans/x.md"),
            vst_home.join("config.json"),
            vst_home.join("worktrees/w1/a.md"),
            PathBuf::from("/etc/passwd"),
            PathBuf::from("/tmp/ok.md"),
        ] {
            assert_eq!(
                denied_by(&fresh, &p, &reg),
                is_denied_prefix(&p, &vst_home, &reg),
                "{}",
                p.display()
            );
        }
    }
}
