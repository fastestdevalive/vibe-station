# `--prompt-file` is never delivered to the spawned agent

## Symptom

An agent runs `vst worktree create … --prompt-file=./task.md` (or `vst session create … --prompt-file=…`).
The worktree and the agent session are created successfully. The agent starts — and just sits there with no task.
No error, no warning, exit code 0. The prompt is silently dropped, 100% of the time.

Perceived as intermittent ("quite a few times") only because agents that happen to use the inline
`--prompt` flag work fine. The `--prompt-file` path has never worked.

## Root cause

Commander converts dashed long options to **camelCase** keys on the opts object. `--prompt-file`
is exposed as `opts.promptFile`. The code reads `opts["prompt-file"]`, which is always `undefined`.

`cli/src/commands/worktree/create.ts:43-45`
```ts
let prompt = opts.prompt;
if (opts["prompt-file"]) {            // ← always undefined; branch is dead
  prompt = readFileSync(opts["prompt-file"], "utf-8");
}
```
Identical bug at `cli/src/commands/session/create.ts:35-37` and — same shape, different flag —
`cli/src/commands/mode/add.ts:39-41` (`--context-file` → `opts["context-file"]`).

So with only `--prompt-file` given, `prompt` stays `undefined`. `JSON.stringify` drops undefined
keys (`cli/src/lib/daemon-client.ts:32`), so the wire body omits `prompt` **entirely** — the daemon
cannot distinguish this from a deliberately prompt-less request.

Empirically confirmed against the repo's own commander:
```
opts keys: [ 'promptFile' ]
opts['prompt-file'] = undefined
opts.promptFile     = "/tmp/x.md"
```

The same repo already reads the camelCase form correctly for `--start-agent` at
`cli/src/commands/project/create.ts:64` (`opts.startAgent`) — proving the convention; the file-flag
sites just got it wrong.

### Why TypeScript didn't catch it

Each action handler hand-declares its own opts shape with the dashed key:
```ts
opts: { …; "prompt-file"?: string }
```
Commander's `.action()` types the callback as `(...args: any[])`, so this fabricated annotation is
accepted as-is. TS then happily type-checks a property access that can never exist at runtime. The
type annotation is the thing that hides the bug — and, importantly, correcting it to camelCase
fixes the code without restoring any compile-time guarantee (see fix item 2).

### Why it fails silently rather than erroring

`prompt` is `optional()` in every daemon Zod schema (`daemon/src/routes/worktrees.ts:135`,
`daemon/src/routes/sessions.ts:38,48`). `{prompt: undefined}` is a fully valid "spawn an agent with
no task" request — indistinguishable from a deliberately prompt-less session. Nothing downstream can
tell that the user asked for a prompt and lost it, so nothing complains.

Two independent defects compound: a **dead read** (wrong key) and a **silent swallow** (a
read-a-file-the-user-named failure that produces no diagnostic).

## Fix

1. **Correct the reads** — use the camelCase keys commander actually provides:
   - `worktree/create.ts`: `opts.promptFile`
   - `session/create.ts`: `opts.promptFile`
   - `mode/add.ts`: `opts.contextFile`

2. **Delete the lying type annotations** — replace the hand-written dashed-key opts interfaces with
   camelCase ones (`promptFile?: string`, `contextFile?: string`).

   **This does not buy compile-time safety, and an earlier draft of this plan wrongly claimed it
   did.** Commander types the callback as `action(fn: (...args: any[]) => void | Promise<void>)`
   (`commander/typings/index.d.ts:547`), so the opts annotation is *never* checked against the
   `.option()` strings. A typo'd `promptFyle?: string` read as `opts.promptFyle` would compile
   exactly as cleanly as the original dashed version did. The code is now correct, but the only
   thing standing between us and a recurrence is the regression test — which is precisely why the
   test asserts on the POSTed body rather than on internals. The real structural fix is the
   deferred `@commander-js/extra-typings` migration below.

3. **Add a shared `resolveFileOrInline()` helper** in `cli/src/lib/text-source.ts` — items 4–6 below would
   otherwise be triplicated verbatim across three files. The helper owns: read-or-die, the
   conflict check, and the empty-file warning. One place to get right, one place to test.

4. **Fail loudly on unreadable prompt files** — `die()` with a clear message if the path is
   missing/unreadable, instead of throwing a raw ENOENT stack. A prompt the user explicitly asked
   for must never be dropped without a word.

5. **Reject mutually-exclusive flags** — use commander's native
   `new Option("--prompt-file <path>").conflicts("prompt")` rather than a hand-rolled `die()`.
   It yields standard commander error output and cooperates with `exitOverride()` in tests.

