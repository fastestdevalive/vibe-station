//! Ports `slugify.ts` — display name -> project-id slug.
//!
//! Stripping leading/trailing dots is a hard safety requirement (the id builds
//! filesystem paths via `Paths::project_dir`), not cosmetics: a slug of "." or
//! ".." would resolve to the data home or its parent.

/// Convert a display name into a slug suitable for use as a project id.
///
/// Rules: lowercase, replace spaces/special chars with hyphens, collapse
/// consecutive hyphens, strip leading/trailing hyphens AND dots. Internal dots
/// are preserved; a name that is all dots/hyphens falls back to "project".
pub fn slugify(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    // Replace any run of chars that aren't a-z0-9 or '.' with a single hyphen.
    let mut out = String::with_capacity(lower.len());
    let mut prev_hyphen = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c);
            prev_hyphen = false;
        } else {
            if !prev_hyphen && !out.is_empty() {
                out.push('-');
            }
            prev_hyphen = true;
        }
    }
    // Strip leading/trailing hyphens AND dots.
    let trimmed: String = out.trim_matches(|c| c == '-' || c == '.').to_string();
    let sliced: String = trimmed.chars().take(64).collect();
    if sliced.is_empty() {
        "project".to_string()
    } else {
        sliced
    }
}

/// A project id is used to build filesystem paths, so it must be a single path
/// segment and never a dot-only traversal token.
pub fn is_safe_project_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains(['/', '\\'])
}
