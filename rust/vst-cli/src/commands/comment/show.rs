//! `vst comment show <id> [--json]`

use vst_types::rest::review::CommentResponse;
use vst_types::review::ReviewComment;

use super::{describe_error_with, exit_code_for, lines_label, parse_flags};
use crate::client::{daemon_get, DaemonResult};
use crate::preflight::preflight;

#[derive(Clone, Debug, PartialEq)]
pub struct CommentShowOptions {
    pub id: String,
    pub json: bool,
}

pub fn parse_comment_show_options(args: &[String]) -> Result<CommentShowOptions, String> {
    let f = parse_flags(args)?;
    if f.positional.len() != 1 || f.unsent || f.worktree.is_some() || f.project.is_some() {
        return Err("Usage: vst comment show <id> [--json]".into());
    }
    Ok(CommentShowOptions {
        id: f.positional[0].clone(),
        json: f.json,
    })
}

/// Human-readable detail lines.
pub fn render_detail(c: &ReviewComment) -> Vec<String> {
    let mut out = vec![
        format!("Comment {} ({})", c.pin, c.id),
        format!("File:    {}", c.path),
    ];
    let lines = lines_label(c);
    if !lines.is_empty() {
        out.push(format!("Lines:   {lines}"));
    }
    out.push(format!("Anchor:  {}", c.anchor.as_str()));
    if let Some(to) = &c.attached_to {
        out.push(format!("Attached to: {to}"));
    }
    if !c.quote.is_empty() {
        out.push("Quote:".to_string());
        out.extend(c.quote.lines().map(|l| format!("  | {l}")));
    }
    out.push("Comment:".to_string());
    out.extend(c.text.lines().map(|l| format!("  | {l}")));
    out
}

/// Fetch one comment, mapping failures to `(message, exit code)` (404 -> 2).
pub async fn fetch_comment(id: &str) -> Result<ReviewComment, (String, i32)> {
    preflight().await;
    let result = daemon_get::<CommentResponse>(&format!("/comments/{id}"))
        .await
        .map_err(|e| (e.to_string(), 1))?;
    match result {
        DaemonResult::Ok { data, .. } => Ok(data.comment),
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

/// What `vst comment show` prints.
pub fn render_output(json: bool, comment: &ReviewComment) -> Vec<String> {
    if json {
        return vec![serde_json::to_string_pretty(comment).unwrap_or_else(|_| "{}".into())];
    }
    render_detail(comment)
}

pub async fn run_comment_show(opts: CommentShowOptions) -> Result<(), (String, i32)> {
    let comment = fetch_comment(&opts.id).await?;
    render_output(opts.json, &comment)
        .iter()
        .for_each(|l| println!("{l}"));
    Ok(())
}
