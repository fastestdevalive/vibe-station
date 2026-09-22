//! Server-driven filename index for Quick Open, keyed by worktree.
//!
//! Replaces the old client-side cache in `web-ui/src/hooks/useWorktreeFiles.ts`
//! (module-level `Map`, invalidated only by a `tree:changed` WS event whose
//! watch was torn down whenever Quick Open closed — see the design doc at
//! `.vibekit/reports/2026-09-18-file-search-server-driven-design.md`). The
//! daemon now owns freshness: the index is updated incrementally whenever the
//! tree watcher (`handlers::tree_watch`) observes a filesystem change, and
//! every keystroke queries it directly instead of the client caching anything.
//!
//! Match precedence: filename prefix match > filename fuzzy match > full-path
//! fuzzy match (see [`rank`]). Ties within a bucket are broken by fuzzy score,
//! then path for determinism. Matching is case-insensitive throughout.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use nucleo_matcher::{Config, Matcher, Utf32Str};
use tokio::sync::RwLock;
use vst_types::rest::worktrees::FileSearchResult;

use super::file_list::FileList;

/// Per-worktree in-memory filename index, backed by [`FileList`] for the
/// actual filesystem walk. Read-heavy (many queries per rebuild), so the
/// index itself lives behind a `tokio::sync::RwLock`.
pub struct FileSearchIndex {
    index: RwLock<HashMap<String, HashSet<String>>>,
    file_list: Arc<FileList>,
}

impl FileSearchIndex {
    pub fn new(file_list: Arc<FileList>) -> Self {
        FileSearchIndex {
            index: RwLock::new(HashMap::new()),
            file_list,
        }
    }

    /// Clone of the stored [`FileList`] handle — used by Phase 2's
    /// directory-materialized case, which needs to walk a subtree directly.
    pub fn file_list_handle(&self) -> Arc<FileList> {
        Arc::clone(&self.file_list)
    }

    // A present entry — even an empty one — means "populated or currently
    // populating"; insert/remove target it directly and are never dropped.
    // Only a worktree with NO entry at all (never queried) is a no-op: the
    // next `search()` call's lazy `populate()` will include it naturally.
    pub async fn insert(&self, worktree_id: &str, rel_path: &str) {
        let mut idx = self.index.write().await;
        if let Some(set) = idx.get_mut(worktree_id) {
            set.insert(rel_path.to_string());
        }
    }

    pub async fn remove(&self, worktree_id: &str, rel_path: &str) {
        let mut idx = self.index.write().await;
        if let Some(set) = idx.get_mut(worktree_id) {
            set.remove(rel_path);
        }
    }

    /// Replace every indexed entry under `prefix` (plus an exact match on
    /// `prefix` itself) with `files`. With `files: vec![]` this deletes the
    /// whole subtree — the directory-deletion case.
    pub async fn merge_subtree(&self, worktree_id: &str, prefix: &str, files: Vec<String>) {
        let mut idx = self.index.write().await;
        let Some(set) = idx.get_mut(worktree_id) else { return };
        set.retain(|p| p != prefix && !p.starts_with(&format!("{prefix}/")));
        set.extend(files);
    }

    /// Forget a worktree entirely — removes the index entry (NOT just clears
    /// it), so the next `search()` on it re-derives the full set from disk via
    /// the existing lazy-populate path. Called when a worktree's last tree
    /// watcher closes: with nobody listening, incremental `insert`/`merge`
    /// would never see files added during the gap, so we forget what we knew
    /// and let the (already-tested) "unpopulated worktree → full disk walk on
    /// first query" logic rebuild it.
    pub async fn evict(&self, worktree_id: &str) {
        self.index.write().await.remove(worktree_id);
    }

    // Called from `search()` on first-ever query for `worktree_id`. Inserts an
    // EMPTY entry BEFORE releasing the write lock and starting the walk, so
    // insert/remove fired during the walk apply to the real set instead of
    // being dropped. The walk result is UNIONED in, not assigned, so a
    // concurrent `remove` during the walk stays removed.
    async fn populate(&self, worktree_id: &str, wt_path: std::path::PathBuf) {
        {
            let mut idx = self.index.write().await;
            if idx.contains_key(worktree_id) {
                return; // already populated, or another caller is populating
            }
            idx.insert(worktree_id.to_string(), HashSet::new());
        }
        let result = self.file_list.list_files(wt_path).await;
        let mut idx = self.index.write().await;
        if let Some(set) = idx.get_mut(worktree_id) {
            set.extend(result.files);
        }
    }

