//! 2.T2: what counts as an artifact.

use std::path::Path;

use vst_artifacts::eligibility::{classify, EffectOp, Eligibility, Ineligible};

const ROOT: &str = "/r/repo";

fn w(p: &str) -> Eligibility {
    classify(Path::new(p), Path::new(ROOT), EffectOp::Write)
}

#[test]
fn outside_the_root_any_extension_is_eligible() {
    assert_eq!(w("/tmp/out/archive.zip"), Eligibility::Eligible);
    assert_eq!(w("/home/u/.claude/plans/x.md"), Eligibility::Eligible);
}

#[test]
fn in_repo_only_documents() {
    assert_eq!(
        w("/r/repo/src/main.rs"),
        Eligibility::Ineligible(Ineligible::SourceFile)
    );
    assert_eq!(w("/r/repo/docs/x.md"), Eligibility::Eligible);
    assert_eq!(w("/r/repo/.plans/x.md"), Eligibility::Eligible);
    assert_eq!(w("/r/repo/shots/a.PNG"), Eligibility::Eligible);
    assert_eq!(w("/r/repo/report.html"), Eligibility::Eligible);
}

#[test]
fn build_and_vendor_folders_are_never_recorded() {
    for p in [
        "/r/repo/node_modules/a/readme.md",
        "/r/repo/target/doc/index.html",
        "/r/repo/.git/info/x.md",
        "/r/repo/dist/a.md",
        "/r/repo/web/build/a.png",
        "/r/repo/.venv/x.md",
        "/r/repo/vendor/lib/README.md",
    ] {
        assert_eq!(w(p), Eligibility::Ineligible(Ineligible::BuildDir), "{p}");
    }
    // node_modules / .git / target are excluded anywhere, build/dist only in-repo.
    assert_eq!(
        w("/elsewhere/node_modules/a.md"),
        Eligibility::Ineligible(Ineligible::BuildDir)
    );
    assert_eq!(w("/elsewhere/dist/a.md"), Eligibility::Eligible);
}

#[test]
fn deletes_are_never_eligible() {
    for p in ["/tmp/a.md", "/r/repo/docs/x.md"] {
        assert_eq!(
            classify(Path::new(p), Path::new(ROOT), EffectOp::Delete),
            Eligibility::Ineligible(Ineligible::Delete)
        );
    }
}
