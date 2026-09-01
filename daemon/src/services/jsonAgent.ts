/**
 * JsonAgentSession — the JSON agent-chat turn engine (Decision 2/3/8/10/12).
 *
 * Long-lived per session (registered in `jsonAgentRegistry`). It owns:
 *  - a FIFO turn queue + sequential runner (one `--resume` turn at a time),
 *  - transcript persistence to `messages.jsonl` under `sessionDataDir`,
 *  - `SessionMeta` accumulation (usage / model / turn-state / queue depth),
 *  - the daemon-synthesized `user` event at enqueue (persisted + broadcast),
 *  - `agentChatId` capture from turn-1 `session_init`, persisted via mutateProject.
 *
 * It NEVER parses raw CLI JSON — it only consumes `plugin.runTurn(...)`, the
 * plugin's normalized event iterator (Decision 3). CLI specifics stay in the
 * plugin behind that async-iterable boundary.
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentPlugin, TurnInput, TurnContext } from "./spawn.js";
import type { TranscriptMeta, TranscriptPage, TranscriptStore, ImportOutcome } from "./transcriptStore.js";
import { openSqliteTranscriptStore, transcriptDbPath } from "./sqliteTranscriptStore.js";
import { getNativeHistoryImporter } from "./nativeHistoryImporter.js";
import { capToolResultContent } from "./toolResultCap.js";
import {
  worktreePath as getWorktreePath,
  sessionDataDir,
  directSessionDataDir,
  systemPromptPath,
  directSystemPromptPath,
} from "./paths.js";
import { mutateProject } from "../state/project-store.js";
import { JsonAgentStream } from "../ws/streams/jsonAgentStream.js";
import { jsonAgentRegistry } from "../state/jsonAgentRegistry.js";
import { AcpConnection, SessionLoadFailed, type AcpLaunchSpec } from "./acp/acpTransport.js";
import type { AcpEnrichHook } from "./acp/normalize.js";
import type {
  ProjectRecord,
  WorktreeRecord,
  SessionRecord,
  Attachment,
  NormalizedEvent,
  NormalizedEventProvider,
  NormalizedEventKind,
  UsageInfo,
  SessionMeta,
  TurnState,
  LifecycleState,
} from "../types.js";

/**
 * How long `release()` waits for an aborted turn's drain to unwind before
 * closing the SQLite handle anyway. The wait exists so the common case closes
 * a quiescent store; the cap exists so a wedged child can never hang the
 * `POST /sessions/:id/done` request. Safe to expire: `released` has already
 * neutralised every writer, and the child's process group is already SIGKILLed.
 */
const RELEASE_DRAIN_TIMEOUT_MS = 2000;

/**
 * Quiet gap after which the next out-of-band ACP event (a task notification
 * arriving between turns) starts a NEW pseudo-turn instead of appending to the
 * previous one — see `handleOutOfBandEvent`.
 */
const OUT_OF_BAND_BURST_GAP_MS = 30_000;

/**
 * Inject absolute attachment paths into a user message (Decision 5). The agent
 * reads the files by absolute path (they live under `sessionDataDir`, not the
 * checkout). Applied at RUN time (not enqueue) so the queued turn retains the
 * raw user text + attachment records for editing (queue-controls A1).
 */
/**
 * True when a usage event reflects a real model call. A claude slash command
 * (/model, /cost, …) completes a turn without hitting the API and reports
 * `totalTokens: 0`; treating that as authoritative would clobber the running
 * token count with zero. Gate all `usage` writes through this so a no-op turn
 * preserves the last real usage instead of dropping the status bar to "0 tok".
 */
function hasRealUsage(usage: UsageInfo | undefined): usage is UsageInfo {
  return !!usage && usage.totalTokens > 0;
}

export function injectAttachments(message: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return message;
  const list = attachments.map((a) => a.path).join("\n");
  const header = `[Attached files:]\n${list}`;
  // Files-only turn (empty prompt): the attachment block IS the message body —
  // never send a literally empty prompt to the CLI (Fix #2).
  return message.trim().length > 0 ? `${message}\n\n${header}` : header;
}

export interface JsonAgentSessionOptions {
  project: ProjectRecord;
  /** null for direct sessions (session lives in project.directSessions). */
  worktree: WorktreeRecord | null;
  session: SessionRecord;
  plugin: AgentPlugin;
  daemonPort: number;
  /** CLI / provider id (from the session's mode). */
  cli: NormalizedEventProvider;
  model?: string;
  modeId?: string;
  modeName?: string;
}

interface QueuedTurn {
  turnId: string;
  /** Monotonic enqueue order — stable identity for ordering across reorders. */
  enqueueOrder: number;
  /** RAW user text (pre-injection) — kept for editing (queue-controls A1). */
  rawMessage: string;
  /** Resolved attachment records — kept for editing + chip rendering. */
  attachments: Attachment[];
  /**
   * Edit-a-sent-message fork (R3.2): when set, this turn branches the harness's
   * own session from this chat id (`--fork-session`) rather than resuming in
   * place, so the fork never mutates the original branch.
   */
  forkFromChatId?: string;
}

/** A queued turn withdrawn into the editing hold (queue-controls A5). */
interface HeldTurn {
  turn: QueuedTurn;
  /** turnIds that were AHEAD of this turn at withdraw — drives re-insert order (A2). */
  aheadIds: string[];
}

/**
 * Enumerate every descendant PID of `rootPid` by walking `/proc` PPID links.
 * claude's Bash tool spawns commands in their OWN process/session group
 * (`setsid`), so they are NOT in the turn root's process group and survive a
 * group-kill — but they remain descendants until the root dies, so we can find
 * and kill them explicitly. Linux-only; returns [] if `/proc` is unavailable.
 */
