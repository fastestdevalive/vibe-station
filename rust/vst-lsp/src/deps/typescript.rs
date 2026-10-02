//! TypeScript dependency probe for typescript-language-server.
//!
//! Mirrors ts-ls 6.x's own resolution order with `stat()`s, so the daemon can
//! classify a missing/unusable TypeScript BEFORE spawning instead of after
//! the server refuses `initialize`:
//!
//! 1. Workspace: walk UP from the root to the first `MODULE_FOLDERS` hit
//!    (ts-ls stops at the first one, usable or not).
//! 2. `initializationOptions.tsserver.fallbackPath` — which we supply from:
//!    a. a nested workspace (`<root>/*/`, `packages/*`, `apps/*`) — ts-ls never
//!       walks down, but monorepos keep TS below the LSP root;
//!    b. `npm root -g`, for a ts-ls installed in a different prefix.
//! 3. "Bundled": Node resolution from ts-ls's own install dir, which finds a
//!    sibling global `typescript`. We probe it only to classify; ts-ls finds
//!    it by itself, so no patch is needed.
//!
//! A candidate counts only if `lib/tsserver.js` exists (exactly what ts-ls
//! checks) — never by version number. TypeScript 7 (the Go port) ships no
//! `tsserver.js`, so it is rejected structurally. `package.json`'s version is
//! read for display text only.
//!
//! We never pass `tsserver.path`: that would override a usable workspace TS.

use std::path::{Path, PathBuf};

use serde_json::json;
use vst_types::rest::lsp::LspFailureKind;

use super::{DependencyModel, DependencyProbe, InitErrorHint, ProbeCtx};
use crate::manager::is_sensitive_path;

/// ts-ls `MODULE_FOLDERS`: where a workspace TypeScript `lib` dir may live.
const MODULE_FOLDERS: &[&str] = &[
    "node_modules/typescript/lib",
    ".vscode/pnpify/typescript/lib",
    ".yarn/sdks/typescript/lib",
    ".pnpm/sdks/typescript/lib",
];

/// Monorepo container dirs whose children are probed for a nested TypeScript.
const NESTED_CONTAINERS: &[&str] = &["packages", "apps"];

pub const MISSING_SUMMARY: &str =
    "TypeScript isn't installed for this project — code navigation needs it.";

pub const MODEL: DependencyModel = DependencyModel {
    probe,
    // Stable ts-ls 6.0.1 wording, pinned by `hints_match_ts_ls_6_messages`.
    init_error_hints: &[
        InitErrorHint {
            needle: "Could not find a valid TypeScript installation",
            kind: LspFailureKind::MissingDependency,
        },
        InitErrorHint {
            needle: "provides no tsserver.js",
            kind: LspFailureKind::IncompatibleDependency,
        },
    ],
    describe_hint,
};

fn incompatible_summary(found: Option<&str>) -> String {
    let what = match found {
        Some(v) => format!("This project's TypeScript {v}"),
        None => "This project's TypeScript".to_string(),
    };
    format!(
        "{what} has no tsserver, which typescript-language-server requires. \
         Install TypeScript 6 or earlier."
    )
}

fn describe_hint(kind: LspFailureKind, root: &Path) -> (String, Option<String>) {
    let summary = match kind {
        LspFailureKind::IncompatibleDependency => incompatible_summary(None),
        _ => MISSING_SUMMARY.to_string(),
    };
    (summary, Some(install_command(root)))
}

/// Package-manager-aware install command, pinned `<7` while ts-ls requires
/// `tsserver.js` (an unpinned `typescript` resolves to 7.x and reproduces the
/// failure). Never auto-run: it mutates the user's package.json + lockfile.
pub fn install_command(root: &Path) -> String {
    let has = |f: &str| root.join(f).is_file();
    if has("pnpm-lock.yaml") {
        "pnpm add -D \"typescript@<7\"".to_string()
    } else if has("yarn.lock") {
        "yarn add -D \"typescript@<7\"".to_string()
    } else if has("bun.lock") || has("bun.lockb") {
        "bun add -d \"typescript@<7\"".to_string()
    } else {
        "npm i -D \"typescript@<7\"".to_string()
    }
}

/// A `typescript/lib` directory: usable iff it contains `tsserver.js`.
struct TsLib {
    lib: PathBuf,
    version: Option<String>,
}

impl TsLib {
    fn at(lib: PathBuf) -> Self {
        let version = read_version(&lib);
        Self { lib, version }
    }

    fn tsserver(&self) -> PathBuf {
        self.lib.join("tsserver.js")
    }

