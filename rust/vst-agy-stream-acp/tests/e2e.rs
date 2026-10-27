//! End-to-end tests: raw newline-delimited JSON-RPC against the real
//! `vst-agy-stream-acp` binary, with `tests/fake_agy.py` standing in for agy.
//!
//! Every test owns a tempdir for the fake's argv/pid/user logs and the session
//! cwd, and kills the agent child on drop.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::time::timeout;

const READ_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN: &str = "abcdefghij0123456789ABCDEFGHIJ0123456789";

struct Agent {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// Kept alive for the whole test (its path is deleted on drop).
    dir: tempfile::TempDir,
    cwd: PathBuf,
    argv_log: PathBuf,
    pid_file: PathBuf,
    user_log: PathBuf,
}

impl Agent {
    /// Spawn the agent binary pointed at the fake agy.
    fn spawn(scenario: &str) -> Self {
        Self::spawn_with(scenario, None)
    }

    fn spawn_with(scenario: &str, known: Option<&str>) -> Self {
        Self::spawn_full(scenario, known, None)
    }

    /// `transcript` = fixture the fake writes as agy's `transcript_full.jsonl`
    /// under the agent's (temp) `HOME`.
    fn spawn_with_transcript(scenario: &str, transcript: Option<&str>) -> Self {
        Self::spawn_full(scenario, None, transcript)
    }

