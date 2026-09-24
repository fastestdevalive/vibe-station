# Turn-implement: LSP Settings page — Phase 2 (Frontend)

You are implementing exactly ONE phase of a larger plan. The full plan lives at
`.vibekit/feature-plans/wip/lsp-settings-page/plan-lsp-settings-page.md` — you do NOT need to
read the whole file; everything needed for this phase is below.

Read the `coding-agent-guardrails` skill, then the `coding` skill, before touching any file.

## Context: Phase 1 (backend) is already done and merged into this working tree

A new daemon endpoint already exists and is live:

```
GET /api/lsp/languages
Response: { languages: LspLanguageSurveyEntry[] }

LspLanguageSurveyEntry (camelCase JSON):
  language: string              // e.g. "rust"
  displayName: string           // e.g. "Rust"
  command: string                // e.g. "rust-analyzer"
  installedOnHost: boolean
  installCommand: string | null  // a single runnable shell line, or null
  installNote: string | null     // extra context / docs URL, or null — never has a Copy button
```

There are exactly 16 languages, always returned, in registry-declaration order (not
alphabetical) — you sort them client-side per item 2.4 below.

## Goal

Add a new Settings → LSP page listing all 16 languages, showing whether each is installed on
the daemon host, and for missing ones a copy-pasteable install command and/or note.

## Checklist — implement exactly these items, mark them `[x]` in the plan file at
`.vibekit/feature-plans/wip/lsp-settings-page/plan-lsp-settings-page.md` (Phase 2 section) as
you complete each one:

- [ ] **2.1** `web-ui/src/api/types.ts`: add these two interfaces (camelCase fields, matching the contract above exactly):
  ```ts
  export interface LspLanguageSurveyEntry {
    language: string;
    displayName: string;
    command: string;
    installedOnHost: boolean;
    installCommand: string | null;
    installNote: string | null;
  }

  export interface LspLanguageSurveyResponse {
    languages: LspLanguageSurveyEntry[];
  }
  ```
- [ ] **2.2** `web-ui/src/api/client.ts`: add a method to the client object, following the exact pattern of the existing `getDiskUsage` method (search for `async getDiskUsage(): Promise<DiskUsageResponse>` in this file — it calls `apiFetch` on `${root}/worktrees/disk-usage` and returns `parseJson(...)`):
  ```ts
  async getLspLanguages(): Promise<LspLanguageSurveyResponse> {
    const root = baseUrl();
    const res = await apiFetch(`${root}/lsp/languages`);
    return parseJson<LspLanguageSurveyResponse>(res);
  },
  ```
  Import `LspLanguageSurveyResponse` from `@/api/types` (or the relative path already used for other type imports at the top of this file — match the existing import style).
