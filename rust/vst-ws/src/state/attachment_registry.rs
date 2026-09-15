//! In-memory registry of uploaded attachments, keyed by session then upload id.
//!
//! Ports `daemon/src/state/attachmentRegistry.ts` (single home per the arch
//! doc's fix note — not duplicated into `vst-store`). The files themselves live
//! durably under the session data dir; this registry just lets
//! `POST /chat { attachmentIds }` resolve an id → its `Attachment` without
//! re-scanning disk. Intentionally in-memory (v1).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

#[derive(Default)]
struct State {
    by_session: HashMap<String, HashMap<String, Value>>,
}

/// A handle to the attachment registry.
#[derive(Clone, Default)]
pub struct AttachmentRegistry(Arc<Mutex<State>>);

impl AttachmentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_attachment(&self, session_id: &str, attachment_id: &str, attachment: Value) {
        let mut st = self.0.lock().unwrap();
        let map = st.by_session.entry(session_id.to_string()).or_default();
        map.insert(attachment_id.to_string(), attachment);
    }

    pub fn get_attachment(&self, session_id: &str, upload_id: &str) -> Option<Value> {
        self.0
            .lock()
            .unwrap()
            .by_session
            .get(session_id)
            .and_then(|m| m.get(upload_id))
            .cloned()
    }

    /// Remove one upload; returns the removed record (or `None` if already gone).
    pub fn remove_attachment(&self, session_id: &str, upload_id: &str) -> Option<Value> {
        let mut st = self.0.lock().unwrap();
        let map = st.by_session.get_mut(session_id)?;
        let removed = map.remove(upload_id);
        if map.is_empty() {
            st.by_session.remove(session_id);
        }
        removed
    }

    pub fn clear_session_attachments(&self, session_id: &str) {
        self.0.lock().unwrap().by_session.remove(session_id);
    }
}
