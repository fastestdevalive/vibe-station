import { useState } from "react";
import { DiffView } from "@/components/preview/DiffView";
import {
  capForDisplay,
  looksLikeUnifiedDiff,
  prettyToolInput,
  summarizeToolInput,
  type ToolCallEntry,
} from "./toolFormat";

interface ToolRunSummaryProps {
  tools: ToolCallEntry[];
  /** True while this run is the trailing item of an active turn — any tool
   *  inside it still missing a result is genuinely in flight (a turn can fire
   *  several tool calls before results land, not just the last one). */
  live?: boolean;
}

// Tool names that describe the same kind of action fold into one bucket so
// the summary doesn't read e.g. "searched 1 time, searched 2 times" for a
// Grep + Glob mix.
const TOOL_ALIASES: Record<string, string> = {
  grep: "search",
  glob: "search",
  multiedit: "edit",
};

// Order in which phrases appear when several kinds of tools ran in the same
// burst (mirrors Claude Code's own ordering, e.g. "Read 1 file, ran 1 shell
// command").
const PHRASE_ORDER = ["read", "write", "edit", "bash", "search"];
const PHRASE_FNS: Record<string, (n: number) => string> = {
  read: (n) => `read ${n} file${n === 1 ? "" : "s"}`,
  write: (n) => `wrote ${n} file${n === 1 ? "" : "s"}`,
  edit: (n) => `edited ${n} file${n === 1 ? "" : "s"}`,
  bash: (n) => `ran ${n} shell command${n === 1 ? "" : "s"}`,
  search: (n) => `searched ${n} time${n === 1 ? "" : "s"}`,
};

function summarizeGroup(tools: ToolCallEntry[]): string {
  const counts = new Map<string, number>();
  // Bucket key -> the first original-cased tool name seen for it, so an
  // unrecognized tool (e.g. "TodoWrite") falls back to its real name instead
  // of a lowercased one ("used TodoWrite 2 times", not "used todowrite...").
  const displayName = new Map<string, string>();
  for (const t of tools) {
    const raw = t.toolName.toLowerCase();
    const key = TOOL_ALIASES[raw] ?? raw;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!displayName.has(key)) displayName.set(key, t.toolName);
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  const pushKey = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const n = counts.get(key);
    if (!n) return;
    const fn = PHRASE_FNS[key];
    parts.push(fn ? fn(n) : `used ${displayName.get(key) ?? key} ${n} time${n === 1 ? "" : "s"}`);
  };
  for (const key of PHRASE_ORDER) pushKey(key);
  for (const key of counts.keys()) pushKey(key);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One tool call inside an expanded run: a single borderless row (icon + name
 * + inline input) — the call and its result are ONE element, not two. A
 * small chevron toggles the merged detail (pretty input + result/diff) only
 * when there's more to show than the inline summary. While running, a
 * spinner replaces the chevron in place of a separate "result" row; once
 * done, a quiet checkmark marks completion when there's no detail to expand
 * into (an empty-output Bash call, say) so it doesn't read as still pending.
 */
