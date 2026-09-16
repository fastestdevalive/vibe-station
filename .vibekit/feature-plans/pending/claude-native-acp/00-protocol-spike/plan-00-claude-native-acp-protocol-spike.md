# Phase brief: 00 — protocol-spike

**Read first:** `../arch-claude-native-acp.md` **in full** — it has the investigation
that motivates this phase and the exact files/packages referenced below. Do not
re-derive what's already established there.

**Skill:** load `rust-coding` for the Rust spike half of this phase.
**Depends on:** nothing in this repo's Rust code — this is investigation +
a standalone spike, not integrated into `vst-agents` yet.

## Goal

Determine EXACTLY what wire protocol `@anthropic-ai/claude-agent-sdk` uses to
drive the real `claude` binary, and prove — with a small, throwaway Rust
prototype, NOT integrated into the daemon — that spawning `claude` directly and
speaking that protocol can complete one real turn (prompt in, streamed
text + at least one real tool call, turn-end) without Node, ACP, or the SDK in
the loop at all.

This phase produces a **decision**, not shippable code: go/no-go for phase 01,
plus a written protocol note phase 01 will build against.

## Approach

### Step 1 — capture ground truth (do this BEFORE reading any minified JS)
Wrap the real `claude` binary invocation while a genuine Rich Chat turn runs
through the existing, working Node-based path (our own daemon, unmodified), and
record every byte exchanged on its stdin and stdout. Options, pick whichever is
least invasive:
- A `tee`-style wrapper script substituted onto `$PATH` in place of `claude` for
  one test run (simplest — no code changes to anything, no risk to the real
  daemon), logging stdin/stdout to files with timestamps.
- `strace -e trace=read,write -s 8192 -p <pid>` attached to the running `claude`
  process for one turn, if the wrapper approach is inconvenient.

Capture at minimum: one plain text-only turn, one turn that uses a tool
(read/write/bash), and — if you can trigger it safely — one turn that hits a
permission prompt, to see the control-channel shape. Do this against a
**disposable test project**, never real user data, and never the live daemon on
port 7421 (use the existing isolated-HOME + scratch-port pattern established in
`10-parity-cutover/report-10-2-n1-n2-baseline.md`'s N1/N2 measurement — same
safety rules apply here).

### Step 2 — cross-reference against what IS documented
Claude Code's own `--help` output and public docs cover `--print`,
`--output-format stream-json`, `--input-format stream-json` at a basic level —
read those first so step 1's captured traffic isn't being decoded from zero.
The bidirectional `control_request`/`control_response` messages (permissions,
steering) are NOT publicly documented as far as this investigation found —
treat anything you infer about them as provisional until confirmed against
real captured traffic from step 1.

### Step 3 — minimal Rust spike
A throwaway `cargo` binary (not a new workspace crate, not wired into
`vst-agents`) that:
1. Spawns `claude --print --input-format stream-json --output-format stream-json ...`
   directly (whatever flags step 1/2 determined are needed) in a disposable
   test project directory.
2. Sends one prompt message in the captured wire format.
3. Parses the streamed JSON-lines output, reconstructing: text/thinking deltas,
   at least one `tool_use` + its `tool_result`, and the turn-end/result message.
4. Prints a human-readable transcript of what it received, for comparison
   against the SAME prompt run through the existing Node/ACP path.

### Step 4 — write the protocol note
A markdown doc (add it to this folder, e.g. `protocol-notes.md`) with: the exact
message shapes observed for turn start/streamed text/tool_use/tool_result/
turn-end, whether/how the permission-request and mid-turn-steering control
messages were observed (or explicitly: "not observed / not attempted, here's
why"), and any version-sensitivity concerns noticed (e.g. does the protocol
shape look tied to a specific `claude` CLI version string).

## Exit criteria (go/no-go gate)

**Go** (proceed to phase 01) requires ALL of:
- The spike completes at least one real text+tool-use turn talking to `claude`
  directly, with output matching the same prompt's real behavior via the
  existing Node path (same tool called, same rough content, not necessarily
  byte-identical).
- The protocol note exists and is concrete enough that phase 01 doesn't need to
  repeat this reverse-engineering work.

**No-go / reduced-scope** (flag clearly, do not silently proceed) if:
- The control channel (permissions/steering) can't be captured/understood
  within this phase's time-box — this doesn't necessarily block phase 01, but
  phase 01's scope must then explicitly document "no mid-turn steering / no
  interactive permission prompts in the native path" as a real, disclosed
  feature gap versus the existing Node/ACP path, not something discovered late.
- The basic turn round-trip can't be gotten working reliably at all — in this
  case, stop here and report back; do not proceed to phase 01 on a shaky
  foundation.

## Report back

Under 800 words: what was captured, what the protocol note says, the go/no-go
call and why, and (if going) exactly what phase 01 can rely on vs. what it will
need to investigate further itself.
