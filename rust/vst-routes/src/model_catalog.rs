//! Shared, per-CLI live model catalog.
//!
//! One instance is shared by `ModeRoutes` (`/cli-models`, starter bundles) and
//! `SessionRoutes` (`PATCH /sessions/:id/model`) so a single probe of the CLI's
//! live model list serves them all. There is no static fallback: a failed
//! probe is returned as an error.
//!
//! Callers for the same CLI are serialized on a per-CLI slot, so N concurrent
//! callers share one probe's outcome — success (cached for [`MODELS_TTL`]) or
//! failure (cached only for the very short [`ERROR_TTL`]: enough that a burst of
//! callers queued behind a failing probe share its error instead of each
//! running their own slow probe, but a user-triggered retry after fixing e.g.
//! the login runs a fresh probe).
//!
//! The probe itself runs in a spawned task that owns the slot, so it completes
//! and records its outcome even if the caller that started it is dropped.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use vst_agents::plugin::AgentPlugin;
use vst_types::rest::modes::CliModels;
use vst_types::CliId;

pub const MODELS_TTL: Duration = Duration::from_secs(10 * 60);
pub const ERROR_TTL: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Slot {
    models: Option<(Vec<String>, Instant)>,
    error: Option<(String, Instant)>,
}

#[derive(Clone, Default)]
pub struct ModelCatalog {
    slots: Arc<Mutex<HashMap<CliId, Arc<Mutex<Slot>>>>>,
}

impl ModelCatalog {
    /// Test seam: a catalog whose entry for `cli` is already populated with
    /// `models`, so no probe runs (and no real CLI is needed).
    pub fn seeded(cli: CliId, models: Vec<String>) -> Self {
        let mut map = HashMap::new();
        map.insert(
            cli,
            Arc::new(Mutex::new(Slot {
                models: Some((models, Instant::now())),
                error: None,
            })),
        );
        Self {
            slots: Arc::new(Mutex::new(map)),
        }
    }

    pub async fn get(&self, cli: CliId, plugin: &dyn AgentPlugin) -> CliModels {
        let slot = {
            let mut slots = self.slots.lock().await;
            slots.entry(cli).or_default().clone()
        };
        // Held (owned) by the spawned probe task below, so later callers wait
        // for it and then read its outcome.
        let mut slot = slot.lock_owned().await;

        if let Some((models, at)) = &slot.models {
            if at.elapsed() < MODELS_TTL {
                return CliModels {
                    models: models.clone(),
                    error: None,
                };
            }
        }
        if let Some((err, at)) = &slot.error {
            if at.elapsed() < ERROR_TTL {
                return CliModels {
                    models: Vec::new(),
                    error: Some(err.clone()),
                };
            }
        }

        let probe = plugin.list_models();
        let task = tokio::spawn(async move {
            let result = probe.await;
            match result.error {
                Some(err) => {
                    slot.models = None;
                    slot.error = Some((err.clone(), Instant::now()));
                    CliModels {
                        models: result.models,
                        error: Some(err),
                    }
                }
                None => {
                    slot.error = None;
                    slot.models = Some((result.models.clone(), Instant::now()));
                    CliModels {
                        models: result.models,
                        error: None,
                    }
                }
            }
        });
        task.await.unwrap_or_else(|e| CliModels {
            models: Vec::new(),
            error: Some(format!("model list probe failed: {e}")),
        })
    }
}
