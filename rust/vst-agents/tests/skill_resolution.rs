//! Behavior contract for `vst_agents::skill_resolution` — ports the top-level
//! pure skill-resolution functions of `jsonAgent.ts` (7A.3/D5/7A.5).

use std::path::PathBuf;

use vst_agents::skill_resolution::{
    inject_attachments, merge_with_skill_catalog, reset_skill_catalog_for_tests,
    resolve_skill_invocations, set_skill_paths, with_skill_catalog_test_guard, MergedSkillEntry,
};
use vst_types::{Attachment, Command, CommandGroup};

fn entry(name: &str, path: Option<&str>) -> MergedSkillEntry {
    MergedSkillEntry {
        name: name.to_string(),
        description: None,
        argument_hint: None,
        path: path.map(PathBuf::from),
    }
}

#[test]
fn no_tokens_legacy_resolution() {
    let catalog = vec![entry("code-review", None)];
    let r = resolve_skill_invocations("/code-review high --fix", &catalog);
    assert_eq!(r.message, "/code-review high --fix");
    assert_eq!(r.skill_invocations.len(), 1);
    assert_eq!(r.skill_invocations[0].name, "code-review");
    assert_eq!(r.skill_invocations[0].args, "high --fix");
}

#[test]
fn no_tokens_non_skill_passthrough() {
    let catalog = vec![entry("code-review", None)];
    let r = resolve_skill_invocations("hello there", &catalog);
    assert_eq!(r.message, "hello there");
    assert!(r.skill_invocations.is_empty());
}

#[test]
fn no_tokens_removed_skill_degrades() {
    let catalog: Vec<MergedSkillEntry> = vec![];
    let r = resolve_skill_invocations("/gone arg", &catalog);
    assert_eq!(r.message, "/gone arg");
    assert!(r.skill_invocations.is_empty());
}

#[test]
fn token_substitution_resolved() {
    let catalog = vec![entry("code-review", Some("/skills/code-review/SKILL.md"))];
    let r = resolve_skill_invocations("use {/code-review high --fix} now", &catalog);
    assert_eq!(r.message, "use /code-review high --fix now");
    assert_eq!(r.skill_invocations.len(), 1);
    assert_eq!(r.skill_invocations[0].name, "code-review");
    assert_eq!(
        r.skill_invocations[0].path.as_deref(),
        Some("/skills/code-review/SKILL.md")
    );
}

#[test]
fn unresolved_token_substitutes_no_entry() {
    let catalog: Vec<MergedSkillEntry> = vec![];
    let r = resolve_skill_invocations("use {/unknown arg} now", &catalog);
    assert_eq!(r.message, "use /unknown arg now");
    assert!(r.skill_invocations.is_empty());
}

#[test]
fn first_resolved_token_forces_newline_for_same_line_prose() {
    let catalog = vec![entry("code-review", None)];
    let r = resolve_skill_invocations("{/code-review} please", &catalog);
    assert_eq!(r.message, "/code-review\nplease");
}

#[test]
fn first_resolved_token_own_newline_preserved() {
    let catalog = vec![entry("code-review", None)];
    let r = resolve_skill_invocations("{/code-review}\nplease", &catalog);
    assert_eq!(r.message, "/code-review\nplease");
}

#[test]
fn merge_with_skill_catalog_undefined_when_no_source() {
    reset_skill_catalog_for_tests();
    assert!(merge_with_skill_catalog(None, true).is_none());
}

#[test]
fn inject_attachments_header_only_when_empty() {
    let att = Attachment {
        id: "a".into(),
        name: "f.txt".into(),
        path: "/data/f.txt".into(),
        size: 10,
        mime: "text/plain".into(),
    };
    assert_eq!(
        inject_attachments("", std::slice::from_ref(&att), false),
        "[Attached files:]\n/data/f.txt"
    );
    assert_eq!(
        inject_attachments("hello", std::slice::from_ref(&att), false),
        "hello\n\n[Attached files:]\n/data/f.txt"
    );
    assert_eq!(
        inject_attachments("", std::slice::from_ref(&att), true),
        "\n\n[Attached files:]\n/data/f.txt"
    );
    assert_eq!(inject_attachments("hello", &[], false), "hello");
}

/// Phase 3.7 (Decision 10): the wire `group` is set from the entry's origin —
/// a directory-scanned skill (`path` present) is `skill`, everything from the
/// CLI's own `commands_update` catalog is `agent`. The client adds its own
/// `"vibe-station"` group on top.
#[tokio::test]
async fn merge_sets_group_from_path_presence() {
    let _guard = with_skill_catalog_test_guard();
    reset_skill_catalog_for_tests();

    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(dir.path().join("code-review")).expect("mkdir");
    std::fs::write(
        dir.path().join("code-review/SKILL.md"),
        "---\nname: code-review\ndescription: Review\n---\nbody",
    )
    .expect("write skill");
    set_skill_paths(&[dir.path().display().to_string()]).await;

    let acp = vec![Command {
        name: "compact".to_string(),
        description: "Compact".to_string(),
        argument_hint: None,
        group: None,
    }];
    let merged = merge_with_skill_catalog(Some(&acp), true).expect("merged catalog");
    let find = |name: &str| {
        merged
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("missing {name} in {merged:?}"))
    };
    assert_eq!(find("code-review").group, Some(CommandGroup::Skill));
    assert_eq!(find("compact").group, Some(CommandGroup::Agent));

    reset_skill_catalog_for_tests();
}