6. **Warn on an empty prompt file, and return `undefined` for it** — not the raw contents. A
   whitespace-only file yields a *truthy* `"\n"`, and plugins gate on `if (prompt.taskPrompt)`
   (`agent-plugins/claude.ts:86`), so it would be **submitted as the agent's task**. Returning
   `undefined` takes the same path as "no prompt given", which is what the warning promises.
   Warn rather than fail: an empty file is unambiguously not what the caller intended, but it is
   not ours to block.

## Test plan

New `cli/src/__tests__/prompt-file.test.ts`, driving the real `buildProgram()` and asserting on the
**request body actually POSTed** — the bug lives at the CLI→daemon boundary, so that is the layer
worth pinning.

### Harness (three non-obvious constraints — the naive version is actively dangerous)

- **`nock` cannot be used.** It is pinned at `^13` (`cli/package.json:40`), which only patches
  `http.ClientRequest`. Both `daemon-client.ts:29` and `preflight.ts:11` use Node's global `fetch`
  (undici); nock 13 does not intercept it. (It is also currently an unused devDep — not the
  established tooling my first draft implied.) Use `vi.stubGlobal("fetch", …)` instead: no new deps,
  and it records `(url, init)` so we can assert on `JSON.parse(init.body)` directly.
- **`VST_DAEMON_URL` must be set in the test.** Otherwise `getDaemonUrl()` (`daemon-url.ts:11-28`)
  falls back to the developer's real `~/.vibe-station/config.json` — on a machine with a live daemon,
  an unstubbed "test" would **create real worktrees**.
- **`process.exit` must be stubbed.** `die()` calls it (`output.ts:35-38`), which would kill the
  vitest worker on the failure-path tests. `program.exitOverride()` only covers commander's own
  exits, not `die()`. Stub it with a throwing mock and assert the thrown code.

### Cases

- `worktree create --prompt-file=<f>` POSTs `{prompt: <file contents>}` — **fails on current code**
- `session create --prompt-file=<f>` POSTs `{prompt: <file contents>}` — **fails on current code**
- `mode add --context-file=<f>` POSTs `{context: <file contents>}` — **fails on current code**
- `--prompt` inline still POSTs the inline text (no regression)
- `--prompt` + `--prompt-file` together → exits non-zero
- `--prompt-file` pointing at a nonexistent path → exits non-zero with a readable message
- multi-line file contents survive verbatim (no trimming/mangling of the body)
- a whitespace-only file omits `prompt` rather than submitting `"\n"` as the task
- `session create --type=terminal --prompt…` → exits non-zero (daemon would discard it)
- `project create --prompt` without `--start-agent` → exits non-zero (body would omit it)

Required args or the command dies before reaching the file logic: `mode add` needs `--name`/`--cli`
(`mode/add.ts:29-34`); `worktree create` needs `--mode`.

Each of the first three must be demonstrated red against unfixed code before the fix lands —
otherwise the test isn't pinning the bug.

## Verification

- `pnpm --filter @vibestation/cli test` + `pnpm typecheck` + `pnpm lint`
- End-to-end in the docker dev sandbox (`docker-compose.dev.yml`): build the CLI, run
  `vst worktree create --prompt-file` against the sandbox daemon, and confirm via
  `vst session output <id>` that the agent received and acted on the file's contents.

## Scope / non-goals

Confined to CLI argument handling. No daemon, plugin, or tmux changes — the delivery path downstream
of the POST is fine and is exercised daily by the working `--prompt` flag.

`vst send --file` (`cli/src/commands/send.ts:27`) is **not** affected: `--file` is a single word, so
`opts.file` is already correct. (It shares the raw-ENOENT roughness and could adopt the helper later;
out of scope here.)

Repo-wide sweep confirms no other instance of the camelCase bug class: commander is used only in
`cli/`, and the only multi-word options in the repo are `--start-agent` (correct), `--prompt-file`
×2, and `--context-file`.

### Sibling silent-drops closed at the same time

Review found two more places a prompt vanished without a word — same symptom, different mechanism,
so they belong with this fix rather than in a follow-up:

- `project create --prompt` **without** `--start-agent` built a body that omitted the prompt
  entirely (`project/create.ts:94`). The inverse was already guarded (`--mode` required when
  `--start-agent`), so this was an asymmetry, not a design.
- `session create --type=terminal --prompt…` POSTed a prompt the daemon only ever consumes for
  agent sessions (`daemon/src/routes/sessions.ts:420`), dropping it on the floor.

Both now `die()`.

### Deferred follow-up

`@commander-js/extra-typings` would infer opts types from the `.option()` strings and delete every
hand-written opts interface — removing the root enabler of this bug class permanently. It touches
every command file, so it belongs in its own PR, not this fix. A custom ESLint rule was considered
and rejected: not worth it for a CLI with four multi-word options.
