import type { RenderItem } from "../MessageList";
import { renderDraftText } from "@/lib/mentions";
import { isOutlineWriteTool } from "@/lib/transcriptOutline";
import type { TranscriptOutlineTurn } from "@/api/types";
import type { OutlineSummaryState } from "@/hooks/useTranscriptOutline";
import type { ToolCallEntry } from "../toolFormat";
import { buildTurnBeats, type Beat } from "./buildTurnBeats";

export interface TurnNode {
  key: string;
  anchor: string;
  /** Position in the whole chat: `turnsBefore` plus the turn's place among the loaded turns. */
  index: number;
  /** The turn's `turnId` (`seq:<n>` for a legacy window turn); empty on a placeholder. */
  turnKey: string;
  number: number | null;
  label: string;
  ts?: string;
  edits: number;
  errors: number;
  review?: { count: number; name: string };
  live: boolean;
  breakBefore: boolean;
  cancelled: boolean;
  beats: Beat[];
  /** A turn whose events are not in the chat window (its key is `n:<index>`). */
  unloaded?: boolean;
  /** An unloaded turn whose window has not landed: a placeholder row with no label. */
  skeleton?: boolean;
  /** First seq of the turn: set on a persisted loaded turn and on an unloaded turn whose window landed. */
  seq?: number;
  /** Tool calls of an unloaded turn. */
  tools?: number;
}

/** Beats of one turn, cached so a streaming delta rebuilds only the live turn. */
interface OutlineCacheEntry {
  /** Fingerprint of the turn's items; any change rebuilds its beats. */
  sig: string;
  /** The todo-done set its beats were built from; a change upstream rebuilds it too. */
  doneKey: string;
  beats: Beat[];
  doneAfter: ReadonlySet<string>;
  /** The node last built for the turn, reused while an identical one is built again. */
  node: TurnNode;
}

/** Per-pane memo for `buildTurnOutline`; create one per chat pane (`createOutlineCache`). */
export interface OutlineCache {
  /** `turnsBefore|activeTurnId`: both feed the nodes, so a change invalidates every entry. */
  optsKey: string;
  turns: Map<string, OutlineCacheEntry>;
}

export function createOutlineCache(): OutlineCache {
  return { optsKey: "", turns: new Map() };
}

function mix(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) | 0;
  return h;
}

/** The head of a text: labels are cut to 60 chars, so this catches an edited line. */
const head = (text: string): string => (text.length > 64 ? text.slice(0, 64) : text);

function toolSig(h: number, t: ToolCallEntry): number {
  h = mix(h, t.id);
  h = mix(h, t.toolName);
  h = mix(h, t.status ?? "");
  h = mix(h, t.result ? `${t.result.isError ? "e" : "o"}${head(t.result.content ?? "")}` : "-");
  return h;
}

/** A cheap fingerprint of a turn's items: enough to notice a settled turn that changed. */
function turnSignature(items: readonly RenderItem[], start: number, end: number): string {
  let h = 5381;
  let textLen = 0;
  for (let i = start; i < end; i++) {
    const it = items[i]!;
    const text = "text" in it && typeof it.text === "string" ? it.text : "";
    textLen += text.length;
    h = mix(h, head(text));
    h = mix(h, it.type);
    h = mix(h, it.id);
    if (it.type === "tool") h = toolSig(h, it);
    else if (it.type === "toolRun") for (const t of it.tools) h = toolSig(h, t);
    else if ("status" in it) h = mix(h, String(it.status ?? ""));
  }
  return `${end - start}:${textLen}:${h}`;
}

const doneKeyOf = (set: ReadonlySet<string>): string => Array.from(set).sort().join("\u0000");

