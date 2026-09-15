//! User skill catalog — scans configured `skillPaths` directories for
//! `<dir>/<name>/SKILL.md` user skills, watches them for changes (debounced),
//! and merges them with the ACP `commands_update` catalog per-field
//! (skill-invocation-in-chat Decision 7). Ports `services/userSkillCatalog.ts`.
//!
//! NOT to be confused with the repo's own same-named things (see AGENTS.md,
//! "Three unrelated things named skill").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use vst_types::Command;

const SKILL_FILE: &str = "SKILL.md";
const DEBOUNCE_MS: u64 = 200;

/// A single scanned `<dir>/<name>/SKILL.md` entry.
#[derive(Clone, Debug, PartialEq)]
pub struct SkillCatalogEntry {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// Absolute path to the skill's SKILL.md — directory-scanned entries only.
    pub path: PathBuf,
}

/// Per-directory scan outcome, surfaced in `GET /skills` (no error status).
#[derive(Clone, Debug, PartialEq)]
pub struct SkillDirectoryStatus {
    pub path: String,
    pub skill_count: usize,
    /// Set only for a REAL failure (permissions, I/O). An absent directory is
    /// reported via `missing`, not here.
    pub error: Option<String>,
    /// True when the directory is absent (ENOENT). Not a failure.
    pub missing: bool,
}

/// A per-field merged catalog entry (Decision 7): on a name collision, ACP
/// wins `description`/`argumentHint`; `path` comes ONLY from the
/// directory-scanned entry and is `None` for an ACP-only name.
#[derive(Clone, Debug, PartialEq)]
pub struct MergedSkillEntry {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub path: Option<PathBuf>,
}

/// Result of scanning one `skillPaths` directory.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanResult {
    pub entries: Vec<SkillCatalogEntry>,
    pub status: SkillDirectoryStatus,
}

/// Parse a SKILL.md's YAML-ish frontmatter defensively. Only a bounded
/// `---\n...\n---` block with simple `key: value` lines is understood; anything
/// else returns `None` rather than failing.
pub fn parse_skill_frontmatter(content: &str) -> Option<HashMap<String, String>> {
    if !content.starts_with("---") {
        return None;
    }
    let first_line_end = content.find('\n')?;
    let close_idx = content[first_line_end..].find("\n---")? + first_line_end;
    let block = &content[first_line_end + 1..close_idx];
    let mut fields = HashMap::new();
    for line in block.lines() {
        let line = line.trim();
        let m = line.find(':')?;
        // key must match ^[A-Za-z0-9_-]+:
        let key = &line[..m];
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        let mut value = line[m + 1..].trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len() - 1].to_string();
        }
        fields.insert(key.to_string(), value);
    }
    Some(fields)
}

/// Scan one `skillPaths` directory for `<name>/SKILL.md` skills. Never fails —
/// a missing directory, unreadable subdirectory, or malformed SKILL.md all
/// degrade to a per-directory `error`/`missing` status.
pub fn scan_skill_directory(dir: &Path) -> ScanResult {
    let mut entries: Vec<SkillCatalogEntry> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    let dirents = match std::fs::read_dir(dir) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ScanResult {
                entries,
                status: SkillDirectoryStatus {
                    path: dir.display().to_string(),
                    skill_count: 0,
                    error: None,
                    missing: true,
                },
            };
        }
        Err(e) => {
            return ScanResult {
                entries,
                status: SkillDirectoryStatus {
                    path: dir.display().to_string(),
                    skill_count: 0,
                    error: Some(e.to_string()),
                    missing: false,
                },
            };
        }
    };

    for dirent in dirents.flatten() {
        let ftype = match dirent.file_type() {
            Ok(t) => t,
            Err(_) => match std::fs::metadata(dirent.path()) {
                Ok(m) => m.file_type(),
                Err(_) => continue,
            },
        };
        if !(ftype.is_dir() || ftype.is_symlink()) {
            continue;
        }
        let skill_dir = dirent.path();
        if ftype.is_symlink() {
            let resolved = std::fs::metadata(&skill_dir).ok();
            match resolved {
                Some(m) if m.is_dir() => {}
                _ => continue,
            }
        }
        let skill_file = skill_dir.join(SKILL_FILE);
        let content = match std::fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(_) => continue, // no SKILL.md in this subdirectory — not a skill
        };
        let frontmatter = parse_skill_frontmatter(&content);
        let name = frontmatter.as_ref().and_then(|f| f.get("name"));
        let name = match name {
            Some(n) if !n.is_empty() => n.clone(),
            _ => {
                skipped.push(skill_file.display().to_string());
                continue;
            }
        };
        let argument_hint = frontmatter
            .as_ref()
            .and_then(|f| f.get("argumentHint"))
            .or_else(|| frontmatter.as_ref().and_then(|f| f.get("argument-hint")))
            .cloned();
        entries.push(SkillCatalogEntry {
            name,
            description: frontmatter
                .as_ref()
                .and_then(|f| f.get("description"))
                .cloned(),
            argument_hint,
            path: skill_file,
        });
    }

    let error = if skipped.is_empty() {
        None
    } else {
        Some(format!(
            "{} skill(s) skipped (missing \"name\" in frontmatter): {}",
            skipped.len(),
            skipped.join(", ")
        ))
    };
    ScanResult {
        status: SkillDirectoryStatus {
            path: dir.display().to_string(),
            skill_count: entries.len(),
            error,
            missing: false,
        },
        entries,
    }
}

