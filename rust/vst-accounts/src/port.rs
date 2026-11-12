//! The `AccountPort` implementation (the spawn-time lookup and the limit
//! signal sink) and the usage/removal planner routes call.

use vst_types::{
    AccountAuth, AccountMethod, AccountPort, AccountResolveError, AccountUsage,
    AccountUsageSession, LimitSignal, ResolvedAccount,
};

use crate::registry::record_locked;
use crate::AccountsHandle;

impl AccountPort for AccountsHandle {
    /// SPAWN-time lookup: unknown => `NotFound`, pending => `Pending`,
    /// signed out => `SignedOut` (R7 — never a silent fallback).
    fn resolve(
        &self,
        cli: &str,
        account_id: Option<&str>,
    ) -> Result<ResolvedAccount, AccountResolveError> {
        let Some(id) = account_id else {
            return Ok(ResolvedAccount::system(cli));
        };
        let (pending, auth, method) = {
            let Ok(state) = self.lock() else {
                return Err(AccountResolveError::NotFound);
            };
            let Some(record) = record_locked(&state, cli, id) else {
                return Err(AccountResolveError::NotFound);
            };
            (record.pending, record.auth, record.method)
        };
        if pending {
            return Err(AccountResolveError::Pending);
        }
        if auth == AccountAuth::SignedOut {
            return Err(AccountResolveError::SignedOut);
        }
        let located = self
            .locate(cli, account_id)
            .ok_or(AccountResolveError::NotFound)?;
        if method == AccountMethod::ApiKey && located.api_key.is_none() {
            tracing::error!(
                cli,
                account = id,
                "API-key account has no readable key file"
            );
            return Err(AccountResolveError::SignedOut);
        }
        Ok(located)
    }

    /// The only writer of the "limited" state (Decision 10).
    fn report_limit(&self, cli: &str, account_id: Option<&str>, signal: LimitSignal) {
        let limited = crate::limit_state::from_signal(&signal);
        if let Err(e) = self.set_limited(cli, account_id, limited) {
            tracing::error!("could not record a chat limit signal: {e}");
        }
    }
}

/// One session, as the caller (routes) sees it, for usage/removal planning.
#[derive(Clone, Copy, Debug)]
pub struct UsageRow<'a> {
    pub session_id: &'a str,
    pub name: Option<&'a str>,
    pub cli: &'a str,
    pub account_id: Option<&'a str>,
    /// The caller decides what "running" means (its own lifecycle knowledge).
    pub running: bool,
}

/// `GET /accounts/:cli/:id/usage` plus the sessions a removal would stop.
#[must_use]
pub fn usage_remove_plan(
    rows: &[UsageRow<'_>],
    cli: &str,
    account_id: Option<&str>,
) -> (AccountUsage, Vec<String>) {
    let mut running = Vec::new();
    let mut stopped = Vec::new();
    let mut past_count = 0_i64;
    for row in rows
        .iter()
        .filter(|r| r.cli == cli && r.account_id == account_id)
    {
        if row.running {
            running.push(AccountUsageSession {
                id: row.session_id.to_string(),
                name: row.name.map(str::to_string),
            });
            stopped.push(row.session_id.to_string());
        } else {
            past_count += 1;
        }
    }
    (
        AccountUsage {
            running,
            past_count,
        },
        stopped,
    )
}