/** Two nodes that read the same everywhere (beats compared by identity: a cached turn reuses them). */
function sameNode(a: TurnNode, b: TurnNode): boolean {
  return (
    a.key === b.key &&
    a.anchor === b.anchor &&
    a.index === b.index &&
    a.turnKey === b.turnKey &&
    a.number === b.number &&
    a.seq === b.seq &&
    a.label === b.label &&
    a.ts === b.ts &&
    a.edits === b.edits &&
    a.errors === b.errors &&
    a.review?.count === b.review?.count &&
    a.review?.name === b.review?.name &&
    a.live === b.live &&
    a.breakBefore === b.breakBefore &&
    a.cancelled === b.cancelled &&
    a.beats === b.beats
  );
}

/**
 * What the chain's geometry and marks read of a node: its anchor, flags, and the beat kinds that earn a mark.
 * Two nodes with the same signature lay out identically, whatever their labels say.
 */
export function nodeShapeSig(n: TurnNode): string {
  let beats = "";
  for (const b of n.beats) beats += b.kind === "error" ? "e" : b.kind === "ask" ? "a" : "s";
  return `${n.anchor}|${n.live ? 1 : 0}${n.errors > 0 ? 1 : 0}${n.review ? 1 : 0}${n.breakBefore ? 1 : 0}|${beats}`;
}

function isErrorTool(result?: { isError?: boolean }, status?: string): boolean {
  return result?.isError === true || status === "failed";
}

export function buildTurnOutline(
  items: RenderItem[],
  opts: { activeTurnId?: string; turnsBefore?: number | null },
  cache?: OutlineCache,
): TurnNode[] {
  const turnsBefore = opts.turnsBefore ?? null;
  const optsKey = `${turnsBefore ?? ""}|${opts.activeTurnId ?? ""}`;
  if (cache && cache.optsKey !== optsKey) {
    cache.optsKey = optsKey;
    cache.turns.clear();
  }

  const nodes: TurnNode[] = [];
  let userIndex = 0;
  let hadBreak = false;
  let doneAfter: ReadonlySet<string> = new Set();

  let openTurn: {
    node: TurnNode;
    /** Position of `node` in `nodes`. */
    at: number;
    start: number;
    key: string;
  } | null = null;

  /** Builds (or reuses) the beats of the turn that just ended, `end` exclusive. */
  const closeTurn = (end: number): void => {
    if (!openTurn) return;
    const sig = turnSignature(items, openTurn.start, end);
    const doneKey = doneKeyOf(doneAfter);
    const cached = cache?.turns.get(openTurn.key);
    if (cached && cached.sig === sig && cached.doneKey === doneKey) {
      openTurn.node.beats = cached.beats;
      doneAfter = cached.doneAfter;
    } else {
      const built = buildTurnBeats(items, openTurn.start, end, doneAfter);
      openTurn.node.beats = built.beats;
      doneAfter = built.doneAfter;
    }
    // An identical node keeps its identity, so the merge and the chain can tell an unchanged turn at a glance.
    if (cached && sameNode(cached.node, openTurn.node)) nodes[openTurn.at] = cached.node;
    cache?.turns.set(openTurn.key, {
      sig,
      doneKey,
      beats: openTurn.node.beats,
      doneAfter,
      node: nodes[openTurn.at]!,
    });
    openTurn = null;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;

    if (it.type === "session_break") {
      hadBreak = true;
      continue;
    }

    if (it.type === "user") {
      closeTurn(i);

      const turnKey = it.turnId ?? it.id;
      const index = (turnsBefore ?? 0) + userIndex;
      userIndex++;

      const plain = renderDraftText(it.text ?? "");
      const lines = plain
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const label = lines[0] ?? "";

      const node: TurnNode = {
        key: turnKey,
        anchor: `u:${turnKey}`,
        index,
        turnKey,
        number: turnsBefore !== null ? index + 1 : null,
        ...(it.seq != null ? { seq: it.seq } : {}),
        label,
        ts: it.ts,
        edits: 0,
        errors: 0,
        ...(it.review
          ? {
              review: {
                count: it.review.comments?.length ?? 0,
                name: it.review.name,
              },
            }
          : {}),
        live: !!opts.activeTurnId && it.turnId === opts.activeTurnId,
        breakBefore: hadBreak,
        cancelled: it.cancelled ?? false,
        beats: [],
      };

      hadBreak = false;
      nodes.push(node);
      openTurn = { node, at: nodes.length - 1, start: i + 1, key: turnKey };
      continue;
    }

    if (!openTurn) continue;

    if (it.type === "error") {
      openTurn.node.errors++;
    } else if (it.type === "tool") {
      if (isErrorTool(it.result, it.status)) {
        openTurn.node.errors++;
      }
      if (isOutlineWriteTool(it.toolName, it.toolKind)) {
        openTurn.node.edits++;
      }
    } else if (it.type === "toolRun") {
      for (const t of it.tools) {
        if (isErrorTool(t.result, t.status)) {
          openTurn.node.errors++;
        }
        if (isOutlineWriteTool(t.toolName, t.toolKind)) {
          openTurn.node.edits++;
        }
      }
    }
  }

  closeTurn(items.length);

  if (cache) {
    // Drop entries for turns no longer loaded (a window swap or a truncated transcript).
    const live = new Set(nodes.map((n) => n.key));
    for (const key of cache.turns.keys()) if (!live.has(key)) cache.turns.delete(key);
  }

  return nodes;
}

