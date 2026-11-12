//! Validation of a user-chosen account folder (Decision 7).
//!
//! Pure apart from reading the chosen folder's canonical path and its entry
//! NAMES (never contents). Every comparison uses canonical paths, compared
//! with `Path::starts_with` (component-wise), folded to lowercase per
//! component only on a case-insensitive volume ([`case_rule_of`]), so
//! `~/.claude-x` is never treated as inside `~/.claude`. The daemon turns a
//! [`PathRefusal`] into an HTTP code and message (`account_errors.rs`).

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Longest accepted input, in characters.
const MAX_INPUT_CHARS: usize = 4096;

/// Most entry names reported in [`Checked::names`].
const MAX_NAMES: usize = 200;

/// Why a chosen folder was refused. Turned into a code/status/text by the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathRefusal {
    /// Empty, too long, contains NUL, not absolute, or has a `..` component.
    Invalid,
    /// `/`, the home folder, or an ancestor of the system or accounts folder.
    TooBroad,
    /// The path does not exist.
    NotFound,
    /// The path exists but is a file.
    NotADirectory,
    /// The folder exists but cannot be read.
    Unreadable,
    /// The harness's own login folder (or inside it).
    SystemFolder,
    /// Inside the accounts root; `owner` names the account whose folder holds it.
    InsideRoot { owner: Option<String> },
    /// The folder is already an account's folder.
    Duplicate { id: String, name: String },
    /// Inside (`inside: true`) or containing (`inside: false`) another account's folder.
    Nested {
        id: String,
        name: String,
        inside: bool,
    },
}

/// An existing account whose folder is compared against the chosen one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtherAccount {
    pub id: String,
    pub name: String,
    pub dir: PathBuf,
}

/// A folder that passed every check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    /// The canonical path.
    pub resolved: PathBuf,
    /// True when the folder has no entries.
    pub is_empty: bool,
    /// Up to 200 entry NAMES (never contents).
    pub names: Vec<String>,
}

/// Whether two names differing only in case are the same folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseRule {
    /// ext4 and friends: `CaseDir` and `casedir` are different folders.
    Sensitive,
    /// APFS default and friends: the comparison is case-folded.
    Insensitive,
}

/// Validate a folder the user chose for an account. See the module docs for the
/// check order; the first failing check wins. The case rule is probed on the
/// chosen folder's own volume.
///
/// # Errors
///
/// The [`PathRefusal`] for the first check that fails.
pub fn check_chosen(
    input: &str,
    home: &Path,
    root: &Path,
    system_dir: Option<&Path>,
    others: &[OtherAccount],
) -> Result<Checked, PathRefusal> {
    check_chosen_inner(input, home, root, system_dir, others, None)
}

/// [`check_chosen`] with the case rule injected (tests, host-independent).
///
/// # Errors
///
/// The [`PathRefusal`] for the first check that fails.
pub fn check_chosen_with(
    input: &str,
    home: &Path,
    root: &Path,
    system_dir: Option<&Path>,
    others: &[OtherAccount],
    rule: CaseRule,
) -> Result<Checked, PathRefusal> {
    check_chosen_inner(input, home, root, system_dir, others, Some(rule))
}

fn check_chosen_inner(
    input: &str,
    home: &Path,
    root: &Path,
    system_dir: Option<&Path>,
    others: &[OtherAccount],
    rule: Option<CaseRule>,
) -> Result<Checked, PathRefusal> {
    let expanded = expand_input(input, home)?;
    let resolved = canonical(&expanded)?;
    let meta = fs::metadata(&resolved).map_err(|_| PathRefusal::Unreadable)?;
    if !meta.is_dir() {
        return Err(PathRefusal::NotADirectory);
    }
    let (is_empty, names) = list_names(&resolved)?;
    let rule = rule.unwrap_or_else(|| case_rule_of(&resolved));

    let home_c = canon_or_self(home);
    let root_c = canon_or_self(root);
    let system_c = system_dir.map(canon_or_self);
    let others_c: Vec<OtherAccount> = others
        .iter()
        .map(|o| OtherAccount {
            dir: canon_or_self(&o.dir),
            ..o.clone()
        })
        .collect();
    if let Some(r) = refusal_for(
        &resolved,
        &home_c,
        &root_c,
        system_c.as_deref(),
        &others_c,
        rule,
    ) {
        return Err(r);
    }
    Ok(Checked {
        resolved,
        is_empty,
        names,
    })
}

