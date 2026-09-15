//! Skill-invocation resolution at turn-run time (ports the top-level pure
//! functions of `services/jsonAgent.ts`: `resolveSkillInvocations`,
//! `resolveLeadingLineInvocation`, `mergeWithSkillCatalog`,
//! `cliSupportsSkillDirective`, `injectAttachments`). Genuinely low-risk and
//! self-contained — no live `JsonAgentSession` state is touched.

use vst_types::{Attachment, Command};

use crate::skill_tokens::{parse_skill_segments, SkillSegment};
use crate::user_skill_catalog::{get_merged_skill_catalog, MergedSkillEntry};

/// A single resolved `{/name args}` token, feeding `formatSkillDirective`'s
/// `<skill-invocations>` block. `path` is omitted for an ACP-only catalog
/// entry (no directory-scanned path).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSkillInvocation {
    pub name: String,
    pub args: String,
    pub path: Option<String>,
}

/// Result of resolving every skill token in a raw turn message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillResolutionResult {
    /// `rawMessage` with every token substituted inline for `/name args`
    /// (RESOLVED or not). A message with no tokens passes through byte-identical.
    pub message: String,
    /// One entry per RESOLVED token, in document order. An unresolved token
    /// still substitutes into `message` but contributes no entry here.
    pub skill_invocations: Vec<ResolvedSkillInvocation>,
}

/// v1 fallback (7A.5): resolve line 1 of a raw turn message against the merged
/// skill catalog — longest-match name, followed by a space or end-of-line.
/// Returns `None` when line 1 doesn't start with "/" + a catalog name.
fn resolve_leading_line_invocation(
    raw_message: &str,
    catalog: &[MergedSkillEntry],
) -> Option<ResolvedSkillInvocation> {
    if !raw_message.starts_with('/') {
        return None;
    }
    let nl = raw_message.find('\n');
    let first_line = match nl {
        Some(idx) => &raw_message[..idx],
        None => raw_message,
    };

    let mut best: Option<&MergedSkillEntry> = None;
    for entry in catalog {
        if entry.name.is_empty() {
            continue;
        }
        let token = format!("/{}", entry.name);
        let matches = first_line == token || first_line.starts_with(&format!("{token} "));
        if matches && (best.is_none() || entry.name.len() > best.unwrap().name.len()) {
            best = Some(entry);
        }
    }
    let best = best?;

    let rest = &first_line[1 + best.name.len()..];
    let args = if let Some(stripped) = rest.strip_prefix(' ') {
        stripped.to_string()
    } else {
        rest.to_string()
    };
    Some(ResolvedSkillInvocation {
        name: best.name.clone(),
        args,
        path: best.path.as_ref().map(|p| p.display().to_string()),
    })
}

/// Resolve every `{/name args}` token in `rawMessage` against the merged skill
/// catalog at TURN-RUN time (never enqueue time). Inline substitution (D5/7A.3):
/// every token — resolved or not — is replaced by `/name args`. A RESOLVED token
/// additionally contributes a `{name, args, path?}` entry. D7: when the FIRST
/// segment is a RESOLVED token followed by same-line prose, the substitution
/// forces a newline after it. v1 fallback: a message with NO tokens is handed
/// to `resolve_leading_line_invocation`.
pub fn resolve_skill_invocations(
    raw_message: &str,
    catalog: &[MergedSkillEntry],
) -> SkillResolutionResult {
    let segments = parse_skill_segments(raw_message);
    let has_token = segments.iter().any(|s| s.is_token());

    if !has_token {
        let legacy = resolve_leading_line_invocation(raw_message, catalog);
        return SkillResolutionResult {
            message: raw_message.to_string(),
            skill_invocations: legacy.into_iter().collect(),
        };
    }

    let mut skill_invocations: Vec<ResolvedSkillInvocation> = Vec::new();
    let mut pieces: Vec<String> = Vec::new();

    for seg in &segments {
        match seg {
            SkillSegment::Text(text) => {
                pieces.push(text.clone());
            }
            SkillSegment::Token { name, args } => {
                if let Some(entry) = catalog.iter().find(|e| e.name == *name) {
                    skill_invocations.push(ResolvedSkillInvocation {
                        name: name.clone(),
                        args: args.clone(),
                        path: entry.path.as_ref().map(|p| p.display().to_string()),
                    });
                }
                pieces.push(if args.is_empty() {
                    format!("/{name}")
                } else {
                    format!("/{name} {args}")
                });
            }
        }
    }

    let first = segments.first();
    let first_is_resolved_token = match first {
        Some(SkillSegment::Token { name, .. }) => catalog.iter().any(|e| e.name == *name),
        _ => false,
    };
    if first_is_resolved_token {
        let head = pieces[0].clone();
        let rest: String = pieces[1..].join("");
        let message = if rest.is_empty() || rest.starts_with('\n') {
            format!("{head}{rest}")
        } else {
            let rest = if let Some(stripped) = rest.strip_prefix(' ') {
                stripped.to_string()
            } else {
                rest
            };
            format!("{head}\n{rest}")
        };
        return SkillResolutionResult {
            message,
            skill_invocations,
        };
    }

    SkillResolutionResult {
        message: pieces.join(""),
        skill_invocations,
    }
}

/// Skills are CLI-agnostic on the no-live-session rebuild path.
pub fn cli_supports_skill_directive(_cli: &str) -> bool {
    true
}

/// Overlay the directory-scanned catalog onto the ACP `commands_update` catalog
/// for the popover-facing `SessionMeta.commands` field. Per-field merge: ACP
/// wins `description`/`argumentHint`; `path` is resolved separately daemon-side
/// and never appears here. Returns `None` only when NEITHER source has answered
/// yet (the genuinely transient "still loading" state).
pub fn merge_with_skill_catalog(
    acp_commands: Option<&[Command]>,
    supports_skill_directive: bool,
) -> Option<Vec<Command>> {
    let acp: &[Command] = acp_commands.unwrap_or(&[]);
    let merged = get_merged_skill_catalog(acp);
    let filtered = merged
        .into_iter()
        .filter(|entry| supports_skill_directive || entry.path.is_none())
        .map(|entry| Command {
            name: entry.name,
            description: entry.description.unwrap_or_default(),
            argument_hint: entry.argument_hint,
        })
        .collect::<Vec<_>>();
    if filtered.is_empty() && acp_commands.is_none() {
        return None;
    }
    Some(filtered)
}

/// Inject absolute attachment paths into a user message (Decision 5). Applied at
/// RUN time (not enqueue) so the queued turn retains the raw user text.
pub fn inject_attachments(
    message: &str,
    attachments: &[Attachment],
    has_resolved_invocation: bool,
) -> String {
    if attachments.is_empty() {
        return message.to_string();
    }
    let list = attachments
        .iter()
        .map(|a| a.path.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let header = format!("[Attached files:]\n{list}");
    if !message.trim().is_empty() || has_resolved_invocation {
        format!("{message}\n\n{header}")
    } else {
        header
    }
}