/** A chat is worth a chain once it has a few turns, or one long autonomous turn with enough beats. */
export function worthShowingChain(nodes: readonly TurnNode[]): boolean {
  return nodes.length >= 3 || nodes.some((n) => n.beats.length >= 3);
}

/** The counts the unloaded rows are built from (the summary, without its status). */
export type OutlineCounts = Pick<OutlineSummaryState, "totalTurns" | "bucketSize" | "tools" | "edits" | "errors">;

/** The window turn each unloaded node was built from (`null`: a placeholder). */
const sourceOf = new WeakMap<TurnNode, TranscriptOutlineTurn | null>();

/**
 * One unloaded row per turn index of the whole chat. A row whose window turn is
 * cached carries its label and counts; any other is a placeholder whose counts
 * are exact at bucketSize 1, else only a region marker on the first placeholder
 * of a bucket that holds errors. `prev` (any earlier build, even of another summary or active turn) is reused
 * row by row while the row's window turn, flags and counts are unchanged, so a refetch or a grown
 * `totalTurns` only allocates the rows that differ.
 */
export function buildUnloadedNodes(
  summary: OutlineCounts,
  windowTurnAt: (index: number) => TranscriptOutlineTurn | undefined,
  activeTurnId: string | undefined,
  prev?: readonly TurnNode[],
): TurnNode[] {
  const exact = summary.bucketSize === 1;
  const out = new Array<TurnNode>(summary.totalTurns);
  let markedBucket = -1;
  for (let i = 0; i < summary.totalTurns; i++) {
    const w = windowTurnAt(i) ?? null;
    let edits = 0;
    let errors = 0;
    let tools: number | undefined;
    if (w) {
      edits = w.counts.edits;
      errors = w.counts.errors;
      tools = w.counts.tools;
    } else if (exact) {
      edits = summary.edits[i] ?? 0;
      errors = summary.errors[i] ?? 0;
      tools = summary.tools[i] ?? 0;
    } else {
      const bucket = Math.floor(i / summary.bucketSize);
      if ((summary.errors[bucket] ?? 0) > 0 && markedBucket !== bucket) {
        errors = 1;
        markedBucket = bucket;
      }
    }
    const live = w != null && !!activeTurnId && w.turnKey === activeTurnId;
    const p = prev?.[i];
    if (
      p &&
      sourceOf.get(p) === w &&
      p.live === live &&
      p.edits === edits &&
      p.errors === errors &&
      p.tools === tools
    ) {
      out[i] = p;
      continue;
    }
    const key = `n:${i}`;
    const node: TurnNode = w
      ? {
          key,
          anchor: key,
          index: i,
          turnKey: w.turnKey,
          number: i + 1,
          label: w.label,
          ...(w.ts ? { ts: w.ts } : {}),
          edits,
          errors,
          live,
          breakBefore: false,
          cancelled: false,
          beats: [],
          unloaded: true,
          seq: w.seq,
          tools: w.counts.tools,
        }
      : {
          key,
          anchor: key,
          index: i,
          turnKey: "",
          number: i + 1,
          label: "",
          edits,
          errors,
          live,
          breakBefore: false,
          cancelled: false,
          beats: [],
          unloaded: true,
          skeleton: true,
          ...(tools != null ? { tools } : {}),
        };
    sourceOf.set(node, w);
    out[i] = node;
  }
  return out;
}

