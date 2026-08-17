<!--
RULES — read before writing this report:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. ANSWER FIRST: the finding goes at the top, before any evidence
3. EVERY CLAIM CITED: file:line, a command + its output, or a screenshot
4. READING TIME: optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Report: PR detection is dead — root cause + locked fix

**Date:** 2026-08-16 · **Commit:** `2e513789443acf41eaa6691078ab9f71f39ee327` · **Scope:** `daemon/src/services/{github,prPoller,lifecycle}.ts`, `vibe-station.db`, live daemon logs · **Method:** log forensics + sqlite + live `gh`/GraphQL probes

## Answer
- **No session has ever reached `needs_review`** — 0 of 269 in the DB, despite the feature shipping in `4ada68d`. ch-62 is not a one-off.
- Root cause is **read-side and silent**: `parseGithubRepo` (`github.ts:47-51`) demands a literal `github.com` host, but 103 of 147 worktrees use SSH host aliases (`git@github-techwithnidhi:...`) → returns `null` → `prPoller.ts:71` `if (!gh) return;` — those worktrees are **never polled at all**, with no log line.
- Two more blockers stack behind it: **no `GITHUB_TOKEN`** (private repos → 404) and the **60 req/hr unauthenticated limit permanently exhausted** by the 44 parseable worktrees.
- All three failure modes return the same `null` as "no PR exists" — which is why this stayed invisible for weeks.
- **Not** a state-clobber race: `/sessions/:id/done` was never called for ch-62 and it never exited. It sat in **Waiting** the whole time PR #84 was open (00:17→04:58Z) and is still alive there.

## Evidence
| Claim | Source |
|-------|--------|
| Regex requires literal `github.com` | `daemon/src/services/github.ts:47-51` |
| ch-62 remote is an SSH alias; both regexes reject it | `$ git -C .../ch-62 remote get-url origin` → `git@github-techwithnidhi:techwithnidhi/console-home.git`; `.test()` → `false`, `false` |
| Unresolvable repo ⇒ silent skip, no log | `daemon/src/services/prPoller.ts:71` |
| Zero `needs_review` ever | `$ sqlite3 vibe-station.db "select state,count(*) from sessions group by state;"` → `done\|168  exited\|42  waiting_for_human\|31  working\|28` |
| PR #84 open + non-draft for 4h41m | `$ gh pr list --state all` → `#84 open, isDraft:false`, merged `04:58:27Z` |
| ch-62 alive, never `done`/`exited`; `/done` never called | DB `state='waiting_for_human'`; grep of daemon log → no hits for `ch-62-a-116f9454/done` |
| No token in daemon env | `/proc/1831796/environ` → zero `*TOKEN` vars |
| Rate limit exhausted | `$ curl api.github.com/rate_limit` → `core:{limit:60, remaining:0}`; unauth pulls → 403 |
| Failures indistinguishable from "no PR" | `github.ts:113,116,137-139` (`return null`) |
| Two GitHub accounts in play | `$ gh auth status` → `techwithnidhi` (active) + `fastestdevalive` |
| Live daemon predates dashboard-bucket fixes | pid 1831796 built Aug 15 16:34 PDT; `966b676` landed Aug 16 14:14 PDT |

## State glossary

`LifecycleState` — `daemon/src/types.ts:8-15`

| State | Meaning | Set by | Terminal? | Live count |
|---|---|---|---|---|
| `not_started` | Record exists, agent not spawned | session create | no | 0 |
| `working` | Pane output changing | lifecycle poller, 1s | no | 28 |
| `idle` | Alive, output quiet, no prompt | lifecycle poller, 1s | no | 0 |
| `waiting_for_human` | Alive, agent prompting for input | lifecycle poller, 1s | no | 31 |
| `needs_review` | **"PR Created"** — open, non-draft PR | PR poller only, 60s (`prPoller.ts:79-84`) | no | **0 — never occupied** |
| `done` | User marked complete | `POST /sessions/:id/done` (`routes/sessions.ts:974-998`) | **yes** | 168 |
| `exited` | Process/tmux gone | `markSessionExited` (`lifecycle.ts:317-348`) | **yes** | 42 |

