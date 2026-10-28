//! `vst comment list [--unsent] [--worktree <id> | --project <id>] [--json]`

use vst_types::rest::review::CommentListResponse;
use vst_types::review::ReviewComment;

use super::{comments_path, describe_error_with, exit_code_for, lines_label, parse_flags};
use crate::client::{daemon_get, DaemonResult};
use crate::output::format_table;
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct CommentListOptions {
    /// `/worktrees/:id/comments` or `/projects/:id/comments`.
    pub path: String,
    pub unsent: bool,
    pub json: bool,
}

pub fn parse_comment_list_options(args: &[String]) -> Result<CommentListOptions, String> {
    let f = parse_flags(args)?;
    if !f.positional.is_empty() {
        return Err(
            "Usage: vst comment list [--unsent] [--worktree <id> | --project <id>] [--json]".into(),
        );
    }
    Ok(CommentListOptions {
        path: comments_path(f.worktree, f.project)?,
        unsent: f.unsent,
        json: f.json,
    })
}

/// Request path with the delivery filter.
pub fn request_path(opts: &CommentListOptions) -> String {
    if opts.unsent {
        format!("{}?delivery=unsent", opts.path)
    } else {
        opts.path.clone()
    }
}

fn one_line(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if flat.chars().count() > max {
        let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    } else {
        flat
    }
}

/// Table lines: id, pin, anchor, `file:lines`, text.
pub fn render_table(items: &[ReviewComment]) -> Vec<String> {
    let rows: Vec<Vec<String>> = items
        .iter()
        .map(|c| {
            let mut loc = c.path.clone();
            let l = lines_label(c);
            if !l.is_empty() {
                loc.push(':');
                loc.push_str(&l);
            }
            vec![
                c.id.clone(),
                c.pin.to_string(),
                c.anchor.as_str().to_string(),
                one_line(&loc, 60),
                one_line(&c.text, 60),
            ]
        })
        .collect();
    format_table(&["ID", "PIN", "ANCHOR", "WHERE", "COMMENT"], &rows)
}

/// What `vst comment list` prints: the JSON array with `--json`, else a table
/// (or a one-line notice when there are no comments).
pub fn render_output(json: bool, comments: &[ReviewComment]) -> Vec<String> {
    if json {
        return vec![serde_json::to_string_pretty(comments).unwrap_or_else(|_| "[]".into())];
    }
    if comments.is_empty() {
        return vec!["No review comments.".to_string()];
    }
    render_table(comments)
}

/// Fetch the scope's comments (with the delivery filter), mapping failures to
/// the CLI's `(message, exit code)`.
pub async fn fetch_comments(
    opts: &CommentListOptions,
) -> Result<Vec<ReviewComment>, (String, i32)> {
    preflight().await;
    let result = daemon_get::<CommentListResponse>(&request_path(opts))
        .await
        .map_err(|e| (e.to_string(), 1))?;
    match result {
        DaemonResult::Ok { data, .. } => Ok(data.comments),
        DaemonResult::Err {
            status,
            error,
            message,
            ..
        } => Err((
            describe_error_with(&error, message.as_deref()),
            exit_code_for(status),
        )),
    }
}

pub async fn run_comment_list(opts: CommentListOptions) -> Result<(), (String, i32)> {
    let comments = fetch_comments(&opts).await?;
    render_output(opts.json, &comments)
        .iter()
        .for_each(|l| println!("{l}"));
    Ok(())
}