function ToolRunEntryRow({ tool, running }: { tool: ToolCallEntry; running: boolean }) {
  const [open, setOpen] = useState(false);
  const inline = summarizeToolInput(tool.toolInput, tool.locations);
  const pretty = prettyToolInput(tool.toolInput);
  // `toolInput` is often `{}` for an ACP adapter that reports the target via
  // `locations` instead (see summarizeToolInput) — an empty-object body adds
  // nothing over the inline location text above, so don't expand into one.
  const hasInputBody = tool.toolInput != null && pretty !== "undefined" && pretty !== "{}";
  const result = tool.result;
  const resultText = result?.content ? capForDisplay(result.content) : "";
  const hasResultBody = resultText.length > 0;
  const isError = !!result?.isError || tool.status === "failed";
  const hasDiffs = !!tool.diffs && tool.diffs.length > 0;
  // Structured diffs win over the heuristic text-sniffing path (Decision 3).
  const isDiff = !hasDiffs && !isError && hasResultBody && looksLikeUnifiedDiff(resultText);
  const hasBody = hasInputBody || hasResultBody || hasDiffs;
  const done = tool.status ? tool.status === "completed" : (!hasBody && !!result);

  return (
    <div className={`chat-tool-entry${isError ? " chat-tool-entry--error" : ""}`}>
      <button
        type="button"
        className="chat-tool-entry__header"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => hasBody && setOpen((v) => !v)}
      >
        {hasBody ? (
          <span className="chat-tool-entry__caret" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        ) : (
          <span className="chat-tool-entry__caret chat-tool-entry__caret--spacer" aria-hidden />
        )}
        <span className="chat-tool-entry__icon" aria-hidden>
          {isError ? "⚠" : "🔧"}
        </span>
        <span className="chat-tool-entry__name">{tool.toolName}</span>
        {inline ? <code className="chat-tool-entry__inline">{inline}</code> : null}
        <span className="chat-tool-entry__status">
          {running ? (
            <span className="chat-spinner" aria-label="running" />
          ) : done ? (
            <span className="chat-tool-entry__done" aria-hidden>
              ✓
            </span>
          ) : null}
        </span>
      </button>
      {open && hasBody ? (
        <div className="chat-tool-entry__body">
          {hasInputBody ? (
            <pre className="chat-tool-entry__pre">
              <code>{pretty}</code>
            </pre>
          ) : null}
          {hasDiffs
            ? tool.diffs!.map((diff, i) => (
                <DiffView key={`${diff.path}-${i}`} oldText={diff.oldText ?? ""} newText={diff.newText} filePath={diff.path} />
              ))
            : null}
          {hasResultBody ? (
            isDiff ? (
              <DiffView diffText={resultText} />
            ) : (
              <pre className="chat-tool-entry__pre">
                <code>{resultText}</code>
              </pre>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls (no text/thinking between them) collapses
 * into one integrated, borderless summary line — matching Claude Code's
 * native terminal transcript (e.g. "Read 1 file, ran 1 shell command")
 * instead of stacking N separately-bordered cards. Collapsed by default,
 * EXCEPT while the run is still live (Change: starts expanded so the user
 * doesn't lose sight of in-progress tool calls mid-turn) — expands into a
 * list of merged, borderless per-tool rows (see ToolRunEntryRow) indented
 * under the summary line; each tool's call and result render as ONE
 * element, not a separate card pair.
 */
export function ToolRunSummary({ tools, live }: ToolRunSummaryProps) {
  // A singleton run's summary line is a generic phrase ("Ran 1 shell
  // command") — start it expanded so the actual tool name + inline args
  // (in the entry row below) are visible without a click, matching what a
  // lone tool call used to show directly.
  const [open, setOpen] = useState(() => !!live || tools.length === 1);
  const hasError = tools.some((t) => t.result?.isError || t.status === "failed");
  // A result already arrived, or a terminal status was set — never spin, even
  // if an adapter's terminal update omitted a fresh `status` field (per ACP's
  // "only changed fields need to be included", a stale `status:"pending"`
  // could otherwise outlive an already-arrived result).
  const isPending = (t: ToolCallEntry) =>
    t.result ? false : t.status ? t.status === "pending" || t.status === "in_progress" : true;
  const hasPending = live && tools.some(isPending);

  return (
    <div className="chat-tool-run">
      <button
        type="button"
        className="chat-tool-run__summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-tool-run__caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className={`chat-tool-run__text${hasError ? " chat-tool-run__text--error" : ""}`}>
          {summarizeGroup(tools)}
        </span>
        {hasPending ? <span className="chat-spinner" aria-label="running" /> : null}
      </button>
      {open ? (
        <div className="chat-tool-run__body">
          {tools.map((t) => (
            <ToolRunEntryRow key={t.id} tool={t} running={!!live && isPending(t)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