- Terminal ⇒ both pollers skip forever (`lifecycle.ts:144`, `prPoller.ts:72`) — a PR opened after that is never detected.
- Only the worktree's `isMain` session can be `needs_review` (`prPoller.ts:114`).
- Dashboard buckets (`DashboardPanel.tsx:19-35`): `working|spawning`→Working · `waiting_for_human|idle`→Waiting · `needs_review`→PR · rest→Finished (hidden by default).

## Decisions locked

> Settled 2026-08-16 via discussion + live probes. Input to the detailed plan — **not implemented**.

| # | Decision | Rationale / evidence |
|---|---|---|
| D1 | **One GraphQL request per GitHub *account*** — alias N repos into one query | Verified: 2-repo aliased query returned both, `rateLimit.cost: 1` of 5000. 10 repos → 2 req/tick |
| D2 | **No `gh` binary dependency.** Transport is `fetch` + GraphQL; credentials come from gh's *data file* `~/.config/gh/hosts.yml` (`users.<login>.oauth_token`), env first, `gh auth token --user X` only opportunistically when `gh` happens to be on PATH | `gh` is **not** in `dev.Dockerfile:21-24`, and `github.ts:1-11` documents avoiding the binary. Reading its config file keeps that constraint while still supporting two accounts. `gh auth switch` **banned** — mutates `hosts.yml` globally, races |
| D3 | **Credential chain:** `GH_TOKEN_<LOGIN>` → `GITHUB_TOKEN`/`GH_TOKEN` → `hosts.yml` → `gh auth token` (if on PATH) → `no_credentials` | Verified: this host's `hosts.yml` holds 3 plaintext `oauth_token`s. Keyring storage is the only gap, and step 4 covers it |
| D4 | **Replace `parseGithubRepo` with async `resolveGithubRemote`** — relaxed regex captures any host, then resolves SSH aliases by **parsing `~/.ssh/config` in TS** (never `ssh -G`; that binary isn't in the image either). Fallback heuristic: alias matching `/^github[-.]/i` | Its regex is the primary root cause. Verified `ssh -G github-techwithnidhi` → `hostname github.com`, and all 103 real aliases match the heuristic |
| D4b | **Account→repo discovery by probe, cached** — order candidates by login-substring-of-alias, then login===owner; probe `repository(owner,name){id}` until one succeeds | Two accounts means the right token per repo can't be known statically; ~1 extra point per new owner, once |
| D5 | **`needs_review` leaves `LifecycleState`; PR status becomes orthogonal `session.pr`** | Kills the 3-writer clobber by construction; closes both latent write-side bugs (unguarded `/done`, PR-blind `exited`) for free |
| D6 | **Keep two pollers** — local tmux ~free @1s vs network billed | The defect was the shared *write target* (D5), never the two timers |
| D7 | **Poll interval 60s → 30s** (was briefly 10s); no on-push trigger needed | 2 req/tick @30s = 240 pts/hr = ~5% of 5000 |
| D8 | **Typed `PrLookupResult` union** — `pr \| no_pr \| not_github \| no_credentials \| error{network\|rate_limited\|auth\|api}`. On `error`/`no_credentials` the poller **holds** current lifecycle state; only a definitive `no_pr` exits `needs_review` | The single `null` return is why this hid for weeks. Also fixes a latent bug: a transient fetch failure today kicks a session *out* of `needs_review` |
| D9 | **Read GraphQL `errors[]` per alias; ignore `gh` exit code** | Verified: bad repo → `"bad": null` + `errors[{type:"NOT_FOUND"}]`, siblings still return data; `gh` exits non-zero anyway |
| D10 | **Startup self-check log** — per project: resolvable? authed? | "Silently dead for 103 worktrees" must be visible day 1 |

### UI decisions (D11–D16)

| # | Decision | Rationale |
|---|---|---|
| D11 | **Two axes, two indicators** — lifecycle `StatusDot` + a separate PR badge when `pr !== none`. Never a combined glyph | Mirrors D5's orthogonality; a merged PR on a `done` session must show both facts |
| D12 | **Rectangle border = single color, strict precedence**: `waiting_for_human` (red) → `pr=merged` (green) → `pr=open` (yellow) → lifecycle color | "Agent blocked on YOU" must never be masked by PR state; draft/closed PRs never drive the border |
| D13 | **Borders stay scoped to few states** — `6f020b6` already removed border color from working/idle/done/exited; keep it that way, add only the PR axis | A border on every state made the colored ones meaningless (`workspace-canvas.css:399-408`). No grey-ing work needed — it's already done |
| ~~D14~~ | ~~PR open = yellow, merged = green~~ | **SUPERSEDED by D17** — yellow was reassigned to `working` |
| **D17** | **Four-colour scheme (2026-08-17, user-specified):** `working` 🟡 yellow · `waiting_for_human` 🔴 red · `pr=open` 🔵 blue · `pr=merged` 🟢 green. Per-theme tokens | Yellow reads as "in progress", blue as "up for review". Blue is free now that `working` isn't the blue-purple accent |
| **D18** | **Precedence:** `working` → `pr=merged` → `pr=open` → `waiting_for_human` → `idle` → `done`/`exited` | Active work is the freshest signal; a PR beats waiting because the agent idles at its prompt right after opening one, so red would otherwise mask blue permanently |
| **D19** | **`done`/`exited` are terminal and always bucket to Finished, regardless of PR state** | `done` is a deliberate manual user action meaning finished. Reverses the earlier "done + merged → PR bucket" idea |
| **D20** | **Blue/green are keyed to the *branch*, not the worktree** — persist `prBranch` and render the PR colour only when it matches the worktree's current branch | Without it, a branch switch shows a stale PR colour until the next 30s tick |
| D14b | **Fix the `needs_review` split-brain** — currently violet `#b98cff` in `StatusDot` (`workspace.css:2129`) but green `var(--success)` on borders (`workspace-canvas.css:414`, `chat.css:30`) | Two surfaces disagree today; the PR axis replaces both, so the divergence disappears rather than needing a reconciliation |
| D15 | **Tokenize all status colors in `tokens.css`; delete hard-coded hexes from `chat.css`, `workspace.css`, `workspace-canvas.css`** | Today the same values are duplicated in 3 files with comments begging them not to drift; per-theme values are impossible without tokens |
| D16 | **Lifecycle keeps text glyphs; PR axis uses lucide-react** (`GitPullRequestArrow`, `GitMerge`, `GitPullRequestDraft`, `GitPullRequestClosed`) | `lucide-react@^0.468.0` already a dependency; git iconography is shape-distinct at 14px, so states never rely on color alone |

**Color table (superseded — see D17/D18 above for the live scheme):**

| Axis | State | Dark | Light | Glyph/icon |
|---|---|---|---|---|
| lifecycle | spawning | `#525252` dashed | `#a3a3a3` dashed | `◐` pulse |
| lifecycle | working | `--accent` #6e78c7 | `--accent` #5c64b5 | `●` |
| lifecycle | idle | `#6b6b6b` | `#737373` | `○` |
| lifecycle | waiting_for_human | `#ef4444` | `#dc2626` | `!` |
| lifecycle | done | `#8a8a8a` | `#525252` | `✓` |
| lifecycle | exited | `#525252` | `#a3a3a3` | `×` |
| **PR** | **open** | **`#eab308`** | **`#a16207`** | `GitPullRequestArrow` |
| **PR** | **merged** | **`#22c55e`** | **`#15803d`** | `GitMerge` |
| PR | draft | `#8a8a8a` | `#737373` | `GitPullRequestDraft` |
| PR | closed | `#6b6b6b` | `#737373` | `GitPullRequestClosed` |

- `needs_review` violet `#b98cff` + `◆` glyph are **deleted** with the enum value.
- Merged-green persists until the worktree is removed; it re-derives on branch change because PR lookup is keyed to the current branch — **no `mergedAt` timestamp or expiry needed**.
- Sidebar rows + dashboard cards have **no rectangle today** — adding the PR badge there is new UI, not a recolor.
- VCS panel's existing "PR open" green `#4ade80` (`workspace.css:3857,3897`) **must move to yellow** or it contradicts the new semantics.
- Contrast: all chosen colors ≥3:1 for non-text UI except `spawning`/`exited` (~2.2–2.5:1), **intentionally** de-emphasized — glyph + dashed style carry that information.

**Rejected:**

| Rejected | Why |
|---|---|
| **Shelling out to the `gh` binary** (earlier D3) | Not in `dev.Dockerfile:21-24`; `github.ts:1-11` documents the deliberate decision to avoid it. Superseded by D2 — depend on its *config file*, not the binary |
| Adding `gh` to `dev.Dockerfile` | Needs the GitHub apt keyring + repo lines; and the sandbox seeds `git init` repos with **no remotes** (`demo-seed.sh:44,765`), so PR detection is inherently a no-op there — the dependency would buy nothing |
| `ssh -G <alias>` for host resolution | `ssh` is not in the image either; parse `~/.ssh/config` in TS instead |
| **`prMergedAt`** (shipped in `966b676`) | Superseded by D5 — `pr.state === "merged"` derives live from the current branch, so retention is free. Removes a SQLite column, row mapper, route field, and 3 tests |
| Single global search query (`gh search prs`) | Two accounts → no one token sees both; search index lags seconds-to-minutes; `author:@me` misses teammate PRs |
| "Just set `GITHUB_TOKEN`" | Single-account assumption — a `techwithnidhi` token 404s on `fastestdevalive` private repos, reproducing the exact silent failure |
| Per-repo REST (10 req/tick) | Superseded by D1 — GraphQL does it in 2 |
| Merging the two pollers | 1s would hammer GitHub; 60s would make the UI feel dead |

## Budget math
| Design | Req/tick | Cost/hr @60s | % of 5000 |
|---|---|---|---|
| Today (per-worktree REST) | 147 | 8,820 | **176% — blows even the authed limit** |
| GraphQL per-account (D1) | **2** | **120** | **2.4%** |
| GraphQL per-account @30s (D7) | 2 | 240 | ~5% |

## Resolved since first draft
| Was open | Resolution |
|---|---|
| Is `gh` on the daemon's PATH? | `/usr/bin/gh` v2.88.1, both accounts authed — but **moot**: D2 dropped the binary dependency |
| Reconcile with `966b676` | It was on `origin/main`, not this branch; branch rebased (4 commits). `prMergedAt` **superseded** by D5 |
| Should a merged PR retain the PR bucket? | Yes — green persists until the worktree is removed, derived live from the current branch |
| Docker sandbox impact | None — seeded repos have no remotes, so lookups short-circuit at `not_github` with zero calls and zero logs |

## Not checked
- Migration for persisted manifests/SQLite rows already carrying `needs_review` — D5 is a breaking change to on-disk records; the back-compat read is designed but unwritten.
- Whether `hosts.yml` keyring-storage (no plaintext `oauth_token`) occurs on any machine this runs on — only this host was inspected, and it stores plaintext.
- `~/.ssh/config` `Include` directives beyond one level, and `Match` blocks — the TS parser handles neither.
- No runtime repro of the fix; every decision above is unimplemented.

## Follow-ups
| # | Question | Why it matters |
|---|----------|-----------------|
| 1 | Does any UI besides the dashboard read `needs_review`? | D5 breaks persisted records — needs a back-compat read |
| 2 | Restart the daemon after landing | The running binary (built Aug 15 16:34) predates even `966b676` |
| 3 | Should `GET /worktrees/:id/pr` (VCS tab) share the poller's cache? | It currently does its own lookup; D1's batch cache could serve it |