/// The comparison half of [`check_chosen`]: pure, no filesystem. Every path is
/// already canonical. Order: too broad, system folder, inside the root,
/// duplicate, nested inside, nested around.
#[must_use]
pub fn refusal_for(
    resolved: &Path,
    home: &Path,
    root: &Path,
    system: Option<&Path>,
    others: &[OtherAccount],
    rule: CaseRule,
) -> Option<PathRefusal> {
    let resolved_f = folded(resolved, rule);
    let home_f = folded(home, rule);
    let root_f = folded(root, rule);
    let system_f = system.map(|s| folded(s, rule));
    if is_forbidden_ancestor(&resolved_f, &home_f, &root_f, system_f.as_deref()) {
        return Some(PathRefusal::TooBroad);
    }
    if system_f.as_ref().is_some_and(|s| resolved_f.starts_with(s)) {
        return Some(PathRefusal::SystemFolder);
    }
    if resolved_f.starts_with(&root_f) {
        return Some(PathRefusal::InsideRoot {
            owner: owner_of(&resolved_f, others, rule),
        });
    }
    compare_others(&resolved_f, others, rule).err()
}

/// Probe whether `dir`'s volume folds case: walking up, take the first
/// component with a cased character, swap its case, and see whether that
/// sibling is the same inode. Missing, different inode, or no cased
/// character anywhere: `Sensitive`.
#[must_use]
pub fn case_rule_of(dir: &Path) -> CaseRule {
    use std::os::unix::fs::MetadataExt;
    let mut cur = dir;
    loop {
        if let Some(name) = cur.file_name().and_then(|n| n.to_str()) {
            let swapped: String = name
                .chars()
                .map(|c| {
                    if c.is_lowercase() {
                        c.to_uppercase().collect::<String>()
                    } else if c.is_uppercase() {
                        c.to_lowercase().collect::<String>()
                    } else {
                        c.to_string()
                    }
                })
                .collect();
            if swapped != name {
                let sibling = cur.with_file_name(swapped);
                let same = match (fs::symlink_metadata(cur), fs::symlink_metadata(sibling)) {
                    (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
                    _ => false,
                };
                return if same {
                    CaseRule::Insensitive
                } else {
                    CaseRule::Sensitive
                };
            }
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return CaseRule::Sensitive,
        }
    }
}

/// Trim, reject NUL/over-long/relative/`..` input, and expand a leading `~`.
fn expand_input(input: &str, home: &Path) -> Result<PathBuf, PathRefusal> {
    let trimmed = input.trim();
    if trimmed.contains('\0') || trimmed.chars().count() > MAX_INPUT_CHARS {
        return Err(PathRefusal::Invalid);
    }
    let expanded = if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    let bad = !expanded.is_absolute()
        || expanded
            .components()
            .any(|c| matches!(c, Component::ParentDir));
    if bad {
        Err(PathRefusal::Invalid)
    } else {
        Ok(expanded)
    }
}

/// Canonicalize; a permission error is `Unreadable`, anything else `NotFound`.
fn canonical(path: &Path) -> Result<PathBuf, PathRefusal> {
    fs::canonicalize(path).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => PathRefusal::Unreadable,
        _ => PathRefusal::NotFound,
    })
}

