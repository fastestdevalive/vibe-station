//! File-tree visibility: gitignored dirs are listed (flagged), gitignored files
//! only via `alwaysShow`, `node_modules`/`.git` never; config loader guards.

use std::fs;
use std::path::Path;

use tempfile::TempDir;
use vst_ws::services::ignore_filter::{load_always_show, DEFAULT_ALWAYS_SHOW};
use vst_ws::services::tree_list::list_tree_dir;

fn write(dir: &Path, rel: &str, content: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn pats(p: &[&str]) -> Vec<String> {
    p.iter().map(|s| s.to_string()).collect()
}

async fn names(root: &Path, sub: &str, always: &[String]) -> Vec<(String, Option<bool>)> {
    let target = if sub.is_empty() {
        root.to_path_buf()
    } else {
        root.join(sub)
    };
    list_tree_dir(root, &target, sub, false, always)
        .await
        .unwrap()
        .into_iter()
        .map(|e| (e.name, e.ignored))
        .collect()
}

fn repo() -> TempDir {
    let tmp = TempDir::new().unwrap();
    let r = tmp.path();
    write(r, ".gitignore", "dist/\n*.png\n*.log\n.env\n");
    write(r, "src/a.rs", "");
    write(r, "dist/bundle.js", "");
    write(r, "dist/logo.png", "");
    write(r, "dist/node_modules/x.js", "");
    write(r, "logo.png", "");
    write(r, "debug.log", "");
    write(r, ".env", "SECRET=1");
    write(r, "node_modules/pkg/i.js", "");
    tmp
}

#[tokio::test]
async fn ignored_dirs_listed_flagged_ignored_files_hidden_unless_always_show() {
    let tmp = repo();
    let got = names(tmp.path(), "", &pats(&[])).await;
    let has = |n: &str| got.iter().find(|(name, _)| name == n).cloned();
    assert_eq!(has("dist"), Some(("dist".into(), Some(true))));
    assert_eq!(has("src"), Some(("src".into(), None)));
    assert!(
        has("logo.png").is_none(),
        "ignored file hidden without override"
    );
    assert!(has("debug.log").is_none());
    assert!(
        has(".env").is_none(),
        "ignored secrets stay hidden at a visible level"
    );
    assert!(has("node_modules").is_none());
    assert!(has(".gitignore").is_some());

    let got = names(tmp.path(), "", &pats(&["*.png"])).await;
    assert!(got.contains(&("logo.png".into(), Some(true))), "{got:?}");
    assert!(!got.iter().any(|(n, _)| n == "debug.log"));
}

#[tokio::test]
async fn listing_inside_an_ignored_dir_shows_entries_flagged_but_not_node_modules() {
    let tmp = repo();
    let got = names(tmp.path(), "dist", &pats(&[])).await;
    assert!(got.contains(&("bundle.js".into(), Some(true))), "{got:?}");
    assert!(got.contains(&("logo.png".into(), Some(true))));
    assert!(!got.iter().any(|(n, _)| n == "node_modules"), "{got:?}");
}

#[tokio::test]
async fn always_show_can_never_reveal_node_modules_or_git() {
    let tmp = repo();
    fs::create_dir_all(tmp.path().join(".git")).unwrap();
    let got = names(tmp.path(), "", &pats(&["*", "**", "node_modules", ".git"])).await;
    assert!(
        !got.iter().any(|(n, _)| n == "node_modules" || n == ".git"),
        "{got:?}"
    );
    assert!(names(tmp.path(), "node_modules", &pats(&["*"]))
        .await
        .is_empty());
}

#[tokio::test]
async fn negated_gitignore_keeps_whitelisted_dir_unflagged() {
    let tmp = TempDir::new().unwrap();
    let r = tmp.path();
    write(r, ".gitignore", "/*\n!/src/\n!/.gitignore\n");
    write(r, "src/a.rs", "");
    write(r, "other/b.rs", "");
    let got = names(r, "", &pats(&[])).await;
    assert!(got.contains(&("src".into(), None)), "{got:?}");
    assert!(got.contains(&("other".into(), Some(true))), "{got:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn ignored_symlinked_dir_pointing_outside_the_root_is_hidden() {
    let tmp = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(outside.path(), "secret.txt", "x");
    let r = tmp.path();
    write(r, ".gitignore", "out/\ninside/\n");
    write(r, "real/x.txt", "");
    std::os::unix::fs::symlink(outside.path(), r.join("out")).unwrap();
    std::os::unix::fs::symlink(r.join("real"), r.join("inside")).unwrap();
    let got = names(r, "", &pats(&[])).await;
    assert!(!got.iter().any(|(n, _)| n == "out"), "{got:?}");
    assert!(got.contains(&("inside".into(), Some(true))), "{got:?}");
}

#[tokio::test]
async fn missing_dir_is_an_error() {
    let tmp = TempDir::new().unwrap();
    assert!(
        list_tree_dir(tmp.path(), &tmp.path().join("nope"), "nope", false, &[])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn config_defaults_override_and_guards() {
    let home = TempDir::new().unwrap();
    let default: Vec<String> = DEFAULT_ALWAYS_SHOW.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        load_always_show(home.path()).await,
        default,
        "missing → default"
    );

    write(
        home.path(),
        "file-tree.json",
        r##"{"alwaysShow": ["*.svg", "  ", "# c", 7, "dist/"]}"##,
    );
    assert_eq!(
        load_always_show(home.path()).await,
        pats(&["*.svg", "dist/"])
    );

    write(home.path(), "file-tree.json", r#"{"alwaysShow": []}"#);
    assert!(
        load_always_show(home.path()).await.is_empty(),
        "[] is honored"
    );

    write(home.path(), "file-tree.json", "{ not json");
    assert_eq!(
        load_always_show(home.path()).await,
        default,
        "corrupt → default"
    );

    write(home.path(), "file-tree.json", r#"{"alwaysShow": "*.png"}"#);
    assert_eq!(
        load_always_show(home.path()).await,
        default,
        "wrong shape → default"
    );

    let big = format!(r#"{{"alwaysShow": ["{}"]}}"#, "a".repeat(70 * 1024));
    write(home.path(), "file-tree.json", &big);
    assert_eq!(
        load_always_show(home.path()).await,
        default,
        "oversized → default"
    );

    let many: Vec<String> = (0..200).map(|i| format!("\"p{i}\"")).collect();
    write(
        home.path(),
        "file-tree.json",
        &format!(r#"{{"alwaysShow": [{}]}}"#, many.join(",")),
    );
    assert_eq!(load_always_show(home.path()).await.len(), 64, "capped");
}

#[cfg(unix)]
#[tokio::test]
async fn config_that_is_a_symlink_is_not_followed() {
    let home = TempDir::new().unwrap();
    let elsewhere = TempDir::new().unwrap();
    write(
        elsewhere.path(),
        "x.json",
        r#"{"alwaysShow": ["*.secret"]}"#,
    );
    std::os::unix::fs::symlink(
        elsewhere.path().join("x.json"),
        home.path().join("file-tree.json"),
    )
    .unwrap();
    let got = load_always_show(home.path()).await;
    assert_eq!(got, pats(&["*.png"]));
}

#[tokio::test]
async fn nested_gitignore_and_deeper_ignored_listing_target() {
    let tmp = TempDir::new().unwrap();
    let r = tmp.path();
    write(r, "pkg/.gitignore", "gen/\n");
    write(r, "pkg/gen/sub/a.txt", "");
    write(r, "pkg/keep.txt", "");
    let got = names(r, "pkg", &pats(&[])).await;
    assert!(got.contains(&("gen".into(), Some(true))), "{got:?}");
    assert!(got.contains(&("keep.txt".into(), None)), "{got:?}");
    // Listing a dir INSIDE the ignored one: its entries are listed, flagged.
    let got = names(r, "pkg/gen/sub", &pats(&[])).await;
    assert!(got.contains(&("a.txt".into(), Some(true))), "{got:?}");
}

#[tokio::test]
async fn ignored_dir_listing_is_capped_deterministically_in_name_order() {
    use vst_ws::services::tree_list::MAX_IGNORED_DIR_ENTRIES;
    let tmp = TempDir::new().unwrap();
    let r = tmp.path();
    write(r, ".gitignore", "big/\n");
    fs::create_dir_all(r.join("big")).unwrap();
    for i in 0..(MAX_IGNORED_DIR_ENTRIES + 50) {
        fs::write(r.join("big").join(format!("f{i:05}")), "").unwrap();
    }
    let got = names(r, "big", &pats(&[])).await;
    assert_eq!(got.len(), MAX_IGNORED_DIR_ENTRIES);
    assert_eq!(got.first().unwrap().0, "f00000");
    assert_eq!(
        got.last().unwrap().0,
        format!("f{:05}", MAX_IGNORED_DIR_ENTRIES - 1)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn listing_through_an_in_root_symlink_to_an_ignored_dir_keeps_the_flag() {
    let tmp = TempDir::new().unwrap();
    let r = tmp.path();
    write(r, ".gitignore", "real/\n");
    write(r, "real/x.txt", "");
    std::os::unix::fs::symlink(r.join("real"), r.join("link")).unwrap();
    let got = names(r, "link", &pats(&[])).await;
    assert!(got.contains(&("x.txt".into(), Some(true))), "{got:?}");
}

#[tokio::test]
async fn entry_serializes_ignored_only_when_set() {
    let tmp = repo();
    let list = list_tree_dir(tmp.path(), tmp.path(), "", false, &[])
        .await
        .unwrap();
    let dist = serde_json::to_value(list.iter().find(|e| e.name == "dist").unwrap()).unwrap();
    assert_eq!(dist["ignored"], true);
    let src = serde_json::to_value(list.iter().find(|e| e.name == "src").unwrap()).unwrap();
    assert!(
        src.get("ignored").is_none(),
        "absent when not ignored: {src}"
    );
}
