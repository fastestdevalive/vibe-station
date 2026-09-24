# Turn-implement: LSP Settings page — Phase 1 (Backend)

You are implementing exactly ONE phase of a larger plan. The full plan lives at
`.vibekit/feature-plans/wip/lsp-settings-page/plan-lsp-settings-page.md` — you do NOT need to
read the whole file; everything needed for this phase is below.

Read the `coding-agent-guardrails` skill, then the `coding` skill, before touching any file.

## Goal

Add a read-only, host-wide `GET /api/lsp/languages` endpoint that lists every language
`rust/vst-lsp/src/registry.rs` knows about, whether its command is found on PATH, and an
install command/note for missing ones.

## Checklist — implement exactly these items, mark them `[x]` in the plan file at
`.vibekit/feature-plans/wip/lsp-settings-page/plan-lsp-settings-page.md` (Phase 1 section) as
you complete each one:

- [ ] **1.1** `rust/vst-lsp/src/registry.rs`: add `display_name: &'static str`,
  `install_command: Option<&'static str>`, `install_note: Option<&'static str>` fields to the
  `LanguageServerConfig` struct; populate all 16 existing literals in `get_configs()` with the
  values from the table below (the `Some(...)`/`None` values are literal Rust code — copy them
  verbatim, do not re-derive install commands); add `pub fn all() -> &'static [LanguageServerConfig] { get_configs() }`.

  | Language | display_name | install_command | install_note |
  |---|---|---|---|
  | rust | Rust | `Some("rustup component add rust-analyzer")` | `None` |
  | typescript | TypeScript / JavaScript | `Some("npm install -g typescript-language-server typescript")` | `None` |
  | python | Python | `Some("npm install -g pyright")` | `None` |
  | go | Go | `Some("go install golang.org/x/tools/gopls@latest")` | `None` |
  | cpp | C / C++ | `None` | `Some("Debian/Ubuntu: apt install clangd — macOS: brew install llvm (adds clangd to PATH via llvm/bin)")` |
  | zig | Zig | `None` | `Some("See https://github.com/zigtools/zls#installation")` |
  | lua | Lua | `None` | `Some("macOS: brew install lua-language-server — Linux: see https://github.com/LuaLS/lua-language-server#installation")` |
  | ruby | Ruby | `Some("gem install solargraph")` | `None` |
  | java | Java | `None` | `Some("brew install jdtls, or see https://github.com/eclipse-jdtls/eclipse.jdt.ls")` |
  | csharp | C# | `None` | `Some("brew install omnisharp, or see https://github.com/OmniSharp/omnisharp-roslyn#installation")` |
  | latex | LaTeX | `Some("cargo install texlab")` | `Some("macOS alternative: brew install texlab")` |
  | html | HTML | `Some("npm install -g vscode-langservers-extracted")` | `None` |
  | css | CSS | `Some("npm install -g vscode-langservers-extracted")` | `None` |
  | json | JSON | `Some("npm install -g vscode-langservers-extracted")` | `None` |
  | kotlin | Kotlin | `None` | `Some("brew install kotlin-language-server, or see https://github.com/fwcd/kotlin-language-server#installation")` |
  | bash | Bash | `Some("npm install -g bash-language-server")` | `None` |

