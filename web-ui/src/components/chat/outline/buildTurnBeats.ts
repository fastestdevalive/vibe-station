/**
 * Pure functions for building beats (sub-turn outline nodes) from chat RenderItems.
 * Pure: no DOM, no Date, no random, no module state.
 */
import type { RenderItem } from "../MessageList";
import {
  extractTodos,
  isTaskName,
  isTodoToolName,
  type ToolCallEntry,
} from "../toolFormat";

export type BeatKind = "ask" | "error" | "break" | "commit" | "subagent" | "todo" | "text";

export interface Beat {
  key: string;        // stable id: the tool entry's id (= its tool_use id) or the item's id
  anchor: string;     // MessageNav anchor: `t:${entry.id}` (tool), `a:${item.id}` (text), `i:${item.id}` (error / status / system_event / session_break)
  kind: BeatKind;
  label: string;      // first line, trimmed, <= 60 chars; WITHOUT the "+N" suffix
  count: number;      // >= 1; shown suffix is count - 1
  ts?: string;        // the source event's timestamp (first one, for a merged beat)
  tsEnd?: string;     // a merged beat's last absorbed timestamp
}

export type RawBeat = Beat & { ord: number }; // ord = private walk ordinal; never leaves this file's callers

export const BEAT_CAP = 12;
const BEAT_LABEL_MAX = 60;

const BEAT_PRIORITY: Record<BeatKind, number> = {
  ask: 7,
  error: 6,
  break: 5,
  commit: 3,
  subagent: 2,
  todo: 2,
  text: 1,
};

function formatBeatLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length > BEAT_LABEL_MAX) {
    return collapsed.slice(0, BEAT_LABEL_MAX - 1) + "…";
  }
  return collapsed;
}

export function beatSpokenLabel(b: Beat): string {
  let prefix: string;
  switch (b.kind) {
    case "ask":
      prefix = "Asked";
      break;
    case "error":
      prefix = "Error";
      break;
    case "break":
      prefix = "Break";
      break;
    case "commit":
      if (b.label.startsWith("Opened PR")) {
        prefix = "Pull request";
      } else if (b.label.startsWith("Pushed")) {
        prefix = "Push";
      } else {
        prefix = "Commit";
      }
      break;
    case "subagent":
      prefix = "Subagent";
      break;
    case "todo": {
      prefix = "Todo done";
      const cleaned = b.label.startsWith("Done: ") ? b.label.slice(6) : b.label;
      const body = cleaned.startsWith(prefix) ? cleaned : `${prefix}: ${cleaned}`;
      return b.count > 1 ? `${body}, and ${b.count - 1} more` : body;
    }
    case "text":
      prefix = "Agent said";
      break;
  }

  const body = b.label.startsWith(prefix) ? b.label : `${prefix}: ${b.label}`;
  return b.count > 1 ? `${body}, and ${b.count - 1} more` : body;
}

function tsOf(ts: string | undefined): { ts?: string } {
  return ts ? { ts } : {};
}

/** Folds one more event into an open burst beat: the count grows and its end time moves. */
function absorbInto(beat: RawBeat, ts: string | undefined): void {
  beat.count++;
  if (ts) beat.tsEnd = ts;
}

interface GapEntry {
  gap: number;
  idx: number;
}

/** Min-heap over (gap, idx): the smallest gap wins, ties go to the lower index. */
function heapLess(a: GapEntry, b: GapEntry): boolean {
  return a.gap !== b.gap ? a.gap < b.gap : a.idx < b.idx;
}

function heapPush(heap: GapEntry[], gap: number, idx: number): void {
  let i = heap.length;
  heap.push({ gap, idx });
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[parent]!)) break;
    [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
    i = parent;
  }
}

function heapPop(heap: GapEntry[]): GapEntry | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined || heap.length === 0) return top;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const l = i * 2 + 1;
    const r = l + 1;
    let best = i;
    if (l < heap.length && heapLess(heap[l]!, heap[best]!)) best = l;
    if (r < heap.length && heapLess(heap[r]!, heap[best]!)) best = r;
    if (best === i) break;
    [heap[i], heap[best]] = [heap[best]!, heap[i]!];
    i = best;
  }
  return top;
}

/**
 * Merges the closest (by `ord` gap) adjacent beats until at most `cap` remain,
 * preferring pairs that touch no protected kind (ask / error / break).
 * O(n log n): a lazy min-heap over adjacent gaps on a linked list, instead of
 * rescanning every pair on every merge.
 */
