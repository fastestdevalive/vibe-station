//! Ports `prefix.ts` — project prefix generation + collision disambiguation.

/// Generate a 1-6 char project prefix from a project id.
///
/// Mirrors AO's `generateSessionPrefix`:
/// 1. ≤4 chars: use as-is (lowercase, max 6)
/// 2. CamelCase: extract uppercase letters (`PyTorch` -> `pt`)
/// 3. kebab/snake case: use initials (`agent-orchestrator` -> `ao`)
/// 4. Single word: first 3 chars (`integrator` -> `int`)
///
/// Always returns lowercase alnum only, capped at 6 chars.
pub fn generate_project_prefix(project_id: &str) -> String {
    let stripped: String = project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let id = if stripped.trim().is_empty() {
        "proj".to_string()
    } else {
        stripped
    };

    let prefix = if id.chars().count() <= 4 {
        id.clone()
    } else {
        let uppercase: String = id.chars().filter(|c| c.is_ascii_uppercase()).collect();
        if uppercase.chars().count() > 1 {
            uppercase
        } else if id.contains('-') || id.contains('_') {
            let sep = if id.contains('-') { '-' } else { '_' };
            id.split(sep).filter_map(|w| w.chars().next()).collect()
        } else {
            id.chars().take(3).collect()
        }
    };

    let lower: String = prefix
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let prefix = if lower.is_empty() {
        let fallback: String = id
            .chars()
            .take(3)
            .collect::<String>()
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        if fallback.is_empty() {
            "pr".to_string()
        } else {
            fallback
        }
    } else {
        lower
    };

    prefix.chars().take(6).collect()
}

/// Error from [`make_unique_prefix`] — 998 collisions on one stem.
#[derive(Debug, thiserror::Error)]
pub enum PrefixError {
    /// Pathological: every candidate up to 999 was already taken.
    #[error("Unable to allocate a unique prefix for '{0}'")]
    NoUniquePrefix(String),
}

/// Disambiguate a base prefix against already-used ones by appending a numeric
/// suffix (`tes` -> `tes2` -> `tes3` …), keeping within the 6-char cap.
pub fn make_unique_prefix(
    base: &str,
    is_taken: &dyn Fn(&str) -> bool,
) -> Result<String, PrefixError> {
    if !is_taken(base) {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let suffix = n.to_string();
        // Trim the base so base+suffix still fits in 6 chars (min 1 char of base).
        let stem_len = 6usize.saturating_sub(suffix.len()).max(1);
        let stem: String = base.chars().take(stem_len).collect();
        let candidate = format!("{stem}{suffix}");
        if !is_taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err(PrefixError::NoUniquePrefix(base.to_string()))
}
