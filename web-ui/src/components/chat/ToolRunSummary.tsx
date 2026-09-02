import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DiffView } from "@/components/preview/DiffView";
import {
  capForDisplay,
  looksLikeUnifiedDiff,
  prettyToolInput,
  relativize,
  summarizeToolInput,
  type ToolCallEntry,
} from "./toolFormat";

const BASH_TOOL_NAMES = new Set(["bash", "terminal"]);
// Read-only/search tool names (Claude Code native names, lowercased).
// ACP sessions use toolKind instead — see below.
const READ_ONLY_TOOL_NAMES = new Set(["read", "ls", "glob", "grep", "websearch", "webfetch", "task", "todowrite"]);

interface ToolRunSummaryProps {
  tools: ToolCallEntry[];
  /** True while this run is the trailing item of an active turn — any tool
   *  inside it still missing a result is genuinely in flight (a turn can fire
   *  several tool calls before results calls, not just the last one). */
  live?: boolean;
  /** Absolute working directory — paths are shown relative to it. */
  cwd?: string;
}

// Tool names that describe the same kind of action fold into one bucket so
// the summary doesn't read e.g. "searched 1 time, searched 2 times" for a
// Grep + Glob mix.
const TOOL_ALIASES: Record<string, string> = {
  grep: "search",
  glob: "search",
  multiedit: "edit",
  // One-line insurance (5.5): any session reporting no `toolKind` at all
  // still buckets "terminal" with bash instead of regressing to the
  // unbounded per-command header.
  terminal: "bash",
};

// Decision 11 — `toolKind` is low-cardinality and reliable (real transcripts
// contain only execute/read/edit/think/other/fetch); `toolName` is often the
// FULL COMMAND STRING in an ACP session, so keying on it (the old bug)
// guarantees one clause per call and an unbounded header. Task is matched by
// NAME first — its `toolKind` is "think", shared with the plain Think tool.
const KIND_BUCKET: Record<string, string> = {
  execute: "bash",
  read: "read",
  edit: "edit",
  search: "search",
  fetch: "fetch",
  think: "think",
};

function isTask(t: ToolCallEntry): boolean {
  return t.toolName.toLowerCase() === "task";
}

// Order in which phrases appear when several kinds of tools ran in the same
// burst (mirrors Claude Code's own ordering, e.g. "Read 1 file, ran 1 shell
// command").
const PHRASE_ORDER = ["read", "write", "edit", "bash", "search", "task"];
const PHRASE_FNS: Record<string, (n: number) => string> = {
  read: (n) => `read ${n} file${n === 1 ? "" : "s"}`,
  write: (n) => `wrote ${n} file${n === 1 ? "" : "s"}`,
  edit: (n) => `edited ${n} file${n === 1 ? "" : "s"}`,
  bash: (n) => `ran ${n} shell command${n === 1 ? "" : "s"}`,
  search: (n) => `searched ${n} time${n === 1 ? "" : "s"}`,
  task: (n) => `delegated to ${n} subagent${n === 1 ? "" : "s"}`,
};

// Header is bounded at four clauses plus "+N more" (5.4), independent of run
// length — a 20-call or 200-call run of the same kinds must produce the
// exact same header text.
const MAX_CLAUSES = 4;
// A name-derived fallback label is truncated (5.3) so one stray tool with a
// very long name (or, on an ACP session, a full command string) can never
// restore the old per-call-clause behavior.
const FALLBACK_LABEL_MAX = 24;

