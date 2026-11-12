import type { NormalizedEvent, TranscriptOutlineTurn } from "@/api/types";
import { isWriteToolName } from "@/components/chat/toolFormat";

const LABEL_MAX = 80;
/** Turns per bucket is `ceil(totalTurns / BUCKET_COUNT)`, so the summary stays about 1000 entries per array. */
const BUCKET_COUNT = 1000;

/** First non-empty trimmed line, control characters removed, at most 80 code points. */
function outlineLabel(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  // eslint-disable-next-line no-control-regex -- C0 and C1 control characters are the point of this strip
  const printable = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return Array.from(printable).slice(0, LABEL_MAX).join("");
}

/** A tool call that writes files: an edit / delete / move kind, or a write-like name. */
export function isOutlineWriteTool(name: string | undefined, kind: string | undefined): boolean {
  return kind === "edit" || kind === "delete" || kind === "move" || (name != null && isWriteToolName(name));
}

/** Turns per bucket for a chat of `totalTurns` user turns (contract: `max(1, ceil(totalTurns / 1000))`). */
export function bucketSizeFor(totalTurns: number): number {
  return Math.max(1, Math.ceil(totalTurns / BUCKET_COUNT));
}

/**
 * The per-turn skeleton of a whole transcript, mirroring the daemon's outline rules: a non-silent user
 * event opens a turn (a repeated turn key does not), top-level tool calls count once per tool id, and
 * nested (subagent) calls, superseded rows and rows before the first turn are ignored.
 */
export function outlineTurnsFromEvents(events: readonly NormalizedEvent[]): TranscriptOutlineTurn[] {
  const turns: TranscriptOutlineTurn[] = [];
  const turnKeys = new Set<string>();
  // Per tail-turn tool id: whether its edit and error have already been counted.
  let tailTools = new Map<string, { edit: boolean; error: boolean }>();

  for (const ev of events) {
    if (ev.logSeq == null || ev.superseded || ev.parentToolUseId) continue;
    const tail = turns[turns.length - 1];

    if (ev.kind === "user") {
      if (ev.silent) continue;
      const turnKey = ev.turnId ?? `seq:${ev.logSeq}`;
      if (turnKeys.has(turnKey)) continue;
      turnKeys.add(turnKey);
      turns.push({
        seq: ev.logSeq,
        turnKey,
        label: outlineLabel(ev.text ?? ""),
        ...(ev.ts ? { ts: ev.ts } : {}),
        counts: { tools: 0, edits: 0, errors: 0 },
      });
      tailTools = new Map();
      continue;
    }

    if (!tail) continue;
    if (ev.kind === "error") {
      tail.counts.errors += 1;
      continue;
    }
    if (ev.kind !== "tool_use" && ev.kind !== "tool_result") continue;

    const id = ev.toolId ?? ev.id;
    const prev = tailTools.get(id);
    const edit = isOutlineWriteTool(ev.toolName, ev.toolKind);
    const error =
      ev.kind === "tool_use"
        ? ev.toolStatus === "failed"
        : ev.toolResult?.isError === true || ev.toolStatus === "failed";
    if (prev === undefined) tail.counts.tools += 1;
    if (edit && !prev?.edit) tail.counts.edits += 1;
    if (error && !prev?.error) tail.counts.errors += 1;
    tailTools.set(id, { edit: prev?.edit === true || edit, error: prev?.error === true || error });
  }
  return turns;
}
