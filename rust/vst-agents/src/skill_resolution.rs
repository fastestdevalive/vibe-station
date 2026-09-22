//! Skill-invocation resolution at turn-run time (ports the top-level pure
//! functions of `services/jsonAgent.ts`: `resolveSkillInvocations`,
//! `resolveLeadingLineInvocation`, `mergeWithSkillCatalog`,
//! `cliSupportsSkillDirective`, `injectAttachments`), plus the user skill
//! catalog itself — scans configured `skillPaths` directories for
//! `<dir>/<name>/SKILL.md` user skills, watches them for changes (debounced),
//! and merges them with the ACP `commands_update` catalog per-field
//! (skill-invocation-in-chat Decision 7). Ports `services/userSkillCatalog.ts`.
//! This is the SINGLE source of truth for skill discovery — `GET /skills`
//! (`vst-routes/src/skills.rs`) reads the same catalog rather than rescanning.
//!
//! NOT to be confused with the repo's own same-named things (see AGENTS.md,
//! "Three unrelated things named skill").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use vst_types::{Attachment, Command};

use crate::skill_tokens::{parse_skill_segments, SkillSegment};

/// A single resolved `{/name args}` token, feeding `formatSkillDirective`'s
/// `<skill-invocations>` block. `path` is omitted for an ACP-only catalog
/// entry (no directory-scanned path).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSkillInvocation {
    pub name: String,
    pub args: String,
    pub path: Option<String>,
}

/// Result of resolving every skill token in a raw turn message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillResolutionResult {
    /// `rawMessage` with every token substituted inline for `/name args`
    /// (RESOLVED or not). A message with no tokens passes through byte-identical.
    pub message: String,
    /// One entry per RESOLVED token, in document order. An unresolved token
    /// still substitutes into `message` but contributes no entry here.
    pub skill_invocations: Vec<ResolvedSkillInvocation>,
}

/// v1 fallback (7A.5): resolve line 1 of a raw turn message against the merged
/// skill catalog — longest-match name, followed by a space or end-of-line.
/// Returns `None` when line 1 doesn't start with "/" + a catalog name.
fn resolve_leading_line_invocation(
    raw_message: &str,
    catalog: &[MergedSkillEntry],
) -> Option<ResolvedSkillInvocation> {
    if !raw_message.starts_with('/') {
        return None;
    }
    let nl = raw_message.find('\n');
    let first_line = match nl {
        Some(idx) => &raw_message[..idx],
        None => raw_message,
    };

    let mut best: Option<&MergedSkillEntry> = None;
    for entry in catalog {
        if entry.name.is_empty() {
            continue;
        }
        let token = format!("/{}", entry.name);
        let matches = first_line == token || first_line.starts_with(&format!("{token} "));
        if matches && (best.is_none() || entry.name.len() > best.unwrap().name.len()) {
            best = Some(entry);
        }
    }
    let best = best?;

    let rest = &first_line[1 + best.name.len()..];
    let args = if let Some(stripped) = rest.strip_prefix(' ') {
        stripped.to_string()
    } else {
        rest.to_string()
    };
    Some(ResolvedSkillInvocation {
        name: best.name.clone(),
        args,
        path: best.path.as_ref().map(|p| p.display().to_string()),
    })
}

/// Resolve every `{/name args}` token in `rawMessage` against the merged skill
/// catalog at TURN-RUN time (never enqueue time). Inline substitution (D5/7A.3):
/// every token — resolved or not — is replaced by `/name args`. A RESOLVED token
/// additionally contributes a `{name, args, path?}` entry. D7: when the FIRST
/// segment is a RESOLVED token followed by same-line prose, the substitution
/// forces a newline after it. v1 fallback: a message with NO tokens is handed
/// to `resolve_leading_line_invocation`.
pub fn resolve_skill_invocations(
    raw_message: &str,
    catalog: &[MergedSkillEntry],
) -> SkillResolutionResult {
    let segments = parse_skill_segments(raw_message);
    let has_token = segments.iter().any(|s| s.is_token());

    if !has_token {
        let legacy = resolve_leading_line_invocation(raw_message, catalog);
        return SkillResolutionResult {
            message: raw_message.to_string(),
            skill_invocations: legacy.into_iter().collect(),
        };
    }

    let mut skill_invocations: Vec<ResolvedSkillInvocation> = Vec::new();
    let mut pieces: Vec<String> = Vec::new();

    for seg in &segments {
        match seg {
            SkillSegment::Text(text) => {
                pieces.push(text.clone());
            }
            SkillSegment::Token { name, args } => {
                if let Some(entry) = catalog.iter().find(|e| e.name == *name) {
                    skill_invocations.push(ResolvedSkillInvocation {
                        name: name.clone(),
                        args: args.clone(),
                        path: entry.path.as_ref().map(|p| p.display().to_string()),
                    });
                }
                pieces.push(if args.is_empty() {
                    format!("/{name}")
                } else {
                    format!("/{name} {args}")
                });
            }
        }
    }

    let first = segments.first();
    let first_is_resolved_token = match first {
        Some(SkillSegment::Token { name, .. }) => catalog.iter().any(|e| e.name == *name),
        _ => false,
    };
    if first_is_resolved_token {
        let head = pieces[0].clone();
        let rest: String = pieces[1..].join("");
        let message = if rest.is_empty() || rest.starts_with('\n') {
            format!("{head}{rest}")
        } else {
            let rest = if let Some(stripped) = rest.strip_prefix(' ') {
                stripped.to_string()
            } else {
                rest
            };
            format!("{head}\n{rest}")
        };
        return SkillResolutionResult {
            message,
            skill_invocations,
        };
    }

    SkillResolutionResult {
        message: pieces.join(""),
        skill_invocations,
    }
}

