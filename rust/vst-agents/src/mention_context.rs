use std::collections::HashSet;
use std::path::PathBuf;
use vst_store::StoreHandle;
use vst_types::domain::{Mention, MentionKind, ProjectRecord};

pub const MAX_MENTIONS: usize = 50;
pub const MAX_CONTEXT_ITEMS: usize = 20;
pub const MAX_FIELD_BYTES: usize = 1024;

/// Sanitize field: control chars -> ' ', '"' -> '\'', and cap at `max_chars` characters.
pub fn sanitize_field(s: &str, max_chars: usize) -> String {
    s.chars()
        .take(max_chars)
        .map(|c| {
            if c.is_control() {
                ' '
            } else if c == '"' {
                '\''
            } else {
                c
            }
        })
        .collect()
}

/// Validate mentions list: <=50 items, id/label non-empty, <=1024 bytes, and NO control chars in id/label.
pub fn validate_mentions(m: &[Mention]) -> Result<(), String> {
    if m.len() > MAX_MENTIONS {
        return Err(format!(
            "Mentions list exceeds maximum of {MAX_MENTIONS} (got {})",
            m.len()
        ));
    }
    for item in m {
        if item.kind == MentionKind::Unknown {
            return Err("unknown mention kind".to_string());
        }
        if item.id.is_empty() {
            return Err("Mention id cannot be empty".to_string());
        }
        if item.label.is_empty() {
            return Err("Mention label cannot be empty".to_string());
        }
        if item.id.len() > MAX_FIELD_BYTES {
            return Err(format!(
                "Mention id exceeds maximum of {MAX_FIELD_BYTES} bytes"
            ));
        }
        if item.label.len() > MAX_FIELD_BYTES {
            return Err(format!(
                "Mention label exceeds maximum of {MAX_FIELD_BYTES} bytes"
            ));
        }
        if item.id.chars().any(|c| c.is_control()) {
            return Err("Mention id cannot contain control characters".to_string());
        }
        if item.label.chars().any(|c| c.is_control()) {
            return Err("Mention label cannot contain control characters".to_string());
        }
    }
    Ok(())
}

fn describe_one_mention(
    item: &Mention,
    projects: &[ProjectRecord],
    worktree_path: &dyn Fn(&str, &str) -> PathBuf,
) -> Option<String> {
    match item.kind {
        MentionKind::File | MentionKind::Unknown => None,
        MentionKind::Agent => {
            // Lookup in worktrees[].sessions[] then direct_sessions[]
            for p in projects {
                for wt in &p.worktrees {
                    for s in &wt.sessions {
                        if s.id == item.id {
                            let raw_name = s
                                .name
                                .as_deref()
                                .filter(|n| !n.is_empty())
                                .unwrap_or(&item.label);
                            let name = sanitize_field(raw_name, 80);
                            let id = sanitize_field(&s.id, 80);
                            let state =
                                crate::prompt_builder::lifecycle_state_str(s.lifecycle.state);
                            let branch = sanitize_field(&wt.branch, 80);
                            let abs_path = worktree_path(&p.id, &wt.id);
                            let path = sanitize_field(&abs_path.display().to_string(), 400);
                            return Some(format!(
                                "- agent \"{name}\" id={id} state={state} worktree={branch} path={path}"
                            ));
                        }
                    }
                }
                for s in &p.direct_sessions {
                    if s.id == item.id {
                        let raw_name = s
                            .name
                            .as_deref()
                            .filter(|n| !n.is_empty())
                            .unwrap_or(&item.label);
                        let name = sanitize_field(raw_name, 80);
                        let id = sanitize_field(&s.id, 80);
                        let state = crate::prompt_builder::lifecycle_state_str(s.lifecycle.state);
                        let project_id = sanitize_field(&p.id, 80);
                        let path = sanitize_field(&p.absolute_path, 400);
                        return Some(format!(
                            "- agent \"{name}\" id={id} state={state} project={project_id} path={path}"
                        ));
                    }
                }
            }
            // Unknown id
            let id = sanitize_field(&item.id, 80);
            let label = sanitize_field(&item.label, 80);
            Some(format!("- agent id={id} \"{label}\" (no longer exists)"))
        }
        MentionKind::Worktree => {
            for p in projects {
                for wt in &p.worktrees {
                    if wt.id == item.id {
                        let raw_name = wt
                            .name
                            .as_deref()
                            .filter(|n| !n.is_empty())
                            .unwrap_or(&wt.branch);
                        let name = sanitize_field(raw_name, 80);
                        let id = sanitize_field(&wt.id, 80);
                        let branch = sanitize_field(&wt.branch, 80);
                        let abs_path = worktree_path(&p.id, &wt.id);
                        let path = sanitize_field(&abs_path.display().to_string(), 400);
                        // The mentioned worktree may belong to another project
                        // than the agent's own — say which.
                        let project_id = sanitize_field(&p.id, 80);
                        return Some(format!(
                            "- worktree \"{name}\" id={id} branch={branch} project={project_id} path={path}"
                        ));
                    }
                }
            }
            let id = sanitize_field(&item.id, 80);
            let label = sanitize_field(&item.label, 80);
            Some(format!("- worktree id={id} \"{label}\" (no longer exists)"))
        }
        MentionKind::Project => {
            for p in projects {
                if p.id == item.id {
                    let id = sanitize_field(&p.id, 80);
                    let path = sanitize_field(&p.absolute_path, 400);
                    return Some(format!("- project id={id} path={path}"));
                }
            }
            let id = sanitize_field(&item.id, 80);
            let label = sanitize_field(&item.label, 80);
            Some(format!("- project id={id} \"{label}\" (no longer exists)"))
        }
    }
}

