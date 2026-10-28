//! Review-comment helpers shared across crates. Part 04 adds its payload types
//! beside this; commit 2 only needs the comment count of a scheduled row's
//! `commentsSnapshot`.

/// What the scheduled-send UI shows about a row's comment snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotMeta {
    pub count: u32,
}

/// Count the comments in a `commentsSnapshot` JSON object: the length of its
/// top-level `comments` array. Parsed tolerantly: anything that is not an object
/// with a non-empty `comments` array (invalid JSON, wrong shape, zero) is `None`.
pub fn snapshot_meta(comments_snapshot_json: &str) -> Option<SnapshotMeta> {
    let v: serde_json::Value = serde_json::from_str(comments_snapshot_json).ok()?;
    let n = v.as_object()?.get("comments")?.as_array()?.len();
    u32::try_from(n)
        .ok()
        .filter(|n| *n > 0)
        .map(|count| SnapshotMeta { count })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_top_level_comments_array() {
        assert_eq!(
            snapshot_meta(r#"{"comments":[{},{}]}"#),
            Some(SnapshotMeta { count: 2 })
        );
    }

    #[test]
    fn wrong_shapes_are_none() {
        for bad in [
            "[{},{}]",
            "{}",
            r#"{"comments":3}"#,
            "not json",
            r#"{"comments":[]}"#,
            "",
            "null",
        ] {
            assert_eq!(snapshot_meta(bad), None, "{bad}");
        }
    }
}
