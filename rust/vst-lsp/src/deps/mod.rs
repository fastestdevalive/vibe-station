//! Per-language, pre-spawn dependency models. A language server whose
//! startup depends on something outside its own binary (typescript-language-
//! server needs a `typescript` package with `lib/tsserver.js`) declares a
//! [`DependencyModel`] on its registry entry; the manager calls it before
//! spawning and never branches on the language itself.

pub mod typescript;

use std::path::{Path, PathBuf};

use serde_json::Value;
use vst_types::rest::lsp::LspFailureKind;

/// Everything a probe may look at. All paths are daemon-resolved; nothing
/// here comes from a workspace-supplied config string.
pub struct ProbeCtx<'a> {
    /// The LSP workspace root.
    pub root: &'a Path,
    /// The server binary as found on `$PATH` (not yet canonicalized).
    pub server_bin: Option<PathBuf>,
    /// `npm root -g`, when npm is on `$PATH` (cached per daemon lifetime).
    pub npm_global_root: Option<PathBuf>,
    /// Daemon home, for the sensitive-path guard on out-of-workspace candidates.
    pub vst_home: &'a Path,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DependencyProbe {
    /// Something usable will be found. `init_options_patch` is deep-merged
    /// into the server's `initializationOptions`; `note` is surfaced as an
    /// info-level `degraded` line while the server is up.
    Ok {
        init_options_patch: Option<Value>,
        note: Option<String>,
    },
    /// Nothing usable to run against.
    Missing {
        summary: String,
        install: Option<String>,
    },
    /// The dependency is present but unusable (e.g. TypeScript 7: no tsserver.js).
    Incompatible {
        summary: String,
        install: Option<String>,
        found: String,
    },
}

/// Backstop only: a stable substring of a server's `initialize` error that
/// upgrades a generic `InitFailed` to a dependency kind when the structural
/// probe said `Ok` but the server disagreed (probe/server version skew).
#[derive(Debug, Clone, Copy)]
pub struct InitErrorHint {
    pub needle: &'static str,
    pub kind: LspFailureKind,
}

#[derive(Debug, Clone, Copy)]
pub struct DependencyModel {
    pub probe: fn(&ProbeCtx) -> DependencyProbe,
    pub init_error_hints: &'static [InitErrorHint],
    /// Summary + install command for a hint-upgraded failure of `kind`.
    pub describe_hint: fn(LspFailureKind, &Path) -> (String, Option<String>),
}

impl DependencyModel {
    /// The dependency kind a raw `initialize` error message maps to, if any.
    pub fn match_hint(&self, message: &str) -> Option<LspFailureKind> {
        self.init_error_hints
            .iter()
            .find(|h| message.contains(h.needle))
            .map(|h| h.kind)
    }
}

/// Deep-merges `patch` into `base` (objects merge key by key; anything else
/// in `patch` replaces). `None` base becomes the patch.
pub fn merge_init_options(base: Option<Value>, patch: Option<Value>) -> Option<Value> {
    fn merge(base: &mut Value, patch: Value) {
        match (base, patch) {
            (Value::Object(b), Value::Object(p)) => {
                for (k, v) in p {
                    merge(b.entry(k).or_insert(Value::Null), v);
                }
            }
            (b, p) => *b = p,
        }
    }
    match (base, patch) {
        (b, None) => b,
        (None, p) => p,
        (Some(mut b), Some(p)) => {
            merge(&mut b, p);
            Some(b)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_keeps_existing_keys_and_adds_patch() {
        let merged = merge_init_options(
            Some(json!({ "tsserver": { "logVerbosity": "off" }, "x": 1 })),
            Some(json!({ "tsserver": { "fallbackPath": "/a/tsserver.js" } })),
        );
        assert_eq!(
            merged,
            Some(json!({
                "tsserver": { "logVerbosity": "off", "fallbackPath": "/a/tsserver.js" },
                "x": 1
            }))
        );
        assert_eq!(
            merge_init_options(None, Some(json!({ "a": 1 }))),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(
            merge_init_options(Some(json!({ "a": 1 })), None),
            Some(json!({ "a": 1 }))
        );
    }
}
