//! `routes/skills.ts` — GET /skills (settings-panel + draft-composer view of
//! scanned user skills).
//!
//! Ports `daemon/src/routes/skills.ts` (24 LOC).
//!
//! Reads the SAME shared, live-watched catalog (`vst_agents::skill_resolution`)
//! that backs Rich Chat's slash-autocomplete — no separate scan, no separate
//! frontmatter parser. This guarantees the draft composer and a running
//! session always see identical skill lists, and that both honor the user's
//! configured `skillPaths` (the catalog singleton is (re)seeded from settings,
//! not from a hardcoded default).

use vst_agents::skill_resolution;
use vst_types::rest::skills::{SkillCatalogEntry, SkillDirectoryStatus, SkillsResult};

/// Handler for `/skills`.
#[derive(Clone, Debug, Default)]
pub struct SkillsRoutes;

impl SkillsRoutes {
    pub fn new() -> Self {
        Self
    }

    /// `GET /skills`
    pub async fn get_skills(&self) -> SkillsResult {
        let mut skills: Vec<SkillCatalogEntry> = skill_resolution::get_skill_entries()
            .into_iter()
            .map(|e| SkillCatalogEntry {
                name: e.name,
                description: e.description.unwrap_or_default(),
                argument_hint: e.argument_hint,
                path: e.path.to_string_lossy().to_string(),
            })
            .collect();
        skills.sort_by(|a, b| a.name.cmp(&b.name));

        let directories = skill_resolution::get_skill_directories()
            .into_iter()
            .map(|d| SkillDirectoryStatus {
                path: d.path,
                skill_count: d.skill_count as i64,
                error: d.error,
                missing: if d.missing { Some(true) } else { None },
            })
            .collect();

        SkillsResult {
            skills,
            directories,
        }
    }
}
