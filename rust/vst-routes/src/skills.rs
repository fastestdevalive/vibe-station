//! `routes/skills.ts` — GET /skills (settings-panel-only view of scanned user skills).
//!
//! Ports `daemon/src/routes/skills.ts` (24 LOC) and `services/userSkillCatalog.ts` scan logic:
//! - `GET /skills`
//!
//! Scans configured `skillPaths` directories for `<dir>/<name>/SKILL.md` user skills.
//! Does not 4xx/5xx on missing or broken directories.

use std::path::{Path, PathBuf};
use vst_types::rest::skills::{SkillCatalogEntry, SkillDirectoryStatus, SkillsResult};

pub const SKILL_FILE: &str = "SKILL.md";

/// Parse a `SKILL.md` frontmatter block defensively (`---\n...\n---`).
pub fn parse_skill_frontmatter(content: &str) -> Option<std::collections::HashMap<String, String>> {
    if !content.starts_with("---") {
        return None;
    }
    let first_line_end = content.find('\n')?;
    let close_idx = content[first_line_end + 1..].find("\n---")?;
    let block = &content[first_line_end + 1..first_line_end + 1 + close_idx];

    let mut map = std::collections::HashMap::new();
    for line in block.lines() {
        let trimmed = line.trim();
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_string();
            let mut val = v.trim().to_string();
            if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                if val.len() >= 2 {
                    val = val[1..val.len() - 1].to_string();
                }
            }
            map.insert(key, val);
        }
    }
    Some(map)
}

/// Scan a single skill directory for `<skill_name>/SKILL.md`.
pub async fn scan_skill_directory(dir: &Path) -> (Vec<SkillCatalogEntry>, SkillDirectoryStatus) {
    let dir_str = dir.to_string_lossy().to_string();
    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                return (
                    vec![],
                    SkillDirectoryStatus {
                        path: dir_str,
                        skill_count: 0,
                        error: None,
                        missing: Some(true),
                    },
                );
            }
            return (
                vec![],
                SkillDirectoryStatus {
                    path: dir_str,
                    skill_count: 0,
                    error: Some(err.to_string()),
                    missing: None,
                },
            );
        }
    };

    let mut entries = Vec::new();
    let mut skipped = Vec::new();

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let skill_dir = entry.path();
        if file_type.is_symlink() {
            match tokio::fs::metadata(&skill_dir).await {
                Ok(m) if m.is_dir() => {}
                _ => continue,
            }
        } else if !file_type.is_dir() {
            continue;
        }

        let skill_file = skill_dir.join(SKILL_FILE);
        let content = match tokio::fs::read_to_string(&skill_file).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        let frontmatter = match parse_skill_frontmatter(&content) {
            Some(fm) => fm,
            None => {
                skipped.push(skill_file.to_string_lossy().to_string());
                continue;
            }
        };

        let name = match frontmatter.get("name") {
            Some(n) if !n.trim().is_empty() => n.clone(),
            _ => {
                skipped.push(skill_file.to_string_lossy().to_string());
                continue;
            }
        };

        let description = frontmatter.get("description").cloned().unwrap_or_default();
        let argument_hint = frontmatter
            .get("argumentHint")
            .or_else(|| frontmatter.get("argument-hint"))
            .cloned();

        entries.push(SkillCatalogEntry {
            name,
            description,
            argument_hint,
            path: skill_file.to_string_lossy().to_string(),
        });
    }

    // Sort entries by name for stable output
    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let error = if skipped.is_empty() {
        None
    } else {
        Some(format!(
            "{} skill(s) skipped (missing \"name\" in frontmatter): {}",
            skipped.len(),
            skipped.join(", ")
        ))
    };

    let status = SkillDirectoryStatus {
        path: dir_str,
        skill_count: entries.len() as i64,
        error,
        missing: None,
    };

    (entries, status)
}

/// Handler for `GET /skills`.
#[derive(Clone, Debug)]
pub struct SkillsRoutes {
    skill_paths: Vec<PathBuf>,
}

impl SkillsRoutes {
    pub fn new(skill_paths: Vec<PathBuf>) -> Self {
        Self { skill_paths }
    }

    /// `GET /skills`
    pub async fn get_skills(&self) -> SkillsResult {
        let mut all_skills = Vec::new();
        let mut directories = Vec::new();

        for dir in &self.skill_paths {
            let (entries, status) = scan_skill_directory(dir).await;
            all_skills.extend(entries);
            directories.push(status);
        }

        SkillsResult {
            skills: all_skills,
            directories,
        }
    }
}