function collectDescendants(rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return []; // no /proc (non-Linux) — group-kill is the only lever
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid …` — comm can contain spaces/parens, so split
      // after the last ')': fields are then [state, ppid, …].
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(rest[1]);
      if (!Number.isFinite(ppid)) continue;
      (childrenOf.get(ppid) ?? childrenOf.set(ppid, []).get(ppid)!).push(pid);
    } catch {
      /* race: process exited while scanning */
    }
  }
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/**
 * Kill each root turn PID AND its whole descendant tree so NO tool subprocess
 * survives a stop / DELETE and keeps writing into a to-be-purged checkout
 * (Decision 13).
 *
 * The tree is FROZEN before it is killed: we SIGSTOP the roots first (a stopped
 * process cannot fork), then enumerate + SIGSTOP descendants to a fixed point,
 * then SIGKILL everything. Freezing first closes the race where a live harness
 * (e.g. claude, whose Bash tool puts commands in their own `setsid` groups)
 * spawns a fresh escapee in the window between enumeration and the kill. Every
 * process group AND pid is SIGKILLed (a `setsid` child is its own group leader,
 * so its group must be killed too; SIGKILL overrides the SIGSTOP). Linux-only
 * enumeration via `/proc`; best-effort throughout.
 */
function killProcessTree(rootPids: Iterable<number>): void {
  const roots = [...rootPids].filter((p) => Number.isFinite(p) && p > 1);
  if (roots.length === 0) return;

  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  const signalGroup = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      /* group already gone */
    }
  };

  // Freeze the roots first so they can't spawn while we walk the tree.
  const frozen = new Set<number>();
  for (const root of roots) {
    signalGroup(root, "SIGSTOP");
    signal(root, "SIGSTOP");
    frozen.add(root);
  }
  // Enumerate + freeze descendants to a fixed point (in-flight forks settle,
  // then no new ones can appear because every ancestor is stopped).
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const root of roots) {
      for (const pid of collectDescendants(root)) {
        if (frozen.has(pid)) continue;
        signalGroup(pid, "SIGSTOP");
        signal(pid, "SIGSTOP");
        frozen.add(pid);
        grew = true;
      }
    }
    if (!grew) break;
  }
  // Now reap the whole frozen tree (SIGKILL overrides SIGSTOP).
  for (const pid of frozen) {
    signalGroup(pid, "SIGKILL");
    signal(pid, "SIGKILL");
  }
}

export class JsonAgentSession {
  private readonly project: ProjectRecord;
  private readonly worktree: WorktreeRecord | null;
  private readonly session: SessionRecord;
  private readonly plugin: AgentPlugin;
  private readonly daemonPort: number;
  private readonly cli: NormalizedEventProvider;
  private readonly cwd: string;
  private readonly dataDir: string;
  /** Durable transcript persistence (SQLite behind the TranscriptStore port). */
  private readonly store: TranscriptStore;
  private readonly systemPromptFile: string;

  readonly stream = new JsonAgentStream();

  private modeId?: string;
  private modeName?: string;
  /**
   * The REQUESTED model — what we spawn with (`ctx.model` → `--model`). Seeded
   * from the session's model override (if any) else the mode's model. It must
   * never drift to an observed usage/subagent model, or a later turn would spawn
   * the wrong model — but the status-bar switcher CAN change it live via
   * `setModel`, which applies to the next spawned turn.
   */
  private requestedModel?: string;
  /**
   * The OBSERVED / display model (from the harness's own events) — surfaced in
   * `SessionMeta` for the status bar only. Never fed back into spawning.
   */
  private model?: string;
  private usage?: UsageInfo;
  private turnState: TurnState = "idle";
  private firstTurnDone = false;

  private queue: QueuedTurn[] = [];
  /** Turns withdrawn for editing (queue-controls) — out of the run queue. */
  private readonly holds = new Map<string, HeldTurn>();
  /** Monotonic enqueue-order counter (never reused). */
  private enqueueCounter = 0;
  private running = false;
  private activeAbort: AbortController | null = null;
  private drainPromise: Promise<void> = Promise.resolve();
  /**
   * Chat id the ACTIVE turn is forking from (R3.2), or undefined for a normal
   * turn. Set for the duration of a fork turn so `handleEvent` adopts the NEW
   * forked session id from its `session_init` — otherwise later turns would
   * `--resume` the ORIGINAL branch and undo the fork.
   */
  private activeForkFromChatId?: string;

  /** Live per-turn child PIDs (own process groups) for orphan-kill safety (Decision 13). */
  private readonly livePids = new Set<number>();

  /**
   * ACP migration (Decision 1): this session's ONE persistent AcpConnection,
   * created lazily on first turn for a plugin with `supportsAcp()`, reused for
   * every later turn, disposed on release()/toggle (Decision 9). `undefined`
   * for a plugin not migrated to ACP.
   */
  private connection?: AcpConnection;
  /**
   * True until the connection's FIRST turn reaches `result` (Decision 6 Option
   * B call-site gate) — `captureNativeChatId` must run exactly once, at that
   * point, never earlier (the native side channel is a filesystem artifact
   * written only once the CLI has actually produced a conversation).
   */
  private connectionFirstTurnPending = false;
  /** Stable turnId for the current burst of out-of-band ACP events (task notifications). */
  private outOfBandTurnId: string | null = null;
  /** `Date.now()` of the last out-of-band event — a long quiet gap opens a new burst. */
  private outOfBandLastAt = 0;

  /**
   * Set by `release()` — this instance is being torn down and must never write
   * again. Two late writers exist and both would corrupt state after release:
   *
   * 1. `drain()`'s `finally` persists lifecycle `idle` as the aborted turn
   *    unwinds. That lands AFTER the caller has persisted `done`, silently
   *    demoting a deliberately-done session back to idle.
   * 2. `persist()` appends to the SQLite store, which `dispose()` has closed —
   *    a straggler event would throw.
   *
   * Both check this latch. It is a latch rather than an ordering rule because
   * the unwinding is asynchronous and cannot be awaited race-free otherwise.
   */
  private released = false;

  constructor(opts: JsonAgentSessionOptions) {
    this.project = opts.project;
    this.worktree = opts.worktree;
    this.session = opts.session;
    this.plugin = opts.plugin;
    this.daemonPort = opts.daemonPort;
    this.cli = opts.cli;
    this.requestedModel = opts.model;
    // Display model starts as the requested model, then tracks what the harness
    // actually reports (observed) as events arrive.
    this.model = opts.model;
    this.modeId = opts.modeId;
    this.modeName = opts.modeName;

    if (opts.worktree) {
      this.cwd = getWorktreePath(opts.project.id, opts.worktree.id);
      this.dataDir = sessionDataDir(opts.project.id, opts.worktree.id, opts.session.id);
      this.systemPromptFile = systemPromptPath(opts.project.id, opts.worktree.id, opts.session.id);
    } else {
      this.cwd = opts.project.absolutePath;
      this.dataDir = directSessionDataDir(opts.project.id, opts.session.id);
      this.systemPromptFile = directSystemPromptPath(opts.project.id, opts.session.id);
    }
    // Durable transcript store (SQLite); migrates any legacy messages.jsonl on
    // first open (kept as a read-only backup). Sole writer per session (R0.8).
    this.store = openSqliteTranscriptStore(this.dataDir, this.session.id);
    // Turn 1 is the first if the transcript has no prior turns.
    this.firstTurnDone = this.hasPersistedTurn();
    // Meta durability (Decision 8): after a daemon restart the in-memory usage/
    // model is empty — rebuild it from the transcript tail so GET /meta and the
    // status bar show the last-known cumulative usage/model immediately.
    this.rebuildMetaFromTranscript();
    // An explicit model override wins over the transcript's observed model so
    // the status bar reflects what the NEXT turn will spawn with (the override),
    // not the last model the harness happened to report.
    if (this.session.modelOverride) this.model = this.session.modelOverride;
  }

  /**
   * Change the model for subsequent turns (status-bar switcher). `override` null
   * clears back to the mode default (`modeDefault`). Applies to the next spawned
   * turn — never mid-flight, since `runOneTurn` reads `requestedModel` at spawn
   * time. Persists to the SessionRecord (restart-durable) and broadcasts meta.
   */
  async setModel(override: string | null, modeDefault?: string): Promise<void> {
    this.requestedModel = override ?? modeDefault;
    // Display the model the next turn will use; the turn's own session_init will
    // later replace it with the concrete resolved id (existing behavior).
    this.model = this.requestedModel;
    await this.persistModelOverride(override);
    this.emitMeta();
  }

  /** Rebuild `usage`/`model` from the last usage/result/model-bearing events. */
  private rebuildMetaFromTranscript(): void {
    const meta = this.store.lastMeta();
    if (meta.model) this.model = meta.model;
    if (meta.usage) this.usage = meta.usage;
  }

  /**
   * Enqueue a user turn (Decision 8/12). Synthesizes + persists + broadcasts the
   * `user` event immediately (so a client opening mid-turn replays it), then
   * kicks the sequential runner. Always accepted — never busy-rejects.
   */
  enqueue(input: {
    /** RAW user text (pre-injection); attachments are injected at run time (A1). */
    message: string;
    attachments?: Attachment[];
    /** Optional system prompt to write before the first turn. */
    systemPrompt?: string;
    /** Fork branch source (R3.2) — this turn runs with `--fork-session` from it. */
    forkFromChatId?: string;
  }): { turnId: string; queuePosition: number } {
    const turnId = randomUUID();
    const attachments = input.attachments ?? [];
    const queuePosition = this.queue.length + (this.running ? 1 : 0);

    if (input.systemPrompt !== undefined) {
      this.ensureDataDir();
      writeFileSync(this.systemPromptFile, input.systemPrompt, "utf8");
    }

    // Decision 12 — daemon-owned user event. Carries the RAW text (attachments
    // render as chips); the injected path header is a run-time concern only (A1).
    const userEvent = this.newEvent("user", {
      role: "user",
      text: input.message,
      turnId,
      ...(attachments.length ? { attachments } : {}),
    });
    this.persist(userEvent);
    this.stream.emitMessage(userEvent);

    this.queue.push({
      turnId,
      enqueueOrder: this.enqueueCounter++,
      rawMessage: input.message,
      attachments,
      ...(input.forkFromChatId ? { forkFromChatId: input.forkFromChatId } : {}),
    });
    if (queuePosition > 0) this.setTurnState("queued");
    this.emitMeta();
    this.kickDrain();
    return { turnId, queuePosition };
  }

  /** Resolves when the queue has fully drained (no active/queued turns). */
  async settled(): Promise<void> {
    await this.drainPromise;
  }

  private kickDrain(): void {
    if (!this.running) {
      this.drainPromise = this.drain();
    }
  }

  /** Abort the active turn and drop all queued AND held turns (Decision 13 / A5). */
  abortAndDrain(): void {
    this.queue = [];
    this.holds.clear();
    // Kill the descendant tree FIRST, while the process ancestry is still intact
    // (a killed parent reparents its children to init, losing the tree), then
    // abort to unwind the iterator / plugin cleanup.
    this.killLivePids();
    this.activeAbort?.abort();
    this.setTurnState("idle");
    this.emitMeta();
  }

  /**
   * Release the session's own SQLite handle (WAL mode → db + -wal + -shm file
   * descriptors). Callers that drop the registry reference (`DELETE
   * /sessions/:id`, worktree delete, tty→json toggle) MUST call this — the
   * registry holding the only reference is not enough, since better-sqlite3
   * has no finalizer the GC can rely on to close the handle promptly. Without
   * this, a daemon that creates/deletes many JSON sessions (or channel-toggles
   * repeatedly — each json→tty→json cycle opens a fresh store) accumulates
   * open handles indefinitely, trending toward fd exhaustion (EMFILE).
   * Idempotent-safe to call even if a turn is still active — callers are
   * expected to `abortAndDrain()` first (as every current call site does).
   */
  dispose(): void {
    try {
      this.store.close();
    } catch {
      /* already closed / best-effort */
    }
  }

  /**
   * Full teardown for a session that is being retired but KEPT on disk
   * (`POST /sessions/:id/done`, `POST /worktrees/:id/done`, delete, worktree
   * delete). Latches `released` first so neither the unwinding drain nor a
   * straggler event can write after us, aborts the active turn + queue, waits
   * (bounded) for the drain to unwind, then closes the SQLite handle.
   *
   * Idempotent. Never throws. The 2 s cap means a wedged child cannot hang the
   * HTTP request — `released` has already neutralised anything it might write,
   * and `abortAndDrain` has already SIGKILLed its process group.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.abortAndDrain();
    await Promise.race([
      this.settled().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, RELEASE_DRAIN_TIMEOUT_MS)),
    ]);
    // Decision 9 — tear down the ACP connection (and its live terminals)
    // BEFORE closing the SQLite handle. Bounded by the same drain timeout
    // above having already elapsed; dispose() itself is internally capped.
    if (this.connection) {
      await this.connection.dispose().catch(() => {});
      this.connection = undefined;
    }
    this.dispose();
  }

  /**
   * Stop the active turn only, keeping queued turns (Decision 8 `/chat/stop`).
   * The runner proceeds to the next queued turn once the aborted one unwinds.
   * Returns true when there was an active turn to abort, false otherwise
   * (only-queued or fully idle → no-op).
   */
  stopActiveTurn(): boolean {
    if (!this.running || !this.activeAbort) return false;
    if (this.connection) {
      // Decision 3 — an ACP connection (and its live terminals) must SURVIVE a
      // Stop: cancel only the in-flight prompt, never kill the process group.
      this.connection.cancelActivePrompt();
    } else {
      // Legacy per-turn spawn: kill the whole descendant tree (tool
      // subprocesses in their own groups would otherwise survive the stop).
      this.killLivePids();
    }
    this.activeAbort.abort();
    return true;
  }

  /**
   * Cancel ONE not-yet-started turn by id — whether queued OR held for edit
   * (queue-controls A5: an abandoned edit must be cancellable, not a zombie).
   * Returns true if removed.
   */
  cancelQueuedTurn(turnId: string): boolean {
    // Capture the turn (queued or held) before removal so we can re-emit its
    // message flagged as cancelled.
    const turn = this.queue.find((t) => t.turnId === turnId) ?? this.holds.get(turnId)?.turn;
    const before = this.queue.length;
    this.queue = this.queue.filter((t) => t.turnId !== turnId);
    const removedFromQueue = this.queue.length < before;
    const removedFromHold = this.holds.delete(turnId);
    if (removedFromQueue || removedFromHold) {
      // The message stays in history but is marked as never processed. Append a
      // superseding `user` event (`cancelled:true`) with the same turnId — replay
      // keeps the LAST `user` per turnId, so it supersedes the original bubble
      // (mirrors the edit path). No assistant turn ever ran for it.
      if (turn) {
        const userEvent = this.newEvent("user", {
          role: "user",
          text: turn.rawMessage,
          turnId,
          cancelled: true,
          ...(turn.attachments.length ? { attachments: turn.attachments } : {}),
        });
        this.persist(userEvent);
        this.stream.emitMessage(userEvent);
      }
      this.syncIdleState();
      this.emitMeta();
    }
    return removedFromQueue || removedFromHold;
  }

  /**
   * Withdraw a queued turn into the editing hold (queue-controls A5) — it can no
   * longer start (race eliminated by construction, R8). Re-acquiring an already
   * held turn is idempotent and returns its held content (recovery path — no 409).
   * Returns the content + original queue index, or "not_queued".
   */
  beginEditQueuedTurn(
    turnId: string,
  ): { message: string; attachments: Attachment[]; queueIndex: number } | "not_queued" {
    const held = this.holds.get(turnId);
    if (held) {
      return {
        message: held.turn.rawMessage,
        attachments: held.turn.attachments,
        queueIndex: held.aheadIds.length,
      };
    }
    const index = this.queue.findIndex((t) => t.turnId === turnId);
    if (index < 0) return "not_queued";
    const aheadIds = this.queue.slice(0, index).map((t) => t.turnId);
    const turn = this.queue.splice(index, 1)[0]!;
    this.holds.set(turnId, { turn, aheadIds });
    this.syncIdleState();
    this.emitMeta();
    return { message: turn.rawMessage, attachments: turn.attachments, queueIndex: index };
  }

  /**
   * Re-enqueue a held turn (queue-controls A2/A5). `edited` overwrites its raw
   * text + attachments and appends a superseding `user` event (`edited:true`);
   * otherwise it is restored unchanged. Re-inserted preserving its original
   * relative order (after the still-present turns that were ahead of it — robust
   * to any cancel/promote during the edit). Returns "ok" or "not_editing".
   */
  resubmitQueuedTurn(
    turnId: string,
    opts: { edited: boolean; message?: string; attachments?: Attachment[] },
  ): "ok" | "not_editing" {
    const held = this.holds.get(turnId);
    if (!held) return "not_editing";
    this.holds.delete(turnId);
    const turn = held.turn;

    if (opts.edited) {
      turn.rawMessage = opts.message ?? "";
      turn.attachments = opts.attachments ?? [];
      const userEvent = this.newEvent("user", {
        role: "user",
        text: turn.rawMessage,
        turnId,
        edited: true,
        ...(turn.attachments.length ? { attachments: turn.attachments } : {}),
      });
      this.persist(userEvent);
      this.stream.emitMessage(userEvent);
    }

    // Insert after every still-present turn that was ahead at withdraw (A2).
    const aheadSet = new Set(held.aheadIds);
    const insertAt = Math.min(
      this.queue.filter((t) => aheadSet.has(t.turnId)).length,
      this.queue.length,
    );
    this.queue.splice(insertAt, 0, turn);
    this.syncIdleState();
    this.emitMeta();
    this.kickDrain();
    return "ok";
  }

  /**
   * Edit an already-ANSWERED turn → fork (R3.1/R3.4/R3.5). Truncate the branch at
   * turn N by marking every row from its first `logSeq` onward superseded (the old
   * branch is kept, git-style, just hidden — R3.3), then enqueue the edited message
   * as a NEW turn carrying `forkFromChatId = agentChatId` so it re-runs with
   * `--fork-session` off the original session. Returns the new turnId + the turnIds
   * that were superseded (for the fork broadcast / other-tab re-sync, R3.6), or
   * "not_found" when turn N has no live rows.
   */
  forkTurn(input: {
    turnId: string;
    message: string;
    attachments?: Attachment[];
  }): { turnId: string; supersededTurnIds: string[] } | "not_found" {
    const forkSeq = this.store.firstSeqOfTurn(input.turnId);
    if (forkSeq === undefined) return "not_found";
    // Truncate at the fork point (rows ≥ forkSeq → superseded, hidden from reads).
    const supersededTurnIds = this.store.markSupersededFrom(forkSeq);
    // Meta may now resolve to an earlier live turn (the superseded tail is gone).
    this.rebuildMetaFromTranscript();
    // Re-run from the fork point on a fresh session id (--fork-session), so the
    // original branch stays intact. No agentChatId (never-answered session) ⇒ no
    // fork source; the turn just runs normally (defensive — R3.5 gates upstream).
    const { turnId } = this.enqueue({
      message: input.message,
      ...(input.attachments && input.attachments.length ? { attachments: input.attachments } : {}),
      ...(this.session.agentChatId ? { forkFromChatId: this.session.agentChatId } : {}),
    });
    return { turnId, supersededTurnIds };
  }

  /**
   * "Send now" — preemptive. Splice the queued turn to the front, then abort the
   * active turn (like Stop — the aborted turn is DROPPED, not re-queued) so the
   * promoted turn runs next immediately. The reorder MUST precede the abort: the
   * drain loop is parked on `await runOneTurn(active)` and cannot `shift()` again
   * until that turn's generator settles, so once it does the promoted turn is
   * already at queue[0] and runs next. No-op abort when idle. Returns "ok" or
   * "not_queued".
   */
  promoteQueuedTurn(turnId: string): "ok" | "not_queued" {
    const index = this.queue.findIndex((t) => t.turnId === turnId);
    if (index < 0) return "not_queued";
    if (index > 0) {
      const turn = this.queue.splice(index, 1)[0]!;
      this.queue.unshift(turn);
      this.emitMeta();
    }
    // Preempt the running turn so the promoted one runs next. Outside the
    // `index > 0` guard on purpose: "send now" on the already-front turn still
    // interrupts. Idle → stopActiveTurn returns false (nothing aborted); the
    // defensive kickDrain then ensures the reordered queue drains.
    this.stopActiveTurn();
    this.kickDrain();
    return "ok";
  }

  /** Recompute the global turn-state from the queue when no turn is running. */
  private syncIdleState(): void {
    if (this.running) return;
    this.setTurnState(this.queue.length > 0 ? "queued" : "idle");
  }

  /** True while turn 1 (system-prompt turn) has not yet completed. */
  get isFirstTurnPending(): boolean {
    return !this.firstTurnDone;
  }

  /** Full transcript (for `chat:replay` / GET /transcript), via the store. */
  readTranscript(): NormalizedEvent[] {
    return this.store.readAll();
  }

  /** Bounded tail-N turns + cursor for the initial `chat:replay` (R2.1). */
  tail(nTurns: number): TranscriptPage {
    return this.store.tail(nTurns);
  }

  /** Keyset "load earlier" page, turn-aligned + cursor (R2.2). */
  pageBefore(beforeSeq: number, limit: number): TranscriptPage {
    return this.store.pageBefore(beforeSeq, limit);
  }

  /** Reconnect delta — events strictly newer than `sinceSeq` (R2.3). */
  since(sinceSeq: number): NormalizedEvent[] {
    return this.store.since(sinceSeq);
  }

  /**
   * The cli/modeId/modeName this instance was constructed with — frozen for
   * its lifetime (set once from the mode resolved at creation time). Exposed
   * so callers (e.g. `resolveJsonAgent`) can reuse an already-live agent's
   * config instead of re-resolving `modeId → Mode`, which would break if the
   * mode was since deleted (deleting an in-use mode is allowed).
   */
  getCli(): NormalizedEventProvider {
    return this.cli;
  }
  getModeId(): string | undefined {
    return this.modeId;
  }
  getModeName(): string | undefined {
    return this.modeName;
  }

  /** Latest cross-harness meta (rebuilt from transcript tail on construction). */
  getMeta(): SessionMeta {
    return {
      sessionId: this.session.id,
      channel: "json",
      ...(this.modeId ? { modeId: this.modeId } : {}),
      ...(this.modeName ? { modeName: this.modeName } : {}),
      cli: this.cli,
      ...(this.model ? { model: this.model } : {}),
      turnState: this.turnState,
      queueDepth: this.queue.length,
      queuedTurnIds: this.queue.map((t) => t.turnId),
      editingTurnIds: [...this.holds.keys()],
      ...(this.usage ? { usage: this.usage } : {}),
      cwd: this.cwd,
    };
  }

  /**
   * The P3 channel-toggle idle gate (R1.1). True only when NOTHING is in flight:
   * no active/running turn, an empty run queue, AND no turns withdrawn for edit.
   * A toggle is rejected (409) whenever this is false so a switch never races an
   * in-flight turn (Decision 13 teardown safety).
   */
  get isIdleForToggle(): boolean {
    return (
      !this.running &&
      this.turnState === "idle" &&
      this.queue.length === 0 &&
      this.holds.size === 0
    );
  }

  /**
   * Backfill terminal-phase turns from the CLI's native store on a tty→json
   * toggle (R1.4 / R0.5–R0.9). Runs the per-CLI at-rest importer past the stored
   * watermark, then commits the events in a single transaction (dedup + atomic +
   * watermark advance). A no-op when the session has no `agentChatId` yet (a
   * brand-new empty session, J12/J13) or the CLI has no importer. Returns the
   * import outcome, or null when nothing ran.
   */
  async importNativeHistory(): Promise<ImportOutcome | null> {
    const agentChatId = this.session.agentChatId;
    if (!agentChatId) return null; // empty session — nothing to backfill (J12/J13)
    const importer = getNativeHistoryImporter(this.cli);
    if (!importer) return null; // CLI has no importer (should be gated upstream, R1.6)

    const watermark = this.store.getNativeWatermark();
    const { events, nextWatermark } = await importer.import({
      sessionId: this.session.id,
      agentChatId,
      cwd: this.cwd,
      ...(watermark ? { watermark: watermark.cursor } : {}),
    });
    const outcome = this.store.importTransaction(events, { cli: this.cli, cursor: nextWatermark });
    // Meta may have advanced (new usage/model from imported turns) — refresh it
    // so the status bar reflects the backfilled terminal-phase context.
    this.rebuildMetaFromTranscript();
    this.emitMeta();
    return outcome;
  }

  // --- internals ---

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!;
        await this.runOneTurn(turn);
      }
    } finally {
      this.running = false;
      if (this.turnState !== "error") this.setTurnState("idle");
      this.emitMeta();
      // Persist lifecycle → waiting_for_human now the queue has fully
      // drained (Decision 11). The lifecycle poller deliberately skips JSON
      // sessions, so nothing else flips the sidebar spinner back off.
      // `POST /chat` / `startJsonCreateTurn` persist `working` while a turn
      // is active/queued; this is the matching post-turn transition.
      //
      // R3 (plan 03, Decision 2 / Decision 0 — R2 dropped, R3 is the sole
      // waiting_for_human entry path for EVERY channel, not just TTY): reaching
      // this finally block AT ALL means `runOneTurn` processed at least one
      // turn in the `while` loop above — i.e. the session has, by construction,
      // already "reached working" this cycle. There is no genesis-vs-later
      // distinction to make here (unlike a naive reading of the TTY poller's
      // `everWorked` flag might suggest) — R3a's carve-out ("never reached
      // working stays idle") has no live manifestation in `drain()` at all,
      // symmetric with why it has none in `lifecycle.ts`'s poller either (see
      // that file's own `everWorked` doc comment). So every drain lands on
      // `waiting_for_human`, including the very first one. Even on a turn
      // error the session is ready for the next message (the error lives in
      // the transcript), so the same choice applies.
      await this.persistLifecycle("waiting_for_human");
    }
  }

  /** Persist the session lifecycle to the manifest (JSON channel, Decision 11). */
  private async persistLifecycle(state: LifecycleState): Promise<void> {
    // Released sessions are terminal (`done`) — the drain's trailing
    // `waiting_for_human` (or any other non-terminal state) must not demote
    // them. See the `released` field comment.
    if (this.released) return;
    try {
      const { persistLifecycleState } = await import("./lifecycle.js");
      await persistLifecycleState(this.project.id, this.worktree?.id, this.session.id, state);
    } catch (err) {
      console.warn(`[json-chat] lifecycle persist failed for ${this.session.id}: ${String(err)}`);
    }
  }

  private async runOneTurn(turn: QueuedTurn): Promise<void> {
    if (!this.plugin.runTurn) {
      const ev = this.newEvent("error", {
        turnId: turn.turnId,
        text: `Plugin '${this.plugin.name}' does not support the JSON channel`,
      });
      this.persist(ev);
      this.stream.emitMessage(ev);
      this.setTurnState("error");
      this.emitMeta();
      return;
    }

    const abort = new AbortController();
    this.activeAbort = abort;
    // A real turn closes any open out-of-band notification burst — notifications
    // that arrive after it must not be folded back into the pre-turn pseudo-turn.
    this.outOfBandTurnId = null;
    this.setTurnState("thinking");
    this.emitMeta();

    // Build the plugin input at RUN time: inject attachment paths into the raw
    // text now, and decide isFirstTurn from live state (the first turn to RUN —
    // not enqueue order — carries the system prompt, robust to reorders) (A1).
    const input: TurnInput = {
      message: injectAttachments(turn.rawMessage, turn.attachments),
      ...(turn.attachments.length ? { attachmentPaths: turn.attachments.map((a) => a.path) } : {}),
      isFirstTurn: !this.firstTurnDone,
    };

    // A fork turn branches the harness's own session (--fork-session) instead of
    // resuming in place; track it so handleEvent adopts the new forked chat id.
    this.activeForkFromChatId = turn.forkFromChatId;
    const ctx: TurnContext = {
      cwd: this.cwd,
      project: this.project,
      worktree: this.worktree,
      session: this.session,
      ...(turn.forkFromChatId ? { forkFromChatId: turn.forkFromChatId } : {}),
      ...(this.session.agentChatId ? { chatId: this.session.agentChatId } : {}),
      // Spawn with the REQUESTED model (constant), never the observed/display one
      // — otherwise a haiku subagent seen mid-turn would become turn N+1's --model.
      ...(this.requestedModel ? { model: this.requestedModel } : {}),
      systemPromptFile: this.systemPromptFile,
      daemonPort: this.daemonPort,
      onSpawn: (pid: number) => this.recordTurnPid(pid),
      // ACP migration (Decision 1/2): only a plugin that calls this ever
      // triggers connection creation — legacy plugins never invoke it.
      getAcpConnection: (spec, enrich) => this.getOrCreateConnection(spec, enrich),
    };

    // Whether the turn reached its own terminal `result` before any abort. A stop
    // that races in AFTER `result` is benign (turn already done) — no marker.
    let sawResult = false;
    try {
      for await (const ev of this.plugin.runTurn(input, ctx, abort.signal)) {
        // Once the turn is aborted, stop consuming/appending its trailing events
        // (a killed harness can still flush a late `session_init`/`result` after
        // the abort) so a replayed transcript of an aborted turn stays ordered.
        if (abort.signal.aborted) break;
        if (ev.kind === "result") sawResult = true;
        ev.turnId = turn.turnId;
        ev.sessionId = this.session.id;
        await this.handleEvent(ev);
      }
      // Only a turn that actually ran counts as "turn 1 done". An aborted turn
      // (Stop, or a preemptive Send-now) that never reached its `result` did not
      // establish the session — leaving `firstTurnDone` false so the NEXT turn
      // still carries the system prompt (never send a promptless turn 1).
      //
      // Known quirk (harmless, not a correctness bug): `handleEvent` captures
      // `agentChatId` off `session_init` — the FIRST event a harness emits —
      // not off `result`. So a turn aborted AFTER session_init but before
      // result can leave `firstTurnDone=false` while `agentChatId` is already
      // set. The next turn then runs with BOTH `isFirstTurn=true` and a
      // resolved chatId, so claude gets `--resume <chatId>
      // --append-system-prompt <fullPrompt>` — the system prompt is
      // re-appended onto the already-resumed session rather than the harness
      // opening fresh. Wasteful (duplicated system-prompt content in
      // context) if a turn-1 is stopped early, but not data loss or a wrong
      // conversation.
      if (!abort.signal.aborted || sawResult) this.firstTurnDone = true;
      // Decision 6 Option B call site — only meaningful once the plugin has
      // actually reached a result on the (possibly brand-new) connection.
      if (sawResult && this.plugin.supportsAcp?.()) await this.maybeCaptureNativeChatId();
    } catch (err) {
      // Plugins return cleanly on abort (they guard the non-zero-exit throw with
      // `!signal.aborted`), so this catch only fires on a real transport/exit
      // failure — an intentional stop never lands here.
      if (!abort.signal.aborted) {
        // Decision 7 — non-zero exit / transport failure → synthetic error event.
        const errEvent = this.newEvent("error", { turnId: turn.turnId, text: String(err) });
        this.persist(errEvent);
        this.stream.emitMessage(errEvent);
        this.setTurnState("error");
        this.emitMeta();
      }
    } finally {
      // A turn stopped BEFORE it produced its own `result` would otherwise end the
      // transcript with no outcome (e.g. mid-`tool_use`) and replay as truncated.
      // Append a terminal `status` marker so a stopped turn reads as terminal.
      if (abort.signal.aborted && !sawResult) this.emitStopped(turn.turnId);
      this.activeAbort = null;
      this.activeForkFromChatId = undefined;
      this.clearTurnPids();
    }
  }

  /** Append + broadcast a synthetic terminal marker for a stopped/aborted turn. */
  private emitStopped(turnId: string): void {
    const ev = this.newEvent("status", { turnId, text: "Turn stopped" });
    this.persist(ev);
    this.stream.emitMessage(ev);
  }

  // --- orphan-process safety (Decision 13) ---

  /** Record a live turn PID and mirror it to a durable pidfile for boot sweep. */
  private recordTurnPid(pid: number): void {
    this.livePids.add(pid);
    this.writePidFile();
  }

  /**
   * SIGKILL any still-live turn process AND its whole descendant tree (Decision
   * 13) — not just the turn's process group, since claude's Bash tool spawns
   * commands in their own `setsid` groups that would otherwise survive.
   */
  private killLivePids(): void {
    killProcessTree(this.livePids);
    this.clearTurnPids();
  }

  private clearTurnPids(): void {
    this.livePids.clear();
    this.writePidFile();
  }

  private writePidFile(): void {
    const pidFile = join(this.dataDir, "turn.pids");
    if (this.livePids.size === 0) {
      try {
        unlinkSync(pidFile);
      } catch {
        /* nothing to clear */
      }
      return;
    }
    this.ensureDataDir();
    writeFileSync(pidFile, [...this.livePids].join("\n"), "utf8");
  }

  // --- ACP connection lifecycle (Decision 1/2/5/9) ---

  /**
   * Lazily create-or-return this session's ONE `AcpConnection`. First call:
   * spawns + `initialize`s, then `session/load`s the existing `agentChatId`
   * (iff `initialize` advertised `loadSession` AND an id already exists) or
   * else `session/new`s (Decision 5) — a failed/unsupported load falls through
   * to a fresh session with a `status` event naming the fallback, never a
   * silent respawn. Subsequent calls return the cached connection untouched.
   */
  private async getOrCreateConnection(
    spec: AcpLaunchSpec,
    enrich?: AcpEnrichHook,
  ): Promise<AcpConnection> {
    // Defensive liveness check, not just truthiness: a cached connection can
    // have died on its own (idle TTL dispose, crashed child process) without
    // this session ever being told directly. `isAlive()` catches that so the
    // next turn transparently respawns instead of reusing a dead connection
    // and hanging forever (see AcpConnection's `onDispose` callback below,
    // which is the primary way `this.connection` gets cleared — this check
    // is a belt-and-suspenders backstop for any path that missed it).
    if (this.connection?.isAlive()) return this.connection;
    this.connection = undefined;

    const conn: AcpConnection = new AcpConnection(spec, this.cli, enrich, () => {
      // Self-healing lazy respawn: notified whenever THIS connection disposes
      // (idle TTL, explicit teardown, or the child process exiting/crashing
      // on its own) so the next getOrCreateConnection() call spawns fresh
      // instead of returning a connection nothing will ever answer on.
      if (this.connection === conn) this.connection = undefined;
    });
    const { loadSession } = await conn.initialize();

    // Decision 6 reconnect id: prefer `acpSessionId` (Option B — the id
    // `session/load` actually understands) and fall back to `agentChatId`
    // (Option A, where the two id spaces coincide so it's ALSO the right
    // value). Never the other way around — using a native-only Option B id
    // for `session/load` would ask the adapter to load an id it never minted.
    const priorAcpId = this.session.acpSessionId ?? this.session.agentChatId;
    let usedFreshSession = true;
    if (loadSession && priorAcpId) {
      try {
        await conn.loadSession(this.cwd, priorAcpId);
        usedFreshSession = false;
      } catch (err) {
        if (!(err instanceof SessionLoadFailed)) throw err;
        const ev = this.newEvent("status", {
          text: "resumed with a fresh agent session — prior context may not be visible to the CLI",
        });
        this.persist(ev);
        this.stream.emitMessage(ev);
      }
    }
    if (usedFreshSession) {
      const acpSessionId = await conn.newSession(this.cwd);
      // Decision 6 Option B: persist the ACP id separately so a LATER
      // reconnect's `session/load` uses it (never `agentChatId`, which stays
      // native-only for this plugin). Option A plugins persist their id via
      // the synthetic `session_init` NormalizedEvent their `runTurn` yields
      // instead (mirrors a legacy plugin's own session_init line) — that
      // path writes `agentChatId` directly and never touches this column, so
      // it is safe to ALSO opportunistically record it here: harmless for
      // Option A (never read back, since `agentChatId` already equals it),
      // necessary for Option B (the only place this id is captured at all).
      await this.persistAcpSessionId(acpSessionId);
    }
    this.connection = conn;
    this.connectionFirstTurnPending = true;
    conn.outOfBandSink = this.handleOutOfBandEvent.bind(this);
    return conn;
  }

  /**
   * Decision 6 Option B call site: called once per connection, at the
   * `result` event of that connection's FIRST turn (never earlier — see the
   * field doc comment). `null` is a normal outcome, not an error. Write-once:
   * never overwrites an `agentChatId` already captured by the terminal path.
   */
  private async maybeCaptureNativeChatId(): Promise<void> {
    if (!this.connectionFirstTurnPending) return;
    this.connectionFirstTurnPending = false;
    const acpSessionId = this.connection?.currentSessionId;
    if (!acpSessionId || !this.plugin.captureNativeChatId) return;
    if (this.session.agentChatId) return; // write-once — terminal path already set it
    const captured = await this.plugin.captureNativeChatId({
      session: this.session,
      project: this.project,
      cwd: this.cwd,
      acpSessionId,
    });
    if (captured) {
      this.session.agentChatId = captured;
      await this.persistChatId(captured);
    }
  }

  /**
   * Decision 6 Option B storage — persist `sessions.acpSessionId` (twin of
   * `persistChatId`, same mutateProject shape). Read back only by
   * `getOrCreateConnection`'s reconnect `session/load` call — never by
   * `getRestoreCommand`/importers/launch argv, which stay on `agentChatId`.
   */
  private async persistAcpSessionId(acpSessionId: string): Promise<void> {
    if (this.session.acpSessionId === acpSessionId) return; // already current
    this.session.acpSessionId = acpSessionId;
    const worktreeId = this.worktree?.id;
    await mutateProject(this.project.id, (p) => {
      if (worktreeId) {
        return {
          ...p,
          worktrees: p.worktrees.map((w) =>
            w.id === worktreeId
              ? {
                  ...w,
                  sessions: w.sessions.map((s) =>
                    s.id === this.session.id ? { ...s, acpSessionId } : s,
                  ),
                }
              : w,
          ),
        };
      }
      return {
        ...p,
        directSessions: p.directSessions.map((s) =>
          s.id === this.session.id ? { ...s, acpSessionId } : s,
        ),
      };
    });
  }

  /**
   * Routes out-of-band ACP events (task notifications sent by the agent outside
   * of an active session/prompt turn) through the same persist+broadcast pipeline
   * as normal turn events. Does NOT call updateTurnState to avoid spurious
   * lifecycle transitions.
   */
  private handleOutOfBandEvent(ev: NormalizedEvent): void {
    if (this.released) return;
    // Mint a burst-stable turnId shared by every event of one notification
    // burst. There is no end-of-burst marker to key off: `session/update`
    // never normalizes to a `result`/`error` event (see normalizeSessionUpdate
    // — only text/thinking/tool_*/status/mode/commands kinds exist), so a
    // burst is closed by a long quiet gap, or by a real turn starting
    // (`runOneTurn` clears the id). Without that, every notification for the
    // whole life of the session would collapse into one endless turn.
    const now = Date.now();
    if (!this.outOfBandTurnId || now - this.outOfBandLastAt > OUT_OF_BAND_BURST_GAP_MS) {
      this.outOfBandTurnId = `notif-${randomUUID()}`;
    }
    this.outOfBandLastAt = now;
    ev.turnId = this.outOfBandTurnId;
    capToolResultContent(ev);
    this.persist(ev);
    this.stream.emitMessage(ev);
  }

  private async handleEvent(ev: NormalizedEvent): Promise<void> {
    // Capture the harness chat id once, from turn-1 session_init (Decision 10).
    if (ev.kind === "session_init") {
      if (ev.model) this.model = ev.model;
      // Capture the harness chat id: first time (normal turn), OR when this is a
      // fork turn — `--fork-session` mints a NEW id we must adopt so subsequent
      // turns resume the FORKED branch, not the original (R3.2).
      if (ev.agentChatId && ev.agentChatId !== this.session.agentChatId) {
        if (!this.session.agentChatId || this.activeForkFromChatId) {
          this.session.agentChatId = ev.agentChatId;
          await this.persistChatId(ev.agentChatId);
        }
      }
    }
    if (ev.model) this.model = ev.model;
    // A turn with no model call (a claude slash command like /model or /cost)
    // reports usage with totalTokens 0. Don't let that clobber the running
    // token count — keep the last real usage instead.
    if (hasRealUsage(ev.usage)) this.usage = ev.usage;

    capToolResultContent(ev);
    this.persist(ev);
    this.stream.emitMessage(ev);
    this.updateTurnState(ev.kind);
    this.emitMeta();
  }

  private newEvent(kind: NormalizedEventKind, extra: Partial<NormalizedEvent>): NormalizedEvent {
    return {
      id: randomUUID(),
      sessionId: this.session.id,
      ts: new Date().toISOString(),
      provider: this.cli,
      kind,
      ...extra,
    };
  }

  private ensureDataDir(): void {
    mkdirSync(this.dataDir, { recursive: true });
  }

  private persist(ev: NormalizedEvent): void {
    // The store handle is closed once released — a straggler event from the
    // unwinding turn would throw against a closed database.
    if (this.released) return;
    // Append-only through the store; assigns + stamps the durable `logSeq`
    // synchronously before the WS send (N3).
    this.store.append(ev);
  }

  private hasPersistedTurn(): boolean {
    return this.store.count() > 0;
  }

  private updateTurnState(kind: NormalizedEventKind): void {
    switch (kind) {
      case "thinking":
        this.setTurnState("thinking");
        break;
      case "text":
        this.setTurnState("responding");
        break;
      case "tool_use":
        this.setTurnState("tool");
        break;
      case "result":
        this.setTurnState("idle");
        break;
      case "error":
        this.setTurnState("error");
        break;
      default:
        // session_init / tool_result / usage / user / status — no transition
        break;
    }
  }

  private setTurnState(state: TurnState): void {
    this.turnState = state;
  }

  private emitMeta(): void {
    this.stream.emitMeta(this.getMeta());
  }

  private async persistChatId(chatId: string): Promise<void> {
    const worktreeId = this.worktree?.id;
    await mutateProject(this.project.id, (p) => {
      if (worktreeId) {
        return {
          ...p,
          worktrees: p.worktrees.map((w) =>
            w.id === worktreeId
              ? {
                  ...w,
                  sessions: w.sessions.map((s) =>
                    s.id === this.session.id ? { ...s, agentChatId: chatId } : s,
                  ),
                }
              : w,
          ),
        };
      }
      return {
        ...p,
        directSessions: p.directSessions.map((s) =>
          s.id === this.session.id ? { ...s, agentChatId: chatId } : s,
        ),
      };
    });
  }

  /** Persist (or clear) the per-session model override on the SessionRecord. */
  private async persistModelOverride(override: string | null): Promise<void> {
    const worktreeId = this.worktree?.id;
    const apply = (s: SessionRecord): SessionRecord => {
      if (override) return { ...s, modelOverride: override };
      // Clear: drop the field entirely (mirrors the pinnedAt unpin pattern).
      const { modelOverride: _drop, ...rest } = s;
      return rest;
    };
    // Keep the in-memory session in sync so a later turn / restart reads it.
    this.session.modelOverride = override ?? undefined;
    await mutateProject(this.project.id, (p) => {
      if (worktreeId) {
        return {
          ...p,
          worktrees: p.worktrees.map((w) =>
            w.id === worktreeId
              ? { ...w, sessions: w.sessions.map((s) => (s.id === this.session.id ? apply(s) : s)) }
              : w,
          ),
        };
      }
      return {
        ...p,
        directSessions: p.directSessions.map((s) => (s.id === this.session.id ? apply(s) : s)),
      };
    });
  }
}

