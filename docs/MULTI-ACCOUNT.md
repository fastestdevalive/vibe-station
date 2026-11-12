# Multi-account — the mental map

Status: implemented + Add-account directory rework (plan 02). Boards: https://claude.ai/artifact/9Z37b7rzze2umRv1KnR4LD
Scope: all supported CLIs ship together; there is no later phase.

## The rules in one screen

1. **An account is a directory** that the vendor CLI signs in to itself: one we create (`~/.vibe-station/accounts/<cli>/<name>`, mode 0700) or one the user already has (e.g. `~/.claude-work`). See rule 11. We never read tokens or credential files.
2. **Modes are independent of accounts.** A mode is `{cli, model, context}`. It never names an account.
3. **Each CLI has one default account** (System login to start with). Changing the default affects only sessions started afterwards.
4. **A session has one account per agent run**, chosen at start:
   explicit pick in the draft UI > parent session's account (subagent, new tab in the worktree) > the CLI's default.
5. **The account reaches the CLI only as env vars at spawn**, at every spawn site: terminal launch, Rich Chat (ACP) connection, limits probe.
6. **Switching a running session's account = replace the agent process in the same session, keeping the model's own context where the CLI allows.** (Implementation note, assumption A1: the replacement gets a NEW session id — the proven `reset_session` path, which clients already follow via `supersededBy` — rather than restarting in place under the same id. Tab slot, pin, worktree, parent link and scheduled rows move to it.) Reuses the session-break mechanism (`SessionBreakKind::Switch`, as `vst agent switch` does today). The session id, tab, worktree and files stay the same; the old process stops and a new one spawns with the new account's env; all old rows stay visible, followed by a break marker.
   How the model's context survives depends on the CLI (this is the part competitors solved better than a transcript export):
   - **Native hand-over (preferred):** before spawning, copy (or hard-link) just this session's native history file from the old account folder into the new one, then resume with the CLI's own resume flag and the same native id (an existing file is replaced only when it is an earlier copy, that is a byte prefix, of the one being handed over; any other existing file is refused). The model gets exactly the context it had. This is nodeterm's approach (`claude-session-copy.ts`, `planCodexRolloutExposure`/`commitCodexRolloutExposure`: copy for Claude, verified hard-link for Codex, refusing anything outside the source `sessions/`). Only that one session crosses accounts, so work and personal histories stay separate.
   - **Transcript fallback:** for a CLI where no native hand-over exists (per the two-identity model: cursor has no bridge to its ACP session), the new process starts empty with a link to a Markdown export of the old chat (`CarryOver::Transcript`). Say so in the break marker.
   - **Terminal:** same native hand-over, since the file copy is independent of the channel; where it is unavailable the run starts fresh with a warning.
   - No summary turn for a native hand-over (an exhausted account cannot run it). The transcript fallback's first message asks the NEW account for a three-line recap; no turn ever runs on the old account.
   - *Rejected:* permanently symlinking every account's history into one shared root (supermux's default, with an `isolated` opt-out). It makes switching trivial but mixes work and personal chats in one folder.
7. **A signed-out account stops its sessions.** No silent fallback to another login.
8. **Shown only when it matters:** badge, composer label and footer name appear only for a CLI with more than one account.
9. **API keys** (typed once) live in a daemon-owned 0600 file beside the account's managed folder (`~/.vibe-station/accounts/<cli>/<id>.key`). An API-key account asks for no folder (its managed folder is still created and isolated), so a key never sits in a user-chosen folder. Injected as env at launch, never returned by the API, never logged. This is a stated exception to "no credentials" and must be added to `AGENTS.md` in the same commit.