function summarizeGroup(tools: ToolCallEntry[]): string {
  const counts = new Map<string, number>();
  // Bucket key -> the first original-cased tool name seen for it, so an
  // unrecognized tool (e.g. "TodoWrite") falls back to its real name instead
  // of a lowercased one ("used TodoWrite 2 times", not "used todowrite...").
  const displayName = new Map<string, string>();
  for (const t of tools) {
    const raw = t.toolName.toLowerCase();
    const key = isTask(t) ? "task" : (KIND_BUCKET[t.toolKind ?? ""] ?? TOOL_ALIASES[raw] ?? raw);
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
    if (fn) {
      parts.push(fn(n));
      return;
    }
    const rawLabel = displayName.get(key) ?? key;
    const label = rawLabel.length > FALLBACK_LABEL_MAX ? `${rawLabel.slice(0, FALLBACK_LABEL_MAX)}…` : rawLabel;
    parts.push(`used ${label} ${n} time${n === 1 ? "" : "s"}`);
  };
  for (const key of PHRASE_ORDER) pushKey(key);
  for (const key of counts.keys()) pushKey(key);
  const shown = parts.length > MAX_CLAUSES ? parts.slice(0, MAX_CLAUSES) : parts;
  const overflow = parts.length - shown.length;
  const text = overflow > 0 ? `${shown.join(", ")}, +${overflow} more` : shown.join(", ");
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
function ToolRunEntryRow({ tool, running, cwd }: { tool: ToolCallEntry; running: boolean; cwd?: string }) {
  const name = tool.toolName.toLowerCase();
  const isBash = BASH_TOOL_NAMES.has(name) || tool.toolKind === "execute";
  // Collapse read-only/search tools — no mutation happened, diffs aren't relevant.
  // Check toolKind first (reliable for ACP sessions where toolName is prose);
  // fall back to name matching for native Claude Code sessions.
  const isReadOnly =
    tool.toolKind === "read" ||
    tool.toolKind === "search" ||
    tool.toolKind === "fetch" ||
    tool.toolKind === "think" ||
    READ_ONLY_TOOL_NAMES.has(name);
  // Edit/Write/Delete/Move tools start expanded so diffs are immediately visible.
  const [open, setOpen] = useState(!isBash && !isReadOnly);
  const inlineFull = summarizeToolInput(tool.toolInput, tool.locations, cwd);
  // Cap long inline text (e.g. Task tool prompts) so it doesn't overflow the row.
  const INLINE_CAP = 80;
  const inline = inlineFull.length > INLINE_CAP ? `${inlineFull.slice(0, INLINE_CAP)}…` : inlineFull;
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
  // Phase 6 — a Task's bracketed sub-thread (Decision 4) also expands the row,
  // even when the Task call itself has no input/result/diff body of its own.
  const hasChildren = !!tool.children && tool.children.length > 0;
  const hasBody = hasInputBody || hasResultBody || hasDiffs || hasChildren;
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
        <span className="chat-tool-entry__name">{isBash ? "Ran" : tool.toolName}</span>
        {inline ? <code className="chat-tool-entry__inline">{inline}</code> : null}
        {hasChildren ? (
          <span className="chat-tool-entry__child-count">
            {tool.children!.length} tool{tool.children!.length === 1 ? "" : "s"}
          </span>
        ) : null}
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
                <DiffView
                  key={`${diff.path}-${i}`}
                  oldText={diff.oldText ?? ""}
                  newText={diff.newText}
                  filePath={relativize(diff.path, cwd)}
                />
              ))
            : null}
          {hasResultBody ? (
            isDiff ? (
              <DiffView diffText={resultText} />
            ) : isBash ? (
              <div className="chat-tool-entry__md workspace-markdown-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultText}</ReactMarkdown>
              </div>
            ) : (
              <pre className="chat-tool-entry__pre">
                <code>{resultText}</code>
              </pre>
            )
          ) : null}
          {hasChildren ? (
            <div className="chat-tool-entry__children">
              {tool.children!.map((child) => (
                <ToolRunEntryRow key={child.id} tool={child} running={false} cwd={cwd} />
              ))}
            </div>
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
export function ToolRunSummary({ tools, live, cwd }: ToolRunSummaryProps) {
  // A singleton run's summary line is a generic phrase ("Ran 1 shell
  // command") — start it expanded so the actual tool name + inline args
  // (in the entry row below) are visible without a click, matching what a
  // lone tool call used to show directly.
  const [open, setOpen] = useState(true);
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
            <ToolRunEntryRow key={t.id} tool={t} running={!!live && isPending(t)} cwd={cwd} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