export interface MergeOpts {
  /** Turns before the chat window: the first persisted loaded turn sits at this index. */
  turnsBefore: number;
  /** Anchor of the loaded row at `seq`, to check a loaded turn against its window turn. */
  seqAnchor: (seq: number) => string | undefined;
  /** Steps fetched for unloaded turns, by turn index. */
  steps?: ReadonlyMap<number, TurnNode>;
}

/** The merged chat, plus the inputs it was built from (so an identical merge returns the same result). */
export interface MergeResult {
  nodes: TurnNode[];
  /** A loaded turn disagreed with its cached window turn: the summary is stale. */
  mismatch: boolean;
  base: readonly TurnNode[];
  loaded: readonly TurnNode[];
  steps: ReadonlyMap<number, TurnNode> | undefined;
  turnsBefore: number;
}

function sameLoaded(a: readonly TurnNode[], b: readonly TurnNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/**
 * The whole chat's turns: `base` (unloaded rows, one per index) with each loaded
 * turn placed at `turnsBefore` + the number of persisted loaded turns before it.
 * A loaded turn whose window turn is a different turn (checked by seq, then anchor)
 * is not placed: it is appended after the server turns and `mismatch` is set (a
 * cached window turn disagrees with the loaded one). Loaded turns without a seq
 * (not persisted yet) are appended too. Never fetches anything. `prev`, the last
 * result, is returned as is when base, steps, position and every loaded node are unchanged.
 */
export function mergeTurnOutline(
  base: readonly TurnNode[],
  loaded: readonly TurnNode[],
  opts: MergeOpts,
  prev?: MergeResult,
): MergeResult {
  if (
    prev &&
    prev.base === base &&
    prev.steps === opts.steps &&
    prev.turnsBefore === opts.turnsBefore &&
    sameLoaded(prev.loaded, loaded)
  ) {
    return prev;
  }
  const nodes = base.slice();
  for (const [idx, fetched] of opts.steps ?? []) {
    const slot = nodes[idx];
    if (!slot || !slot.unloaded) continue;
    nodes[idx] = {
      ...slot,
      beats: fetched.beats,
      breakBefore: fetched.breakBefore,
      cancelled: fetched.cancelled,
      ...(fetched.review ? { review: fetched.review } : {}),
    };
  }

  const appended: TurnNode[] = [];
  let mismatch = false;
  let persisted = 0;
  for (const n of loaded) {
    if (n.seq == null) {
      appended.push(n);
      continue;
    }
    const idx = opts.turnsBefore + persisted;
    persisted++;
    const slot = nodes[idx];
    const fits = slot
      ? slot.seq == null || slot.seq === n.seq || opts.seqAnchor(slot.seq) === n.anchor
      : idx === nodes.length;
    if (!fits) {
      if (slot?.seq != null) mismatch = true;
      appended.push(n);
      continue;
    }
    nodes[idx] = n.index === idx && n.number === idx + 1 ? n : { ...n, index: idx, number: idx + 1 };
  }

  for (const n of appended) nodes.push({ ...n, index: nodes.length, number: null });
  return { nodes, mismatch, base, loaded, steps: opts.steps, turnsBefore: opts.turnsBefore };
}