/// Per-field merge of the ACP catalog with directory-scanned entries (Decision 7).
pub fn merge_catalogs(
    acp_commands: &[Command],
    dir_entries: &[SkillCatalogEntry],
) -> Vec<MergedSkillEntry> {
    let mut by_name: HashMap<String, MergedSkillEntry> = HashMap::new();

    for entry in dir_entries {
        by_name.insert(
            entry.name.clone(),
            MergedSkillEntry {
                name: entry.name.clone(),
                description: entry.description.clone(),
                argument_hint: entry.argument_hint.clone(),
                path: Some(entry.path.clone()),
            },
        );
    }

    for cmd in acp_commands {
        let existing = by_name.get(&cmd.name);
        by_name.insert(
            cmd.name.clone(),
            MergedSkillEntry {
                name: cmd.name.clone(),
                // ACP wins on a real (non-empty) value; an ABSENT or EMPTY ACP
                // field must not clobber a directory entry's real one. `||`
                // semantics — empty string falls through.
                description: {
                    let d = cmd.description.clone();
                    if !d.is_empty() {
                        Some(d)
                    } else {
                        existing.and_then(|e| e.description.clone())
                    }
                },
                argument_hint: {
                    let a = cmd.argument_hint.clone();
                    if a.as_ref().map(|s| !s.is_empty()).unwrap_or(false) {
                        a
                    } else {
                        existing.and_then(|e| e.argument_hint.clone())
                    }
                },
                // path comes ONLY from a directory entry — never from ACP.
                path: existing.and_then(|e| e.path.clone()),
            },
        );
    }

    by_name.into_values().collect()
}

// ── Singleton state ─────────────────────────────────────────────────────────
// One in-memory catalog for the whole daemon process (skills are global, not
// per-session). Rebuilt from `skillPaths` on `set_skill_paths`/`refresh` and
// kept current by a debounced watch per directory.

static PATHS: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());
static ENTRIES: RwLock<Vec<SkillCatalogEntry>> = RwLock::new(Vec::new());
static DIRECTORIES: RwLock<Vec<SkillDirectoryStatus>> = RwLock::new(Vec::new());

fn scan_all(paths: &[PathBuf]) {
    let results: Vec<ScanResult> = paths.iter().map(|p| scan_skill_directory(p)).collect();
    *ENTRIES.write().unwrap() = results.iter().flat_map(|r| r.entries.clone()).collect();
    *DIRECTORIES.write().unwrap() = results.iter().map(|r| r.status.clone()).collect();
}

/// Rescan + rewatch a new `skillPaths` directory set (from `PATCH /settings`).
/// Starts a debounced background watcher per directory set.
pub async fn set_skill_paths(paths: &[String]) {
    let pathbufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    *PATHS.write().unwrap() = pathbufs.clone();
    scan_all(&pathbufs);
    start_watching(pathbufs);
}

/// Rescan the currently-set `skillPaths` without changing the watch set.
pub async fn refresh_skill_catalog() {
    let paths = PATHS.read().unwrap().clone();
    scan_all(&paths);
}

/// Current directory-scanned entries (flattened across all `skillPaths`).
pub fn get_skill_entries() -> Vec<SkillCatalogEntry> {
    ENTRIES.read().unwrap().clone()
}

/// Current per-directory scan status, for `GET /skills`.
pub fn get_skill_directories() -> Vec<SkillDirectoryStatus> {
    DIRECTORIES.read().unwrap().clone()
}

/// The merged view (Decision 7) — ACP catalog overlaid on directory entries.
pub fn get_merged_skill_catalog(acp_commands: &[Command]) -> Vec<MergedSkillEntry> {
    let dir_entries = get_skill_entries();
    merge_catalogs(acp_commands, &dir_entries)
}

/// Test-only: stop watchers and reset in-memory state between test cases.
pub fn reset_skill_catalog_for_tests() {
    stop_watching();
    *PATHS.write().unwrap() = Vec::new();
    *ENTRIES.write().unwrap() = Vec::new();
    *DIRECTORIES.write().unwrap() = Vec::new();
}

// ── Watcher (Gotcha #9: chokidar → notify) ─────────────────────────────────
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static WATCH_ACTIVE: AtomicBool = AtomicBool::new(false);

fn start_watching(paths: Vec<PathBuf>) {
    stop_watching();
    if paths.is_empty() {
        return;
    }
    WATCH_ACTIVE.store(true, Ordering::SeqCst);
    tokio::spawn(async move {
        use notify::{RecommendedWatcher, RecursiveMode, Watcher};
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(64);
        let mut watcher = match RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if res.is_ok() {
                    let _ = tx.blocking_send(());
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(_) => return,
        };
        for p in &paths {
            let _ = watcher.watch(p, RecursiveMode::Recursive);
        }
        let mut last_schedule: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                _ = rx.recv() => {
                    let now = tokio::time::Instant::now();
                    match last_schedule {
                        Some(last) if now.duration_since(last) < Duration::from_millis(DEBOUNCE_MS) => {}
                        _ => {
                            last_schedule = Some(now);
                            // Debounced rescan on a background thread (scan is sync).
                            let paths = PATHS.read().unwrap().clone();
                            tokio::task::spawn_blocking(move || scan_all(&paths));
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            if !WATCH_ACTIVE.load(Ordering::SeqCst) {
                break;
            }
        }
    });
}

fn stop_watching() {
    WATCH_ACTIVE.store(false, Ordering::SeqCst);
}