    fn spawn_full(scenario: &str, known: Option<&str>, transcript: Option<&str>) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).expect("session cwd");
        let argv_log = dir.path().join("argv.log");
        let pid_file = dir.path().join("agy.pid");
        let user_log = dir.path().join("user.log");
        let fake = format!("{}/tests/fake_agy.py", env!("CARGO_MANIFEST_DIR"));

        let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_vst-agy-stream-acp"));
        cmd.env("AGY_BIN", fake)
            .env("FAKE_AGY_ARGV_LOG", &argv_log)
            .env("FAKE_AGY_PID_FILE", &pid_file)
            .env("FAKE_AGY_USER_LOG", &user_log)
            .env("FAKE_AGY_SCENARIO", scenario)
            .env("HOME", dir.path().join("home"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(known) = known {
            cmd.env("FAKE_AGY_KNOWN", known);
        }
        if let Some(transcript) = transcript {
            cmd.env("FAKE_AGY_TRANSCRIPT", transcript);
        }

        let mut child = cmd.spawn().expect("agent binary starts");
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().expect("agent stdout"));
        Self {
            child,
            stdin,
            stdout,
            next_id: 0,
            dir,
            cwd,
            argv_log,
            pid_file,
            user_log,
        }
    }

    /// Create `<HOME>/<rel>` (the agent's temp HOME, which the fake's
    /// `__HOME__` placeholder expands to).
    fn home_file(&self, rel: &str, body: &str) {
        let path = self.dir.path().join("home").join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).expect("home dir");
        std::fs::write(path, body).expect("home file");
    }

    fn cwd(&self) -> String {
        self.cwd.to_string_lossy().into_owned()
    }

    async fn write_line(&mut self, message: &Value) {
        let stdin = self.stdin.as_mut().expect("agent stdin open");
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .expect("write to agent");
        stdin.flush().await.expect("flush agent stdin");
    }

    async fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await;
        id
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await;
    }

    async fn read_message(&mut self) -> Value {
        let mut line = String::new();
        let read = timeout(READ_TIMEOUT, self.stdout.read_line(&mut line))
            .await
            .expect("agent must answer within the read timeout")
            .expect("read agent stdout");
        assert!(read > 0, "agent closed stdout unexpectedly");
        serde_json::from_str(line.trim()).unwrap_or_else(|error| {
            panic!("agent stdout must be pure JSON-RPC ({error}): {line:?}")
        })
    }

    /// Read notifications until the response with `id` arrives.
    async fn read_until_response(&mut self, id: u64) -> (Vec<Value>, Value) {
        let mut notifications = Vec::new();
        loop {
            let message = self.read_message().await;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return (notifications, message);
            }
            assert!(
                message.get("method").is_some(),
                "unexpected message while waiting for response {id}: {message}"
            );
            notifications.push(message);
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> (Vec<Value>, Value) {
        let id = self.send(method, params).await;
        self.read_until_response(id).await
    }

    /// Read until the first `session/update` notification.
    async fn read_first_update(&mut self) -> Value {
        loop {
            let message = self.read_message().await;
            if message.get("method").is_some() {
                return message;
            }
        }
    }

    async fn initialize(&mut self) -> Value {
        let (_, response) = self
            .request("initialize", json!({ "protocolVersion": 1 }))
            .await;
        response
    }

    async fn new_session(&mut self) -> String {
        let cwd = self.cwd();
        let (_, response) = self
            .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await;
        response["result"]["sessionId"]
            .as_str()
            .unwrap_or_else(|| panic!("session/new must return a sessionId: {response}"))
            .to_string()
    }

    fn prompt_params(session_id: &str, text: &str) -> Value {
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }],
        })
    }

    async fn prompt(&mut self, session_id: &str, text: &str) -> (Vec<Value>, Value) {
        self.request("session/prompt", Self::prompt_params(session_id, text))
            .await
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    async fn wait_exit(&mut self, limit: Duration) -> std::process::ExitStatus {
        timeout(limit, self.child.wait())
            .await
            .expect("agent must exit")
            .expect("agent exit status")
    }

    fn argv_entries(&self) -> Vec<Value> {
        let raw = std::fs::read_to_string(&self.argv_log).unwrap_or_default();
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("argv log is JSON"))
            .collect()
    }

    fn user_lines(&self) -> usize {
        std::fs::read_to_string(&self.user_log).map_or(0, |raw| raw.lines().count())
    }

    fn fake_pid(&self) -> u32 {
        let raw = std::fs::read_to_string(&self.pid_file).unwrap_or_default();
        raw.trim().parse().expect("fake agy wrote its pid")
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn session_updates(notifications: &[Value]) -> Vec<&Value> {
    notifications
        .iter()
        .filter(|message| message["method"] == "session/update")
        .map(|message| &message["params"]["update"])
        .collect()
}

fn chunk_texts(notifications: &[Value]) -> Vec<String> {
    session_updates(notifications)
        .into_iter()
        .filter(|update| update["sessionUpdate"] == "agent_message_chunk")
        .filter_map(|update| update["content"]["text"].as_str().map(str::to_string))
        .collect()
}

fn tool_update_text(update: &Value) -> String {
    update["content"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["content"]["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

async fn wait_until_dead(pid: u32, limit: Duration) {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        if !pid_alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("agy pid {pid} was still alive after {limit:?}");
}

// ---------------------------------------------------------------------------
// new session then prompt: end_turn with usage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn new_then_prompt_end_turn() {
    let mut agent = Agent::spawn("turn_text.jsonl");

    let init = agent.initialize().await;
    assert_eq!(init["result"]["protocolVersion"], 1);
    assert_eq!(init["result"]["agentCapabilities"]["loadSession"], true);
    assert!(
        init["result"].get("_meta").is_none(),
        "agy must not advertise steering: {init}"
    );

    let session_id = agent.new_session().await;
    assert_eq!(session_id, "conv-new-0001");

    let (notifications, response) = agent.prompt(&session_id, "say hello").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let chunks = chunk_texts(&notifications);
    assert_eq!(
        chunks.first().map(String::as_str),
        Some("agy Rich Chat auto-approves tool calls.\n\n"),
        "first chunk is the auto-approve note: {chunks:?}"
    );
    let streamed: String = chunks[1..].concat();
    assert_eq!(streamed, "Hello world!");

    let usage = &response["result"]["usage"];
    assert_eq!(usage["inputTokens"], 7541);
    assert_eq!(usage["outputTokens"], 11);
    assert_eq!(usage["thoughtTokens"], 10);
    assert_eq!(usage["cachedReadTokens"], 0);
    assert_eq!(usage["totalTokens"], 7552);
}

// ---------------------------------------------------------------------------
// tool turn ordering: call then update
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_turn_orders_call_then_update() {
    let mut agent = Agent::spawn("turn_tool.jsonl");
    agent.initialize().await;
    let session_id = agent.new_session().await;

    let (notifications, response) = agent.prompt(&session_id, "echo hi").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let updates = session_updates(&notifications);
    let call_position = updates
        .iter()
        .position(|update| update["sessionUpdate"] == "tool_call")
        .expect("a tool_call update");
    let completed_position = updates
        .iter()
        .position(|update| {
            update["sessionUpdate"] == "tool_call_update"
                && update["status"] == "completed"
                && tool_update_text(update).contains("hi")
        })
        .expect("a completed tool_call_update containing the output");
    assert!(
        call_position < completed_position,
        "tool_call must precede its completed update"
    );

    let call = updates[call_position];
    assert_eq!(call["status"], "in_progress");
    assert_eq!(call["kind"], "execute");
    assert_eq!(call["title"], "echo hi");
    assert_eq!(call["toolCallId"], "agy-conv-new-2");
}

// ---------------------------------------------------------------------------
// File-tool diffs from agy's transcript
// ---------------------------------------------------------------------------

/// DONE `tool_call_update`s of a file-tool turn, in stream order, plus the
/// `tool_call` titles.
fn file_tool_turn(notifications: &[Value]) -> (Vec<String>, Vec<Value>) {
    let updates = session_updates(notifications);
    let titles = updates
        .iter()
        .filter(|u| u["sessionUpdate"] == "tool_call")
        .map(|u| u["title"].as_str().unwrap_or_default().to_string())
        .collect();
    let done = updates
        .iter()
        .filter(|u| u["sessionUpdate"] == "tool_call_update" && u["status"] == "completed")
        .map(|u| (*u).clone())
        .collect();
    (titles, done)
}

fn diff_items(update: &Value) -> Vec<&Value> {
    update["content"]
        .as_array()
        .map(|items| items.iter().filter(|i| i["type"] == "diff").collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn file_tool_updates_carry_diffs_from_the_transcript() {
    let mut agent =
        Agent::spawn_with_transcript("turn_file_tools.jsonl", Some("transcript_e2e.jsonl"));
    agent.initialize().await;
    let session_id = agent.new_session().await;
    let (notifications, response) = agent.prompt(&session_id, "edit a file").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let (titles, done) = file_tool_turn(&notifications);
    assert_eq!(
        titles,
        [
            "write_file",
            "edit_file",
            "read_file",
            "playwright: browser_navigate"
        ]
    );
    assert_eq!(done.len(), 4);

    let write = diff_items(&done[0]);
    assert_eq!(write.len(), 1, "write_file diff: {:?}", done[0]);
    assert_eq!(write[0]["path"], "/tmp/x/hello.txt");
    assert_eq!(write[0]["newText"], "hi there");
    assert!(write[0].get("oldText").map_or(true, Value::is_null));

    let edit = diff_items(&done[1]);
    assert_eq!(edit.len(), 1, "edit_file diff: {:?}", done[1]);
    assert_eq!(edit[0]["path"], "/tmp/x/hello.txt");
    assert_eq!(edit[0]["oldText"], "hi");
    assert_eq!(edit[0]["newText"], "bye");
    assert_eq!(edit[0]["_meta"]["oldStart"], 1);
    assert_eq!(edit[0]["_meta"]["newStart"], 1);
    assert!(
        write[0].get("_meta").map_or(true, Value::is_null),
        "write_file diffs start at line 1 without _meta"
    );

    assert!(diff_items(&done[2]).is_empty(), "read_file has no diff");
    assert_eq!(tool_update_text(&done[2]), "1 lines, 8 bytes");
    assert!(diff_items(&done[3]).is_empty(), "mcp call has no diff");
}

#[tokio::test]
async fn edit_file_diffs_carry_real_line_starts_or_no_diff() {
    let mut agent = Agent::spawn_with_transcript(
        "turn_edit_lines.jsonl",
        Some("transcript_e2e_edit_lines.jsonl"),
    );
    // one.txt is never read (agy reported a single replacement at line 3).
    agent.home_file("work/dup.txt", "l1\nbaz\nl3\nbaz\nl5");
    agent.home_file("work/uniq.txt", "l1\nbaz\nl3");
    agent.home_file("work/amb.txt", "baz\nx\nbaz");
    agent.initialize().await;
    let session_id = agent.new_session().await;
    let (notifications, response) = agent.prompt(&session_id, "edit files").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let (_, done) = file_tool_turn(&notifications);
    assert_eq!(done.len(), 4);
    let starts = |diff: &Value| {
        (
            diff["_meta"]["oldStart"].clone(),
            diff["_meta"]["newStart"].clone(),
        )
    };

    // Result row: 1 replacement at line 3.
    let one = diff_items(&done[0]);
    assert_eq!(one.len(), 1, "{:?}", done[0]);
    assert_eq!(
        (one[0]["oldText"].as_str(), one[0]["newText"].as_str()),
        (Some("old"), Some("new"))
    );
    assert_eq!(starts(one[0]), (3.into(), 3.into()));

    // Result row: 2 replacements from line 2, but later tool calls exist in
    // the (static) transcript, so the file is not read: first replacement only.
    let dup = diff_items(&done[1]);
    assert_eq!(dup.len(), 1, "{:?}", done[1]);
    assert_eq!(starts(dup[0]), (2.into(), 2.into()));

    // No result row and a later call: never guess, no diff.
    assert!(diff_items(&done[2]).is_empty(), "{:?}", done[2]);

    // Last call, no result row, Replacement occurs twice: ambiguous, no diff.
    assert!(diff_items(&done[3]).is_empty(), "{:?}", done[3]);
}

/// One edit call, last in the transcript: the file may be scanned.
async fn single_edit_diffs(transcript: &str, body: &str) -> Vec<(Value, Value)> {
    let mut agent = Agent::spawn_with_transcript("turn_edit_scan.jsonl", Some(transcript));
    agent.home_file("work/dup.txt", body);
    agent.initialize().await;
    let session_id = agent.new_session().await;
    let (notifications, _) = agent.prompt(&session_id, "edit files").await;
    let (_, done) = file_tool_turn(&notifications);
    assert_eq!(done.len(), 1);
    diff_items(&done[0])
        .iter()
        .map(|d| {
            (
                d["_meta"]["oldStart"].clone(),
                d["_meta"]["newStart"].clone(),
            )
        })
        .collect()
}

#[tokio::test]
async fn last_edit_call_scans_the_file_for_every_occurrence() {
    let got = single_edit_diffs("transcript_e2e_edit_scan.jsonl", "l1\nbaz\nl3\nbaz\nl5").await;
    assert_eq!(got, [(2.into(), 2.into()), (4.into(), 4.into())]);
}

#[tokio::test]
async fn last_edit_call_without_result_row_uses_a_unique_occurrence() {
    let got = single_edit_diffs("transcript_e2e_edit_unique.jsonl", "l1\nbaz\nl3").await;
    assert_eq!(got, [(2.into(), 2.into())]);
}

#[tokio::test]
async fn parallel_calls_in_one_response_never_get_guessed_secondary_hunks() {
    // Call 1 replaces TOKEN x3 by two lines, call 2 (same response) inserts two
    // lines after "c". The file on disk already has both changes, so scanning
    // it for call 1 would give wrong lines (the live "case (e)").
    let mut agent = Agent::spawn_with_transcript(
        "turn_edit_parallel.jsonl",
        Some("transcript_e2e_edit_parallel.jsonl"),
    );
    agent.home_file("work/e.txt", "TO\nKEN\nb\nc\nX\nY\nTO\nKEN\nd\nTO\nKEN\ne");
    agent.initialize().await;
    let session_id = agent.new_session().await;
    let (notifications, _) = agent.prompt(&session_id, "edit files").await;
    let (_, done) = file_tool_turn(&notifications);
    assert_eq!(done.len(), 2);
    let first = diff_items(&done[0]);
    assert_eq!(first.len(), 1, "{:?}", done[0]);
    assert_eq!(first[0]["_meta"]["newStart"], 1);
    let second = diff_items(&done[1]);
    assert_eq!(second.len(), 1, "{:?}", done[1]);
    assert_eq!(second[0]["_meta"]["newStart"], 4);
}

#[tokio::test]
async fn missing_transcript_gives_plain_completed_updates() {
    let mut agent = Agent::spawn_with_transcript("turn_file_tools.jsonl", None);
    agent.initialize().await;
    let session_id = agent.new_session().await;
    let (notifications, response) = agent.prompt(&session_id, "edit a file").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let (_, done) = file_tool_turn(&notifications);
    assert_eq!(done.len(), 4);
    for update in &done {
        assert!(
            diff_items(update).is_empty(),
            "no transcript, no diff: {update}"
        );
    }
}

// ---------------------------------------------------------------------------
// session/load: known id ok, unknown id errors without forking
// ---------------------------------------------------------------------------

#[tokio::test]
async fn load_known_id_ok_and_unknown_id_errors_without_fork() {
    // Process #1: loading an id the fake knows succeeds.
    let mut known = Agent::spawn_with("turn_text.jsonl", Some("conv-known-0001"));
    known.initialize().await;
    let cwd = known.cwd();
    let (_, response) = known
        .request(
            "session/load",
            json!({ "sessionId": "conv-known-0001", "cwd": cwd, "mcpServers": [] }),
        )
        .await;
    assert!(
        response.get("error").is_none(),
        "a known id must load: {response}"
    );
    assert_eq!(response["result"], json!({}));

    // Process #2 (one session per agent process): an unknown id must fail and
    // must NOT leave a forked agy running.
    let mut bogus = Agent::spawn("turn_text.jsonl");
    bogus.initialize().await;
    let cwd = bogus.cwd();
    let (_, response) = bogus
        .request(
            "session/load",
            json!({ "sessionId": "conv-bogus", "cwd": cwd, "mcpServers": [] }),
        )
        .await;
    let error = response
        .get("error")
        .unwrap_or_else(|| panic!("an unknown id must fail: {response}"));
    assert_eq!(error["code"], -32602);
    assert!(
        error["message"]
            .as_str()
            .unwrap_or_default()
            .contains("unknown sessionId"),
        "error must name the id: {error}"
    );

    let pid = bogus.fake_pid();
    wait_until_dead(pid, Duration::from_secs(2)).await;
}

/// A failed `session/load` leaves the agent WITHOUT a
/// session (agy killed), so the daemon's fallback `session/new` on the SAME
/// connection succeeds.
#[tokio::test]
async fn failed_load_leaves_no_session_so_new_session_succeeds() {
    let mut agent = Agent::spawn("turn_text.jsonl");
    agent.initialize().await;
    let cwd = agent.cwd();
    let (_, failed) = agent
        .request(
            "session/load",
            json!({ "sessionId": "conv-bogus", "cwd": cwd, "mcpServers": [] }),
        )
        .await;
    assert!(
        failed.get("error").is_some(),
        "the load must fail: {failed}"
    );
    let fork_pid = agent.fake_pid();
    wait_until_dead(fork_pid, Duration::from_secs(2)).await;

    // Same connection: the fallback must be accepted and usable.
    let session_id = agent.new_session().await;
    assert_eq!(session_id, "conv-new-0001");
    let (notifications, response) = agent.prompt(&session_id, "hello").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert_eq!(
        chunk_texts(&notifications).concat(),
        "agy Rich Chat auto-approves tool calls.\n\nHello world!",
        "a fresh session/new emits the auto-approve note first"
    );
}

// ---------------------------------------------------------------------------
// cancel and respawn on next prompt
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_is_cancelled_and_next_prompt_respawns() {
    let mut agent = Agent::spawn("HANG,turn_text.jsonl");
    agent.initialize().await;
    let session_id = agent.new_session().await;
    assert_eq!(session_id, "conv-new-0001");

    let id = agent
        .send("session/prompt", Agent::prompt_params(&session_id, "first"))
        .await;
    // Wait until agy is actually mid-turn (first chunk: the auto-approve note).
    let first = agent.read_first_update().await;
    assert_eq!(
        first["params"]["update"]["sessionUpdate"],
        "agent_message_chunk"
    );

    agent
        .notify("session/cancel", json!({ "sessionId": session_id }))
        .await;
    let (_, response) = timeout(Duration::from_secs(8), agent.read_until_response(id))
        .await
        .expect("cancel must answer within 8 s");
    assert!(
        response.get("error").is_none(),
        "a user cancel is never a chat error: {response}"
    );
    assert_eq!(response["result"]["stopReason"], "cancelled");

    // The next prompt lazily respawns `--conversation <id>`.
    let (notifications, response) = agent.prompt(&session_id, "second").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert_eq!(chunk_texts(&notifications).concat(), "Hello world!");

    let entries = agent.argv_entries();
    assert_eq!(entries.len(), 2, "one spawn per turn after the cancel");
    let second_argv: Vec<&str> = entries[1]["argv"]
        .as_array()
        .expect("argv array")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let conversation = second_argv
        .iter()
        .position(|arg| *arg == "--conversation")
        .map(|index| second_argv[index + 1]);
    assert_eq!(conversation, Some("conv-new-0001"));

    let expected = agent.cwd.canonicalize().expect("canonical cwd");
    for entry in &entries {
        let reported = Path::new(entry["cwd"].as_str().expect("cwd string"))
            .canonicalize()
            .expect("canonical reported cwd");
        assert_eq!(reported, expected, "agy must run in the requested cwd");
    }
}

// ---------------------------------------------------------------------------
// cancel during respawn does not write the prompt
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_during_respawn_does_not_write_prompt() {
    let mut agent = Agent::spawn("HANG,turn_text.jsonl");
    agent.initialize().await;
    let session_id = agent.new_session().await;

    // First turn: cancel mid-turn so the process is killed.
    let id = agent
        .send("session/prompt", Agent::prompt_params(&session_id, "first"))
        .await;
    agent.read_first_update().await;
    agent
        .notify("session/cancel", json!({ "sessionId": session_id }))
        .await;
    let (_, response) = timeout(Duration::from_secs(8), agent.read_until_response(id))
        .await
        .expect("first cancel must answer");
    assert_eq!(response["result"]["stopReason"], "cancelled");
    assert_eq!(agent.user_lines(), 1, "the first turn wrote one prompt");

    // Second turn: cancel immediately, i.e. while agy is still starting. The
    // prompt must never reach agy.
    let id = agent
        .send(
            "session/prompt",
            Agent::prompt_params(&session_id, "second"),
        )
        .await;
    agent
        .notify("session/cancel", json!({ "sessionId": session_id }))
        .await;
    let (_, response) = timeout(Duration::from_secs(8), agent.read_until_response(id))
        .await
        .expect("a cancel during respawn must still answer");
    assert!(
        response.get("error").is_none(),
        "cancel during respawn must be `cancelled`, not an error: {response}"
    );
    assert_eq!(response["result"]["stopReason"], "cancelled");
    assert_eq!(
        agent.user_lines(),
        1,
        "no second prompt may be written to agy"
    );
}

// ---------------------------------------------------------------------------
// result error becomes a JSON-RPC error
// ---------------------------------------------------------------------------

#[tokio::test]
async fn result_error_becomes_jsonrpc_error() {
    let mut agent = Agent::spawn("turn_error.jsonl");
    agent.initialize().await;
    let session_id = agent.new_session().await;

    let (_, response) = agent.prompt(&session_id, "hello").await;
    let error = response
        .get("error")
        .unwrap_or_else(|| panic!("an ERROR result must be a JSON-RPC error: {response}"));
    assert_eq!(error["code"], -32603);
    assert!(
        error["message"]
            .as_str()
            .unwrap_or_default()
            .contains("model overloaded"),
        "error must carry agy's message: {error}"
    );
    assert!(response.get("result").is_none());
}

#[tokio::test]
async fn denied_actions_note_is_appended() {
    let mut agent = Agent::spawn("turn_tool_error.jsonl");
    agent.initialize().await;
    let session_id = agent.new_session().await;

    let (notifications, response) = agent.prompt(&session_id, "write a file").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    let updates = session_updates(&notifications);
    let failed = updates
        .iter()
        .find(|update| {
            update["sessionUpdate"] == "tool_call_update" && update["status"] == "failed"
        })
        .unwrap_or_else(|| panic!("a failed tool update: {updates:?}"));
    assert!(
        tool_update_text(failed).contains("user denied permission"),
        "failed tool must carry agy's error message: {failed}"
    );

    let note = chunk_texts(&notifications)
        .into_iter()
        .find(|text| text.contains("Antigravity denied"))
        .expect("a denied-actions note chunk");
    assert!(
        note.starts_with("\n\nAntigravity denied: RunCommand"),
        "note shape: {note:?}"
    );
}

#[tokio::test]
async fn agy_exit_is_error_with_redacted_stderr() {
    let mut agent = Agent::spawn("EXIT");
    agent.initialize().await;
    let session_id = agent.new_session().await;

    let (_, response) = agent.prompt(&session_id, "hello").await;
    let message = response["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("agy dying must be a JSON-RPC error: {response}"));
    assert!(
        message.contains("agy exited unexpectedly"),
        "message must say agy exited: {message}"
    );
    assert!(
        message.contains("fatal: signed out"),
        "message must quote agy's stderr: {message}"
    );
    assert!(
        !message.contains(TOKEN),
        "long token-like strings must be redacted: {message}"
    );
}

// ---------------------------------------------------------------------------
// stdin EOF kills agy
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stdin_eof_kills_agy_idle_and_mid_turn() {
    // Sub-case 1: agy is idle after a finished turn.
    let mut idle = Agent::spawn("turn_text.jsonl");
    idle.initialize().await;
    let session_id = idle.new_session().await;
    let (_, response) = idle.prompt(&session_id, "hello").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let pid = idle.fake_pid();
    assert!(pid_alive(pid), "agy is kept alive between turns");

    idle.close_stdin();
    let status = idle.wait_exit(Duration::from_secs(3)).await;
    assert!(status.success(), "agent must exit 0 on stdin EOF: {status}");
    wait_until_dead(pid, Duration::from_secs(3)).await;

    // Sub-case 2: agy is mid-turn (blocked forever) when stdin closes.
    let mut busy = Agent::spawn("HANG");
    busy.initialize().await;
    let session_id = busy.new_session().await;
    busy.send("session/prompt", Agent::prompt_params(&session_id, "hang"))
        .await;
    busy.read_first_update().await;
    let pid = busy.fake_pid();
    assert!(pid_alive(pid), "agy is running the hanging turn");

    busy.close_stdin();
    let status = busy.wait_exit(Duration::from_secs(3)).await;
    assert!(
        status.success(),
        "agent must exit 0 on stdin EOF mid-turn: {status}"
    );
    wait_until_dead(pid, Duration::from_secs(3)).await;
}