- [ ] **2.3** `web-ui/src/api/mock.ts`: add a `getLspLanguages()` method to the mock API object (same object that has `getDiskUsage`), returning a hard-coded fixture array of all 16 languages (language, displayName, command copied from `rust/vst-lsp/src/registry.rs`'s `get_configs()` if you want exact values, or any representative values — the important part is the shape). Include:
  - at least 2 entries with `installedOnHost: true` (installCommand/installNote both `null` for these — nothing to install)
  - at least one entry with `installedOnHost: false`, `installCommand` set to a non-null string, `installNote: null`
  - at least one entry with `installedOnHost: false`, `installCommand: null`, `installNote` set to a non-null string
  - at least one entry with `installedOnHost: false`, BOTH `installCommand` and `installNote` set (e.g. a "latex"-like entry: `installCommand: "cargo install texlab"`, `installNote: "macOS alternative: brew install texlab"`)
  - never an entry with both `installCommand` and `installNote` null when `installedOnHost` is false
- [ ] **2.4** Create `web-ui/src/components/settings/LspSetting.tsx` (new file). Look at `web-ui/src/components/settings/SkillsSetting.tsx` first for the established fetch-on-mount pattern (a `refresh` callback wrapped in `useCallback`, called from `useEffect`, with a `loadFailed` boolean state that is SEPARATE from "empty list" so a fetch error never renders identically to "nothing to show"). Your component:
  - Props: `{ api: ApiInstance }` (import `ApiInstance` type from `@/api`)
  - State: languages (`LspLanguageSurveyEntry[] | null` — null means "not loaded yet"), `loadFailed: boolean`
  - Three render states:
    - **Loading** (languages is null, loadFailed is false): a simple loading indicator/text
    - **Error** (loadFailed is true): an inline error message, e.g. "Failed to load LSP language status."
    - **Loaded** (languages is non-null array): render every entry
  - Sort order for the loaded list: entries with `installedOnHost: false` first, then `installedOnHost: true`; within each group, alphabetical by `displayName`
  - Each row shows: `displayName`, a badge/pill reading "Installed" or "Missing" (color-code if convenient using this app's existing CSS custom properties like `var(--fg-muted)`/theme tokens — look at `SkillsSetting.tsx` or `StorageSetting.tsx` for the inline-style convention this codebase uses, since components here use inline `style={{...}}` objects with CSS variables rather than a CSS framework)
  - For a Missing row with non-null `installCommand`: render it in a `<code>` element, plus a "Copy" button. Import `copyText` from `@/lib/copyText` (or the relative path — check how other settings components import from `web-ui/src/lib/`). On click: `await copyText(entry.installCommand)`, then flip a per-row "copied" state to true for ~1.5s so the button label changes to "Copied" and then reverts (look at `RemoteAccessSetting.tsx`'s existing copy-button implementation around its `markCopied` call for the exact UX pattern already established in this codebase — copy that pattern, don't invent a new one)
  - For a Missing row with non-null `installNote`: render it as plain text below the command (or standalone if there's no command) — never inside/next to the Copy button, and never render a Copy button for `installNote` text
  - A Missing row with `installCommand: null` renders no Copy button at all
  - Use `SectionHeader` (from `./SectionHeader`, already used by `SkillsSetting.tsx`) at the top with a title like "LSP" and a one-line description explaining what the page shows
- [ ] **2.5** `web-ui/src/components/settings/SettingsPanel.tsx`: import `LspSetting` and add `{ id: "lsp", label: "LSP", content: <LspSetting api={api} /> }` to the `sections` array (search for the existing array literal — it currently ends with the `remote-access` entry).

## Verify (run these yourself before reporting done)

- [ ] **2.T1** Create `web-ui/src/components/settings/LspSetting.test.tsx`. Look at `web-ui/src/components/settings/HiddenProjectsSetting.test.tsx` first for this codebase's test setup pattern (`render`/`screen`/`waitFor` from `@testing-library/react`, `createMockApi()` from `@/api/mock`, `vi.spyOn`/`vi.fn()` from vitest). Write a test that: renders `<LspSetting api={mockApi} />` where `mockApi.getLspLanguages` is spied/mocked to resolve with a fixture of at least 4 entries covering the four `installCommand`/`installNote` combinations from 2.3; asserts (via `waitFor`) that all entries' `displayName`s appear; asserts a "Missing" badge/text appears for the `installedOnHost: false` entries; asserts a Copy-button element exists only for entries with non-null `installCommand`; asserts note text appears only for entries with non-null `installNote`.
- [ ] **2.T2** In the same test file: a second test where `mockApi.getLspLanguages` is mocked to reject (`vi.spyOn(api, "getLspLanguages").mockRejectedValue(new Error("boom"))`) — assert the rendered output shows an error state (e.g. `screen.getByText(/failed to load/i)`), not zero rows silently.
- [ ] **2.T3** In the same test file: a third test — stub `navigator.clipboard` with `Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true })` before rendering (jsdom has no real clipboard implementation); use `userEvent` (from `@testing-library/user-event`, already a devDependency — see `HiddenProjectsSetting.test.tsx`'s import) to click a Copy button for a row with a known `installCommand`; assert `navigator.clipboard.writeText` was called with exactly that string; assert the button's visible text changes to something containing "Copied" afterward.
- [ ] **2.T4** — this is a MANUAL check, do not try to automate it: run `cd web-ui && npx vitest run src/components/settings/LspSetting.test.tsx` and confirm all new tests pass. Then run `cd web-ui && npx tsc --noEmit` (or the project's existing typecheck script — check `web-ui/package.json`'s `scripts` block for the exact command name, e.g. `npm run typecheck`) to confirm no type errors were introduced across `types.ts`/`client.ts`/`mock.ts`/`SettingsPanel.tsx`/the new component.

## Before you finish

- Mark every `[ ]` above `[x]` in the plan file (`.vibekit/feature-plans/wip/lsp-settings-page/plan-lsp-settings-page.md`, Phase 2 section) as you complete it.
- If you made any deviation from this spec, write a short note under the plan's `## Key Decisions` section (append after any existing deviation notes — don't delete Phase 1's).
- Do NOT commit anything — the orchestrating session handles commits.
- Do NOT touch any `rust/` files — Phase 1 is already done.
- Report back concisely: what you changed, and the exact output of the vitest run and the typecheck command.
