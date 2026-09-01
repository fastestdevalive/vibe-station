# Research: Reliable skill invocation from rich-chat

> Not yet planned for implementation — captured for later. No code changes in this doc's scope.

**Issue:** skill-invocation-in-chat
**Status:** Pending (research only)

---

## Problem

- Typing `/skill-name args` in the TTY (terminal channel) is intercepted by Claude Code's own harness dispatcher **before** it reaches the model — deterministic, zero token cost.
- Typing the same `/skill-name args` text in rich-chat (ACP `session/prompt`) has no such interception layer — it arrives as plain prompt text, and the model must *recognize* the slash syntax and choose to invoke the Skill tool itself.
- Observed in practice: recognition is not reliable — the model sometimes treats `/skill-name` as a topic rather than a command, requiring the user to explicitly say "that's a skill, invoke it."
- This affects every CLI vibe-station drives (claude, cursor, opencode) that goes through the daemon's chat path, not just Claude specifically.

## Findings

- **ACP has no dispatch mechanism for this.** The Agent Client Protocol spec (`session/prompt`) is a generic request-response; there is no distinct message type or flag for "invoke this skill by name," unlike the TTY's local interception.
- **`session/init` advertises `slash_commands`**, but this is informational only (what commands exist) — dispatch still relies on the model parsing prompt text.
- **Per-CLI skill/command formats likely differ** (Claude skills vs Cursor rules vs opencode commands) — a daemon-side solution needs to be CLI-agnostic or route through [`AgentPlugin`](../../../CLAUDE.md) per the "all CLI-specific logic lives in the plugin" invariant already established in this codebase.

## Inclination (not yet decided)

- A **daemon-driven rewrite** is preferred over relying on model recognition: before the daemon forwards a chat message as a `session/prompt`, detect a leading `/skill-name` in the outgoing text and rewrite that portion inline — replacing it with the skill's full resolved path/instructions (or an unambiguous directive) rather than leaving it as bare text for the model to interpret.
- This should live in `daemon/src/agent-plugins/` per the existing plugin-boundary rule — each CLI's plugin resolves its own skill/command lookup and rewrite format, since "Terminal" (`Bash`) vs `Edit` naming differences and skill/command formats already diverge per-CLI in this codebase.
- **Open problem — arguments:** the composer is a single free-text field. `/skill-name arg1 arg2` mixes the skill selector and its arguments in one string with no structured separation. Any rewrite logic needs a clear boundary between "this is the skill name" and "this is the args payload" — e.g. first whitespace-delimited token after `/` is the skill, remainder is `args` verbatim (matches the existing `Skill` tool's `{skill, args}` shape) — but this needs validation against real skill usage patterns (do any skill names contain spaces or special chars? do args ever need to reference the skill name again?).
- Deferred: exact detection regex, where in the daemon pipeline the rewrite happens (before persist? before ACP send only?), how failure/no-match cases degrade (fall through to plain text vs error), and whether cursor/opencode need this at all given their own command surfaces may already work differently.

## Alternative considered

- Contributing to the upstream [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) adapter to add a proper `session/command`-style dispatch message. Rejected as the primary path for now: it only fixes Claude, not cursor/opencode, and vibe-station doesn't control that repo's release cadence — but worth revisiting if the daemon-side rewrite proves too fragile per-CLI.

## Next steps (when this is picked up)

1. Confirm argument-boundary convention against real skill catalogs across all three CLIs.
2. Decide rewrite injection point in the daemon chat pipeline.
3. Prototype for Claude only first (highest-value CLI), validate reliability improvement, then generalize to the `AgentPlugin` interface.