/**
 * Get (or lazily create + register) the JsonAgentSession for a session.
 * Registered on first turn (Decision 2) and reused for later turns.
 */
export function getOrCreateJsonAgentSession(opts: JsonAgentSessionOptions): JsonAgentSession {
  const existing = jsonAgentRegistry.get(opts.session.id);
  if (existing) return existing;
  const created = new JsonAgentSession(opts);
  jsonAgentRegistry.set(opts.session.id, created);
  return created;
}

/**
 * Read a session's full transcript from disk via the store (no live session).
 * Opens the per-session SQLite store — migrating a legacy `messages.jsonl` on
 * first open — and returns everything. Returns `[]` (and creates nothing) when
 * neither the DB nor a legacy transcript exists yet.
 */
export function readTranscriptFromDataDir(dataDir: string, sessionId: string): NormalizedEvent[] {
  return withDiskStore(dataDir, sessionId, (store) => store.readAll(), []);
}

/** Bounded tail-N turns page from disk (no live session). */
export function readTailFromDataDir(dataDir: string, sessionId: string, nTurns: number): TranscriptPage {
  return withDiskStore(dataDir, sessionId, (store) => store.tail(nTurns), { events: [], hasMore: false });
}

/** Keyset "load earlier" page from disk (no live session). */
export function readPageBeforeFromDataDir(
  dataDir: string,
  sessionId: string,
  beforeSeq: number,
  limit: number,
): TranscriptPage {
  return withDiskStore(dataDir, sessionId, (store) => store.pageBefore(beforeSeq, limit), {
    events: [],
    hasMore: false,
  });
}

