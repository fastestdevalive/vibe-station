//! Shared ripgrep search utility for worktree search, project search, and LSP fallback.

use std::collections::HashMap;
use std::path::Path;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use vst_types::rest::worktrees::{SearchFileMatches, SearchMatch, SearchResult};

#[derive(Debug, thiserror::Error)]
pub enum RgSearchError {
    #[error("ripgrep not found on PATH")]
    NotFound,
    #[error("ripgrep process error: {0}")]
    ProcessError(String),
}

#[derive(Debug, Clone)]
pub struct RgRawMatch {
    pub path: String,
    pub line_number: u32,
    pub start_byte: usize,
    pub end_byte: usize,
    pub line_text: String,
}

/// Run `rg --json` subprocess in `root` and collect up to `limit` raw match records.
pub async fn rg_search(
    root: &Path,
    q: &str,
    re: bool,
    case: bool,
    word: bool,
    glob: Option<&str>,
    limit: usize,
) -> Result<Vec<RgRawMatch>, RgSearchError> {
    let mut argv = vec![
        "--json".to_string(),
        "--hidden".to_string(),
        "--glob".to_string(),
        "!.git".to_string(),
        "--glob".to_string(),
        "!.git/**".to_string(),
    ];

    if !re {
        argv.push("--fixed-strings".into());
    }
    if case {
        argv.push("--case-sensitive".into());
    } else {
        argv.push("--ignore-case".into());
    }
    if word {
        argv.push("--word-regexp".into());
    }
    if let Some(g) = glob {
        argv.push("--glob".into());
        argv.push(g.to_string());
    }
    argv.push("--".into());
    argv.push(q.to_string());

    let mut child = Command::new("rg")
        .args(&argv)
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // The caller (Axum handler future) can be dropped mid-stream —
        // e.g. the browser aborts a superseded search request while this
        // is still awaiting `lines.next_line()`. Without this, dropping
        // the future orphans the `rg` process instead of terminating it;
        // `kill_on_drop` makes tokio kill it as part of dropping `child`.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                RgSearchError::NotFound
            } else {
                RgSearchError::ProcessError(format!("Failed to spawn rg: {e}"))
            }
        })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        RgSearchError::ProcessError("Failed to capture rg stdout".into())
    })?;

    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = reader.lines();

    let mut matches = Vec::new();

    while let Some(line) = lines.next_line().await.unwrap_or(None) {
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }

        let data = match parsed.get("data") {
            Some(d) => d,
            None => continue,
        };

        let path = data
            .pointer("/path/text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let line_number = data
            .pointer("/line_number")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let lines_text = data
            .pointer("/lines/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let submatches = match data.get("submatches").and_then(|v| v.as_array()) {
            Some(a) => a,
            None => continue,
        };

        for sm in submatches {
            let start = sm.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let end = sm.get("end").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

            matches.push(RgRawMatch {
                path: path.clone(),
                line_number,
                start_byte: start,
                end_byte: end,
                line_text: lines_text.to_string(),
            });

            if matches.len() >= limit {
                break;
            }
        }

        if matches.len() >= limit {
            break;
        }
    }

    // Kill the child if we stopped early (truncated) or just let it finish.
    let _ = child.kill().await;
    let _ = child.wait().await;

    Ok(matches)
}

/// Split `line` at byte offsets `start..end` into `(pre, mid, post)`,
/// then truncate the three fragments so the combined char-count stays
/// within `SNIP_MAX` (240). Public for unit-testing.
pub fn truncate_snippet(line: &str, start: usize, end: usize) -> (String, String, String) {
    const SNIP_LEAD: usize = 32;
    const SNIP_KEEP: usize = 16;
    const SNIP_MAX: usize = 240;

    // Byte-offset split — clamp to line length to avoid panic.
    let start = start.min(line.len());
    let end = end.min(line.len()).max(start);
    let raw_pre = &line[..start];
    let raw_mid = &line[start..end];
    let raw_post = &line[end..];

    // --- pre ---
    let mut pre: String = raw_pre.trim_start_matches([' ', '\t']).to_string();
    if pre.chars().count() > SNIP_LEAD {
        let keep: String = pre.chars().rev().take(SNIP_KEEP).collect::<Vec<_>>().into_iter().rev().collect();
        pre = format!("…{keep}");
    }

    // --- mid ---
    let mut mid: String = raw_mid.to_string();
    let mid_budget = SNIP_MAX.saturating_sub(pre.chars().count());
    if mid.chars().count() > mid_budget {
        let keep = mid_budget.saturating_sub(1);
        mid = mid.chars().take(keep).collect::<String>() + "…";
    }

    // --- post ---
    let budget = SNIP_MAX.saturating_sub(pre.chars().count()).saturating_sub(mid.chars().count());
    let mut post: String = if budget > 0 {
        let p = raw_post.to_string();
        if p.chars().count() > budget {
            p.chars().take(budget).collect::<String>() + "…"
        } else {
            p
        }
    } else {
        String::new()
    };
    post = post.trim_end_matches([' ', '\t']).to_string();

    (pre, mid, post)
}

/// Shape flat `RgRawMatch`es into grouped `SearchResult` with truncated snippets.
pub fn shape_search_matches(
    raw_matches: &[RgRawMatch],
    limit: usize,
) -> SearchResult {
    let mut files: Vec<SearchFileMatches> = Vec::new();
    let mut file_index: HashMap<String, usize> = HashMap::new();
    let mut total_matches: usize = 0;
    let mut truncated = false;

    for m in raw_matches {
        let (pre, mid, post) = truncate_snippet(&m.line_text, m.start_byte, m.end_byte);

        let search_match = SearchMatch {
            line: m.line_number,
            pre,
            mid,
            post,
        };

        let idx = if let Some(&i) = file_index.get(&m.path) {
            i
        } else {
            let i = files.len();
            file_index.insert(m.path.clone(), i);
            files.push(SearchFileMatches {
                path: m.path.clone(),
                matches: Vec::new(),
            });
            i
        };
        files[idx].matches.push(search_match);
        total_matches += 1;

        if total_matches >= limit {
            truncated = true;
            break;
        }
    }

    SearchResult {
        files,
        truncated,
        total_matches,
    }
}
