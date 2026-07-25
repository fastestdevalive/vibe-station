# Plan: make "Send now" preemptive

**Decision:** "Send now" on a queued turn (1) moves it to queue front, (2) aborts the running turn like Stop — the aborted turn is DROPPED, not re-queued — so the promoted turn runs next immediately.

## Daemon — orchestrate INSIDE `promoteQueuedTurn` (jsonAgent.ts:479)
Reorder MUST precede abort (drain dequeues the now-front turn once the aborted one unwinds).
```ts
promoteQueuedTurn(turnId: string): "ok" | "not_queued" {
  const index = this.queue.findIndex((t) => t.turnId === turnId);
  if (index < 0) return "not_queued";
  if (index > 0) {
    const turn = this.queue.splice(index, 1)[0]!;
    this.queue.unshift(turn);
    this.emitMeta();
  }
  // Preemptive: abort active turn (like Stop; aborted turn DROPPED, not re-queued)
  // so the promoted turn runs next. Reorder above MUST precede this abort.
  // No-op when idle (stopActiveTurn returns false with nothing running).
  this.stopActiveTurn();
  this.kickDrain(); // defensive: ensures reordered queue drains if nothing was active
  return "ok";
}
```
- Abort is OUTSIDE the `index>0` guard (send-now on the already-front turn still preempts).
- `stopActiveTurn` (:377) kills PIDs + `activeAbort.abort()`, does NOT touch `this.queue` → queued turns survive. Returns false when idle.
- drain (:536)/runOneTurn (:568): after abort the `for await` breaks (:617), `finally` emits "Turn stopped" via `emitStopped` (:639,646) when no result, then `while (queue.length>0)` shifts the promoted (front) turn.
- Update stale "nothing interrupted" comments: `promoteQueuedTurn` doc (:474-477) + route comment (`sessions.ts:1085`).

## Edge cases
- Promoted == active: impossible (running turn already `shift()`ed out of queue; `findIndex` can't match).
- Abort races natural completion: benign (stopActiveTurn returns false or races after `sawResult`; no double-run).
- Dropped turn: keeps partial events + "Turn stopped" marker (identical to Stop; no FE work).
- Aborting turn 1 (system prompt): `firstTurnDone` stays false → promoted turn carries the system prompt (correct, matches existing design).
- `--resume` CLI aborted mid-write: touches native session state exactly as Stop already does (accepted; note in commit).

## FE
- `useChat.sendNow` (useChat.ts:206): NO change (preemption is server-side).
- `QueuedTray.tsx:134-135`: update `title` → `"Send now (interrupts the current turn)"`. KEEP `aria-label="Send now"` (tests query it; still accurate). Resolves the deferred label question.
- No optimistic UI — let the meta stream drive spinner/tray/new-turn.

## Tests
Daemon (`jsonChatQueue.test.ts`, `makeGatePlugin` harness):
- send-now preempts: enqueue A,B,C; A running; `promoteQueuedTurn(c)`; next started is C not B; `started===["A","C"]`; after settle `["A","C","B"]`, A once; transcript has "Turn stopped" for A, no error event.
- send-now on only queued turn still preempts (index===0 path): enqueue A,B; A running; promote B; A aborted, `started===["A","B"]`, "Turn stopped" for A.
- send-now jumps ahead + preempts: enqueue A,B,C,D; A running; promote D; `started===["A","D","B","C"]`.
- (weak/optional) idle no-op-abort: spy `stopActiveTurn` false; drop if timing-flaky, rely on defensive `kickDrain` + comment.

FE:
- `QueuedTray.test.tsx`: assert Send-now button `title` matches `/interrupt/i`; keep existing click test.
- `useChat.test.ts`: existing sendNow→promoteQueuedTurn test stays green unchanged.

## Commit
Single commit: `promoteQueuedTurn` body + comments (jsonAgent.ts), route comment (sessions.ts), QueuedTray tooltip, daemon + FE tests. Message notes: aborted turn DROPPED not re-queued; aborting `--resume` CLI mid-turn touches native state as Stop does.

## Risks to flag
- Destructive, no undo — clicking Send now kills an expensive in-progress turn, discards partial work. Tooltip is the only warning. (Out of scope: confirm affordance / re-queue-undo.)
- Idle-case test hard to make deterministic → prefer defensive code + comment over a flaky test.
- Semantics change vs old "harmless jump-the-queue" mental model → stale A8 comments must be removed.