- [ ] **1.2** `rust/vst-lsp/src/manager.rs`: add `pub fn language_survey(&self) -> Vec<vst_types::rest::lsp::LspLanguageSurveyEntry>` on `LspManager`, in the SAME file as the existing private `fn binary_on_path(cmd: &str) -> bool` (around line 718) — call `binary_on_path` directly, do NOT change its visibility to `pub`. Iterate `registry::all()`, and for each `LanguageServerConfig` build one `LspLanguageSurveyEntry { language: cfg.language.to_string(), display_name: cfg.display_name.to_string(), command: cfg.command.to_string(), installed_on_host: binary_on_path(cfg.command), install_command: cfg.install_command.map(|s| s.to_string()), install_note: cfg.install_note.map(|s| s.to_string()) }`.
- [ ] **1.3** `rust/vst-types/src/rest/lsp.rs`: add two new structs near the existing `LspLanguageStatus`/`LspStatusesResponse` (around line 62-66), matching that file's `#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]` + `#[serde(rename_all = "camelCase")]` style:
  ```rust
  pub struct LspLanguageSurveyEntry {
      pub language: String,
      pub display_name: String,
      pub command: String,
      pub installed_on_host: bool,
      pub install_command: Option<String>,
      pub install_note: Option<String>,
  }

  pub struct LspLanguageSurveyResponse {
      pub languages: Vec<LspLanguageSurveyEntry>,
  }
  ```
- [ ] **1.4** `rust/vst-routes/src/lsp.rs`: on `impl LspRoutes`, add a new method `pub fn language_survey(&self) -> vst_types::rest::lsp::LspLanguageSurveyResponse` that calls `self.lsp_manager.language_survey()` and wraps it as `LspLanguageSurveyResponse { languages: ... }`. No workspace resolution, no `Result` return type — this call cannot fail.
- [ ] **1.5** `rust/vst-daemon/src/server.rs`: add `.route("/lsp/languages", get(handle_lsp_languages))` to the `api` router chain (put it near the `/skills` route around line 697). Add the handler function near `handle_get_skills` (around line 3213):
  ```rust
  async fn handle_lsp_languages(State(state): State<AppState>) -> Json<LspLanguageSurveyResponse> {
      Json(state.lsp_routes.language_survey())
  }
  ```
  You will need to import `LspLanguageSurveyResponse` from `vst_types::rest::lsp` in this file (there's already a `use vst_types::rest::lsp::{...}` block around line 60 — add it there).

## Verify (run these yourself before reporting done)

- [ ] **1.T1** Unit — in `rust/vst-lsp/src/registry.rs`'s existing `#[cfg(test)] mod tests`, add a test asserting: `all()` returns exactly 16 entries; all 16 `language` values are unique; every entry has a non-empty `display_name`; every entry has `install_command.is_some() || install_note.is_some()`; every entry's `language` resolves via `lookup_by_language(entry.language)` to a config with the same `command`. Run: `cd rust && cargo test -p vst-lsp`
- [ ] **1.T2** Integration — new test file `rust/vst-routes/tests/lsp_languages_test.rs`. Build an `LspManager` the same way `rust/vst-routes/tests/lsp_test.rs`'s `test_lsp_root_matches_get_file_exactly` does (`Paths::with_home` + a `tempdir()`), build an `LspRoutes` over it, call `.language_survey()`, assert exactly 16 entries in the response, then for each entry `serde_json::to_value(entry)` and assert its object has exactly the keys `language`, `displayName`, `command`, `installedOnHost`, `installCommand`, `installNote` (camelCase — this is the contract the frontend depends on). Do NOT assert a specific `true`/`false` value for `installedOnHost` on any language — the test runner's installed toolchain varies. Run: `cd rust && cargo test -p vst-routes --test lsp_languages_test`
- [ ] **1.T3** Manual sanity check — run `cd rust && cargo build` (or at minimum `cargo check -p vst-daemon`) to confirm the whole workspace still compiles with the new route wired in.

## Before you finish

- Mark every `[ ]` above `[x]` in the plan file (`.vibekit/feature-plans/wip/lsp-settings-page/plan-lsp-settings-page.md`, Phase 1 section) as you complete it.
- If you made any deviation from this spec (e.g. a field name had to differ, a different file needed the import), write a short note under the plan's `## Key Decisions` section explaining what and why — the next phase's agent will not have any memory of this conversation and needs it in writing.
- Do NOT commit anything — the orchestrating session handles commits.
- Do NOT touch any `web-ui/` files — that's Phase 2, a separate agent.
- Report back concisely: what you changed, and the exact output of the two `cargo test` commands above.
