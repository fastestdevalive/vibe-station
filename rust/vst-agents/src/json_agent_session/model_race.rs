//! Session establishment with lost-model-race recovery.
//!
//! Some ACP adapters (opencode) create their session before their own
//! config has loaded and silently fall back to a different model. A plugin
//! that cares about the model says so via
//! [`AgentPlugin::acp_initial_config_option`](crate::AgentPlugin); this module
//! then verifies the model the session REPORTS (`currentValue` from
//! `session/new`/`session/load`), tries to fix it with
//! `session/set_config_option`, and — because a process that lost the race
//! stays lost — disposes and respawns the whole connection within a bounded
//! [`RetryBudget`]. Nothing here knows which CLI it is talking to.

use std::future::Future;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::acp_transport::{AcpTransport, AcpTransportError, InitializeOutcome};

/// Bound on respawn-and-retry. Measured against real opencode (v2.0.18) only
/// ~16% of spawns win the startup race — the race is decided at process start,
/// so waiting in-process does not help — and each attempt costs ~0.45s. Hence
/// many cheap attempts, capped by wall-clock so a hopeless model still fails
/// in bounded time.
#[derive(Debug, Clone, Copy)]
pub(super) struct RetryBudget {
    /// Total connection-setup attempts (first try + retries).
    pub max_attempts: usize,
    /// Give up starting new attempts once this much time has passed since the
    /// first one began (an in-flight attempt is never cut short).
    pub max_elapsed: Duration,
    /// Pause between attempts. Tiny: a fresh process is a fresh race draw,
    /// there is nothing to wait for.
    pub backoff: Duration,
}

pub(super) const RETRY_BUDGET: RetryBudget = RetryBudget {
    max_attempts: 25,
    max_elapsed: Duration::from_secs(12),
    backoff: Duration::from_millis(10),
};

/// Budget for a connection setup whose wanted model already failed to load on
/// the previous setup (see [`select_budget`]): a hopeless model must not cost
/// 12s of respawns on every later turn/respawn.
pub(super) const REDUCED_RETRY_BUDGET: RetryBudget = RetryBudget {
    max_attempts: 3,
    max_elapsed: Duration::from_secs(3),
    backoff: Duration::from_millis(10),
};

/// Pick the retry budget for a setup wanting `wanted`. `last_unrecovered` is
/// the wanted model of the session's last final mismatch; while the wanted
/// model is unchanged the small budget applies, any other model (or none)
/// gets the full one.
pub(super) fn select_budget(last_unrecovered: Option<&str>, wanted: Option<&str>) -> RetryBudget {
    match (last_unrecovered, wanted) {
        (Some(last), Some(w)) if last == w => REDUCED_RETRY_BUDGET,
        _ => RETRY_BUDGET,
    }
}

/// A failed `session/set_config_option` for a model the adapter ITSELF lists
/// means it is refusing a model it knows about; a fresh process draws the
/// same answer, so retrying cannot help. Only a model MISSING from the list
/// (the lost startup race) is worth respawning for.
pub(super) fn refusal_is_final(adapter_models: &[String], wanted: &str) -> bool {
    adapter_models.iter().any(|m| m == wanted)
}

/// What to do with a just-established connection, decided under the same
/// lock acquisition that would store it (so a `set_model` cannot slip in
/// between the check and the store).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SetupVerdict {
    Keep,
    /// The desired model moved during setup: the connection is on a stale model.
    Redo,
}

pub(super) fn setup_verdict(
    started_generation: u64,
    current_generation: u64,
    desired_model: &str,
    active_model: &str,
) -> SetupVerdict {
    if current_generation != started_generation || desired_model != active_model {
        SetupVerdict::Redo
    } else {
        SetupVerdict::Keep
    }
}

/// The ACP session id must be persisted whenever a FRESH session was created,
/// whatever model it ended up on — including after a final [`ModelState::
/// Mismatch`]. A session on the wrong model can still be repaired later
/// (`session/load` + `set_config_option`), whereas dropping the id loses the
/// conversation on the next respawn (and, after a failed `session/load`
/// fallback, would leave the stale unloadable id stored). A resumed session
/// already has its id stored.
pub(super) fn should_persist_session_id(resumed: bool, _model: &ModelState) -> bool {
    !resumed
}