pub fn describe_mentions(
    m: &[Mention],
    projects: &[ProjectRecord],
    worktree_path: &dyn Fn(&str, &str) -> PathBuf,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut non_file_mentions = Vec::new();
    for item in m {
        if item.kind == MentionKind::File {
            continue;
        }
        if seen.insert((item.kind, &item.id)) {
            non_file_mentions.push(item);
        }
    }

    let total = non_file_mentions.len();
    let take_count = total.min(MAX_CONTEXT_ITEMS);
    let mut lines = Vec::new();

    for item in &non_file_mentions[..take_count] {
        if let Some(line) = describe_one_mention(item, projects, worktree_path) {
            let capped: String = line.chars().take(400).collect();
            lines.push(capped);
        }
    }

    if total > MAX_CONTEXT_ITEMS {
        let omitted = total - MAX_CONTEXT_ITEMS;
        lines.push(format!("- ({omitted} more mentions omitted)"));
    }

    lines
}

pub fn format_mention_block(lines: &[String]) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let mut out = String::from(
        "[Mentions: the user referenced these items with @. Ids are authoritative; names are not unique.]",
    );
    for line in lines {
        out.push('\n');
        out.push_str(line);
    }
    Some(out)
}

pub async fn append_mention_block(
    message: String,
    m: &[Mention],
    store: &StoreHandle,
    paths: &crate::paths::Paths,
) -> String {
    let has_non_file = m.iter().any(|item| item.kind != MentionKind::File);
    if !has_non_file {
        return message;
    }

    let projects = store.get_all_projects().await;
    let lines = describe_mentions(m, &projects, &|project_id, worktree_id| {
        paths.worktree_path(project_id, worktree_id)
    });

    if let Some(block) = format_mention_block(&lines) {
        if message.is_empty() {
            block
        } else {
            format!("{message}\n\n{block}")
        }
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use vst_types::domain::{
        Channel, LifecycleState, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
    };

    fn make_test_session(id: &str, name: Option<&str>, state: LifecycleState) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            worktree_id: None,
            project_id: "p1".to_string(),
            is_main: true,
            sort_order: 1.0,
            r#type: SessionType::Agent,
            mode_id: None,
            mode_icon: None,
            name: name.map(|s| s.to_string()),
            name_source: None,
            tmux_name: format!("tmux-{id}"),
            use_tmux: true,
            channel: Some(Channel::Json),
            lifecycle: SessionLifecycle {
                state,
                reason: None,
                last_transition_at: "2026-01-01T00:00:00Z".to_string(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            draft_prompt: None,
            draft_config: None,
            archived_at: None,
            handoff_summary: None,
            parent_session_id: None,
            superseded_by: None,
            carry_over: None,
            pr: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        }
    }

    fn make_test_worktree(
        id: &str,
        name: Option<&str>,
        branch: &str,
        sessions: Vec<SessionRecord>,
    ) -> WorktreeRecord {
        WorktreeRecord {
            id: id.to_string(),
            name: name.map(|s| s.to_string()),
            branch: branch.to_string(),
            branch_is_placeholder: None,
            base_branch: "main".to_string(),
            base_sha: "abcd".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 1.0,
            terminal_seq: None,
            agent_seq: None,
            lsp_enabled: None,
            sessions,
            open_files: vec![],
        }
    }

    fn make_test_project(
        id: &str,
        path: &str,
        worktrees: Vec<WorktreeRecord>,
        direct_sessions: Vec<SessionRecord>,
    ) -> ProjectRecord {
        ProjectRecord {
            id: id.to_string(),
            absolute_path: path.to_string(),
            prefix: "p".to_string(),
            is_git: true,
            default_branch: Some("main".to_string()),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            hidden: None,
            direct_sessions,
            direct_session_seq: None,
            worktrees,
            next_worktree_num: None,
            lsp_enabled: None,
            open_files: vec![],
        }
    }

    #[test]
    fn test_sanitization_and_validation() {
        assert_eq!(sanitize_field("hello\nworld\"", 80), "hello world'");
        assert_eq!(sanitize_field("abcdefghij", 5), "abcde");

        let valid = vec![Mention {
            kind: MentionKind::File,
            id: "a/b.ts".to_string(),
            label: "b.ts".to_string(),
        }];
        assert!(validate_mentions(&valid).is_ok());

        let too_many: Vec<_> = (0..51)
            .map(|i| Mention {
                kind: MentionKind::File,
                id: format!("f{i}"),
                label: format!("l{i}"),
            })
            .collect();
        assert!(validate_mentions(&too_many).is_err());

        let empty_id = vec![Mention {
            kind: MentionKind::File,
            id: "".to_string(),
            label: "label".to_string(),
        }];
        assert!(validate_mentions(&empty_id).is_err());

        let long_label = vec![Mention {
            kind: MentionKind::File,
            id: "id".to_string(),
            label: "a".repeat(1025),
        }];
        assert!(validate_mentions(&long_label).is_err());

        let newline_id = vec![Mention {
            kind: MentionKind::File,
            id: "id\n".to_string(),
            label: "label".to_string(),
        }];
        assert!(validate_mentions(&newline_id).is_err());

        let bell_label = vec![Mention {
            kind: MentionKind::File,
            id: "id".to_string(),
            label: "label\u{7}".to_string(),
        }];
        assert!(validate_mentions(&bell_label).is_err());

        let unknown = vec![Mention {
            kind: MentionKind::Unknown,
            id: "x".to_string(),
            label: "x".to_string(),
        }];
        assert_eq!(
            validate_mentions(&unknown).unwrap_err(),
            "unknown mention kind"
        );
    }

    #[test]
    fn test_describe_mentions_lines() {
        let wt_sess = make_test_session("s1", Some("Fix login"), LifecycleState::Working);
        let wt_sess_noname = make_test_session("s2", None, LifecycleState::Idle);
        let direct_sess = make_test_session("s3", Some("Helper"), LifecycleState::WaitingForHuman);

        let wt1 = make_test_worktree(
            "wt1",
            Some("feat-x"),
            "feat/login",
            vec![wt_sess, wt_sess_noname],
        );
        let wt2 = make_test_worktree("wt2", None, "feat/branch-only", vec![]);

        let proj = make_test_project("p1", "/path/to/project", vec![wt1, wt2], vec![direct_sess]);
        let projects = vec![proj];

        let mock_wt_path = |p: &str, w: &str| PathBuf::from(format!("/worktrees/{p}/{w}"));

        let mentions = vec![
            Mention {
                kind: MentionKind::Agent,
                id: "s1".to_string(),
                label: "Fix login".to_string(),
            },
            Mention {
                kind: MentionKind::Agent,
                id: "s2".to_string(),
                label: "FallbackLabel".to_string(),
            },
            Mention {
                kind: MentionKind::Agent,
                id: "s3".to_string(),
                label: "Helper".to_string(),
            },
            Mention {
                kind: MentionKind::Worktree,
                id: "wt1".to_string(),
                label: "feat-x".to_string(),
            },
            Mention {
                kind: MentionKind::Worktree,
                id: "wt2".to_string(),
                label: "feat/branch-only".to_string(),
            },
            Mention {
                kind: MentionKind::Project,
                id: "p1".to_string(),
                label: "Project 1".to_string(),
            },
            Mention {
                kind: MentionKind::Agent,
                id: "s_unknown".to_string(),
                label: "Old name".to_string(),
            },
            Mention {
                kind: MentionKind::File,
                id: "file/a.txt".to_string(),
                label: "a.txt".to_string(),
            },
        ];

        let lines = describe_mentions(&mentions, &projects, &mock_wt_path);
        assert_eq!(
            lines[0],
            "- agent \"Fix login\" id=s1 state=working worktree=feat/login path=/worktrees/p1/wt1"
        );
        assert_eq!(
            lines[1],
            "- agent \"FallbackLabel\" id=s2 state=idle worktree=feat/login path=/worktrees/p1/wt1"
        );
        assert_eq!(
            lines[2],
            "- agent \"Helper\" id=s3 state=waiting_for_human project=p1 path=/path/to/project"
        );
        assert_eq!(
            lines[3],
            "- worktree \"feat-x\" id=wt1 branch=feat/login project=p1 path=/worktrees/p1/wt1"
        );
        assert_eq!(
            lines[4],
            "- worktree \"feat/branch-only\" id=wt2 branch=feat/branch-only project=p1 path=/worktrees/p1/wt2"
        );
        assert_eq!(lines[5], "- project id=p1 path=/path/to/project");
        assert_eq!(
            lines[6],
            "- agent id=s_unknown \"Old name\" (no longer exists)"
        );
        assert_eq!(lines.len(), 7); // file produces no line
    }

    #[test]
    fn test_dedupe_and_omitted_line() {
        let mock_wt_path = |p: &str, w: &str| PathBuf::from(format!("/wt/{p}/{w}"));
        let mut mentions = Vec::new();
        // 25 distinct agents
        for i in 0..25 {
            mentions.push(Mention {
                kind: MentionKind::Agent,
                id: format!("agent_{i}"),
                label: format!("Agent {i}"),
            });
        }
        // Duplicate agent_0
        mentions.push(Mention {
            kind: MentionKind::Agent,
            id: "agent_0".to_string(),
            label: "Agent 0 dup".to_string(),
        });

        let lines = describe_mentions(&mentions, &[], &mock_wt_path);
        assert_eq!(lines.len(), 21); // 20 lines + 1 omitted line
        assert_eq!(lines[20], "- (5 more mentions omitted)");
    }

    #[test]
    fn test_sanitized_interpolation() {
        let sess = make_test_session(
            "s_bad",
            Some("Bad\nName\"Quotes\""),
            LifecycleState::Working,
        );
        let wt = make_test_worktree("wt_bad", None, "branch\u{1}ctrl", vec![sess]);
        let proj = make_test_project("p_bad", "/path\u{2}ctrl", vec![wt], vec![]);
        let mock_wt_path = |_p: &str, _w: &str| PathBuf::from("/worktrees/path\u{3}ctrl");

        let mentions = vec![
            Mention {
                kind: MentionKind::Agent,
                id: "s_bad".to_string(),
                label: "fallback\n\"bad\"".to_string(),
            },
            Mention {
                kind: MentionKind::Agent,
                id: "s_missing".to_string(),
                label: "a".repeat(120),
            },
        ];

        let lines = describe_mentions(&mentions, &[proj], &mock_wt_path);
        assert_eq!(
            lines[0],
            "- agent \"Bad Name'Quotes'\" id=s_bad state=working worktree=branch ctrl path=/worktrees/path ctrl"
        );
        // Fallback label sanitized and capped at 80
        assert_eq!(
            lines[1],
            format!(
                "- agent id=s_missing \"{}\" (no longer exists)",
                "a".repeat(80)
            )
        );
    }

    #[tokio::test]
    async fn test_append_mention_block_async() {
        let dir = tempfile::tempdir().unwrap();
        let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
        let paths = crate::paths::Paths::with_home(dir.path().to_path_buf());

        // 0. Empty mentions slice returns the message unchanged
        let msg0 = "Plain message".to_string();
        assert_eq!(
            append_mention_block(msg0.clone(), &[], &store, &paths).await,
            msg0
        );

        // 1. Files-only input returns message byte-identical and early
        let file_mentions = vec![Mention {
            kind: MentionKind::File,
            id: "a.ts".to_string(),
            label: "a.ts".to_string(),
        }];
        let msg = "Hello from agent".to_string();
        let out = append_mention_block(msg.clone(), &file_mentions, &store, &paths).await;
        assert_eq!(out, msg);

        // 2. Non-file mention on empty store -> (no longer exists)
        let agent_mentions = vec![Mention {
            kind: MentionKind::Agent,
            id: "s1".to_string(),
            label: "Agent 1".to_string(),
        }];
        let out = append_mention_block(msg.clone(), &agent_mentions, &store, &paths).await;
        assert!(out.starts_with("Hello from agent\n\n[Mentions:"));
        assert!(out.contains("- agent id=s1 \"Agent 1\" (no longer exists)"));

        // 3. Empty message with only mentions -> block alone
        let out_empty = append_mention_block(String::new(), &agent_mentions, &store, &paths).await;
        assert!(out_empty.starts_with("[Mentions:"));
        assert!(!out_empty.starts_with("\n"));
    }

    #[tokio::test]
    async fn test_append_mention_block_uses_injected_paths() {
        let dir = tempfile::tempdir().unwrap();
        let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
        let wt = make_test_worktree("wt1", Some("feat-x"), "feat/login", vec![]);
        store
            .add_project(make_test_project(
                "p1",
                "/path/to/project",
                vec![wt],
                vec![],
            ))
            .await
            .unwrap();
        let home = dir.path().join("custom-home");
        let paths = crate::paths::Paths::with_home(home.clone());
        let mentions = vec![Mention {
            kind: MentionKind::Worktree,
            id: "wt1".to_string(),
            label: "feat-x".to_string(),
        }];
        let out = append_mention_block("hi".to_string(), &mentions, &store, &paths).await;
        let expected = home
            .join("projects")
            .join("p1")
            .join("worktrees")
            .join("wt1");
        assert!(
            out.contains(&format!("path={}", expected.display())),
            "{out}"
        );
    }
}