/// Skills are CLI-agnostic on the no-live-session rebuild path.
pub fn cli_supports_skill_directive(_cli: &str) -> bool {
    true
}

/// Overlay the directory-scanned catalog onto the ACP `commands_update` catalog
/// for the popover-facing `SessionMeta.commands` field. Per-field merge: ACP
/// wins `description`/`argumentHint`; `path` is resolved separately daemon-side
/// and never appears here. Returns `None` only when NEITHER source has answered
/// yet (the genuinely transient "still loading" state).
pub fn merge_with_skill_catalog(
    acp_commands: Option<&[Command]>,
    supports_skill_directive: bool,
) -> Option<Vec<Command>> {
    let acp: &[Command] = acp_commands.unwrap_or(&[]);
    let merged = get_merged_skill_catalog(acp);
    let filtered = merged
        .into_iter()
        .filter(|entry| supports_skill_directive || entry.path.is_none())
        .map(|entry| Command {
            name: entry.name,
            description: entry.description.unwrap_or_default(),
            argument_hint: entry.argument_hint,
        })
        .collect::<Vec<_>>();
    if filtered.is_empty() && acp_commands.is_none() {
        return None;
    }
    Some(filtered)
}

/// Inject absolute attachment paths into a user message (Decision 5). Applied at
/// RUN time (not enqueue) so the queued turn retains the raw user text.
pub fn inject_attachments(
    message: &str,
    attachments: &[Attachment],
    has_resolved_invocation: bool,
) -> String {
    if attachments.is_empty() {
        return message.to_string();
    }
    let list = attachments
        .iter()
        .map(|a| a.path.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let header = format!("[Attached files:]\n{list}");
    if !message.trim().is_empty() || has_resolved_invocation {
        format!("{message}\n\n{header}")
    } else {
        header
    }
}

// ── User skill catalog ──────────────────────────────────────────────────────
// Directory-scanned `<skillPaths>/<name>/SKILL.md` skills, kept live by a
// debounced watcher and merged with the ACP `commands_update` catalog above.

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
/// `---\n...\n---` block is understood; a `key: value` line is extracted, any
/// other line (a YAML list item, a blank line, ...) is skipped rather than
/// aborting the whole parse.
pub fn parse_skill_frontmatter(content: &str) -> Option<HashMap<String, String>> {
    if !content.starts_with("---") {
        return None;
    }
    let first_line_end = content.find('\n')?;
    // Search AFTER the opening fence's own newline — searching from
    // `first_line_end` itself would match that same newline against an
    // immediately-following `---` (an empty block, `"---\n---\n"`) and
    // produce a `close_idx` behind `first_line_end + 1`, panicking the
    // slice below.
    let close_idx = content[first_line_end + 1..].find("\n---")? + first_line_end + 1;
    let block = &content[first_line_end + 1..close_idx];
    let mut fields = HashMap::new();
    for line in block.lines() {
        let line = line.trim();
        let m = match line.find(':') {
            Some(m) => m,
            None => continue,
        };
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

/// Dedup by name (first occurrence, in `skillPaths` order, wins) so a skill
/// symlinked/present under more than one configured root shows up exactly
/// once — same "name is the unique key" semantics `merge_catalogs` already
/// uses. Pure — no singleton access — so it's independently unit-testable
/// without racing other tests over the shared statics below.
pub fn dedup_scan_results(results: &[ScanResult]) -> Vec<SkillCatalogEntry> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut deduped: Vec<SkillCatalogEntry> = Vec::new();
    for r in results {
        for entry in &r.entries {
            if seen.insert(entry.name.clone()) {
                deduped.push(entry.clone());
            }
        }
    }
    deduped.sort_by(|a, b| a.name.cmp(&b.name));
    deduped
}

fn scan_all(paths: &[PathBuf]) {
    let results: Vec<ScanResult> = paths.iter().map(|p| scan_skill_directory(p)).collect();
    *ENTRIES.write().unwrap() = dedup_scan_results(&results);
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

/// Current directory-scanned entries (flattened across all `skillPaths`, deduped by name).
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// A generation counter, not a bool: `set_skill_paths` can now be called
// repeatedly at runtime (every `PATCH /settings` that touches `skillPaths`,
// not just once at daemon startup). A bool flip-then-reflip race would leak
// the PREVIOUS watcher task forever — `stop_watching` flips it false, but
// `start_watching`'s very next line flips it back true before the old task's
// loop ever gets to observe `false`, so it never breaks. Each spawned task
// captures the generation it was started with and only keeps running while
// it's still the current one.
static WATCH_GENERATION: AtomicU64 = AtomicU64::new(0);

fn start_watching(paths: Vec<PathBuf>) {
    // Bump first — invalidates any previously running watcher task whether
    // or not we spawn a new one below.
    let generation = WATCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if paths.is_empty() {
        return;
    }
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
            if WATCH_GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
        }
    });
}

fn stop_watching() {
    WATCH_GENERATION.fetch_add(1, Ordering::SeqCst);
}
