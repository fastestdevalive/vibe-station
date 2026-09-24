use serde_json::json;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct LanguageServerConfig {
    pub language: &'static str,
    pub display_name: &'static str,
    pub command: &'static str,
    pub args: Vec<String>,
    pub extensions: &'static [&'static str],
    pub init_options: Option<serde_json::Value>,
    pub extra_env: Vec<(String, String)>,
    pub install_command: Option<&'static str>,
    pub install_note: Option<&'static str>,
}

pub fn all() -> &'static [LanguageServerConfig] {
    get_configs()
}

static SERVERS: OnceLock<Vec<LanguageServerConfig>> = OnceLock::new();

fn get_configs() -> &'static [LanguageServerConfig] {
    SERVERS.get_or_init(|| {
        vec![
            LanguageServerConfig {
                language: "rust",
                display_name: "Rust",
                command: "rust-analyzer",
                args: vec![],
                extensions: &["rs"],
                init_options: Some(json!({
                    "checkOnSave": {
                        "enable": false
                    }
                })),
                extra_env: vec![],
                install_command: Some("rustup component add rust-analyzer"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "typescript",
                display_name: "TypeScript / JavaScript",
                command: "typescript-language-server",
                args: vec!["--stdio".to_string()],
                extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("npm install -g typescript-language-server typescript"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "python",
                display_name: "Python",
                command: "pyright-langserver",
                args: vec!["--stdio".to_string()],
                extensions: &["py"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("npm install -g pyright"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "go",
                display_name: "Go",
                command: "gopls",
                args: vec![],
                extensions: &["go"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("go install golang.org/x/tools/gopls@latest"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "cpp",
                display_name: "C / C++",
                command: "clangd",
                args: vec![],
                extensions: &["c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "mm", "m"],
                init_options: None,
                extra_env: vec![],
                install_command: None,
                install_note: Some("Debian/Ubuntu: apt install clangd — macOS: brew install llvm (adds clangd to PATH via llvm/bin)"),
            },
            LanguageServerConfig {
                language: "zig",
                display_name: "Zig",
                command: "zls",
                args: vec![],
                extensions: &["zig"],
                init_options: None,
                extra_env: vec![],
                install_command: None,
                install_note: Some("See https://github.com/zigtools/zls#installation"),
            },
            LanguageServerConfig {
                language: "lua",
                display_name: "Lua",
                command: "lua-language-server",
                args: vec![],
                extensions: &["lua"],
                init_options: None,
                extra_env: vec![],
                install_command: None,
                install_note: Some("macOS: brew install lua-language-server — Linux: see https://github.com/LuaLS/lua-language-server#installation"),
            },
            LanguageServerConfig {
                language: "ruby",
                display_name: "Ruby",
                command: "solargraph",
                args: vec!["stdio".to_string()],
                extensions: &["rb"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("gem install solargraph"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "java",
                display_name: "Java",
                command: "jdtls",
                args: vec![],
                extensions: &["java"],
                init_options: None,
                extra_env: vec![],
                install_command: None,
                install_note: Some("brew install jdtls, or see https://github.com/eclipse-jdtls/eclipse.jdt.ls"),
            },
            LanguageServerConfig {
                language: "csharp",
                display_name: "C#",
                command: "omnisharp",
                args: vec!["-lsp".to_string()],
                extensions: &["cs"],
                init_options: None,
                extra_env: vec![],
                install_command: None,
                install_note: Some("brew install omnisharp, or see https://github.com/OmniSharp/omnisharp-roslyn#installation"),
            },
            LanguageServerConfig {
                language: "latex",
                display_name: "LaTeX",
                command: "texlab",
                args: vec![],
                extensions: &["tex", "sty", "cls"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("cargo install texlab"),
                install_note: Some("macOS alternative: brew install texlab"),
            },
            LanguageServerConfig {
                language: "html",
                display_name: "HTML",
                command: "vscode-html-language-server",
                args: vec!["--stdio".to_string()],
                extensions: &["html", "htm"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("npm install -g vscode-langservers-extracted"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "css",
                display_name: "CSS",
                command: "vscode-css-language-server",
                args: vec!["--stdio".to_string()],
                extensions: &["css", "scss", "less"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("npm install -g vscode-langservers-extracted"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "json",
                display_name: "JSON",
                command: "vscode-json-language-server",
                args: vec!["--stdio".to_string()],
                extensions: &["json", "jsonc"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("npm install -g vscode-langservers-extracted"),
                install_note: None,
            },
            LanguageServerConfig {
                language: "kotlin",
                display_name: "Kotlin",
                command: "kotlin-language-server",
                args: vec![],
                extensions: &["kt", "kts"],
                init_options: None,
                extra_env: vec![],
                install_command: None,
                install_note: Some("brew install kotlin-language-server, or see https://github.com/fwcd/kotlin-language-server#installation"),
            },
            LanguageServerConfig {
                language: "bash",
                display_name: "Bash",
                command: "bash-language-server",
                args: vec!["start".to_string()],
                extensions: &["sh", "bash"],
                init_options: None,
                extra_env: vec![],
                install_command: Some("npm install -g bash-language-server"),
                install_note: None,
            },
        ]
    })
}

pub fn lookup(ext: &str) -> Option<&'static LanguageServerConfig> {
    let clean_ext = ext.trim_start_matches('.');
    get_configs().iter().find(|cfg| {
        cfg.extensions.iter().any(|&e| e.eq_ignore_ascii_case(clean_ext))
    })
}

pub fn lookup_by_language(lang: &str) -> Option<&'static LanguageServerConfig> {
    get_configs().iter().find(|cfg| {
        cfg.language.eq_ignore_ascii_case(lang)
            || (cfg.language == "cpp" && (lang.eq_ignore_ascii_case("c") || lang.eq_ignore_ascii_case("c++") || lang.eq_ignore_ascii_case("c/c++")))
            || (cfg.language == "csharp" && (lang.eq_ignore_ascii_case("cs") || lang.eq_ignore_ascii_case("c#")))
            || (cfg.language == "latex" && lang.eq_ignore_ascii_case("tex"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_lookups() {
        let cpp_cfg = lookup("cpp").expect("clangd config for cpp");
        assert_eq!(cpp_cfg.command, "clangd");
        assert_eq!(cpp_cfg.language, "cpp");
        assert!(cpp_cfg.args.is_empty());

        let rb_cfg = lookup("rb").expect("solargraph config for rb");
        assert_eq!(rb_cfg.command, "solargraph");
        assert_eq!(rb_cfg.args, vec!["stdio".to_string()]);

        let sh_cfg = lookup("sh").expect("bash-language-server config for sh");
        assert_eq!(sh_cfg.command, "bash-language-server");
        assert_eq!(sh_cfg.args, vec!["start".to_string()]);

        let java_cfg = lookup_by_language("java").expect("jdtls config for java");
        assert_eq!(java_cfg.command, "jdtls");
        assert_eq!(java_cfg.language, "java");

        assert!(lookup("xyz").is_none());

        // Alias lookups
        assert_eq!(lookup_by_language("c").unwrap().command, "clangd");
        assert_eq!(lookup_by_language("c++").unwrap().command, "clangd");
        assert_eq!(lookup_by_language("csharp").unwrap().command, "omnisharp");
        assert_eq!(lookup_by_language("c#").unwrap().command, "omnisharp");
        assert_eq!(lookup_by_language("cs").unwrap().command, "omnisharp");
        assert_eq!(lookup_by_language("tex").unwrap().command, "texlab");
    }

    #[test]
    fn test_all_language_survey_entries() {
        let entries = all();
        assert_eq!(entries.len(), 16);

        let mut langs = std::collections::HashSet::new();
        for entry in entries {
            assert!(!entry.display_name.is_empty(), "empty display_name for {}", entry.language);
            assert!(
                entry.install_command.is_some() || entry.install_note.is_some(),
                "{} has neither install_command nor install_note",
                entry.language
            );
            let resolved = lookup_by_language(entry.language)
                .unwrap_or_else(|| panic!("language {} does not resolve via lookup_by_language", entry.language));
            assert_eq!(resolved.command, entry.command);
            assert!(langs.insert(entry.language), "duplicate language {}", entry.language);
        }
        assert_eq!(langs.len(), 16);
    }
}
