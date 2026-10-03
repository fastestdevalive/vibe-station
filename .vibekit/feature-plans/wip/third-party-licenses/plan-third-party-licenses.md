<!--
RULES — read before writing or implementing:
1. FORMAT: Bullets, tables, code, diagrams ONLY — no prose paragraphs
2. REQUIREMENTS: One crisp line each — no verbose descriptions
3. CHECKLIST: Mark items [x] as you complete them — this is your persistent todo list
4. READING TIME: Optimize for fast human scanning — if it's hard to skim, rewrite it
-->

# Plan: Third-party licenses in Settings → About

> A short, static "Third-party licenses" list for the components we redistribute inside the vst binary/tarball/desktop app.

**Status:** Pending
**Reference files:**
- UI home: `web-ui/src/components/settings/AboutSetting.tsx`
- Section header + styling conventions: `web-ui/src/components/settings/SectionHeader.tsx`
- Test pattern: `web-ui/src/components/settings/LspSetting.test.tsx`

---

## Problem & Concept

- We now ship a compiled Claude ACP adapter and other third-party components; Apache-2.0/MIT ask for attribution
- Add one compact section to the existing About panel — no new nav item, no daemon/API change

## Out of Scope

- Every transitive npm/Cargo dependency (thousands; not "worth listing")
- Generated license files, build-time license scanners, a new settings page
- Daemon/REST changes; shipping license text files in the tarball

## Requirements

| # | Requirement |
|---|-------------|
| 1 | "Third-party licenses" section at the bottom of `AboutSetting`, below the existing card |
| 2 | Exactly the five rows below — nothing else |
| 3 | Each row: name, one-line role, license name, link to the upstream license/terms |
| 4 | Data is a typed constant in its own small file; no fetching |
| 5 | Matches existing settings styling (inline styles + design tokens, no bare hexes) |
| 6 | One test: renders all rows and the links open in a new tab with `rel="noreferrer"` |

## The list (verified from the installed packages; the agent re-verifies URLs)

| Component | Role | License |
|-----------|------|---------|
| `@agentclientprotocol/claude-agent-acp` (+ `@agentclientprotocol/sdk`) | Claude Rich Chat adapter, compiled into `claude-acp` | Apache-2.0 |
| `@anthropic-ai/claude-agent-sdk` | Runs the user's `claude` CLI, embedded in `claude-acp` | Anthropic terms — link https://code.claude.com/docs/en/legal-and-compliance |
| Bun runtime | Embedded in `claude-acp` by `bun build --compile` | MIT |
| `agy-acp` (openab) | agy Rich Chat adapter, shipped beside `vst` | MIT |
| `cloudflared` | Remote-access tunnel, desktop app bundle only | Apache-2.0 |

## Change Map

```
web-ui/src/components/settings/
  AboutSetting.tsx            ~ render the section
  thirdPartyLicenses.ts       + typed constant (5 rows)
  AboutSetting.test.tsx       + one test
```

## Implementation Phases

### Phase 1 — Data + UI
- [x] 1.1 `thirdPartyLicenses.ts`: `{ name, role, license, url }[]` with the five rows; confirm each URL from the package's own `repository`/LICENSE
- [x] 1.2 `AboutSetting.tsx`: section under the existing card; compact rows; external links `target="_blank" rel="noreferrer"`
- [x] 1.T1 `AboutSetting.test.tsx`: five rows render, links have the right attrs
- [x] 1.T2 `pnpm --filter @vibestation/web test` for the file, `pnpm --filter @vibestation/web typecheck` (and lint if the repo has it)

## Risks

- None material; static text. Don't add rows beyond the five.
