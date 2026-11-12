import { describe, expect, it } from "vitest";
import type { RenderItem } from "../MessageList";
import {
  BEAT_CAP,
  beatSpokenLabel,
  buildTurnBeats,
  mergeBeats,
  type RawBeat,
} from "./buildTurnBeats";

describe("buildTurnBeats", () => {
  describe("table-driven detection and labels", () => {
    it("ask tool entry (AskUserQuestion)", () => {
      const items: RenderItem[] = [
        {
          type: "user",
          id: "u1",
          turnId: "u1",
          text: "Help me",
        },
        {
          type: "tool",
          id: "t_ask",
          toolName: "AskUserQuestion",
          toolInput: {
            questions: [{ question: "Which file should we update?" }],
          },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 1, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_ask",
        anchor: "t:t_ask",
        kind: "ask",
        label: "Asked: Which file should we update?",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Asked: Which file should we update?");
    });

    it("error item and tool error", () => {
      const items: RenderItem[] = [
        {
          type: "error",
          id: "err_item",
          text: "Network timeout while fetching repo",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "err_item",
        anchor: "i:err_item",
        kind: "error",
        label: "Network timeout while fetching repo",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Error: Network timeout while fetching repo");
    });

    it("todo tool entry with fresh done items", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_todo",
          toolName: "TodoWrite",
          toolInput: {
            todos: [
              { content: "Task 1", status: "completed" },
              { content: "Task 2", status: "completed" },
              { content: "Task 3", status: "in_progress" },
            ],
          },
          status: "completed",
        },
      ];
      const doneBefore = new Set(["Task 1"]);
      const { beats, doneAfter } = buildTurnBeats(items, 0, items.length, doneBefore);
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_todo",
        anchor: "t:t_todo",
        kind: "todo",
        label: "Done: Task 2",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Todo done: Task 2");
      expect(doneAfter).toEqual(new Set(["Task 1", "Task 2"]));
    });

    it("commit tool entry: git commit with heredoc subject", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_commit",
          toolName: "execute",
          toolKind: "execute",
          toolInput: {
            command: `git commit -m "$(cat <<'EOF'\nInitial feature implementation\n\nDetailed body\nEOF\n)"`,
          },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_commit",
        anchor: "t:t_commit",
        kind: "commit",
        label: "Commit: Initial feature implementation",
        count: 1,
      });
    });

    it("commit tool entry: gh pr create with pull number", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_pr",
          toolName: "execute",
          toolKind: "execute",
          toolInput: {
            command: "gh pr create --title 'Feature' --body 'Details'",
          },
          result: {
            content: "https://github.com/org/repo/pull/412 created successfully",
          },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_pr",
        anchor: "t:t_pr",
        kind: "commit",
        label: "Opened PR #412",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Pull request: Opened PR #412");
    });

    it("commit tool entry: commit with PR in message is spoken as Commit, not Pull request", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_commit_pr",
          toolName: "execute",
          toolKind: "execute",
          toolInput: {
            command: 'git commit -m "fix PR review notes"',
          },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_commit_pr",
        anchor: "t:t_commit_pr",
        kind: "commit",
        label: "Commit: fix PR review notes",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Commit: fix PR review notes");
    });

    it("commit tool entry: git push with branch", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_push",
          toolName: "execute",
          toolKind: "execute",
          toolInput: {
            command: "git push -u origin feat/x",
          },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_push",
        anchor: "t:t_push",
        kind: "commit",
        label: "Pushed feat/x",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Pushed feat/x");
    });

    it.each([
      ["git push", "Pushed"],
      ["git push 2>&1 | tail -3", "Pushed"],
      ["git push && echo ok", "Pushed"],
      ["git push origin HEAD", "Pushed"],
      ["git push origin HEAD:main", "Pushed main"],
      ["git push origin feat/y 2>&1 | tail -3", "Pushed feat/y"],
      ["git push origin feat/y; echo done", "Pushed feat/y"],
      ["git push origin feat/y > /tmp/out.log", "Pushed feat/y"],
      ["git push -u origin feat/y || true", "Pushed feat/y"],
      ['git commit -am "Tidy the parser"', "Commit: Tidy the parser"],
      ["git commit -m 'Plain subject'", "Commit: Plain subject"],
      ["git commit --amend --no-edit", "Commit"],
    ])("git label for %j is %j", (command, label) => {
      const items: RenderItem[] = [
        { type: "tool", id: "t_git", toolName: "execute", toolKind: "execute", toolInput: { command }, status: "completed" },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({ kind: "commit", label });
    });

    it("subagent tool entry with done suffix when settled-ok", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_task",
          toolName: "Task",
          toolInput: {
            description: "Research architecture options",
          },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_task",
        anchor: "t:t_task",
        kind: "subagent",
        label: "Subagent: Research architecture options · done",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Subagent: Research architecture options · done");
    });

    it("break item: session_break with switch to plan", () => {
      const items: RenderItem[] = [
        {
          type: "session_break",
          id: "brk_1",
          kind: "switch",
          toMode: "plan",
        },
        {
          type: "assistant",
          id: "as_1",
          text: "Planning next steps.",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "brk_1",
        anchor: "i:brk_1",
        kind: "break",
        label: "Switched to plan",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Break: Switched to plan");
    });

    it("break item: session_break reset gives Fresh start", () => {
      const items: RenderItem[] = [
        {
          type: "session_break",
          id: "brk_reset",
          kind: "reset",
        },
        {
          type: "assistant",
          id: "as_reset",
          text: "Starting fresh.",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "brk_reset",
        anchor: "i:brk_reset",
        kind: "break",
        label: "Fresh start",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Break: Fresh start");
    });

    it("status compaction: 'Conversation compacted' and 'Compacting context…' both yield 'Context compacted'; 'Turn stopped' yields no beat", () => {
      const items: RenderItem[] = [
        {
          type: "status",
          id: "st_1",
          text: "Conversation compacted",
        },
        {
          type: "status",
          id: "st_2",
          text: "Compacting context…",
        },
        {
          type: "status",
          id: "st_3",
          text: "Turn stopped",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(2);
      expect(beats[0]!.label).toBe("Context compacted");
      expect(beats[1]!.label).toBe("Context compacted");
    });

    it("cuts a 90-char first line to 60 with …", () => {
      const longText = "A".repeat(90);
      const items: RenderItem[] = [
        {
          type: "error",
          id: "err_long",
          text: longText,
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats[0]!.label).toHaveLength(60);
      expect(beats[0]!.label).toBe("A".repeat(59) + "…");
    });

    it("strips markdown markers from a text beat", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_prev",
          toolName: "read_file",
          status: "completed",
        },
        {
          type: "assistant",
          id: "as_text",
          text: "### **Header** `code` notes\nMore text",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "as_text",
        anchor: "a:as_text",
        kind: "text",
        label: "Header code notes",
        count: 1,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Agent said: Header code notes");
    });
  });

  describe("error bursts and edge cases", () => {
    it("accumulates consecutive errors into a burst until settled-ok entry or assistant", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_err1",
          toolName: "execute",
          status: "failed",
          result: { content: "Command failed with code 1" },
        },
        {
          type: "error",
          id: "t_err2",
          text: "Second error occurred",
        },
        {
          type: "tool",
          id: "t_err3",
          toolName: "execute",
          status: "failed",
          result: { content: "Third error occurred" },
        },
        {
          type: "tool",
          id: "t_ok",
          toolName: "read_file",
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({
        key: "t_err1",
        kind: "error",
        label: "execute failed: Command failed with code 1",
        count: 3,
      });
      expect(beatSpokenLabel(beats[0]!)).toBe("Error: execute failed: Command failed with code 1, and 2 more");
    });

    it("an error step label skips a code-fence line and falls back to the tool name alone", () => {
      const fenced: RenderItem[] = [
        {
          type: "tool",
          id: "t_fenced",
          toolName: "Terminal",
          status: "failed",
          result: { content: "```\nNo such file\n```" },
        },
      ];
      expect(buildTurnBeats(fenced, 0, fenced.length, new Set()).beats[0]).toMatchObject({
        kind: "error",
        label: "Terminal failed: No such file",
      });

      const fencesOnly: RenderItem[] = [
        {
          type: "tool",
          id: "t_fences",
          toolName: "Terminal",
          status: "failed",
          result: { content: "```\n```" },
        },
      ];
      expect(buildTurnBeats(fencesOnly, 0, fencesOnly.length, new Set()).beats[0]).toMatchObject({
        kind: "error",
        label: "Terminal failed",
      });

      // A plain first line is unchanged.
      const plain: RenderItem[] = [
        {
          type: "tool",
          id: "t_plain",
          toolName: "execute",
          status: "failed",
          result: { content: "Command failed with code 1" },
        },
      ];
      expect(buildTurnBeats(plain, 0, plain.length, new Set()).beats[0]).toMatchObject({
        kind: "error",
        label: "execute failed: Command failed with code 1",
      });
    });

    it("failed git push is an error beat, never a commit beat", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_push_fail",
          toolName: "execute",
          toolKind: "execute",
          toolInput: {
            command: "git push origin main",
          },
          status: "failed",
          result: { isError: true, content: "remote rejected: protected branch" },
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]!.kind).toBe("error");
      expect(beats[0]!.label).toContain("execute failed: remote rejected: protected branch");
    });

    it("late-failing earlier entry yields error beat at that position", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t1",
          toolName: "build",
          status: "failed",
          result: { isError: true, content: "Compilation error" },
        },
        {
          type: "assistant",
          id: "as1",
          text: "Checking compilation output.",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(2);
      expect(beats[0]!.kind).toBe("error");
      expect(beats[1]!.kind).toBe("text");
    });

    it("todo baseline carrying across turns", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_todo_1",
          toolName: "TodoWrite",
          toolInput: {
            todos: [{ content: "Task A", status: "completed" }],
          },
          status: "completed",
        },
      ];
      const res1 = buildTurnBeats(items, 0, 1, new Set());
      expect(res1.beats).toHaveLength(1);
      expect(res1.beats[0]!.label).toBe("Done: Task A");

      // In next turn, Task A is already in doneBefore
      const items2: RenderItem[] = [
        {
          type: "tool",
          id: "t_todo_2",
          toolName: "TodoWrite",
          toolInput: {
            todos: [
              { content: "Task A", status: "completed" },
              { content: "Task B", status: "completed" },
            ],
          },
          status: "completed",
        },
      ];
      const res2 = buildTurnBeats(items2, 0, 1, res1.doneAfter);
      expect(res2.beats).toHaveLength(1);
      expect(res2.beats[0]!.label).toBe("Done: Task B");
      expect(res2.doneAfter).toEqual(new Set(["Task A", "Task B"]));
    });
  });

  describe("mergeBeats", () => {
    it("merges 37 raw beats down to 12 with counts summing to 37", () => {
      const raw: RawBeat[] = [];
      for (let i = 0; i < 37; i++) {
        raw.push({
          key: `k_${i}`,
          anchor: `t:k_${i}`,
          kind: "commit",
          label: `Commit ${i}`,
          count: 1,
          ord: i * 2,
        });
      }
      const merged = mergeBeats(raw, BEAT_CAP);
      expect(merged).toHaveLength(12);
      const totalCount = merged.reduce((acc, b) => acc + b.count, 0);
      expect(totalCount).toBe(37);
      // Ensure input not mutated
      expect(raw).toHaveLength(37);
    });

    it("protected kinds (ask, error, break) merge only when nothing else can", () => {
      const raw: RawBeat[] = [
        { key: "a1", anchor: "t:a1", kind: "ask", label: "Ask 1", count: 1, ord: 1 },
        { key: "c1", anchor: "t:c1", kind: "commit", label: "Commit 1", count: 1, ord: 2 },
        { key: "c2", anchor: "t:c2", kind: "commit", label: "Commit 2", count: 1, ord: 3 },
        { key: "e1", anchor: "i:e1", kind: "error", label: "Error 1", count: 1, ord: 4 },
      ];
      // Cap at 3: c1 and c2 can merge (neither is protected)
      const merged = mergeBeats(raw, 3);
      expect(merged).toHaveLength(3);
      expect(merged.map((b) => b.kind)).toEqual(["ask", "commit", "error"]);
      expect(merged[1]!.count).toBe(2);

      // Now cap at 2: since only protected kinds remain around commit, adjacent pairs are now considered
      const merged2 = mergeBeats(raw, 2);
      expect(merged2).toHaveLength(2);
    });

    it("30 commit beats from ONE toolRun merge to 12 with no survivor count above 6", () => {
      const raw: RawBeat[] = [];
      for (let i = 0; i < 30; i++) {
        raw.push({
          key: `t_${i}`,
          anchor: `t:t_${i}`,
          kind: "commit",
          label: `Commit ${i}`,
          count: 1,
          ord: i + 1,   // distinct ords
        });
      }
      const merged = mergeBeats(raw, 12);
      expect(merged).toHaveLength(12);
      const totalCount = merged.reduce((acc, b) => acc + b.count, 0);
      expect(totalCount).toBe(30);
      for (const b of merged) {
        expect(b.count).toBeLessThanOrEqual(6);
      }
    });

    it("merges exactly like the pairwise scan it replaces (smallest gap, lowest index on a tie)", () => {
      /** The original O(n^2) scan, kept as the reference the heap must reproduce. */
      const reference = (beats: RawBeat[], cap: number): RawBeat[] => {
        if (beats.length <= cap) return beats.map((b) => ({ ...b }));
        const list = beats.map((b) => ({ ...b }));
        const protectedKinds = new Set(["ask", "error", "break"]);
        const priority: Record<string, number> = {
          ask: 7, error: 6, break: 5, commit: 3, subagent: 2, todo: 2, text: 1,
        };
        while (list.length > cap) {
          const candidates: number[] = [];
          for (let i = 0; i < list.length - 1; i++) {
            if (!protectedKinds.has(list[i]!.kind) && !protectedKinds.has(list[i + 1]!.kind)) candidates.push(i);
          }
          if (candidates.length === 0) for (let i = 0; i < list.length - 1; i++) candidates.push(i);
          let bestI = candidates[0]!;
          let minGap = list[bestI + 1]!.ord - list[bestI]!.ord;
          for (let j = 1; j < candidates.length; j++) {
            const idx = candidates[j]!;
            const gap = list[idx + 1]!.ord - list[idx]!.ord;
            if (gap < minGap) {
              minGap = gap;
              bestI = idx;
            }
          }
          const b1 = list[bestI]!;
          const b2 = list[bestI + 1]!;
          const kind = (priority[b1.kind] ?? 0) >= (priority[b2.kind] ?? 0) ? b1.kind : b2.kind;
          const end = b2.tsEnd ?? b2.ts;
          list.splice(bestI, 2, {
            ...b1,
            kind,
            count: b1.count + b2.count,
            ...(end ? { tsEnd: end } : {}),
          });
        }
        return list;
      };

      // Deterministic pseudo-random fixtures: mixed kinds, tied gaps, tsEnds.
      let seed = 7;
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const kinds: RawBeat["kind"][] = ["text", "commit", "todo", "subagent", "ask", "error", "break"];
      const fixtures: RawBeat[][] = [
        [
          { key: "a1", anchor: "t:a1", kind: "ask", label: "Ask", count: 1, ord: 1 },
          { key: "c1", anchor: "t:c1", kind: "commit", label: "C1", count: 1, ord: 2 },
          { key: "c2", anchor: "t:c2", kind: "commit", label: "C2", count: 1, ord: 3 },
          { key: "e1", anchor: "i:e1", kind: "error", label: "E1", count: 1, ord: 4 },
        ],
        [
          { key: "x", anchor: "t:x", kind: "text", label: "X", count: 2, ord: 1, ts: "T0", tsEnd: "T1" },
          { key: "y", anchor: "t:y", kind: "commit", label: "Y", count: 1, ord: 3 },
          { key: "z", anchor: "t:z", kind: "text", label: "Z", count: 1, ord: 4 },
        ],
        Array.from({ length: 24 }, (_, i) => ({
          key: `k${i}`,
          anchor: `t:k${i}`,
          kind: kinds[Math.floor(rand() * kinds.length)]!,
          label: `L${i}`,
          count: 1 + Math.floor(rand() * 3),
          ord: 1 + Math.floor(rand() * 4),
          ...(i % 3 === 0 ? { ts: `T${i}` } : {}),
        })),
      ];
      for (const raw of fixtures) {
        for (const cap of [2, 3, 5]) {
          expect(mergeBeats(raw, cap)).toEqual(reference(raw, cap));
        }
      }
    });

    it("buildTurnBeats strips ord from all returned Beat objects", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_1",
          toolName: "execute",
          toolKind: "execute",
          toolInput: { command: "git commit -m 'Initial'" },
          status: "completed",
        },
      ];
      const { beats } = buildTurnBeats(items, 0, 1, new Set());
      expect(beats).toHaveLength(1);
      expect("ord" in beats[0]!).toBe(false);
    });
  });

  describe("timestamps", () => {
    it("every beat kind copies its source item's ts", () => {
      const items: RenderItem[] = [
        { type: "user", id: "u1", turnId: "u1", text: "go" },
        { type: "tool", id: "t_ask", toolName: "AskUserQuestion", toolInput: { question: "Q?" }, status: "completed", ts: "T1" },
        { type: "tool", id: "t_ok", toolName: "Read", status: "completed", ts: "T2" },
        { type: "assistant", id: "a1", text: "Done reading", ts: "T3" },
        { type: "toolRun", id: "r1", tools: [{ id: "t_c", toolName: "Bash", toolKind: "execute", toolInput: { command: "git commit -m 'x'" }, status: "completed", ts: "T4" }] },
        { type: "error", id: "e1", text: "boom", ts: "T5" },
        { type: "status", id: "s1", text: "Context compacted", ts: "T6" },
        { type: "system_event", id: "se1", text: "paused", agentName: "helper", ts: "T7" },
        { type: "session_break", id: "sb1", kind: "reset", ts: "T8" },
        { type: "assistant", id: "a2", text: "fresh", ts: "T9" },
      ];
      const { beats } = buildTurnBeats(items, 1, items.length, new Set());
      expect(beats.map((b) => [b.kind, b.ts])).toEqual([
        ["ask", "T1"],
        ["text", "T3"],
        ["commit", "T4"],
        ["error", "T5"],
        ["break", "T6"],
        ["subagent", "T7"],
        ["break", "T8"],
      ]);
      expect(beats.every((b) => b.tsEnd === undefined)).toBe(true);
    });

    it("a beat whose source has no ts carries none", () => {
      const items: RenderItem[] = [{ type: "error", id: "e1", text: "boom" }];
      const { beats } = buildTurnBeats(items, 0, 1, new Set());
      expect("ts" in beats[0]!).toBe(false);
    });

    it("an error burst keeps its first ts and ends at the last absorbed one", () => {
      const items: RenderItem[] = [
        { type: "error", id: "e1", text: "one", ts: "T1" },
        { type: "error", id: "e2", text: "two", ts: "T2" },
        { type: "tool", id: "t1", toolName: "Bash", status: "failed", ts: "T3" },
      ];
      const { beats } = buildTurnBeats(items, 0, items.length, new Set());
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({ count: 3, ts: "T1", tsEnd: "T3" });
    });

    it("mergeBeats keeps the first beat's ts and takes the absorbed beat's end", () => {
      const raw: RawBeat[] = [
        { key: "c1", anchor: "t:c1", kind: "commit", label: "C1", count: 1, ord: 1, ts: "T1" },
        { key: "c2", anchor: "t:c2", kind: "commit", label: "C2", count: 1, ord: 2, ts: "T2" },
        { key: "c3", anchor: "t:c3", kind: "commit", label: "C3", count: 1, ord: 3, ts: "T3" },
      ];
      const once = mergeBeats(raw, 2);
      expect(once[0]).toMatchObject({ key: "c1", count: 2, ts: "T1", tsEnd: "T2" });
      const twice = mergeBeats(raw, 1);
      expect(twice[0]).toMatchObject({ key: "c1", count: 3, ts: "T1", tsEnd: "T3" });
      // A merged pair absorbs the other beat's own end, not just its start
      const pre: RawBeat[] = [
        { ...raw[0]! },
        { ...raw[1]!, count: 2, tsEnd: "T2b" },
      ];
      expect(mergeBeats(pre, 1)[0]).toMatchObject({ ts: "T1", tsEnd: "T2b" });
    });
  });

  describe("streaming append stability", () => {
    it("appending a new item preserves existing beats", () => {
      const items: RenderItem[] = [
        {
          type: "tool",
          id: "t_1",
          toolName: "execute",
          toolKind: "execute",
          toolInput: { command: "git commit -m 'Commit 1'" },
          status: "completed",
        },
      ];
      const res1 = buildTurnBeats(items, 0, items.length, new Set());
      expect(res1.beats).toHaveLength(1);
      expect(res1.beats[0]!.key).toBe("t_1");

      items.push({
        type: "tool",
        id: "t_2",
        toolName: "execute",
        toolKind: "execute",
        toolInput: { command: "git commit -m 'Commit 2'" },
        status: "completed",
      });

      const res2 = buildTurnBeats(items, 0, items.length, new Set());
      expect(res2.beats).toHaveLength(2);
      expect(res2.beats[0]!.key).toBe("t_1");
      expect(res2.beats[1]!.key).toBe("t_2");
    });
  });
});