10. **Labels follow supermux / nodeterm.** `label` is optional and editable. Display name = label, else the email the CLI reports (read through the vendor's own command, never from credential files), else the folder's own name, else the id; the System login is always "System login" unless renamed. The Add dialog prefills the name with the email; Rename lives in Settings. The email is always shown as secondary text beside a custom label, so a name can't hide which login it is. Labels are unique per CLI; the same email twice is rejected by the duplicate check.

11. **An account is a directory** (every harness with accounts; agy has none).
    - **Folder per harness:** claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME`, omp/pi `PI_CODING_AGENT_DIR`, opencode `XDG_DATA_HOME` root, cursor `XDG_CONFIG_HOME` root.
    - **Add account asks for a folder.** Default: "Create a new folder for me" at `~/.vibe-station/accounts/<cli>/<name>`. Alternative: "Choose a folder" the user already has.
    - **One flow, not two.** Managed vs chosen differs only on removal (`createdByUs` on `AccountRecord`, serde default): managed = Remove (folder deleted, confirm names it); chosen = Unlink (forgotten only).
    - **A chosen folder is never deleted, linked into, or have its config, credentials or settings modified** by vibe-station. The vendor CLI, run with that folder for identity checks, limits and agents, keeps its own state there as it would when run by hand. Shared-entry symlinks go only into folders we created. The one permitted write is the single copied session-history file of a native account switch (see the closing decisions below).
    - **Folder chooser:** the existing `components/dialogs/FolderChooserDialog.tsx` (`/fs/complete`, `/fs/check`), reused as is. It cannot create a folder; the daemon creates the managed one.
    - **Already signed in** (the harness's identity command succeeds with the folder's env): added at once, label prefilled with the email.
    - **Not signed in:** the account is "Waiting for sign-in" with numbered steps, a Copy button per command, "Check again", and an optional "Open in a terminal tab". No terminal is opened by default.
    - **Step text comes from the daemon** (`signInCommand` / `signInHint` in the account payload, built from the plugin); the UI has no per-harness code.
      - claude: `CLAUDE_CONFIG_DIR=<dir> claude auth login`
      - codex: `CODEX_HOME=<dir> codex login`
      - cursor: `XDG_CONFIG_HOME=<dir> cursor-agent login` *(unverified)*
      - opencode: `XDG_DATA_HOME=<dir> opencode auth login`
      - pi / omp: one instruction line, "Run `PI_CODING_AGENT_DIR=<dir> pi` (or `omp`) and use /login inside" *(omp unverified)*
    - **API key:** a small "Use an API key instead" link, only for claude, codex, cursor; no folder is asked for (rule 9).
    - **Entry points, one dialog "Add <Harness> account":** (1) Settings → Harnesses and modes → <Harness> → Accounts → "Add account"; (2) the account picker footer "Add account…" in the draft composer, harness preselected; (3) the empty state under the System row: "Only this machine's login so far. Add another to choose an account per agent."
    - **Passive hint only:** "Detected: `<dir>` — Add" when a session reports a config dir that is not an account. The disk is never scanned.
    - **Validation (daemon, before any write):** expand `~`; absolute, no `..`; canonicalize; exists and is a readable directory (or is creatable for "create for me").
    - **Refused, each shown inline in the dialog:** the harness's system folder ("That is your system login folder; it is already the default account."); a folder inside our accounts root that is another account; the same path as, or a path nested with, an existing account; a duplicate identity (known only after sign-in).
    - **Identity** only through the vendor's own command with the env set; never credential files, never `.claude.json`.
    - **Lifecycle unchanged:** pending row with Cancel / Retry, Name optional (placeholder "Work or Personal"), "Signed out" state word + "Sign in" (same copyable steps; a pending row is removed through the normal confirm), rename, make default.

## CLI → mechanism table

| CLI | Isolation (env at spawn) | API-key account | Sign-in command (confirm) | Shared into account folder | Limits probe per account | Manual switch on limit | Supports account change (context kept) |
|---|---|---|---|---|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `ANTHROPIC_API_KEY` | `claude` login flow | skills, settings, MCP | yes (`get_usage`, existing) | offered | **Yes, native** (copy session file; proven by nodeterm) |
| codex | `CODEX_HOME` | `CODEX_API_KEY` / `OPENAI_API_KEY` | `codex login` | skills, config | yes (existing) | offered | native in Terminal (hard-link rollout); transcript in Rich Chat (V5) |
| cursor | private `XDG_CONFIG_HOME` (`cursor/auth.json`) | `CURSOR_API_KEY` | `cursor-agent login` | none | no (shows "No plan limits") | offered | **Yes, transcript only** (no bridge to its native id) |
| opencode | `XDG_DATA_HOME` (other data dirs linked in) | provider API keys | `opencode auth login` | config | no | offered | Yes, transcript only (one shared sqlite store, V8) |
| agy | none — ships without accounts (V9) | `GEMINI_API_KEY` | in-CLI sign-in | none | yes (`agy_limits.rs`, per home *to test*) | offered | none — ships without accounts (V9) |
| omp | `PI_CODING_AGENT_DIR` (omp.rs:59) | per provider | in-CLI login | skills, config | no | offered | Yes; native likely (sessions under the agent dir, omp.rs:56) *(verify)*, else transcript |
| pi | `PI_CODING_AGENT_DIR` (pi.rs:54) | per provider | in-CLI login | skills, config | no | offered | Yes; native likely (sessions under the agent dir, pi.rs:50) *(verify)*, else transcript |

**"Supports account change" applies to both channels (Terminal and Rich Chat).** The session-file copy is channel-independent. Rich Chat additionally tears down the session's persistent ACP connection and reconnects with the new account's env, then resumes by ACP session id. That is native only where the ACP id is the CLI's own id (two-identity model: claude, opencode, omp, agy). Cursor is transcript-only in both channels. Codex is not covered by the two-identity section, so whether its Rich Chat resume is native is **unconfirmed**: test it first.

Verified cells are recorded under "Verified facts" below; cursor and omp rows are unverified (binaries absent).

## Where it touches the code

| Layer | Change |
|---|---|
| `vst-types` | `AccountRecord`; `SessionRecord.account_id: Option<String>` (serde default; None = System login); per-CLI default account; `LimitWindow`/`LimitsResult`/`LimitSlotRef` gain optional `account_id`. Mirror in `web-ui/src/api/types.ts` in the same commit. |
| new crate `vst-accounts` | Registry, account folders, shared-entry symlinks, identity read via the CLI itself. Wired in `run.rs`; injected into the plugin layer by closure. |
| `AgentPlugin` | `supports_accounts()` (false), `account_env(acct)`, `account_login_command()`, `account_shared_entries()`; `get_limits(env)`. Every CLI implements them. |
| Spawn sites | `sessions.rs` (3 `get_environment` merges) and `acp_connection.rs` `.envs(agent_env)`: apply `account_env` after `get_environment`. |
| Importers | Claude / Codex / omp history importers take the session's account folder as a parameter, never the daemon's own env. |
| Limits | Probe once per account; footer chips pin one window of one account; popup grouped "Claude · Work". |
| Web UI | Accounts block in each Settings harness tab; account chip in the draft composer; sidebar badge; tab tooltip; signed-out and limit banners. State in `useServerStore`, pushed by WS event. |
| `vst` CLI | `vst agent create --account=<id>`; subagents inherit the parent's account. |

## Limit detection (kept deliberately simple)

One event, **"account limited: session, account, reset time"**, from exactly two sources. No error-text parsing, no tmux pane scraping, no fixtures from exhausting real accounts.

1. **The limits poller, for every session of every channel.** It already probes each account (300 s, plus a probe after each turn). A window at 100% with a future reset time marks that account limited; a later read below 100%, or the reset time passing, clears it. This is the whole story for Terminal sessions, and the fallback for Rich Chat.
2. **Structured chat events, where the agent already sends them (Rich Chat only).** Seen in supermux, which maps them to the same "limited" rule:
   - claude: the raw SDK `rate_limit_event` frame (`rate_limit_info.unifiedWindows[*].utilization` 0..1, `resetsAt`; status `rejected` marks a window full). We already receive raw SDK messages through `acp_ext_notification_event` (claude_tasks.rs), so this is one more mapping in the claude plugin.
   - codex: the `account/rateLimits/updated` notification (`rateLimits` payload, same shape our `codex_limits.rs` already parses). *Verify that our Rust codex-acp port forwards it.*
   - Neither is handled in our code today (no match for `rate_limit_event` / `rateLimits/updated` outside the probes).

Consequences, stated plainly:
- cursor, opencode, omp, pi have no probe and no known chat event, so they get **no limit banner**. Their failed turns just show the CLI's own error. Revisit only if a harness gains a structured signal.
- Terminal sessions learn of a limit up to ~5 minutes late (shorter after a turn, because of the post-turn probe).
- Whatever listens (today the banner, later any auto-switch policy) subscribes to the one event; neither source knows about its listeners.

## What happens when…

| Event | Result |
|---|---|
| A pinned limits slot's account was removed | The slot shows that CLI's System login. |
| Change the CLI's default account | Only new sessions are affected. |
| Pick a different account in the draft UI | That session uses it; the default is unchanged. |
| Switch a running session's account | Native hand-over where the CLI allows, else transcript fallback (rule 6). |
| A new account is added | Its limits are probed as soon as it is added, not on the next interval. |
| Account signed out mid-session | Banner + sign-in; the session stays stopped. |
| Account hits its limit | Banner offers Wait or Switch this session to another account. Today this is the user's choice; the switch is a single code path (rule 6) so a future per-user or per-project "auto-switch" policy can call it without redesign. The design must not forbid automation: the banner, the break marker and the limits state are all driven by events, not by a button press. |
| Remove an account | Confirm lists running and past sessions; running ones stop; past sessions show "Account removed" and ask for an account on resume. Managed folder (created by us): **Remove**, the confirm names the folder and it is deleted. Chosen folder: **Unlink**, the account is only forgotten and the folder is untouched. |
| Toggle Terminal ↔ Rich Chat | Same account; importer reads that account's folder. |
| Subagent / new tab in worktree | Inherits the parent's account unless `--account` is given. |
| Only one account for a CLI | No picker, no badge, no name in the footer. |

## Verified facts (A1 spike)

Read-only checks only (`--help`, `strings`, source reads); no sign-in, no credential file, no keychain, and
no account value (email/plan) is recorded here. Binaries present locally: `claude`, `codex`, `opencode`,
`agy`, `pi`. Absent: `cursor-agent`, `omp` — those rows use the written fallback.

| id | command run | observed | decision taken |
|---|---|---|---|
| V1 | `claude --help`; `claude auth --help`; `claude auth status --help`; `strings $(command -v claude) \| grep -m3 CLAUDE_CONFIG_DIR` | `CLAUDE_CONFIG_DIR` appears in the binary (documented in its own error text as the config dir). `claude auth` has `login` and `status`; `claude auth status` defaults to `--json` and prints `loggedIn`, `email`, `subscriptionType`, `planTier` (values deliberately not copied here). | login = `["claude","auth","login"]`; identity = `["claude","auth","status"]`, parse JSON: `signed_in` = `loggedIn`, `email` = `email`, `plan` = `subscriptionType` (else `planTier`). |
| V2 | `claude mcp --help`; `strings $(command -v claude) \| grep -m5 '\.claude\.json'` | MCP servers are managed through `claude mcp`; the binary's own strings show `.claude.json` carries the cached auth ("refusing to write to avoid wiping ~/.claude.json"). User-scope MCP therefore lives in a file that also holds identity. | `.claude.json` holds identity ⇒ NOT shareable. Shared entries = `skills`, `settings.json`, `agents`, `commands`, `CLAUDE.md`. MCP not shared; Settings shows the hint "MCP servers configured in ~/.claude.json are not shared". |
| V3 | `find vendor/rust-acp -name 'claude-agent-acp*'` (none); `scripts/build-rust-acp.sh --help`; read `rust/vst-agents/src/acp_connection.rs:590` | No adapter binary is checked out locally. `acp_connection.rs` launches the adapter with `.envs(agent_env)`, so the account env is set on the adapter process and is inherited by the `claude` child it spawns. | "inherited" — the env reaches the spawned `claude` by construction; no adapter-side support needed. |
| V4 | `codex --help`; `codex login --help`; `codex login status --help`; `codex login status`; `strings $(command -v codex) \| grep -m3 CODEX_HOME` | `CODEX_HOME` is honoured (the binary resolves it, and `codex_import.rs` already reads it). `codex login` / `codex login status` exist; `codex login status` prints one line ("Logged in using ChatGPT"), no email. | login = `["codex","login"]`; identity = `["codex","login","status"]`, parse text: a line containing "Logged in" ⇒ `signed_in = true`; "not logged in" ⇒ `false`; no email available (display name falls back to label/id). |
| V5 | `sed -n '40,70p' vendor/rust-acp/pins.toml`; `grep -rn 'rateLimits' rust/vst-agents/src rust/vst-agents/tests`; `grep -n 'session/load\|acp_session_id_is_native' rust/vst-agents/src/codex*.rs`; `ls rust/vst-agents/tests/fixtures/codex/` | The port's pinned upstream is codex 2.2.2. Our code only *requests* `account/rateLimits/read` (`codex_limits.rs:233`) and parses its response; nothing anywhere handles an `account/rateLimits/updated` notification, and no fixture shows one. Codex resume is native for Terminal via `codex resume <id>` + `rollout-<ts>-<id>.jsonl`; Rich Chat's ACP id is stored as the native id when no hook id was captured (`codex.rs:500`), but no evidence of an adapter-side rollout hand-over. | NO/unknown ⇒ fallback: codex `account_session_handover` = `Files(HardLink rollout)` ONLY when `session.channel != Some(Channel::Json)`; Rich Chat ⇒ `Transcript`. `codex_accounts.rs::account_limit_signal` returns `None` (poller only). |
| V6 | `command -v cursor-agent` (absent); `ls ~/.config` (names only) | Binary absent, so nothing can be verified. `~/.config` holds a `cursor` directory plus unrelated tool dirs (`gh`, `git`, `opencode`, …). | Unverified, recorded in a doc comment. login = `["cursor-agent","login"]`, identity = `["cursor-agent","status"]`. Shared entries = `SharedEntries{ source_dir: ~/.config, set: AllExcept(["cursor"]) }` — a private `XDG_CONFIG_HOME` would otherwise hide `~/.config/gh`, `~/.config/git`, … from the agent's tools. Handover `Unsupported` (transcript only). |
| V7 | `strings $(command -v opencode) \| grep -E 'XDG_DATA_HOME\|OPENCODE_(DATA\|HOME)'`; `opencode --help`; `opencode auth --help` | opencode resolves its auth path as `$XDG_DATA_HOME/opencode/auth.json`, falling back to `~/.local/share/opencode/auth.json`. `opencode auth` has `login`, `logout`, `list`, `switch`, `export`/`import` (`export` prints secrets — never use it). | `account_env` = `XDG_DATA_HOME=<dir>` (the preferred var is present). login = `["opencode","auth","login"]`; identity = `["opencode","auth","list"]` (names only, tolerant parse; never `auth export`). |
| V8 | read `rust/vst-agents/src/opencode_import.rs:344-352` | opencode's native store is ONE sqlite file, `~/.local/share/opencode/opencode.db`, holding every session. | `Unsupported` ⇒ `Transcript`. Copying the db would mix histories, violating "only that session crosses accounts". |
| V9 | `agy --help`; `strings $(command -v agy) \| grep -E '^[A-Z][A-Z0-9_]*(CONFIG\|DATA\|STATE\|HOME\|DIR)[A-Z0-9_]*$'`; `agy install --help`; read `rust/vst-agents/src/agy.rs:99-104`, `agy_limits.rs:233` | No dedicated config/data/state directory env var exists: the only `AGY_*`/`ANTIGRAVITY_*` variables are gateway/auth/port/tier switches, and its data dir is chosen by an internal `--app_data_dir=` flag (not an env var we can set through `account_env`). `agy_log_path` and the limits probe both resolve from the whole home dir. The plan's dedicated-env requirement is NOT met. | **No shadow `HOME`.** agy `supports_accounts()` = `false`, `accounts_unsupported_reason()` = `Some("agy keeps its login under the whole home directory; a separate login would hide your ssh and git setup from the agent, so multiple agy accounts are not supported yet.")`. agy ships without accounts — the plan's only allowed shortfall; the orchestrator must tell the user. |
| V10 | read `rust/vst-agents/src/omp.rs:48-70`; read `rust/vst-agents/src/pi.rs:54-64`; `pi --help`; `command -v omp` (absent) | omp's per-vst session store is `<cwd>/.vibe-station/omp-sessions/<sessionId>` — inside the worktree, so account-independent. Its default store is `<home>/.omp/agent/sessions` (or `$PI_CODING_AGENT_DIR/sessions`). pi's store is `<home>/.pi/agent/sessions` (or `$PI_CODING_AGENT_DIR/sessions`), files named `<ts>_<id>.jsonl`. | omp handover = `InPlace` (store lives under `<cwd>`, account-independent). pi handover = `Files(Copy)` of the `<ts>_<id>.jsonl` found under `<from>/sessions`, matched by the suffix `_<id>.jsonl`. Both harnesses' env var is `PI_CODING_AGENT_DIR`. |
| V11 | read `rust/vst-agents/src/claude_tasks.rs:29-36,62`; `ls rust/vst-agents/tests/fixtures/claude_tasks/`; `grep -rn rate_limit_event rust/vst-agents/src rust/vst-agents/tests`; adapter binary absent under `vendor/rust-acp` | `CLAUDE_RAW_SDK_FILTER` is a list of `{type, subtype}` pairs compared for equality by the adapter's `shouldEmitRawMessage`; `rate_limit_event` has no `subtype`, so a type-only entry cannot match. No `rate_limit_event` fixture or handler exists anywhere in our tree. | **No** — do not add it (A2.7 skips the raw filter). claude's limited state is poller-only. The chat-signal test `claude_rate_limit_event_maps_signal` still runs on the hand-written fixture of the pure parser. |
| V12 | listed `~/.claude/projects` (names only) against a session's cwd | Claude names a project dir from the canonical cwd with every non-alphanumeric character replaced by `-` (a symlinked or `_`-bearing path differs from a naively derived slug). | We find the conversation by its chat id (`find_claude_conversation`) and reuse the directory name found. The System login hands over to and from `~/.claude`. |

## Decisions closing the Add-account review (apply when building)

- **Writes into a chosen folder:** we never modify its config, credentials or settings and never install hooks or symlinks there. The ONLY thing we may write is the single session-history file copied in by a native account switch (an existing file is replaced only when it is an earlier copy, that is a byte prefix, of the one being handed over; any other existing file is refused; it is the same file the CLI itself would write there when it runs).
- **Vocabulary:** one word per fact, the same word the wire uses (`auth: "signed_out"`, `account_signed_out`). Supersedes the earlier "Needs sign-in" decision (round 1 of multi-account-4).

  | Fact | Copy |
  |---|---|
  | Identity check says not logged in | **Signed out** |
  | The fix | **Sign in** |
  | Folder added, login not confirmed | **Waiting for sign-in** (muted) + **Finish sign-in** |
  | No identity command or unknown result | **Not verified** |
  | Signed in | (no label) |
  | Banner title | "X is signed out" |
  | Banner hint | "This agent is paused until you sign in. It never switches accounts on its own." |
  | Removed account | **Account removed** |
  | Limits popup | "Signed out. Sign in from Settings." / "No plan limits (API key or signed out)" |
  | Daemon 409 | "This account is signed out. Sign in, then try again." |
- **`createdByUs` default:** `false` (serde default), so an unknown record is only ever forgotten, never deleted.
- **pi/omp sign-in hint** gets a Copy button on the launch line (`PI_CODING_AGENT_DIR=<dir> pi`).
- **Claude env override:** for any non-System claude account the daemon unsets inherited `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (an env token outranks a stored login), except the account's own API key.

## Showing an account

`AccountChip` is the only component that draws an account (row, inline and mark variants); `ACCOUNT_WORDS` (`web-ui/src/lib/accounts.ts`) is the only source of account words. The monogram is neutral on purpose (no hue), so it can never be read as a status colour beside the status dot; signed-out, waiting and removed use a dashed border as a non-colour cue.

## Known limitations

- A Terminal session's chat id is read from the plugin's post-spawn record at switch time when it was never stored (only for a CLI whose switch support is native; bounded to 2 s).
- If the same chat was continued by hand in both accounts, the two files diverge and a native switch is refused (409 `handover_failed`); the session stays where it is. The UI then offers a transcript switch (Rich Chat, `carryOver: "transcript"`) or a new conversation (Terminal, `carryOver: "none"`).
- The first Terminal agent in a new Claude folder shows Claude's own first-run setup (theme, trust). We neither skip nor answer it (that would mean editing `.claude.json` or answering a dialog); the session waits for the user in the pane. Rich Chat is unaffected.

## API surface notes (for reviewers)

- **Routes with no web-UI caller.** `POST /api/accounts/sign-in`, `POST /api/accounts/sign-in/:attemptId/finish` and `DELETE /api/accounts/sign-in/:attemptId` (terminal-first sign-in, the original design) are kept for non-UI clients such as a mobile app or the CLI. The web UI signs in through the copyable steps plus `POST /api/accounts/:cli/:id/refresh`, and re-signs-in through `POST /api/accounts/:cli/:id/sign-in`. Removing the three routes is a safe follow-up if no other client adopts them.
- **Pending rows and daemon restarts.** On boot the daemon drops pending rows of CLIs that cannot verify identity (pi, omp), because nothing could ever confirm them; an add interrupted by a restart must be redone. Rows of CLIs that can verify are kept and confirmed by "Check again".
