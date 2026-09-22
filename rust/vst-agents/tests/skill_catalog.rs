//! Behavior contract for `vst_agents::skill_resolution`'s user skill catalog
//! — ports `daemon/src/__tests__/userSkillCatalog.test.ts`
//! (parseSkillFrontmatter, scanSkillDirectory, mergeCatalogs) plus the
//! Gotcha #9 atomic-rename-on-save watch test the TS suite never had.

use std::path::Path;
use std::time::Duration;

use vst_agents::skill_resolution::{
    dedup_scan_results, get_skill_entries, merge_catalogs, parse_skill_frontmatter,
    reset_skill_catalog_for_tests, scan_skill_directory, set_skill_paths, SkillCatalogEntry,
};
use vst_types::Command;

fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

#[test]
fn frontmatter_parses_basic_fields() {
    let fm = parse_skill_frontmatter("---\nname: code-review\ndescription: Review code\n---\nbody")
        .unwrap();
    assert_eq!(fm.get("name").unwrap(), "code-review");
    assert_eq!(fm.get("description").unwrap(), "Review code");
}

#[test]
fn frontmatter_strips_matching_quotes() {
    let fm = parse_skill_frontmatter("---\nname: \"quoted\"\n---\n").unwrap();
    assert_eq!(fm.get("name").unwrap(), "quoted");
}

#[test]
fn frontmatter_unquoted_stays() {
    let fm = parse_skill_frontmatter("---\nargumentHint: args here\n---\n").unwrap();
    assert_eq!(fm.get("argumentHint").unwrap(), "args here");
}

#[test]
fn frontmatter_uses_argument_hint_fallback() {
    let fm = parse_skill_frontmatter("---\nargument-hint: dashed\n---\n").unwrap();
    assert_eq!(fm.get("argument-hint").unwrap(), "dashed");
}

#[test]
fn frontmatter_malformed_returns_none() {
    assert!(parse_skill_frontmatter("no frontmatter").is_none());
    assert!(parse_skill_frontmatter("---").is_none());
    assert!(parse_skill_frontmatter("---\nnever closed").is_none());
}

/// Regression: an immediately-closed empty block (`"---\n---\n"`) must
/// degrade to `None`, not panic on an inverted slice range.
#[test]
fn frontmatter_empty_block_returns_none_without_panicking() {
    assert!(parse_skill_frontmatter("---\n---\nbody").is_none());
    assert!(parse_skill_frontmatter("---\n---\n").is_none());
}

#[test]
fn scan_directory_finds_skill() {
    let dir = tempfile::tempdir().unwrap();
    write(
        &dir.path().join("code-review/SKILL.md"),
        "---\nname: code-review\ndescription: Review\n---\nbody",
    );
    let result = scan_skill_directory(dir.path());
    assert_eq!(result.status.skill_count, 1);
    assert_eq!(result.entries[0].name, "code-review");
    assert_eq!(result.entries[0].description.as_deref(), Some("Review"));
    assert_eq!(result.status.missing, false);
}

#[test]
fn scan_directory_missing_reports_missing() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    let result = scan_skill_directory(&missing);
    assert!(result.status.missing);
    assert_eq!(result.status.skill_count, 0);
}

#[test]
fn scan_directory_skips_no_name_skill() {
    let dir = tempfile::tempdir().unwrap();
    write(
        &dir.path().join("noskill/SKILL.md"),
        "---\ndescription: no name\n---\nbody",
    );
    let result = scan_skill_directory(dir.path());
    assert_eq!(result.status.skill_count, 0);
    assert!(result
        .status
        .error
        .as_deref()
        .unwrap()
        .contains("missing \"name\""));
}

#[test]
fn merge_catalogs_acp_wins_description_on_collision() {
    let dir_entry = SkillCatalogEntry {
        name: "code-review".into(),
        description: Some("dir desc".into()),
        argument_hint: None,
        path: "/skills/code-review/SKILL.md".into(),
    };
    let acp = vec![Command {
        name: "code-review".into(),
        description: "acp desc".into(),
        argument_hint: None,
    }];
    let merged = merge_catalogs(&acp, std::slice::from_ref(&dir_entry));
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].description.as_deref(), Some("acp desc"));
    assert_eq!(
        merged[0].path.as_deref(),
        Some(Path::new("/skills/code-review/SKILL.md"))
    );
}

#[test]
fn merge_catalogs_empty_acp_preserves_dir() {
    let dir_entry = SkillCatalogEntry {
        name: "x".into(),
        description: Some("dir desc".into()),
        argument_hint: None,
        path: "/skills/x/SKILL.md".into(),
    };
    let acp = vec![Command {
        name: "x".into(),
        description: "".into(),
        argument_hint: None,
    }];
    let merged = merge_catalogs(&acp, std::slice::from_ref(&dir_entry));
    assert_eq!(merged[0].description.as_deref(), Some("dir desc"));
    assert!(merged[0].path.is_some());
}

#[test]
fn merge_catalogs_acp_only_name_has_no_path() {
    let acp = vec![Command {
        name: "native".into(),
        description: "native cmd".into(),
        argument_hint: None,
    }];
    let merged = merge_catalogs(&acp, &[]);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].path, None);
}