export function mergeBeats(beats: RawBeat[], cap: number = BEAT_CAP): RawBeat[] {
  if (beats.length <= cap) {
    return beats.map((b) => ({ ...b }));
  }
  const list = beats.map((b) => ({ ...b }));
  const n = list.length;
  const protectedKinds = new Set<BeatKind>(["ask", "error", "break"]);

  // A merged pair keeps the left slot and drops the right one; `next` walks the live chain.
  const next = new Array<number>(n);
  for (let i = 0; i < n - 1; i++) next[i] = i + 1;
  next[n - 1] = -1;
  const alive = new Array<boolean>(n).fill(true);
  let size = n;
  /** Set once no adjacent pair avoids a protected kind; merges then ignore kinds. */
  let allowAll = false;

  const gapAt = (i: number): number => list[next[i]!]!.ord - list[i]!.ord;
  const heap: GapEntry[] = [];
  const pushPair = (i: number): void => {
    if (next[i]! !== -1) heapPush(heap, gapAt(i), i);
  };
  for (let i = 0; i < n - 1; i++) pushPair(i);

  while (size > cap) {
    let pick: GapEntry | undefined;
    for (;;) {
      const e = heapPop(heap);
      if (!e) break;
      const j = next[e.idx]!;
      if (j === -1 || !alive[e.idx] || !alive[j] || e.gap !== gapAt(e.idx)) continue;
      if (!allowAll && (protectedKinds.has(list[e.idx]!.kind) || protectedKinds.has(list[j]!.kind))) {
        continue;
      }
      pick = e;
      break;
    }
    if (!pick) {
      if (allowAll) break;
      // Nothing mergeable under the protected rule: consider every adjacent pair.
      allowAll = true;
      for (let i = 0; i < n; i++) if (alive[i] && next[i] !== -1) pushPair(i);
      continue;
    }

    const i = pick.idx;
    const j = next[i]!;
    const b1 = list[i]!;
    const b2 = list[j]!;
    const kind = BEAT_PRIORITY[b1.kind] >= BEAT_PRIORITY[b2.kind] ? b1.kind : b2.kind;
    const end = b2.tsEnd ?? b2.ts;
    const merged: RawBeat = {
      ...b1,
      kind,
      count: b1.count + b2.count,
      ...(end ? { tsEnd: end } : {}),
    };
    list[i] = merged;
    alive[j] = false;
    next[i] = next[j]!;
    size--;
    pushPair(i);
  }

  return list.filter((_, i) => alive[i]!);
}

interface ToolBeatContext {
  ord: number;
  doneBefore: ReadonlySet<string>;
  updateDoneBefore: (set: ReadonlySet<string>) => void;
}

type ToolBeatRule = (entry: ToolCallEntry, ctx: ToolBeatContext) => RawBeat | null;

function entryState(entry: ToolCallEntry): "failed" | "settled-ok" | "pending" {
  if (entry.result?.isError === true || entry.status === "failed") {
    return "failed";
  }
  if (entry.result !== undefined || entry.status === "completed") {
    return "settled-ok";
  }
  return "pending";
}

function beat(
  kind: BeatKind,
  anchor: string,
  key: string,
  label: string,
  ctx: { ord: number } | number,
  ts?: string,
  count = 1,
): RawBeat {
  const ord = typeof ctx === "number" ? ctx : ctx.ord;
  return {
    key,
    anchor,
    kind,
    label: formatBeatLabel(label),
    count,
    ord,
    ...tsOf(ts),
  };
}

function askBeat(entry: ToolCallEntry, ctx: ToolBeatContext): RawBeat | null {
  const normName = (entry.toolName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normName !== "askuserquestion" && normName !== "exitplanmode") {
    return null;
  }
  const inp = entry.toolInput as Record<string, unknown> | undefined;
  let q: string | undefined;
  if (inp && typeof inp === "object") {
    if (Array.isArray(inp.questions) && inp.questions[0]?.question) {
      q = String(inp.questions[0].question);
    } else if (typeof inp.question === "string" && inp.question) {
      q = inp.question;
    } else if (typeof inp.plan === "string" && inp.plan) {
      const firstLine = inp.plan.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (firstLine) q = firstLine;
    }
  }
  const label = q ? `Asked: ${q}` : "Asked";
  return beat("ask", `t:${entry.id}`, entry.id, label, ctx, entry.ts);
}