    fn usable(&self) -> bool {
        self.tsserver().is_file()
    }

    fn version_text(&self) -> String {
        match &self.version {
            Some(v) => format!("TypeScript {v}"),
            None => "TypeScript".to_string(),
        }
    }
}

fn read_version(lib: &Path) -> Option<String> {
    let pkg = lib.parent()?.join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

/// Step 1: the first `MODULE_FOLDERS` hit walking up from `root`.
fn workspace_lib(root: &Path) -> Option<TsLib> {
    let mut dir = Some(root);
    while let Some(d) = dir {
        for folder in MODULE_FOLDERS {
            let lib = d.join(folder);
            if lib.is_dir() {
                return Some(TsLib::at(lib));
            }
        }
        dir = d.parent();
    }
    None
}

/// Step 2a: a usable `node_modules/typescript` one level below the root (or
/// below `packages/` / `apps/`). Workspace code, so confined to the canonical
/// root rather than run through `is_sensitive_path` (worktrees themselves
/// live under `~/.vibe-station`).
fn nested_lib(root: &Path) -> Option<(TsLib, String)> {
    let canon_root = root.canonicalize().ok()?;
    let mut parents: Vec<PathBuf> = vec![canon_root.clone()];
    parents.extend(NESTED_CONTAINERS.iter().map(|c| canon_root.join(c)));
    for parent in parents {
        let Ok(entries) = std::fs::read_dir(&parent) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && name != "node_modules"
            })
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let lib = dir.join("node_modules/typescript/lib");
            let Ok(canon) = lib.canonicalize() else {
                continue;
            };
            if !canon.starts_with(&canon_root) {
                continue;
            }
            let ts = TsLib::at(canon);
            if ts.usable() {
                let rel = dir
                    .strip_prefix(&canon_root)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_default();
                return Some((ts, rel));
            }
        }
    }
    None
}

/// An out-of-workspace candidate: canonicalized, structurally usable, and not
/// under a sensitive prefix.
fn trusted_global(lib: &Path, vst_home: &Path) -> Option<TsLib> {
    let canon = lib.canonicalize().ok()?;
    if is_sensitive_path(&canon, Some(vst_home)) {
        return None;
    }
    let ts = TsLib::at(canon);
    ts.usable().then_some(ts)
}

/// Step 3: Node's resolution from ts-ls's install dir — every ancestor not
/// itself named `node_modules` contributes `<ancestor>/node_modules`.
fn bundled_lib(server_bin: &Path, vst_home: &Path) -> Option<TsLib> {
    let real = server_bin.canonicalize().ok()?;
    let mut dir = real.parent();
    while let Some(d) = dir {
        if d.file_name().is_some_and(|n| n != "node_modules") {
            if let Some(ts) = trusted_global(&d.join("node_modules/typescript/lib"), vst_home) {
                return Some(ts);
            }
        }
        dir = d.parent();
    }
    None
}

