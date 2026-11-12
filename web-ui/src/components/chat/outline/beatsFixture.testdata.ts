import type { AcpToolKind, NormalizedEvent } from "@/api/types";

/**
 * Fixture builder generating a realistic 6-turn chat transcript with a long
 * tool-heavy autonomous run in turn 4 (40+ tool calls), and a reply-only turn 6.
 */
export function beatsFixtureEvents(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let seq = 1;
  const baseTs = new Date("2026-11-12T10:00:00.000Z").getTime();

  function ts(offsetSec: number): string {
    return new Date(baseTs + offsetSec * 1000).toISOString();
  }

  let time = 1;
  function user(turnId: string, text: string): void {
    events.push({
      id: `evt-u-${turnId}`,
      sessionId: "sess-beats",
      ts: ts(time++),
      provider: "claude",
      kind: "user",
      role: "user",
      text,
      turnId,
      logSeq: seq++,
    });
  }

  function asst(turnId: string, text: string): void {
    events.push({
      id: `evt-a-${seq}`,
      sessionId: "sess-beats",
      ts: ts(time++),
      provider: "claude",
      kind: "text",
      role: "assistant",
      text,
      turnId,
      logSeq: seq++,
    });
  }

  function tool(
    turnId: string,
    toolId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    resultContent: string,
    extra?: { toolKind?: AcpToolKind; isError?: boolean },
  ): void {
    events.push(
      {
        id: `evt-c-${toolId}`,
        sessionId: "sess-beats",
        ts: ts(time++),
        provider: "claude",
        kind: "tool_use",
        toolName,
        toolId,
        toolInput,
        toolKind: extra?.toolKind,
        turnId,
        logSeq: seq++,
      },
      {
        id: `evt-r-${toolId}`,
        sessionId: "sess-beats",
        ts: ts(time++),
        provider: "claude",
        kind: "tool_result",
        toolId,
        toolResult: {
          content: resultContent,
          ...(extra?.isError ? { isError: true } : {}),
        },
        turnId,
        logSeq: seq++,
      },
    );
  }

  // --- Turn 1 ---
  user("t-1", "Initialize project structure");
  asst("t-1", "I will set up the repository files.");
  tool("t-1", "call-1-1", "write_file", { path: "src/index.ts" }, "File written");
  asst("t-1", "Project initialized.");

  // --- Turn 2 ---
  user("t-2", "Add configuration");
  asst("t-2", "Creating configuration files.");
  tool("t-2", "call-2-1", "write_file", { path: "tsconfig.json" }, "Wrote tsconfig");
  asst("t-2", "Configuration created.");

  // --- Turn 3 ---
  user("t-3", "Check database connection");
  asst("t-3", "Running connection check.");
  tool("t-3", "call-3-1", "Bash", { command: "psql -c 'SELECT 1'" }, "1", { toolKind: "execute" });
  asst("t-3", "Database is reachable.");

  // --- Turn 4 (Long autonomous run with 40+ tool calls) ---
  user("t-4", "Implement migration and deploy feature");

  // 1. AskUserQuestion
  tool("t-4", "call-4-ask", "AskUserQuestion", { question: "Should we proceed with database migration?" }, "Yes, proceed with migration");

  // 2. Failing command burst (3 in a row)
  for (let i = 1; i <= 3; i++) {
    tool("t-4", `call-4-err-${i}`, "Bash", { command: "cargo test" }, "FAILED: connection refused to redis", {
      toolKind: "execute",
      isError: true,
    });
  }

  // 3. Two todo calls completing Task A then Task B
  tool(
    "t-4",
    "call-4-todo-1",
    "TodoWrite",
    { todos: [{ text: "Write migration", status: "completed" }, { text: "Run migration", status: "pending" }] },
    "ok",
  );
  tool(
    "t-4",
    "call-4-todo-2",
    "TodoWrite",
    { todos: [{ text: "Write migration", status: "completed" }, { text: "Run migration", status: "completed" }] },
    "ok",
  );
  tool("t-4", "call-4-read-gap1", "read_file", { path: "src/schema.ts" }, "export interface Schema {}");

  // 4. Task call with children
  events.push(
    {
      id: "evt-c4-task",
      sessionId: "sess-beats",
      ts: ts(time++),
      provider: "claude",
      kind: "tool_use",
      toolName: "Task",
      toolId: "call-4-task",
      toolInput: { description: "Subagent: Run security scan" },
      turnId: "t-4",
      logSeq: seq++,
    },
    {
      id: "evt-c4-task-c1",
      sessionId: "sess-beats",
      ts: ts(time++),
      provider: "claude",
      kind: "tool_use",
      toolName: "Bash",
      toolKind: "execute",
      toolId: "call-4-task-c1",
      toolInput: { command: "npm audit" },
      turnId: "t-4",
      logSeq: seq++,
    },
    {
      id: "evt-r4-task-c1",
      sessionId: "sess-beats",
      ts: ts(time++),
      provider: "claude",
      kind: "tool_result",
      toolId: "call-4-task-c1",
      toolResult: { content: "found 0 vulnerabilities" },
      turnId: "t-4",
      logSeq: seq++,
    },
    {
      id: "evt-r4-task",
      sessionId: "sess-beats",
      ts: ts(time++),
      provider: "claude",
      kind: "tool_result",
      toolId: "call-4-task",
      toolResult: { content: "Subagent: Run security scan · done" },
      turnId: "t-4",
      logSeq: seq++,
    },
  );
  tool("t-4", "call-4-read-gap2", "read_file", { path: "src/audit.json" }, "{}");

  // 5. 24 intermediate read_file executions
  for (let i = 1; i <= 24; i++) {
    tool("t-4", `call-4-read-${i}`, "read_file", { path: `src/module_${i}.ts` }, `content of module ${i}`);
  }

  // 6. 14 adjacent commits (merge into fewer beats)
  for (let c = 1; c <= 14; c++) {
    tool("t-4", `call-4-commit-${c}`, "Bash", { command: `git commit -m "step ${c}: update schema migration"` }, `[main step-${c}] step ${c}`, {
      toolKind: "execute",
    });
  }

  // 7. gh pr create
  tool("t-4", "call-4-pr", "Bash", { command: 'gh pr create --title "feat: v2 schema" --body "Automated PR"' }, "https://github.com/vibe-station/vibe-station/pull/412", {
    toolKind: "execute",
  });

  // 8. git push
  tool("t-4", "call-4-push", "Bash", { command: "git push origin feat/x" }, "To github.com:vibe-station/vibe-station.git\n * [new branch] feat/x -> feat/x", {
    toolKind: "execute",
  });

  // 9. "Conversation compacted" status
  events.push({
    id: "evt-s4-compact",
    sessionId: "sess-beats",
    ts: ts(time++),
    provider: "claude",
    kind: "status",
    text: "Conversation compacted",
    turnId: "t-4",
    logSeq: seq++,
  });

  // 10. Assistant text after tool runs
  asst("t-4", "Migration has been executed, committed, pushed and PR #412 opened.");

  // --- Turn 5 ---
  user("t-5", "Review status");
  tool("t-5", "call-5-1", "Bash", { command: "git status" }, "nothing to commit, working tree clean", {
    toolKind: "execute",
  });
  asst("t-5", "Working tree is clean.");

  // --- Turn 6 (reply with NO tool, so NO beats) ---
  user("t-6", "Thank you, all done!");
  asst("t-6", "You are welcome! Everything is ready.");

  return events;
}