function errorBeat(entry: ToolCallEntry, ctx: ToolBeatContext): RawBeat | null {
  if (entryState(entry) !== "failed") {
    return null;
  }
  const firstLine = entry.result?.content
    ? entry.result.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== "" && !/^(`{2,}|~{3,})[\w-]*$/.test(l))
    : undefined;
  const label = firstLine
    ? `${entry.toolName} failed: ${firstLine}`
    : `${entry.toolName} failed`;
  return beat("error", `t:${entry.id}`, entry.id, label, ctx, entry.ts);
}

function todoBeat(entry: ToolCallEntry, ctx: ToolBeatContext): RawBeat | null {
  if (!isTodoToolName(entry.toolName)) {
    return null;
  }
  const todos = extractTodos(entry.toolName, entry.toolInput, entry.result?.content) ?? [];
  const done = todos.filter((t) => t.state === "done").map((t) => t.text);
  const fresh = done.filter((t) => !ctx.doneBefore.has(t));
  ctx.updateDoneBefore(new Set(done));

  if (fresh.length === 0) {
    return null;
  }

  return beat("todo", `t:${entry.id}`, entry.id, `Done: ${fresh[0]}`, ctx, entry.ts, fresh.length);
}

function commitBeat(entry: ToolCallEntry, ctx: ToolBeatContext): RawBeat | null {
  if (entry.toolKind !== "execute") {
    return null;
  }
  const rawCmd = (entry.toolInput as Record<string, unknown> | undefined)?.command;
  const cmd = Array.isArray(rawCmd)
    ? rawCmd.join(" ")
    : typeof rawCmd === "string"
    ? rawCmd
    : "";

  if (/\bgit\s+commit\b/.test(cmd)) {
    let subject: string | undefined;
    // Look for heredoc: $(cat <<...
    const heredocIdx = cmd.search(/\$\(cat\s*<</);
    if (heredocIdx !== -1) {
      const lines = cmd.split(/\r?\n/);
      const lineWithHeredoc = lines.findIndex((l) => /\$\(cat\s*<</.test(l));
      if (lineWithHeredoc !== -1) {
        subject = lines.slice(lineWithHeredoc + 1).map((l) => l.trim()).find(Boolean);
      }
    }
    if (!subject) {
      // `-m "msg"`, or the message flag at the end of a short-flag cluster (`-am "msg"`).
      const m = /(?:^|\s)-[a-zA-Z]*m\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(cmd);
      if (m) {
        const val = m[1] ?? m[2] ?? m[3];
        if (val && !val.startsWith("$(cat")) {
          subject = val;
        }
      }
    }
    const label = subject ? `Commit: ${subject}` : "Commit";
    return beat("commit", `t:${entry.id}`, entry.id, label, ctx, entry.ts);
  }

  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const prMatch = entry.result?.content?.match(/\/pull\/(\d+)/);
    const label = prMatch ? `Opened PR #${prMatch[1]}` : "Opened PR";
    return beat("commit", `t:${entry.id}`, entry.id, label, ctx, entry.ts);
  }

  if (/\bgit\s+push\b/.test(cmd)) {
    const pushIdx = cmd.search(/\bgit\s+push\b/);
    // Only the push's own arguments: stop at the first shell operator or redirect.
    const after = cmd.slice(pushIdx + "git push".length).split(/(?:^|\s)\d*[<>]|&&|\|\||[;|&]/)[0]!;
    const tokens = after.trim().split(/\s+/).filter(Boolean);
    const nonFlags = tokens.filter((tok) => !tok.startsWith("-"));
    let branch: string | undefined;
    if (nonFlags.length >= 2) {
      const ref = nonFlags[1]!.replace(/^HEAD:/, "");
      if (ref && ref !== "HEAD") branch = ref;
    }
    const label = branch ? `Pushed ${branch}` : "Pushed";
    return beat("commit", `t:${entry.id}`, entry.id, label, ctx, entry.ts);
  }

  return null;
}

function subagentBeat(entry: ToolCallEntry, ctx: ToolBeatContext): RawBeat | null {
  const hasChildren = (entry.children?.length ?? 0) > 0;
  const isTask = isTaskName(entry.toolName);
  if (!hasChildren && !isTask) {
    return null;
  }
  const inp = entry.toolInput as Record<string, unknown> | undefined;
  let desc: string | undefined;
  if (inp && typeof inp === "object") {
    if (typeof inp.description === "string" && inp.description.trim()) {
      desc = inp.description.trim();
    } else if (typeof inp.prompt === "string" && inp.prompt.trim()) {
      desc = inp.prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    }
  }
  if (!desc) {
    desc = entry.toolName;
  }
  const isSettled = entryState(entry) === "settled-ok";
  const label = `Subagent: ${desc}` + (isSettled ? " · done" : "");
  return beat("subagent", `t:${entry.id}`, entry.id, label, ctx, entry.ts);
}

