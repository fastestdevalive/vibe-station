//! Account seam of a JSON-channel session: the accounts registry captured at
//! build time (the ACP connection and the chat limit-signal path have no
//! registry access of their own) and the session's account folder.

use std::path::PathBuf;
use std::sync::Arc;

use vst_types::AccountPort;

use super::{provider_str, JsonAgentSession};

impl JsonAgentSession {
    /// Attach the accounts registry (first call wins). Called at build time by
    /// `get_or_create_json_agent_session` — the ACP connection and the chat
    /// limit-signal path have no registry access of their own (Decision 3).
    pub fn attach_account_port(&self, port: Arc<dyn AccountPort>) {
        let _ = self.0.account_port.set(port);
    }

    /// The accounts registry captured at build time, if any.
    pub(super) fn account_port(&self) -> Option<Arc<dyn AccountPort>> {
        self.0.account_port.get().cloned()
    }

    /// The session's account folder, or `None` for the System login
    /// (Decision 6). Best-effort READ: an unresolvable account yields `None`
    /// (the System store) rather than failing the import — blocking a spawn is
    /// `merge_account_env`'s job, not this lookup's.
    pub(super) fn account_dir(&self) -> Option<PathBuf> {
        let port = self.account_port()?;
        let (cli, account_id) = {
            let s = self.0.state.lock().unwrap();
            (provider_str(self.0.cli), s.session.account_id.clone())
        };
        port.resolve(&cli, account_id.as_deref())
            .ok()
            .and_then(|resolved| resolved.dir)
    }
}
