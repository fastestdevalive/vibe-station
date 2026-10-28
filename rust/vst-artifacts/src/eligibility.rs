//! What counts as an artifact (plan Decision 14): the code-owned lists the PRD
//! calls "and similar".

use std::path::{Component, Path};

/// What the producer did to the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectOp {
    Write,
    Delete,
}

/// Why a path is not an artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ineligible {
    /// Deletes never add or refresh a row (R15).
    Delete,
    /// In-repo non-document: the Changes view covers source edits (R20).
    SourceFile,
    /// Inside a build or vendor folder (R18).
    BuildDir,
}

impl Ineligible {
    /// Human message for `ARTIFACT_INELIGIBLE`.
    pub fn message(self) -> &'static str {
        match self {
            Ineligible::Delete => "a delete does not add an artifact",
            Ineligible::SourceFile => "in-repo source files are shown in Changes",
            Ineligible::BuildDir => "build and vendor folders are never artifacts",
        }
    }
}

/// Verdict of [`classify`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Ineligible(Ineligible),
}

/// Document extensions that are artifacts when they are inside the repo.
pub const DOC_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdx", "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
    "ico", "avif",
];

/// Folder names never recorded inside the repo.
pub const BUILD_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    ".cache",
    ".gradle",
    "Pods",
    "coverage",
    ".turbo",
    ".parcel-cache",
    ".terraform",
    ".svelte-kit",
    ".angular",
];

/// Folder names never recorded anywhere, in or out of the repo.
pub const ANYWHERE_DIRS: &[&str] = &["node_modules", ".git", "target"];

fn has_segment(path: &Path, names: &[&str]) -> bool {
    path.components().any(|c| match c {
        Component::Normal(n) => n.to_str().is_some_and(|n| names.contains(&n)),
        _ => false,
    })
}

fn is_document(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|e| DOC_EXTENSIONS.contains(&e.as_str()))
}

/// Decide whether a canonical `path` becomes an artifact of the scope whose
/// canonical root is `scope_root`.
///
/// Outside the root any extension is eligible (the user cannot find those
/// files otherwise); inside, only documents, and never in build/vendor folders.
/// `node_modules`, `.git` and `target` are excluded everywhere. Gitignored
/// plan folders stay eligible: there is no gitignore filter (R14).
pub fn classify(canonical: &Path, scope_root: &Path, op: EffectOp) -> Eligibility {
    if op == EffectOp::Delete {
        return Eligibility::Ineligible(Ineligible::Delete);
    }
    match canonical.strip_prefix(scope_root) {
        Ok(rel) => {
            if has_segment(rel, BUILD_DIRS) || has_segment(rel, ANYWHERE_DIRS) {
                Eligibility::Ineligible(Ineligible::BuildDir)
            } else if is_document(canonical) {
                Eligibility::Eligible
            } else {
                Eligibility::Ineligible(Ineligible::SourceFile)
            }
        }
        Err(_) => {
            if has_segment(canonical, ANYWHERE_DIRS) {
                Eligibility::Ineligible(Ineligible::BuildDir)
            } else {
                Eligibility::Eligible
            }
        }
    }
}
