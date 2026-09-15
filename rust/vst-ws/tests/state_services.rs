//! Behavior contract for `vst-ws::state::attachment_registry` and
//! `vst-ws::services::pending_file_opens`. Ports
//! `daemon/src/state/attachmentRegistry.ts` and
//! `daemon/src/services/pendingFileOpens.ts`.

use serde_json::json;
use vst_ws::services::pending_file_opens::PendingFileOpens;
use vst_ws::state::attachment_registry::AttachmentRegistry;

#[test]
fn attachment_register_get_remove_clear() {
    let reg = AttachmentRegistry::new();
    let a1 =
        json!({"id": "u1", "path": "/tmp/x.png", "name": "x.png", "size": 10, "mime": "image/png"});
    reg.register_attachment("s1", "u1", a1.clone());
    assert_eq!(reg.get_attachment("s1", "u1"), Some(a1.clone()));
    assert_eq!(reg.get_attachment("s1", "nope"), None);
    assert_eq!(reg.get_attachment("other", "u1"), None);

    // remove returns the record
    let removed = reg.remove_attachment("s1", "u1");
    assert_eq!(removed, Some(a1.clone()));
    assert_eq!(reg.get_attachment("s1", "u1"), None);

    // clear wipes all for a session
    reg.register_attachment("s2", "u1", a1.clone());
    reg.register_attachment("s2", "u2", a1.clone());
    reg.clear_session_attachments("s2");
    assert_eq!(reg.get_attachment("s2", "u1"), None);
    assert_eq!(reg.get_attachment("s2", "u2"), None);
}

#[test]
fn pending_file_opens_dedupes_and_clears_per_worktree() {
    let q = PendingFileOpens::new();
    q.append("wt-1", "a.txt");
    q.append("wt-1", "b.txt");
    q.append("wt-1", "a.txt"); // dup — no-op
    q.append("wt-2", "c.txt");

    assert_eq!(
        q.get("wt-1"),
        vec!["a.txt".to_string(), "b.txt".to_string()]
    );
    assert_eq!(q.get("wt-2"), vec!["c.txt".to_string()]);
    assert_eq!(q.get("wt-3"), Vec::<String>::new());

    q.clear("wt-1");
    assert_eq!(q.get("wt-1"), Vec::<String>::new());
    assert_eq!(q.get("wt-2"), vec!["c.txt".to_string()]);
}