/// Whether the session ended up on the model the plugin asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ModelState {
    /// The plugin has no model preference (no config option), or the adapter
    /// reports no model so it can't be verified — behave as before.
    Unchecked,
    Confirmed,
    /// The session runs on `actual` and could not be moved to the wanted model.
    Mismatch {
        actual: String,
    },
}

pub(super) struct Established<T> {
    pub conn: T,
    pub session_id: String,
    /// `session/load` succeeded (vs. a fresh `session/new`).
    pub resumed: bool,
    /// A `session/load` was attempted but rejected, so a fresh session was made.
    pub load_fell_back: bool,
    pub model: ModelState,
    /// The model the session reported before a successful
    /// `set_config_option` moved it to the wanted one (`None` when no
    /// correction was needed). On a resumed session this is the model the
    /// CLI silently restored, which the caller surfaces to the user.
    pub corrected_from: Option<String>,
    /// Connections spawned to get here (1 = first try succeeded).
    pub attempts: usize,
}

/// Callback `(wanted, actual)` fired on the first mismatch when a retry will follow.
pub(super) type RetryNotifier<'a> = dyn Fn(&str, &str) + Send + Sync + 'a;

pub(super) struct EstablishParams<'a> {
    pub cwd: &'a Path,
    pub prior_session_id: Option<&'a str>,
    pub acp_meta: Option<serde_json::Value>,
    /// `(config_id, value)` from the plugin; `None` = plugin doesn't care.
    pub model_option: Option<(String, String)>,
    /// Best-effort `(config_id, value)` pairs from `acp_session_config_options`.
    pub extra_options: Vec<(String, String)>,
    /// From `acp_model_refusal_is_final`: a refused model set never retries.
    pub refusal_is_final: bool,
    /// Called once, on the FIRST mismatch, only when a retry will actually
    /// follow: `(wanted, actual)`. Lets the caller tell the user why the chat
    /// is about to pause.
    pub on_first_retry: Option<&'a RetryNotifier<'a>>,
}

/// Outcome of [`establish_once`].
struct Attempt {
    session_id: String,
    resumed: bool,
    load_fell_back: bool,
    model: ModelState,
    corrected_from: Option<String>,
    /// True when retrying cannot help (see `refusal_is_final`).
    hopeless: bool,
}

/// One attempt on an already-initialized connection: load-or-new, then verify
/// the model. Never disposes `conn`.
async fn establish_once<T: AcpTransport>(
    conn: &T,
    init: InitializeOutcome,
    p: &EstablishParams<'_>,
) -> Result<Attempt, AcpTransportError> {
    let mut reported: Option<String> = None;
    let mut adapter_models: Vec<String> = Vec::new();
    let mut load_fell_back = false;
    let mut session: Option<(String, bool)> = None;
    if let (true, Some(prior)) = (init.load_session_supported, p.prior_session_id) {
        match conn.load_session(p.cwd, prior, p.acp_meta.clone()).await {
            Ok(o) => {
                reported = o.current_model;
                adapter_models = o.models;
                session = Some((prior.to_string(), true));
            }
            Err(AcpTransportError::SessionLoadFailed(_)) => load_fell_back = true,
            Err(e) => return Err(e),
        }
    }
    let (session_id, resumed) = match session {
        Some(s) => s,
        None => {
            let o = conn.new_session(p.cwd, p.acp_meta.clone()).await?;
            reported = o.current_model;
            adapter_models = o.models;
            (o.session_id, false)
        }
    };

    for (config_id, value) in &p.extra_options {
        if let Err(e) = conn.set_config_option(config_id, value).await {
            tracing::warn!(%config_id, %value, error = %e,
                "acp_session_config_options entry not applied (non-fatal)");
        }
    }

    let mut hopeless = false;
    let mut corrected_from = None;
    let model = match &p.model_option {
        None => ModelState::Unchecked,
        // An empty wanted value carries no preference: nothing to compare or
        // recover (and a set would be bogus).
        Some((_, wanted)) if wanted.is_empty() => ModelState::Unchecked,
        Some((config_id, wanted)) => {
            if reported.as_deref() == Some(wanted.as_str()) {
                ModelState::Confirmed
            } else {
                match conn.set_config_option(config_id, wanted).await {
                    Ok(()) => {
                        corrected_from = reported;
                        ModelState::Confirmed
                    }
                    Err(e) => match reported {
                        Some(actual) => {
                            hopeless =
                                p.refusal_is_final || refusal_is_final(&adapter_models, wanted);
                            tracing::warn!(%config_id, %wanted, %actual, error = %e, hopeless,
                                "model option not applied; session is on a different model");
                            ModelState::Mismatch { actual }
                        }
                        // Adapter doesn't report a model, so nothing to compare:
                        // a failed set is non-fatal, as it always was.
                        None => {
                            tracing::warn!(%config_id, %wanted, error = %e,
                                "acp_initial_config_option failed (non-fatal, model unverifiable)");
                            ModelState::Unchecked
                        }
                    },
                }
            }
        }
    };
    Ok(Attempt {
        session_id,
        resumed,
        load_fell_back,
        model,
        corrected_from,
        hopeless,
    })
}