/// Regression: a `key: value` line elsewhere in frontmatter must not be lost
/// just because an earlier or later line has no colon (e.g. a YAML list item
/// under `triggers:`). Previously `?`-early-returned the WHOLE parse to
/// `None`, silently dropping the skill.
#[test]
fn frontmatter_survives_list_field() {
    let fm = parse_skill_frontmatter(
        "---\nname: sdlc\ndescription: Orchestrates SDLC\ntriggers:\n  - \"/sdlc\"\n  - \"plan\"\n---\nbody",
    )
    .unwrap();
    assert_eq!(fm.get("name").unwrap(), "sdlc");
    assert_eq!(fm.get("description").unwrap(), "Orchestrates SDLC");
}

#[test]
fn scan_directory_finds_skill_with_list_frontmatter() {
    let dir = tempfile::tempdir().unwrap();
    write(
        &dir.path().join("sdlc/SKILL.md"),
        "---\nname: sdlc\ndescription: Orchestrates SDLC\ntriggers:\n  - \"/sdlc\"\n---\nbody",
    );
    let result = scan_skill_directory(dir.path());
    assert_eq!(result.status.skill_count, 1);
    assert_eq!(result.entries[0].name, "sdlc");
}

/// Regression: the same skill present under more than one configured
/// `skillPaths` root (e.g. two symlinks to the same source dir) must appear
/// exactly once in the deduped scan output, not once per root. Exercises the
/// pure `dedup_scan_results` directly (not the global singleton) so it can't
/// race other tests that call `set_skill_paths`.
#[test]
fn dedup_scan_results_collapses_same_name_across_roots() {
    let root_a = tempfile::tempdir().unwrap();
    let root_b = tempfile::tempdir().unwrap();
    write(
        &root_a.path().join("sdlc/SKILL.md"),
        "---\nname: sdlc\ndescription: from a\n---\nbody",
    );
    write(
        &root_b.path().join("sdlc/SKILL.md"),
        "---\nname: sdlc\ndescription: from b\n---\nbody",
    );

    let results = vec![
        scan_skill_directory(root_a.path()),
        scan_skill_directory(root_b.path()),
    ];
    let deduped = dedup_scan_results(&results);
    let matches: Vec<_> = deduped.iter().filter(|e| e.name == "sdlc").collect();
    assert_eq!(matches.len(), 1, "expected exactly one deduped entry");
    // First occurrence (root_a, scanned first) wins.
    assert_eq!(matches[0].description.as_deref(), Some("from a"));
}

/// Regression: `set_skill_paths` may now be called repeatedly at runtime
/// (every `PATCH /settings` that touches `skillPaths`, not just once at
/// daemon startup). Back-to-back calls — including re-setting the same path
/// set twice, which previously could interact badly with the watcher's
/// stop/start bool flag — must not panic and must leave the catalog
/// reflecting only the LAST call's path set.
#[tokio::test]
async fn set_skill_paths_can_be_called_repeatedly() {
    reset_skill_catalog_for_tests();
    let root_a = tempfile::tempdir().unwrap();
    let root_b = tempfile::tempdir().unwrap();
    write(
        &root_a.path().join("a-skill/SKILL.md"),
        "---\nname: a-skill\n---\n",
    );
    write(
        &root_b.path().join("b-skill/SKILL.md"),
        "---\nname: b-skill\n---\n",
    );

    set_skill_paths(&[root_a.path().display().to_string()]).await;
    set_skill_paths(&[root_b.path().display().to_string()]).await;
    set_skill_paths(&[root_b.path().display().to_string()]).await; // re-set same set

    let entries = get_skill_entries();
    assert!(entries.iter().any(|e| e.name == "b-skill"));
    assert!(entries.iter().all(|e| e.name != "a-skill"));

    reset_skill_catalog_for_tests();
}

/// Gotcha #9: an editor writing via atomic rename (temp file + rename) must
/// still be picked up by the chokidar->notify watch and trigger a rescan.
#[tokio::test]
async fn atomic_rename_on_save_triggers_rescan() {
    reset_skill_catalog_for_tests();
    let dir = tempfile::tempdir().unwrap();
    // Pre-seed a skill so the initial scan has an entry.
    write(
        &dir.path().join("code-review/SKILL.md"),
        "---\nname: code-review\ndescription: v1\n---\nbody",
    );
    set_skill_paths(&[dir.path().display().to_string()]).await;

    // Let the notify watcher arm its recursive watch before we mutate the tree
    // (the TS chokidar resolves on "ready"; notify's simple API has no ready
    // event, so a short settle is the faithful equivalent).
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Atomic rename: write to a temp sibling, then rename over the target.
    let target = dir.path().join("code-review/SKILL.md");
    let tmp = dir.path().join("code-review/SKILL.md.tmp");
    std::fs::write(
        &tmp,
        "---\nname: code-review\ndescription: v2-renamed\n---\nbody",
    )
    .unwrap();
    std::fs::rename(&tmp, &target).unwrap();

    // Poll for the watcher's debounced rescan to land.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let entries = get_skill_entries();
        if entries
            .iter()
            .any(|e| e.description.as_deref() == Some("v2-renamed"))
        {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("atomic-rename-on-save rescan never landed");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    reset_skill_catalog_for_tests();
}