const TOOL_BEAT_RULES: ToolBeatRule[] = [
  askBeat,
  errorBeat,
  todoBeat,
  commitBeat,
  subagentBeat,
];

export function buildTurnBeats(
  items: RenderItem[],
  start: number,
  end: number,
  doneBefore: ReadonlySet<string>,
): { beats: Beat[]; doneAfter: ReadonlySet<string> } {
  const rawBeats: RawBeat[] = [];
  let ord = 0;
  let currentDone = doneBefore;
  let openErrorBeat: RawBeat | null = null;

  for (let i = start; i < end; i++) {
    ord++;
    const item = items[i]!;

    if (item.type === "tool") {
      ord++;
      processEntry(item, ord);
    } else if (item.type === "toolRun") {
      for (const t of item.tools) {
        ord++;
        processEntry(t, ord);
      }
    } else if (item.type === "error") {
      // error item always yields error beat
      if (openErrorBeat) {
        absorbInto(openErrorBeat, item.ts);
      } else {
        const b = beat("error", `i:${item.id}`, item.id, item.text ?? "", ord, item.ts);
        rawBeats.push(b);
        openErrorBeat = b;
      }
    } else if (item.type === "assistant") {
      // settled-ok or assistant item closes an error burst
      openErrorBeat = null;

      // Check text beat: previous item in [start, end), skipping thinking, is tool or toolRun
      let prevIdx = i - 1;
      while (prevIdx >= start && items[prevIdx]?.type === "thinking") {
        prevIdx--;
      }
      if (prevIdx >= start && (items[prevIdx]?.type === "tool" || items[prevIdx]?.type === "toolRun")) {
        const lines = (item.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          const rawLine = lines[0]!
            .replace(/^\s*(?:[#>]+|[-*])\s+/, "")
            .replace(/[`*]/g, "")
            .trim();
          if (rawLine) {
            rawBeats.push(beat("text", `a:${item.id}`, item.id, rawLine, ord, item.ts));
          }
        }
      }
    } else if (item.type === "session_break") {
      // check if followed by assistant / tool / toolRun / error in [start, end)
      let followed = false;
      for (let j = i + 1; j < end; j++) {
        const nextType = items[j]!.type;
        if (nextType === "assistant" || nextType === "tool" || nextType === "toolRun" || nextType === "error") {
          followed = true;
          break;
        }
      }
      if (followed) {
        let label = "Fresh start";
        if (item.kind === "switch") {
          const target = item.toMode ?? item.toProvider;
          if (target) {
            label = `Switched to ${target}`;
          }
        }
        rawBeats.push(beat("break", `i:${item.id}`, item.id, label, ord, item.ts));
      }
    } else if (item.type === "status") {
      if (/\bcompact/i.test(item.text ?? "")) {
        rawBeats.push(beat("break", `i:${item.id}`, item.id, "Context compacted", ord, item.ts));
      }
    } else if (item.type === "system_event") {
      if (item.agentName) {
        rawBeats.push(beat("subagent", `i:${item.id}`, item.id, `${item.agentName}: ${item.text}`, ord, item.ts));
      }
    }
  }

  function processEntry(entry: ToolCallEntry, entryOrd: number): void {
    const state = entryState(entry);

    if (state === "settled-ok") {
      openErrorBeat = null;
    }

    const ctx: ToolBeatContext = {
      ord: entryOrd,
      doneBefore: currentDone,
      updateDoneBefore: (set) => {
        currentDone = set;
      },
    };

    for (const rule of TOOL_BEAT_RULES) {
      const beat = rule(entry, ctx);
      if (beat) {
        if (beat.kind === "error") {
          if (openErrorBeat) {
            absorbInto(openErrorBeat, beat.ts);
          } else {
            rawBeats.push(beat);
            openErrorBeat = beat;
          }
        } else {
          rawBeats.push(beat);
        }
        break; // first matching rule wins
      }
    }
  }

  const merged = mergeBeats(rawBeats, BEAT_CAP);
  // strip ord
  const beats: Beat[] = merged.map(({ ord: _, ...b }) => b);

  return { beats, doneAfter: currentDone };
}