pub fn probe(ctx: &ProbeCtx) -> DependencyProbe {
    let workspace = workspace_lib(ctx.root);
    let unusable_workspace = match &workspace {
        Some(ts) if ts.usable() => {
            // Workspace wins — exactly what ts-ls does; nothing to patch.
            return DependencyProbe::Ok {
                init_options_patch: None,
                note: None,
            };
        }
        Some(ts) => Some(ts.version_text()),
        None => None,
    };
    let why = match &unusable_workspace {
        Some(found) => format!("workspace {found} has no tsserver"),
        None => "this project has no TypeScript of its own".to_string(),
    };
    let fallback = |ts: &TsLib, source: &str| DependencyProbe::Ok {
        init_options_patch: Some(json!({
            "tsserver": { "fallbackPath": ts.tsserver().to_string_lossy() }
        })),
        note: Some(format!("Using {} ({source}) — {why}.", ts.version_text())),
    };

    if let Some((ts, rel)) = nested_lib(ctx.root) {
        return fallback(&ts, &format!("from {rel}/"));
    }
    if let Some(ts) = ctx
        .server_bin
        .as_deref()
        .and_then(|bin| bundled_lib(bin, ctx.vst_home))
    {
        return DependencyProbe::Ok {
            init_options_patch: None,
            note: Some(format!("Using {} (global) — {why}.", ts.version_text())),
        };
    }
    if let Some(ts) = ctx
        .npm_global_root
        .as_deref()
        .and_then(|r| trusted_global(&r.join("typescript/lib"), ctx.vst_home))
    {
        return fallback(&ts, "global");
    }

    let install = Some(install_command(ctx.root));
    match unusable_workspace {
        Some(found) => {
            let version = found.strip_prefix("TypeScript ").map(str::to_string);
            DependencyProbe::Incompatible {
                summary: incompatible_summary(version.as_deref()),
                install,
                found,
            }
        }
        None => DependencyProbe::Missing {
            summary: MISSING_SUMMARY.to_string(),
            install,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lays out `<dir>/node_modules/typescript` with `version`; TS 5-style
    /// (`tsserver.js` present) or TS 7-style (no `tsserver.js`).
    fn install_ts(dir: &Path, version: &str, with_tsserver: bool) -> PathBuf {
        let pkg = dir.join("node_modules/typescript");
        std::fs::create_dir_all(pkg.join("lib")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            format!(r#"{{ "name": "typescript", "version": "{version}" }}"#),
        )
        .unwrap();
        std::fs::write(pkg.join("lib/typescript.js"), "").unwrap();
        if with_tsserver {
            std::fs::write(pkg.join("lib/tsserver.js"), "").unwrap();
        }
        pkg.join("lib")
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        let home = tmp.path().join("vst-home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        Fixture {
            root: root.canonicalize().unwrap(),
            home,
            _tmp: tmp,
        }
    }

    fn run(f: &Fixture, server_bin: Option<PathBuf>, npm: Option<PathBuf>) -> DependencyProbe {
        probe(&ProbeCtx {
            root: &f.root,
            server_bin,
            npm_global_root: npm,
            vst_home: &f.home,
        })
    }

    #[test]
    fn no_typescript_anywhere_is_missing_with_npm_install() {
        let f = fixture();
        match run(&f, None, None) {
            DependencyProbe::Missing { summary, install } => {
                assert_eq!(summary, MISSING_SUMMARY);
                assert_eq!(install.as_deref(), Some("npm i -D \"typescript@<7\""));
            }
            other => panic!("expected Missing, got {other:?}"),
        }
    }

    #[test]
    fn ts7_layout_without_tsserver_is_incompatible() {
        let f = fixture();
        install_ts(&f.root, "7.0.2", false);
        match run(&f, None, None) {
            DependencyProbe::Incompatible {
                summary,
                found,
                install,
            } => {
                assert_eq!(found, "TypeScript 7.0.2");
                assert!(
                    summary.contains("TypeScript 7.0.2 has no tsserver"),
                    "{summary}"
                );
                assert!(summary.contains("Install TypeScript 6 or earlier"));
                assert!(install.is_some());
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn root_typescript_wins_with_no_patch() {
        let f = fixture();
        install_ts(&f.root, "5.9.3", true);
        // Even with a nested + global TS available, the workspace wins.
        install_ts(&f.root.join("web-ui"), "5.4.0", true);
        let global = f.root.parent().unwrap().join("global");
        install_ts(&global, "5.9.3", true);
        assert_eq!(
            run(&f, None, Some(global.join("node_modules"))),
            DependencyProbe::Ok {
                init_options_patch: None,
                note: None
            }
        );
    }

    #[test]
    fn ancestor_typescript_counts_as_workspace() {
        let f = fixture();
        install_ts(&f.root, "5.9.3", true);
        let sub = f.root.join("crates/app");
        std::fs::create_dir_all(&sub).unwrap();
        let p = probe(&ProbeCtx {
            root: &sub,
            server_bin: None,
            npm_global_root: None,
            vst_home: &f.home,
        });
        assert!(matches!(
            p,
            DependencyProbe::Ok {
                init_options_patch: None,
                ..
            }
        ));
    }

    #[test]
    fn nested_web_ui_typescript_is_passed_as_fallback_path() {
        let f = fixture();
        let lib = install_ts(&f.root.join("web-ui"), "5.4.5", true);
        match run(&f, None, None) {
            DependencyProbe::Ok {
                init_options_patch: Some(patch),
                note: Some(note),
            } => {
                assert_eq!(
                    patch["tsserver"]["fallbackPath"],
                    lib.join("tsserver.js").to_string_lossy().as_ref()
                );
                assert!(
                    patch["tsserver"].get("path").is_none(),
                    "never tsserver.path"
                );
                assert_eq!(
                    note,
                    "Using TypeScript 5.4.5 (from web-ui/) — this project has no TypeScript of its own."
                );
            }
            other => panic!("expected Ok with patch, got {other:?}"),
        }
    }

    #[test]
    fn nested_under_packages_is_found_and_ts7_nested_is_skipped() {
        let f = fixture();
        install_ts(&f.root.join("aaa"), "7.0.2", false);
        install_ts(&f.root.join("packages/core"), "5.8.0", true);
        match run(&f, None, None) {
            DependencyProbe::Ok { note: Some(n), .. } => {
                assert!(n.contains("5.8.0 (from packages/core/)"), "{n}")
            }
            other => panic!("expected nested Ok, got {other:?}"),
        }
    }

    #[test]
    fn workspace_ts7_with_global_fallback_is_ok_with_note() {
        let f = fixture();
        install_ts(&f.root, "7.0.2", false);
        let global = f.root.parent().unwrap().join("global");
        install_ts(&global, "5.9.3", true);
        match run(&f, None, Some(global.join("node_modules"))) {
            DependencyProbe::Ok {
                init_options_patch: Some(patch),
                note: Some(note),
            } => {
                assert!(patch["tsserver"]["fallbackPath"]
                    .as_str()
                    .unwrap()
                    .ends_with("global/node_modules/typescript/lib/tsserver.js"));
                assert_eq!(
                    note,
                    "Using TypeScript 5.9.3 (global) — workspace TypeScript 7.0.2 has no tsserver."
                );
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn global_ts7_does_not_help() {
        let f = fixture();
        let global = f.root.parent().unwrap().join("global");
        install_ts(&global, "7.0.2", false);
        assert!(matches!(
            run(&f, None, Some(global.join("node_modules"))),
            DependencyProbe::Missing { .. }
        ));
    }

    #[test]
    fn sibling_of_ts_ls_install_is_bundled_without_patch() {
        // <prefix>/lib/node_modules/{typescript-language-server,typescript}
        let f = fixture();
        let modules = f.root.parent().unwrap().join("prefix/lib/node_modules");
        let tsls = modules.join("typescript-language-server/lib");
        std::fs::create_dir_all(&tsls).unwrap();
        std::fs::write(tsls.join("cli.mjs"), "").unwrap();
        let bin_dir = f.root.parent().unwrap().join("prefix/bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join("typescript-language-server");
        std::os::unix::fs::symlink(tsls.join("cli.mjs"), &bin).unwrap();
        // Lay out <prefix>/lib/node_modules/typescript.
        install_ts(modules.parent().unwrap(), "5.9.3", true);

        match run(&f, Some(bin), None) {
            DependencyProbe::Ok {
                init_options_patch: None,
                note: Some(note),
            } => assert!(
                note.starts_with("Using TypeScript 5.9.3 (global)"),
                "{note}"
            ),
            other => panic!("expected bundled Ok, got {other:?}"),
        }
    }

    #[test]
    fn global_candidate_under_sensitive_path_is_rejected() {
        let f = fixture();
        let global = f.home.join("npm");
        install_ts(&global, "5.9.3", true);
        assert!(matches!(
            run(&f, None, Some(global.join("node_modules"))),
            DependencyProbe::Missing { .. }
        ));
    }

    #[test]
    fn install_command_follows_lockfile() {
        let f = fixture();
        assert_eq!(install_command(&f.root), "npm i -D \"typescript@<7\"");
        std::fs::write(f.root.join("bun.lockb"), "").unwrap();
        assert_eq!(install_command(&f.root), "bun add -d \"typescript@<7\"");
        std::fs::write(f.root.join("yarn.lock"), "").unwrap();
        assert_eq!(install_command(&f.root), "yarn add -D \"typescript@<7\"");
        std::fs::write(f.root.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(install_command(&f.root), "pnpm add -D \"typescript@<7\"");
    }

    #[test]
    fn hints_match_ts_ls_6_messages() {
        // Captured verbatim from typescript-language-server 6.0.1.
        let missing = "Request initialize failed with message: Could not find a valid TypeScript \
            installation. Please ensure that the \"typescript\" dependency is installed in the \
            workspace or that a valid `tsserver.path` is specified. Exiting.";
        let incompatible = "Request initialize failed with message: The TypeScript of the \
            workspace (TypeScript 7.0.2 at \"/home/vst/projects/vibe-station/node_modules/typescript/lib\") \
            provides no tsserver.js. No other valid TypeScript installation was found. Exiting.";
        assert_eq!(
            MODEL.match_hint(missing),
            Some(LspFailureKind::MissingDependency)
        );
        assert_eq!(
            MODEL.match_hint(incompatible),
            Some(LspFailureKind::IncompatibleDependency)
        );
        assert_eq!(MODEL.match_hint("some other failure"), None);
    }
}