    /// Fuzzy-search the index for `worktree_id`, lazily populating it from
    /// disk on first-ever query.
    pub async fn search(
        &self,
        worktree_id: &str,
        wt_path: &Path,
        query: &str,
        limit: usize,
    ) -> FileSearchResult {
        self.populate(worktree_id, wt_path.to_path_buf()).await;
        let idx = self.index.read().await;
        let empty = HashSet::new();
        let candidates = idx.get(worktree_id).unwrap_or(&empty);
        rank(query, candidates, limit)
    }
}

// nucleo-matcher 0.3 requires a FRESH Vec<char> scratch buffer per Utf32Str::new()
// call — it must not be reused across different source strings. The needle must be
// case-folded by the CALLER (nucleo-matcher does not case-fold internally despite
// Config::DEFAULT.ignore_case existing) — do it once, outside the loop.
fn rank(query: &str, candidates: &HashSet<String>, limit: usize) -> FileSearchResult {
    if query.is_empty() {
        let files: Vec<String> = candidates.iter().take(limit).cloned().collect();
        return FileSearchResult {
            truncated: candidates.len() > limit,
            files,
        };
    }
    let query_lower = query.to_lowercase();
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut scored: Vec<(u8, u32, &str)> = Vec::new();
    for path in candidates {
        let name = path.rsplit('/').next().unwrap_or(path);
        let name_lower = name.to_lowercase();

        let mut query_buf = Vec::new();
        let query_key = Utf32Str::new(&query_lower, &mut query_buf);

        if name_lower.starts_with(&query_lower) {
            scored.push((2, u32::MAX - name.len() as u32, path)); // shorter name wins ties
            continue;
        }
        let mut name_buf = Vec::new();
        let name_key = Utf32Str::new(&name_lower, &mut name_buf);
        if let Some(score) = matcher.fuzzy_match(name_key, query_key) {
            scored.push((1, score as u32, path));
            continue;
        }
        let path_lower = path.to_lowercase();
        let mut path_buf = Vec::new();
        let path_key = Utf32Str::new(&path_lower, &mut path_buf);
        if let Some(score) = matcher.fuzzy_match(path_key, query_key) {
            scored.push((0, score as u32, path)); // fuzzy_match returns Option<u16>
        }
    }
    let truncated = scored.len() > limit;
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(b.2)));
    let files = scored
        .into_iter()
        .take(limit)
        .map(|(_, _, p)| p.to_string())
        .collect();
    FileSearchResult { files, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn index() -> Arc<FileSearchIndex> {
        Arc::new(FileSearchIndex::new(Arc::new(FileList::new())))
    }

    // Pre-populate a worktree's index entry directly, bypassing the lazy
    // filesystem fill, for the scoring/insert/remove/merge tests.
    async fn seed(idx: &FileSearchIndex, worktree_id: &str, files: Vec<&str>) {
        let mut map = idx.index.write().await;
        let set = map
            .entry(worktree_id.to_string())
            .or_insert_with(HashSet::new);
        set.extend(files.iter().map(|s| s.to_string()));
    }

    async fn all(idx: &FileSearchIndex, worktree_id: &str) -> HashSet<String> {
        idx.index
            .read()
            .await
            .get(worktree_id)
            .cloned()
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn prefix_match_ranks_above_fuzzy() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/main.rs", "src/main_test.rs", "src/other/zzmain.rs"],
        )
        .await;

        let res = idx
            .search("wt1", Path::new("/nonexistent"), "main", 10)
            .await;

        assert!(!res.truncated);
        assert_eq!(res.files[0], "src/main.rs");
        assert!(res.files.contains(&"src/main_test.rs".to_string()));
    }

    #[tokio::test]
    async fn fuzzy_match_on_filename() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/components/QuickOpen.tsx", "README.md"],
        )
        .await;

        let res = idx
            .search("wt1", Path::new("/nonexistent"), "qkopn", 10)
            .await;
        assert_eq!(res.files, vec!["src/components/QuickOpen.tsx".to_string()]);
    }

    #[tokio::test]
    async fn fuzzy_match_falls_back_to_full_path() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/hooks/useWorktreeFiles.ts", "src/main.ts"],
        )
        .await;

        // "hooksuse" only matches when the directory component is included.
        let res = idx
            .search("wt1", Path::new("/nonexistent"), "hooksuse", 10)
            .await;
        assert_eq!(res.files, vec!["src/hooks/useWorktreeFiles.ts".to_string()]);
    }

    #[tokio::test]
    async fn empty_query_returns_first_n_entries() {
        let idx = index();
        seed(&idx, "wt1", vec!["a.rs", "b.rs", "c.rs", "d.rs"]).await;

        let res = idx.search("wt1", Path::new("/nonexistent"), "", 2).await;
        assert_eq!(res.files.len(), 2);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn unknown_worktree_lazily_fills_from_disk() {
        let idx = index();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("hello.txt"), "hi").unwrap();

        let res = idx.search("brand-new-wt", dir.path(), "hello", 10).await;
        assert_eq!(res.files, vec!["hello.txt".to_string()]);

        // Second call should now hit the populated index directly (no panic
        // even though the path is bogus this time).
        let res2 = idx
            .search("brand-new-wt", Path::new("/does/not/exist"), "hello", 10)
            .await;
        assert_eq!(res2.files, vec!["hello.txt".to_string()]);
    }

    #[tokio::test]
    async fn evict_then_search_finds_file_added_during_gap() {
        let idx = index();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("before.txt"), "x").unwrap();

        // First query populates the index.
        let res = idx.search("wt1", dir.path(), "before", 10).await;
        assert_eq!(res.files, vec!["before.txt".to_string()]);

        // Evict (simulating the worktree's last tree watcher closing — nobody
        // is listening, so incremental inserts would miss new files).
        idx.evict("wt1").await;

        // A file created during the "nobody listening" gap:
        fs::write(dir.path().join("after-gap.txt"), "y").unwrap();

        // The next search must re-walk disk and find the new file, not serve
        // the stale pre-gap index (Phase 3 / plan point 3).
        let res = idx.search("wt1", dir.path(), "after-gap", 10).await;
        assert_eq!(res.files, vec!["after-gap.txt".to_string()]);
    }

    #[tokio::test]
    async fn insert_on_unpopulated_worktree_is_noop() {
        let idx = index();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("real.txt"), "x").unwrap();

        // insert on an unpopulated worktree must not create a partial entry.
        idx.insert("wt-unpop", "only-inserted.txt").await;
        assert!(all(&idx, "wt-unpop").await.is_empty());

        // search should still trigger a full lazy populate and find the file
        // on disk, NOT just the previously-inserted one.
        let res = idx.search("wt-unpop", dir.path(), "", 100).await;
        assert!(res.files.contains(&"real.txt".to_string()));
        assert!(!res.files.contains(&"only-inserted.txt".to_string()));
    }

    #[tokio::test]
    async fn insert_and_remove_on_populated_worktree() {
        let idx = index();
        seed(&idx, "wt1", vec!["a.rs"]).await;

        idx.insert("wt1", "b.rs").await;
        let res = idx.search("wt1", Path::new("/nonexistent"), "b", 10).await;
        assert_eq!(res.files, vec!["b.rs".to_string()]);

        idx.remove("wt1", "b.rs").await;
        let res = idx.search("wt1", Path::new("/nonexistent"), "b", 10).await;
        assert!(res.files.is_empty());
    }

    #[tokio::test]
    async fn merge_subtree_replaces_under_prefix_only() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec![
                "src/a.rs",
                "src/sub/old1.rs",
                "src/sub/nested/old2.rs",
                "other.rs",
            ],
        )
        .await;

        idx.merge_subtree(
            "wt1",
            "src/sub",
            vec!["src/sub/new1.rs".to_string(), "src/sub/new2.rs".to_string()],
        )
        .await;

        let set = all(&idx, "wt1").await;
        assert!(set.contains("src/a.rs"));
        assert!(set.contains("other.rs"));
        assert!(!set.contains("src/sub/old1.rs"));
        assert!(!set.contains("src/sub/nested/old2.rs"));
        assert!(set.contains("src/sub/new1.rs"));
        assert!(set.contains("src/sub/new2.rs"));
    }

    #[tokio::test]
    async fn merge_subtree_with_empty_files_removes_subtree() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/a.rs", "src/sub/x.rs", "src/sub/nested/y.rs", "keep.rs"],
        )
        .await;

        idx.merge_subtree("wt1", "src/sub", vec![]).await;

        let set = all(&idx, "wt1").await;
        assert!(set.contains("src/a.rs"));
        assert!(set.contains("keep.rs"));
        assert!(!set.contains("src/sub/x.rs"));
        assert!(!set.contains("src/sub/nested/y.rs"));
    }

    #[tokio::test]
    async fn no_match_returns_empty() {
        let idx = index();
        seed(&idx, "wt1", vec!["a.rs"]).await;
        let res = idx
            .search("wt1", Path::new("/nonexistent"), "zzzzz-nope", 10)
            .await;
        assert!(res.files.is_empty());
        assert!(!res.truncated);
    }

    #[tokio::test]
    async fn query_case_is_ignored() {
        let idx = index();
        seed(&idx, "wt1", vec!["src/components/QuickOpen.tsx"]).await;

        for q in ["QUICKOPEN", "QuickOpen", "quickopen"] {
            let res = idx.search("wt1", Path::new("/nonexistent"), q, 10).await;
            assert_eq!(
                res.files,
                vec!["src/components/QuickOpen.tsx".to_string()],
                "query {q:?} should match case-insensitively"
            );
        }
    }
}
