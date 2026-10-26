//! Semver pick/compare helpers.

use crate::update::github::Release;

/// Parse a version string, tolerating a leading `v` (GitHub tag names are
/// usually `v1.2.3`; `VST_VERSION` has no `v`).
pub fn parse(s: &str) -> Option<semver::Version> {
    let s = s.strip_prefix('v').unwrap_or(s);
    semver::Version::parse(s).ok()
}

/// A release chosen as the latest, with how many newer-than-current releases
/// it represents.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    /// Version string, no `v` prefix.
    pub version: String,
    pub release: Release,
    pub behind_count: u32,
}

/// Whether a release is eligible for "latest" selection.
///
/// Drafts are never eligible. Prereleases are only eligible when the running
/// `current` is itself a prerelease (so a stable install is never offered a
/// beta downgrade/upgrade past the last stable).
fn eligible(release: &Release, current_is_prerelease: bool) -> bool {
    if release.draft {
        return false;
    }
    if release.prerelease && !current_is_prerelease {
        return false;
    }
    true
}

/// Pick the newest eligible release newer than `current` (if any).
///
/// Returns `None` when no eligible release is strictly newer than `current`.
/// `behind_count` = the number of eligible releases strictly newer than
/// `current` (up to and including the picked latest).
pub fn pick_latest(releases: &[Release], current: &str) -> Option<Candidate> {
    let current = parse(current)?;
    let current_is_prerelease = !current.pre.is_empty();

    let mut newer: Vec<(&Release, semver::Version)> = Vec::new();
    for release in releases {
        if !eligible(release, current_is_prerelease) {
            continue;
        }
        if let Some(v) = parse(&release.tag_name) {
            if v > current {
                newer.push((release, v));
            }
        }
    }

    if newer.is_empty() {
        return None;
    }

    // newest first
    newer.sort_by(|a, b| b.1.cmp(&a.1));
    let (best, best_version) = &newer[0];
    Some(Candidate {
        version: best_version.to_string(),
        release: (*best).clone(),
        behind_count: newer.len() as u32,
    })
}

/// Whether an update is available. False if either version is
/// unparseable.
pub fn update_available(current: &str, latest: &str) -> bool {
    match (parse(current), parse(latest)) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, prerelease: bool, draft: bool) -> Release {
        Release {
            tag_name: tag.to_string(),
            prerelease,
            draft,
            body: None,
            html_url: format!("https://example.com/releases/{tag}"),
            assets: vec![],
        }
    }

    #[test]
    fn parse_strips_v_and_rejects_garbage() {
        assert_eq!(parse("1.2.3").unwrap().to_string(), "1.2.3");
        assert_eq!(parse("v1.2.3").unwrap().to_string(), "1.2.3");
        assert!(parse("nonsense").is_none());
        assert!(parse("").is_none());
    }

    #[test]
    fn ordering_beta_lt_stable() {
        // 0.0.1-beta < 0.1.0 < 0.1.1-beta
        let b1 = parse("0.0.1-beta").unwrap();
        let s = parse("0.1.0").unwrap();
        let b2 = parse("0.1.1-beta").unwrap();
        assert!(b1 < s && s < b2);
    }

    #[test]
    fn pick_ignores_drafts_and_older() {
        let releases = vec![rel("v0.5.0", false, false), rel("v0.4.0", false, false)];
        let c = pick_latest(&releases, "0.3.0").unwrap();
        assert_eq!(c.version, "0.5.0");
        assert_eq!(c.behind_count, 2);
    }

    #[test]
    fn pick_skips_draft() {
        let releases = vec![rel("v9.9.9", false, true), rel("v1.0.0", false, false)];
        let c = pick_latest(&releases, "0.1.0").unwrap();
        assert_eq!(c.version, "1.0.0");
        assert_eq!(c.behind_count, 1);
    }

    #[test]
    fn prerelease_ignored_when_current_stable() {
        let releases = vec![
            rel("v2.0.0-beta.1", true, false),
            rel("v1.5.0", false, false),
        ];
        let c = pick_latest(&releases, "1.0.0").unwrap();
        assert_eq!(
            c.version, "1.5.0",
            "stable must not be offered a prerelease"
        );
    }

    #[test]
    fn prerelease_allowed_when_current_prerelease() {
        let releases = vec![rel("v2.0.0-beta.2", true, false)];
        let c = pick_latest(&releases, "2.0.0-beta.1").unwrap();
        assert_eq!(c.version, "2.0.0-beta.2");
    }

    #[test]
    fn no_newer_release_is_none() {
        let releases = vec![rel("v1.0.0", false, false)];
        assert!(pick_latest(&releases, "1.0.0").is_none());
        assert!(pick_latest(&releases, "1.5.0").is_none());
    }

    #[test]
    fn equal_version_not_available() {
        assert!(!update_available("1.0.0", "1.0.0"));
        assert!(!update_available("v1.0.0", "1.0.0"));
        assert!(update_available("1.0.0", "1.0.1"));
    }

    #[test]
    fn unparseable_current_not_available() {
        assert!(!update_available("garbage", "1.0.0"));
        assert!(!update_available("1.0.0", "garbage"));
    }
}