/// Canonical form of `path`, or `path` unchanged when it does not exist.
fn canon_or_self(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Components kept component-wise; lowercased only for [`CaseRule::Insensitive`].
fn folded(path: &Path, rule: CaseRule) -> PathBuf {
    path.components()
        .map(|c| {
            let s = c.as_os_str().to_string_lossy();
            match rule {
                CaseRule::Insensitive => s.to_lowercase(),
                CaseRule::Sensitive => s.into_owned(),
            }
        })
        .collect()
}

/// Whether the folder is `/`, the home folder, or a strict ancestor of the
/// system folder or the accounts root (e.g. `~/.vibe-station` with no accounts).
fn is_forbidden_ancestor(resolved: &Path, home: &Path, root: &Path, system: Option<&Path>) -> bool {
    let strict_ancestor_of = |of: &Path| of.starts_with(resolved) && of != resolved;
    resolved == Path::new("/")
        || resolved == home
        || strict_ancestor_of(root)
        || system.is_some_and(strict_ancestor_of)
}

/// Name of the account whose folder equals or contains `resolved`, if any.
fn owner_of(resolved: &Path, others: &[OtherAccount], rule: CaseRule) -> Option<String> {
    others
        .iter()
        .find(|o| resolved.starts_with(folded(&o.dir, rule)))
        .map(|o| o.name.clone())
}

/// Refuse a folder equal to, inside, or containing another account's folder.
fn compare_others(
    resolved: &Path,
    others: &[OtherAccount],
    rule: CaseRule,
) -> Result<(), PathRefusal> {
    for o in others {
        if folded(&o.dir, rule) == resolved {
            return Err(duplicate(o));
        }
    }
    for o in others {
        if resolved.starts_with(folded(&o.dir, rule)) {
            return Err(nested(o, true));
        }
    }
    for o in others {
        if folded(&o.dir, rule).starts_with(resolved) {
            return Err(nested(o, false));
        }
    }
    Ok(())
}

fn duplicate(o: &OtherAccount) -> PathRefusal {
    PathRefusal::Duplicate {
        id: o.id.clone(),
        name: o.name.clone(),
    }
}

fn nested(o: &OtherAccount, inside: bool) -> PathRefusal {
    PathRefusal::Nested {
        id: o.id.clone(),
        name: o.name.clone(),
        inside,
    }
}

/// Whether the folder is empty, and up to 200 of its entry names.
fn list_names(dir: &Path) -> Result<(bool, Vec<String>), PathRefusal> {
    let read = fs::read_dir(dir).map_err(|_| PathRefusal::Unreadable)?;
    let mut is_empty = true;
    let mut names = Vec::new();
    for entry in read.flatten() {
        is_empty = false;
        if names.len() < MAX_NAMES {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok((is_empty, names))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn other(dir: &str) -> OtherAccount {
        OtherAccount {
            id: "acc_o".into(),
            name: "Other".into(),
            dir: PathBuf::from(dir),
        }
    }

    fn refuse(resolved: &str, others: &[OtherAccount], rule: CaseRule) -> Option<PathRefusal> {
        refusal_for(
            Path::new(resolved),
            Path::new("/h"),
            Path::new("/h/.vibe-station/accounts"),
            Some(Path::new("/h/.claude")),
            others,
            rule,
        )
    }

    #[test]
    fn duplicate_only_when_insensitive() {
        let o = [other("/h/CaseDir")];
        assert_eq!(refuse("/h/casedir", &o, CaseRule::Sensitive), None);
        assert!(matches!(
            refuse("/h/casedir", &o, CaseRule::Insensitive),
            Some(PathRefusal::Duplicate { .. })
        ));
    }

    #[test]
    fn nesting_only_when_insensitive() {
        let o = [other("/h/casedir")];
        assert_eq!(refuse("/h/CaseDir/sub", &o, CaseRule::Sensitive), None);
        assert!(matches!(
            refuse("/h/CaseDir/sub", &o, CaseRule::Insensitive),
            Some(PathRefusal::Nested { inside: true, .. })
        ));
    }

    #[test]
    fn system_folder_only_when_insensitive() {
        assert_eq!(refuse("/h/.Claude", &[], CaseRule::Sensitive), None);
        assert_eq!(
            refuse("/h/.Claude", &[], CaseRule::Insensitive),
            Some(PathRefusal::SystemFolder)
        );
        // Component-wise: a look-alike prefix is never inside the system folder.
        assert_eq!(refuse("/h/.claude-x", &[], CaseRule::Insensitive), None);
    }

    #[test]
    fn accounts_root_only_when_insensitive() {
        let r = "/h/.Vibe-Station/Accounts/x";
        assert_eq!(refuse(r, &[], CaseRule::Sensitive), None);
        assert!(matches!(
            refuse(r, &[], CaseRule::Insensitive),
            Some(PathRefusal::InsideRoot { .. })
        ));
    }

    #[test]
    fn probe_matches_the_volume() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("Probe");
        fs::create_dir(&dir).expect("mkdir");
        let expected = match fs::create_dir(tmp.path().join("probe")) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => CaseRule::Insensitive,
            _ => CaseRule::Sensitive,
        };
        assert_eq!(case_rule_of(&dir), expected);
    }

    #[test]
    fn probe_without_cased_name_does_not_panic() {
        let _ = case_rule_of(Path::new("/"));
        let _ = case_rule_of(Path::new("/123/456"));
    }
}
