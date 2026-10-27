//! Pure ranking function for file search.
//!
//! Match precedence: filename prefix match > filename fuzzy match > full-path
//! fuzzy match. Within each match bucket, ties are broken by age-relative hour
//! buckets (younger first), then fuzzy score, then path for determinism.
//! Matching is case-insensitive throughout.

use std::collections::HashMap;

use nucleo_matcher::{Config, Matcher, Utf32Str};
use vst_types::rest::worktrees::FileSearchResult;

const MS_PER_HOUR: i64 = 3_600_000;

#[inline]
pub(crate) fn age_bucket(created_ms: i64, now_ms: i64) -> u64 {
    if created_ms <= 0 {
        u64::MAX
    } else {
        let diff = (now_ms - created_ms).max(0);
        (diff / MS_PER_HOUR) as u64
    }
}

// nucleo-matcher 0.3 requires a FRESH Vec<char> scratch buffer per Utf32Str::new()
// call — it must not be reused across different source strings. The needle must be
// case-folded by the CALLER (nucleo-matcher does not case-fold internally despite
// Config::DEFAULT.ignore_case existing) — do it once, outside the loop.
pub(crate) fn rank(
    query: &str,
    candidates: &HashMap<String, i64>,
    limit: usize,
    now_ms: i64,
) -> FileSearchResult {
    if query.is_empty() {
        let truncated = candidates.len() > limit;
        let mut sorted: Vec<(&String, u64)> = candidates
            .iter()
            .map(|(path, &created)| (path, age_bucket(created, now_ms)))
            .collect();
        sorted.sort_by(|(path_a, age_a), (path_b, age_b)| {
            age_a.cmp(age_b).then_with(|| path_a.cmp(path_b))
        });
        let files = sorted
            .into_iter()
            .take(limit)
            .map(|(path, _)| path.clone())
            .collect();
        return FileSearchResult {
            files,
            truncated,
            indexing: false,
        };
    }

    // Whitespace is dropped from the needle so a multi-word query like
    // "auth middleware" still fuzzy-matches `authMiddleware.ts` (nucleo treats
    // a space as a literal character, which no path contains).
    let query_lower: String = query.to_lowercase().split_whitespace().collect();
    if query_lower.is_empty() {
        return rank("", candidates, limit, now_ms);
    }
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut scored: Vec<(u8, u64, u32, &str)> = Vec::new();

    for (path, &created_ms) in candidates {
        let name = path.rsplit('/').next().unwrap_or(path);
        let name_lower = name.to_lowercase();
        let age = age_bucket(created_ms, now_ms);

        let mut query_buf = Vec::new();
        let query_key = Utf32Str::new(&query_lower, &mut query_buf);

        if name_lower.starts_with(&query_lower) {
            scored.push((2, age, u32::MAX - name.len() as u32, path));
            continue;
        }

        let mut name_buf = Vec::new();
        let name_key = Utf32Str::new(&name_lower, &mut name_buf);
        if let Some(score) = matcher.fuzzy_match(name_key, query_key) {
            scored.push((1, age, score as u32, path));
            continue;
        }

        let path_lower = path.to_lowercase();
        let mut path_buf = Vec::new();
        let path_key = Utf32Str::new(&path_lower, &mut path_buf);
        if let Some(score) = matcher.fuzzy_match(path_key, query_key) {
            scored.push((0, age, score as u32, path));
        }
    }

    let truncated = scored.len() > limit;
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0) // match bucket desc
            .then_with(|| a.1.cmp(&b.1)) // age_bucket asc
            .then_with(|| b.2.cmp(&a.2)) // score desc
            .then_with(|| a.3.cmp(b.3)) // path asc
    });
    let files = scored
        .into_iter()
        .take(limit)
        .map(|(_, _, _, p)| p.to_string())
        .collect();
    FileSearchResult {
        files,
        truncated,
        indexing: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rank_whitespace_in_query_is_ignored() {
        let now_ms = 1_000_000_000_000;
        let mut c = HashMap::new();
        c.insert("src/authMiddleware.ts".to_string(), now_ms);
        c.insert("src/cors.ts".to_string(), now_ms);
        let res = rank("auth middleware", &c, 10, now_ms);
        assert_eq!(res.files, vec!["src/authMiddleware.ts".to_string()]);
        let all = rank("   ", &c, 10, now_ms);
        assert_eq!(all.files.len(), 2);
    }

    #[test]
    fn test_rank_recency_and_buckets() {
        let now_ms = 1_000_000_000_000;
        let one_hour = 3_600_000;

        let mut candidates = HashMap::new();
        // File aged 1 hour vs aged 5 hours, same match bucket (prefix match on "main")
        let file_1h = "src/main.rs".to_string();
        let file_5h = "src/main_old.rs".to_string();
        candidates.insert(file_1h.clone(), now_ms - one_hour);
        candidates.insert(file_5h.clone(), now_ms - 5 * one_hour);

        let res = rank("main", &candidates, 10, now_ms);
        assert_eq!(res.files[0], file_1h, "younger file should rank first");
        assert_eq!(res.files[1], file_5h);

        // Two files 5 ms apart (same age bucket) keep fuzzy-score order
        let mut fuzzy_candidates = HashMap::new();
        let fuzzy_better = "src/components/QuickOpen.tsx".to_string();
        let fuzzy_worse = "src/components/QuickOtherPopup.tsx".to_string();
        fuzzy_candidates.insert(fuzzy_better.clone(), now_ms - 100);
        fuzzy_candidates.insert(fuzzy_worse.clone(), now_ms - 105);

        let res_fuzzy = rank("quickop", &fuzzy_candidates, 10, now_ms);
        assert_eq!(res_fuzzy.files[0], fuzzy_better);
        assert_eq!(res_fuzzy.files[1], fuzzy_worse);

        // A file >= 1 h younger outranks a better-scoring older one within the same match bucket
        let mut rank_override = HashMap::new();
        // "qkopn" fuzzy matches both; QuickOpen.tsx has a better fuzzy score, but is 2 hours old;
        // QuickOtherOpen.tsx is 10 minutes old (age 0).
        let older_better = "src/components/QuickOpen.tsx".to_string();
        let younger_worse = "src/components/QuickOtherOpen.tsx".to_string();
        rank_override.insert(older_better.clone(), now_ms - 2 * one_hour);
        rank_override.insert(younger_worse.clone(), now_ms - 600_000);

        let res_override = rank("qkopn", &rank_override, 10, now_ms);
        assert_eq!(res_override.files[0], younger_worse);
        assert_eq!(res_override.files[1], older_better);

        // A prefix match with old time still beats a younger fuzzy match (match bucket first)
        let mut bucket_beats = HashMap::new();
        let prefix_old = "src/apple.rs".to_string();
        let fuzzy_young = "src/a_p_p_l_e.rs".to_string();
        bucket_beats.insert(prefix_old.clone(), now_ms - 100 * one_hour);
        bucket_beats.insert(fuzzy_young.clone(), now_ms - 1000);

        let res_bucket = rank("apple", &bucket_beats, 10, now_ms);
        assert_eq!(res_bucket.files[0], prefix_old);
        assert_eq!(res_bucket.files[1], fuzzy_young);

        // created_ms == 0 sorts last
        let mut zero_cand = HashMap::new();
        let zero_time = "src/main_stat_failed.rs".to_string();
        let old_time = "src/main_very_old.rs".to_string();
        zero_cand.insert(zero_time.clone(), 0);
        zero_cand.insert(old_time.clone(), now_ms - 10_000 * one_hour);

        let res_zero = rank("main", &zero_cand, 10, now_ms);
        assert_eq!(res_zero.files[0], old_time);
        assert_eq!(res_zero.files[1], zero_time);

        // Empty query youngest bucket first, ties by path
        let mut empty_cand = HashMap::new();
        empty_cand.insert("b_young.rs".to_string(), now_ms - 1000);
        empty_cand.insert("a_young.rs".to_string(), now_ms - 2000);
        empty_cand.insert("c_old.rs".to_string(), now_ms - 5 * one_hour);
        empty_cand.insert("d_zero.rs".to_string(), 0);

        let res_empty = rank("", &empty_cand, 10, now_ms);
        assert_eq!(res_empty.files[0], "a_young.rs");
        assert_eq!(res_empty.files[1], "b_young.rs");
        assert_eq!(res_empty.files[2], "c_old.rs");
        assert_eq!(res_empty.files[3], "d_zero.rs");
    }
}