/** Reconnect delta from disk (no live session). */
export function readSinceFromDataDir(dataDir: string, sessionId: string, sinceSeq: number): NormalizedEvent[] {
  return withDiskStore(dataDir, sessionId, (store) => store.since(sinceSeq), []);
}

/** Bounded last model + last real usage from disk (R2.6 — no full read). */
export function readMetaFromDataDir(dataDir: string, sessionId: string): TranscriptMeta {
  return withDiskStore(dataDir, sessionId, (store) => store.lastMeta(), {});
}

/**
 * Open the per-session store from disk, run `fn`, and close it. Returns
 * `fallback` (creating nothing) when neither a DB nor a legacy transcript
 * exists yet.
 */
function withDiskStore<T>(
  dataDir: string,
  sessionId: string,
  fn: (store: ReturnType<typeof openSqliteTranscriptStore>) => T,
  fallback: T,
): T {
  const hasDb = existsSync(transcriptDbPath(dataDir));
  const hasLegacy = existsSync(join(dataDir, "messages.jsonl"));
  if (!hasDb && !hasLegacy) return fallback;
  const store = openSqliteTranscriptStore(dataDir, sessionId);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * Rebuild a `SessionMeta` from a transcript (Decision 8 meta durability) for the
 * case where no live `JsonAgentSession` is registered (e.g. after a restart, or
 * GET /meta on a session that has never taken a turn this process).
 */
export function buildMetaFromTranscript(opts: {
  sessionId: string;
  cli: string;
  modeId?: string;
  modeName?: string;
  model?: string;
  /** When set, wins over the transcript's observed model (a live switch is what
   *  the next turn will spawn with — see JsonAgentSession.setModel). */
  modelOverride?: string;
  events: NormalizedEvent[];
}): SessionMeta {
  let model = opts.model;
  let usage: UsageInfo | undefined;
  for (const ev of opts.events) {
    if (ev.model) model = ev.model;
    if (hasRealUsage(ev.usage)) usage = ev.usage;
  }
  return assembleMeta(opts, { ...(model ? { model } : {}), ...(usage ? { usage } : {}) });
}

/**
 * Assemble a `SessionMeta` from a bounded `TranscriptMeta` (last model + last
 * real usage), for the restart-durable no-live-session path (R2.6). Avoids the
 * whole-transcript read `buildMetaFromTranscript` needs — the store's
 * `lastMeta()` resolves both via a bounded reverse scan.
 */
export function buildMetaFromStoreMeta(opts: {
  sessionId: string;
  cli: string;
  modeId?: string;
  modeName?: string;
  modelOverride?: string;
  cwd?: string;
  meta: TranscriptMeta;
}): SessionMeta {
  return assembleMeta(opts, opts.meta);
}

/** Shared idle-meta assembly: apply the model override, then build the record. */
function assembleMeta(
  opts: { sessionId: string; cli: string; modeId?: string; modeName?: string; modelOverride?: string; cwd?: string },
  found: TranscriptMeta,
): SessionMeta {
  const model = opts.modelOverride ?? found.model;
  return {
    sessionId: opts.sessionId,
    channel: "json",
    ...(opts.modeId ? { modeId: opts.modeId } : {}),
    ...(opts.modeName ? { modeName: opts.modeName } : {}),
    cli: opts.cli,
    ...(model ? { model } : {}),
    turnState: "idle",
    queueDepth: 0,
    queuedTurnIds: [],
    editingTurnIds: [],
    ...(found.usage ? { usage: found.usage } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  };
}