/// Spawn (via `make_conn`, which must also `initialize`) and establish a
/// session, retrying on a model mismatch within `budget` with a fresh
/// connection each time. Returns the last attempt's outcome, which is
/// still `Mismatch` if every attempt lost — the caller decides how to surface
/// that. Hard errors (spawn/initialize/session failures) propagate at once.
pub(super) async fn establish_with_recovery<T, F, Fut>(
    mut make_conn: F,
    p: &EstablishParams<'_>,
    budget: RetryBudget,
) -> Result<Established<T>, AcpTransportError>
where
    T: AcpTransport,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(T, InitializeOutcome), AcpTransportError>>,
{
    let started = Instant::now();
    let mut attempt = 1;
    loop {
        let (conn, init) = make_conn().await?;
        let a = match establish_once(&conn, init, p).await {
            Ok(r) => r,
            Err(e) => {
                conn.dispose().await;
                return Err(e);
            }
        };
        if let ModelState::Mismatch { actual } = &a.model {
            if !a.hopeless
                && attempt < budget.max_attempts.max(1)
                && started.elapsed() < budget.max_elapsed
            {
                if attempt == 1 {
                    if let (Some(cb), Some((_, wanted))) = (p.on_first_retry, &p.model_option) {
                        cb(wanted, actual);
                    }
                }
                tracing::warn!(
                    attempt,
                    max = budget.max_attempts,
                    "model race lost; respawning agent"
                );
                conn.dispose().await;
                tokio::time::sleep(budget.backoff).await;
                attempt += 1;
                continue;
            }
        }
        return Ok(Established {
            conn,
            session_id: a.session_id,
            resumed: a.resumed,
            load_fell_back: a.load_fell_back,
            model: a.model,
            corrected_from: a.corrected_from,
            attempts: attempt,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp_transport::{LoadSessionOutcome, NewSessionOutcome, PromptTurn, SteerOutcome};
    use agent_client_protocol::schema::v1::ContentBlock;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// Scripted transport. `new_session` reports each entry of `reported` in
    /// turn (the script is shared across respawns); `load_session` reports
    /// `load_model` (or fails when `load_ok` is false); `set_config_option`
    /// succeeds only if `set_ok`; `new_session` hard-fails on spawn number
    /// `fail_new_on_spawn`.
    #[derive(Clone)]
    struct Mock {
        log: Arc<Mutex<Vec<String>>>,
        set_ok: bool,
        reported: Arc<Mutex<Vec<Option<String>>>>,
        load_model: Option<String>,
        load_ok: bool,
        spawn_no: usize,
        fail_new_on_spawn: Option<usize>,
        disposed: Arc<AtomicBool>,
        models: Vec<String>,
    }

    impl AcpTransport for Mock {
        async fn initialize(&self) -> Result<InitializeOutcome, AcpTransportError> {
            Ok(InitializeOutcome {
                load_session_supported: true,
            })
        }
        async fn new_session(
            &self,
            _: &Path,
            _: Option<serde_json::Value>,
        ) -> Result<NewSessionOutcome, AcpTransportError> {
            if self.fail_new_on_spawn == Some(self.spawn_no) {
                return Err(AcpTransportError::RequestFailed("session/new boom".into()));
            }
            let mut r = self.reported.lock().unwrap();
            let cur = if r.len() > 1 {
                r.remove(0)
            } else {
                r[0].clone()
            };
            self.log.lock().unwrap().push("new".into());
            Ok(NewSessionOutcome {
                session_id: "acp-1".into(),
                models: self.models.clone(),
                current_model: cur,
            })
        }
        async fn load_session(
            &self,
            _: &Path,
            _: &str,
            _: Option<serde_json::Value>,
        ) -> Result<LoadSessionOutcome, AcpTransportError> {
            self.log.lock().unwrap().push("load".into());
            if !self.load_ok {
                return Err(AcpTransportError::SessionLoadFailed("gone".into()));
            }
            Ok(LoadSessionOutcome {
                current_model: self.load_model.clone(),
                models: self.models.clone(),
            })
        }
        fn current_session_id(&self) -> Option<String> {
            None
        }
        fn send_prompt(&self, _: &str, _: Vec<ContentBlock>) -> PromptTurn {
            unimplemented!()
        }
        fn cancel_active_prompt(&self) {}
        fn supports_steering(&self) -> bool {
            false
        }
        async fn steer(&self, _: Vec<ContentBlock>) -> SteerOutcome {
            SteerOutcome::Unsupported
        }
        async fn set_config_option(&self, _: &str, _: &str) -> Result<(), AcpTransportError> {
            self.log.lock().unwrap().push("set".into());
            if self.set_ok {
                Ok(())
            } else {
                Err(AcpTransportError::RequestFailed("model not found".into()))
            }
        }
        fn is_alive(&self) -> bool {
            !self.disposed.load(Ordering::SeqCst)
        }
        async fn dispose(&self) {
            self.log.lock().unwrap().push("dispose".into());
            self.disposed.store(true, Ordering::SeqCst);
        }
    }

    fn budget(max_attempts: usize) -> RetryBudget {
        RetryBudget {
            max_attempts,
            max_elapsed: Duration::from_secs(60),
            backoff: Duration::from_millis(1),
        }
    }

    struct Script {
        reported: Vec<Option<&'static str>>,
        set_ok: bool,
        model: Option<&'static str>,
        prior: Option<&'static str>,
        load_model: Option<&'static str>,
        load_ok: bool,
        fail_new_on_spawn: Option<usize>,
        budget: RetryBudget,
        models: Vec<&'static str>,
        refusal_is_final: bool,
        on_first_retry: Option<Box<RetryNotifier<'static>>>,
    }

    impl Script {
        fn new(
            reported: Vec<Option<&'static str>>,
            set_ok: bool,
            model: Option<&'static str>,
        ) -> Self {
            Self {
                reported,
                set_ok,
                model,
                prior: None,
                load_model: None,
                load_ok: true,
                fail_new_on_spawn: None,
                budget: budget(5),
                models: vec![],
                refusal_is_final: false,
                on_first_retry: None,
            }
        }
    }

    async fn run_script(
        sc: Script,
    ) -> (
        Result<Established<Mock>, AcpTransportError>,
        Vec<String>,
        usize,
    ) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let reported = Arc::new(Mutex::new(
            sc.reported
                .into_iter()
                .map(|o| o.map(String::from))
                .collect::<Vec<_>>(),
        ));
        let spawns = Arc::new(Mutex::new(0usize));
        let (l, r, s) = (log.clone(), reported.clone(), spawns.clone());
        let (set_ok, load_ok, fail) = (sc.set_ok, sc.load_ok, sc.fail_new_on_spawn);
        let load_model = sc.load_model.map(String::from);
        let models: Vec<String> = sc.models.iter().map(|m| m.to_string()).collect();
        let p = EstablishParams {
            cwd: Path::new("/tmp"),
            prior_session_id: sc.prior,
            acp_meta: None,
            model_option: sc.model.map(|m| ("model".to_string(), m.to_string())),
            extra_options: Vec::new(),
            refusal_is_final: sc.refusal_is_final,
            on_first_retry: sc
                .on_first_retry
                .as_ref()
                .map(|f| f as &(dyn Fn(&str, &str) + Send + Sync)),
        };
        let est = establish_with_recovery(
            move || {
                let spawn_no = {
                    let mut n = s.lock().unwrap();
                    *n += 1;
                    *n
                };
                let m = Mock {
                    log: l.clone(),
                    set_ok,
                    reported: r.clone(),
                    load_model: load_model.clone(),
                    load_ok,
                    spawn_no,
                    fail_new_on_spawn: fail,
                    disposed: Arc::new(AtomicBool::new(false)),
                    models: models.clone(),
                };
                async move {
                    let init = m.initialize().await?;
                    Ok((m, init))
                }
            },
            &p,
            sc.budget,
        )
        .await;
        let spawns = *spawns.lock().unwrap();
        let log = log.lock().unwrap().clone();
        (est, log, spawns)
    }

    async fn run(
        reported: Vec<Option<&'static str>>,
        set_ok: bool,
        model: Option<&'static str>,
        attempts: usize,
    ) -> (Established<Mock>, Vec<String>, usize) {
        let mut sc = Script::new(reported, set_ok, model);
        sc.budget = budget(attempts);
        let (est, log, spawns) = run_script(sc).await;
        (est.unwrap(), log, spawns)
    }

    #[tokio::test]
    async fn retries_until_the_model_sticks() {
        // Attempts 1-2 lose the race (set fails on "wrong"); attempt 3 reports the wanted model.
        let (est, log, spawns) = run(
            vec![Some("wrong"), Some("wrong"), Some("good")],
            false,
            Some("good"),
            5,
        )
        .await;
        assert_eq!(spawns, 3);
        assert_eq!(est.attempts, 3);
        assert_eq!(est.model, ModelState::Confirmed);
        assert_eq!(log.iter().filter(|e| *e == "dispose").count(), 2);
        assert!(est.conn.is_alive(), "the confirmed connection is kept");
    }

    #[tokio::test]
    async fn set_config_option_success_fixes_a_wrong_model_without_respawn() {
        let (est, _, spawns) = run(vec![Some("wrong")], true, Some("good"), 5).await;
        assert_eq!(est.corrected_from.as_deref(), Some("wrong"));
        assert_eq!((spawns, est.model), (1, ModelState::Confirmed));
    }

    #[tokio::test]
    async fn gives_up_after_bounded_attempts_and_reports_the_mismatch() {
        let (est, log, spawns) = run(vec![Some("wrong")], false, Some("good"), 5).await;
        assert_eq!(spawns, 5);
        assert_eq!(est.attempts, 5);
        assert_eq!(
            est.model,
            ModelState::Mismatch {
                actual: "wrong".into()
            }
        );
        // Every failed attempt but the last is disposed; the last is kept usable.
        assert_eq!(log.iter().filter(|e| *e == "dispose").count(), 4);
        assert!(est.conn.is_alive());
    }

    #[tokio::test]
    async fn wall_clock_budget_stops_retries_before_the_attempt_cap() {
        let mut sc = Script::new(vec![Some("wrong")], false, Some("good"));
        sc.budget = RetryBudget {
            max_attempts: 1000,
            max_elapsed: Duration::ZERO,
            backoff: Duration::from_millis(1),
        };
        let (est, _, spawns) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!(
            spawns, 1,
            "elapsed budget exhausted after the first attempt"
        );
        assert!(matches!(est.model, ModelState::Mismatch { .. }));
    }

    #[tokio::test]
    async fn plugin_without_a_model_option_is_untouched() {
        let (est, log, spawns) = run(vec![Some("anything")], false, None, 5).await;
        assert_eq!((spawns, est.model), (1, ModelState::Unchecked));
        assert!(!log.contains(&"set".to_string()));
    }

    #[tokio::test]
    async fn unreported_model_keeps_legacy_nonfatal_set_failure() {
        let (est, _, spawns) = run(vec![None], false, Some("good"), 5).await;
        assert_eq!((spawns, est.model), (1, ModelState::Unchecked));
    }

    #[tokio::test]
    async fn empty_wanted_model_skips_comparison_and_recovery() {
        let (est, log, spawns) = run(vec![Some("anything")], false, Some(""), 5).await;
        assert_eq!((spawns, est.model), (1, ModelState::Unchecked));
        assert!(!log.contains(&"set".to_string()));
    }

    #[tokio::test]
    async fn hard_error_on_a_later_attempt_propagates_and_disposes() {
        let mut sc = Script::new(vec![Some("wrong")], false, Some("good"));
        sc.fail_new_on_spawn = Some(3);
        let (est, log, spawns) = run_script(sc).await;
        assert!(est.is_err(), "session/new failure on attempt 3 is fatal");
        assert_eq!(spawns, 3);
        // Attempts 1-2 disposed for the retry, attempt 3 disposed on the error.
        assert_eq!(log.iter().filter(|e| *e == "dispose").count(), 3);
    }

    #[tokio::test]
    async fn resumed_session_with_a_different_stored_model_is_fixed_in_place() {
        let mut sc = Script::new(vec![Some("unused")], true, Some("good"));
        sc.prior = Some("acp-old");
        sc.load_model = Some("stored-other");
        let (est, log, spawns) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!((spawns, est.model.clone()), (1, ModelState::Confirmed));
        assert!(est.resumed);
        assert_eq!(est.session_id, "acp-old");
        assert_eq!(*log, ["load", "set"]);
        assert_eq!(est.corrected_from.as_deref(), Some("stored-other"));
    }

    #[tokio::test]
    async fn resumed_session_already_on_the_wanted_model_records_no_correction() {
        let mut sc = Script::new(vec![Some("unused")], true, Some("good"));
        sc.prior = Some("acp-old");
        sc.load_model = Some("good");
        let (est, log, _) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!(est.model, ModelState::Confirmed);
        assert_eq!(est.corrected_from, None);
        assert_eq!(
            *log,
            ["load"],
            "no set when the reported model already matches"
        );
    }

    /// Claude: `session/load` makes the CLI restore the transcript's model
    /// (e.g. `claude-sonnet-4-6`, 200k) and ignores `_meta`'s model; only a
    /// follow-up `set_config_option` re-pins the requested alias. The adapter
    /// lists the alias, so a refusal is final — no respawn loop.
    #[tokio::test]
    async fn claude_style_load_drift_is_re_pinned_without_respawn() {
        let mut sc = Script::new(vec![Some("unused")], true, Some("sonnet"));
        sc.prior = Some("acp-old");
        sc.load_model = Some("claude-sonnet-4-6");
        sc.models = vec!["default", "sonnet", "opus"];
        let (est, log, spawns) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!((spawns, est.model.clone()), (1, ModelState::Confirmed));
        assert!(est.resumed);
        assert_eq!(est.corrected_from.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(*log, ["load", "set"]);
    }

    #[tokio::test]
    async fn resumed_session_whose_model_cannot_be_set_retries() {
        let mut sc = Script::new(vec![Some("unused")], false, Some("good"));
        sc.prior = Some("acp-old");
        sc.load_model = Some("stored-other");
        let (est, _, spawns) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!(spawns, 5);
        assert!(est.resumed);
        assert_eq!(
            est.model,
            ModelState::Mismatch {
                actual: "stored-other".into()
            }
        );
    }

    #[tokio::test]
    async fn failed_load_falls_back_to_a_fresh_session() {
        let mut sc = Script::new(vec![Some("good")], true, Some("good"));
        sc.prior = Some("acp-old");
        sc.load_ok = false;
        let (est, _, _) = run_script(sc).await;
        let est = est.unwrap();
        assert!(est.load_fell_back && !est.resumed);
    }

    #[tokio::test]
    async fn refusal_of_a_listed_model_gives_up_after_one_attempt() {
        let mut sc = Script::new(vec![Some("wrong")], false, Some("good"));
        sc.models = vec!["wrong", "good"];
        let (est, log, spawns) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!((spawns, est.attempts), (1, 1));
        assert!(matches!(est.model, ModelState::Mismatch { .. }));
        assert!(!log.contains(&"dispose".to_string()), "last conn is kept");
    }

    /// Claude: an unlisted value the adapter can't resolve (stale override,
    /// full id) is refused deterministically — never a respawn loop.
    #[tokio::test]
    async fn plugin_declared_final_refusal_never_respawns() {
        let mut sc = Script::new(vec![Some("unused")], false, Some("claude-gone-1"));
        sc.prior = Some("acp-old");
        sc.load_model = Some("claude-sonnet-4-6");
        sc.models = vec!["default", "sonnet"];
        sc.refusal_is_final = true;
        let (est, log, spawns) = run_script(sc).await;
        let est = est.unwrap();
        assert_eq!((spawns, est.attempts), (1, 1));
        assert_eq!(
            est.model,
            ModelState::Mismatch {
                actual: "claude-sonnet-4-6".into()
            }
        );
        assert!(!log.contains(&"dispose".to_string()), "last conn is kept");
    }

    #[tokio::test]
    async fn refusal_of_an_unlisted_model_still_retries() {
        let mut sc = Script::new(vec![Some("wrong")], false, Some("good"));
        sc.models = vec!["wrong"];
        let (_, _, spawns) = run_script(sc).await;
        assert_eq!(spawns, 5);
    }

    #[tokio::test]
    async fn first_retry_callback_fires_once_and_only_when_retrying() {
        use std::sync::atomic::AtomicUsize;
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let mut sc = Script::new(vec![Some("wrong")], false, Some("good"));
        sc.on_first_retry = Some(Box::new(move |w, a| {
            assert_eq!((w, a), ("good", "wrong"));
            c.fetch_add(1, Ordering::SeqCst);
        }));
        let _ = run_script(sc).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "once across 5 attempts");

        // Hopeless refusal: no retry follows, so no "retrying…" notice.
        let c = calls.clone();
        let mut sc = Script::new(vec![Some("wrong")], false, Some("good"));
        sc.models = vec!["wrong", "good"];
        sc.on_first_retry = Some(Box::new(move |_, _| {
            c.fetch_add(100, Ordering::SeqCst);
        }));
        let _ = run_script(sc).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn refusal_is_final_only_for_models_the_adapter_lists() {
        let l = vec!["a".to_string(), "b".to_string()];
        assert!(refusal_is_final(&l, "a"));
        assert!(!refusal_is_final(&l, "c"));
        assert!(!refusal_is_final(&[], "a"));
    }

    #[test]
    fn budget_is_reduced_only_while_the_wanted_model_is_the_unrecovered_one() {
        assert_eq!(select_budget(None, Some("m")).max_attempts, 25);
        assert_eq!(select_budget(Some("m"), Some("m")).max_attempts, 3);
        assert_eq!(
            select_budget(Some("m"), Some("m")).max_elapsed,
            Duration::from_secs(3)
        );
        assert_eq!(select_budget(Some("old"), Some("m")).max_attempts, 25);
        assert_eq!(select_budget(Some("m"), None).max_attempts, 25);
    }

    #[test]
    fn setup_verdict_redoes_on_generation_or_model_change() {
        use SetupVerdict::*;
        assert_eq!(setup_verdict(3, 3, "a", "a"), Keep);
        assert_eq!(setup_verdict(3, 4, "b", "a"), Redo);
        assert_eq!(setup_verdict(3, 3, "b", "a"), Redo);
        // A -> B -> A: the generation moved, so be conservative and redo.
        assert_eq!(setup_verdict(3, 5, "a", "a"), Redo);
    }

    #[test]
    fn session_id_is_persisted_for_fresh_sessions_even_on_final_mismatch() {
        let mismatch = ModelState::Mismatch { actual: "x".into() };
        assert!(should_persist_session_id(false, &mismatch));
        assert!(should_persist_session_id(false, &ModelState::Confirmed));
        assert!(should_persist_session_id(false, &ModelState::Unchecked));
        // A resumed session already has its id stored.
        assert!(!should_persist_session_id(true, &ModelState::Confirmed));
        assert!(!should_persist_session_id(true, &mismatch));
    }
}
