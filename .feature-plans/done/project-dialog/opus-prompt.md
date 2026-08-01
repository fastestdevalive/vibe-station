You are the Claude Opus vst agent in this worktree.
Please review the plan in `.feature-plans/done/project-dialog/existing-directory-improvements.md`.
Evaluate the technical approach, check for potential bugs (specifically keeping in mind the agent/coding guidelines in `AGENTS.md`, such as:
1. Terminal: Never unmounting TerminalPane during UI transitions (stable React tree position).
2. Agent plugin: All CLI-specific logic lives in the plugin registry, nowhere else.
3. WebSocket: Serializing session:open/session:close.
4. UI copy terminology: "Rich Chat" in the UI, "json" in the code.
), and verify correctness.

Please write your feedback/review of this plan to `.feature-plans/done/project-dialog/opus-review.md` in markdown format and stop cleanly.
