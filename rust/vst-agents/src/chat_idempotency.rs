//! `clientMessageId` idempotency for `POST /sessions/:id/chat`.
//!
//! Owns one slot per `(session, clientMessageId)`. A slot is an async mutex
//! over the accepted result: the first send holds the lock while it works and
//! stores its result before releasing, so a duplicate racing it waits and then
//! reads that result instead of enqueuing again. A failed first send leaves the
//! slot empty, so the next waiter becomes the owner.
//!
//! In memory only: lost on daemon restart, forgotten when a session is deleted
//! through `SessionRoutes::delete_session` ([`ChatIdempotency::forget`];
//! worktree/project deletes leave theirs to the size bounds). Bounded to
//! [`MAX_IDS_PER_SESSION`] ids per session and [`MAX_SESSIONS`] tracked sessions
//! (least recently used evicted).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use std::future::Future;

use vst_types::rest::sessions::Delivery;

/// Ids remembered per session.
pub const MAX_IDS_PER_SESSION: usize = 256;
/// Sessions tracked at once (bounds memory when sessions are never deleted).
pub const MAX_SESSIONS: usize = 512;

/// What the first accepted send returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedSend {
    pub turn_id: String,
    pub queue_position: usize,
    pub delivery: Option<Delivery>,
}

/// Why [`ChatIdempotency::accept_once`] gave no result.
#[derive(Debug)]
pub enum AcceptError<E> {
    /// The send itself failed (nothing is remembered; a retry is a fresh send).
    Send(E),
    /// The send task panicked or was aborted.
    Task(String),
}

/// One `(session, clientMessageId)` slot; `None` until a send is accepted.
pub type SendSlot = Arc<tokio::sync::Mutex<Option<AcceptedSend>>>;

#[derive(Default)]
struct SessionIds {
    /// Oldest first; a hit moves the id to the back.
    order: VecDeque<String>,
    slots: HashMap<String, SendSlot>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, SessionIds>,
    /// Oldest first; touched on every `slot` call.
    session_order: VecDeque<String>,
}

/// The per-daemon store (hosted by `JsonAgentRegistry`).
#[derive(Default)]
pub struct ChatIdempotency {
    inner: Mutex<Inner>,
}

impl ChatIdempotency {
    /// The slot for `(session_id, client_message_id)`, created on first use.
    pub fn slot(&self, session_id: &str, client_message_id: &str) -> SendSlot {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        touch(&mut g.session_order, session_id);
        // Evict the least recently used session none of whose slots is held.
        while g.session_order.len() > MAX_SESSIONS {
            let Some(pos) = g.session_order.iter().position(|sid| {
                sid != session_id
                    && g.sessions.get(sid).map_or(true, |ids| {
                        ids.slots.values().all(|s| Arc::strong_count(s) == 1)
                    })
            }) else {
                break;
            };
            if let Some(old) = g.session_order.remove(pos) {
                g.sessions.remove(&old);
            }
        }
        let ids = g.sessions.entry(session_id.to_string()).or_default();
        if let Some(slot) = ids.slots.get(client_message_id).cloned() {
            touch(&mut ids.order, client_message_id);
            return slot;
        }
        // Evict the oldest id whose slot nobody holds (an in-flight send keeps
        // its slot, so it is never evicted from under its own duplicates).
        while ids.order.len() >= MAX_IDS_PER_SESSION {
            let Some(pos) = ids.order.iter().position(|id| {
                ids.slots
                    .get(id)
                    .map_or(true, |s| Arc::strong_count(s) == 1)
            }) else {
                break;
            };
            if let Some(old) = ids.order.remove(pos) {
                ids.slots.remove(&old);
            }
        }
        let slot: SendSlot = Arc::default();
        ids.slots
            .insert(client_message_id.to_string(), slot.clone());
        ids.order.push_back(client_message_id.to_string());
        slot
    }

    /// Run `work` at most once per `(session, clientMessageId)`.
    ///
    /// Returns `(accepted, false)` for the send that ran, `(stored, true)` for a
    /// duplicate (including one that waited on the in-flight first send). `work`
    /// runs in a spawned task owning the slot lock, so a caller that goes away
    /// mid-send (dropped HTTP handler future) can neither abandon a half-done
    /// send nor lose the stored result. A failed `work` stores nothing and the
    /// next waiter becomes the owner.
    pub async fn accept_once<E, F>(
        &self,
        session_id: &str,
        client_message_id: &str,
        work: F,
    ) -> Result<(AcceptedSend, bool), AcceptError<E>>
    where
        F: Future<Output = Result<AcceptedSend, E>> + Send + 'static,
        E: Send + 'static,
    {
        let mut guard = self.slot(session_id, client_message_id).lock_owned().await;
        if let Some(accepted) = guard.as_ref() {
            return Ok((accepted.clone(), true));
        }
        tokio::spawn(async move {
            let accepted = work.await?;
            *guard = Some(accepted.clone());
            Ok((accepted, false))
        })
        .await
        .map_err(|e| AcceptError::Task(e.to_string()))?
        .map_err(AcceptError::Send)
    }

    /// Drop everything remembered for a deleted session.
    pub fn forget(&self, session_id: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.sessions.remove(session_id);
        g.session_order.retain(|s| s != session_id);
    }

    #[cfg(test)]
    fn len(&self, session_id: &str) -> usize {
        let g = self.inner.lock().unwrap();
        g.sessions.get(session_id).map_or(0, |s| s.slots.len())
    }
}

fn touch(order: &mut VecDeque<String>, key: &str) {
    if let Some(pos) = order.iter().position(|k| k == key) {
        order.remove(pos);
    }
    order.push_back(key.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted(id: &str) -> AcceptedSend {
        AcceptedSend {
            turn_id: id.into(),
            queue_position: 0,
            delivery: Some(Delivery::Queued),
        }
    }

    #[test]
    fn same_key_same_slot_distinct_per_session() {
        let c = ChatIdempotency::default();
        assert!(Arc::ptr_eq(&c.slot("s1", "a"), &c.slot("s1", "a")));
        assert!(!Arc::ptr_eq(&c.slot("s1", "a"), &c.slot("s2", "a")));
        assert!(!Arc::ptr_eq(&c.slot("s1", "a"), &c.slot("s1", "b")));
    }

    #[test]
    fn lru_evicts_oldest_and_a_hit_refreshes() {
        let c = ChatIdempotency::default();
        let first = c.slot("s", "id-0");
        for i in 1..MAX_IDS_PER_SESSION {
            let slot = c.slot("s", &format!("id-{i}"));
            *slot.try_lock().unwrap() = Some(accepted(&format!("t{i}")));
        }
        drop(first);
        // Refresh id-0, then overflow by one: id-1 (now oldest) goes.
        let kept = c.slot("s", "id-0");
        c.slot("s", "overflow");
        assert_eq!(c.len("s"), MAX_IDS_PER_SESSION);
        assert!(Arc::ptr_eq(&kept, &c.slot("s", "id-0")));
        // id-1 was the oldest unheld id: evicted, so its slot is recreated empty
        // while a surviving neighbour still holds its stored result.
        assert!(c.slot("s", "id-1").try_lock().unwrap().is_none());
        assert!(c.slot("s", "id-3").try_lock().unwrap().is_some());
    }

    #[test]
    fn held_slot_is_not_evicted() {
        let c = ChatIdempotency::default();
        let held = c.slot("s", "held");
        for i in 0..MAX_IDS_PER_SESSION + 5 {
            c.slot("s", &format!("id-{i}"));
        }
        assert!(Arc::ptr_eq(&held, &c.slot("s", "held")));
    }

    #[test]
    fn forget_drops_session() {
        let c = ChatIdempotency::default();
        let a = c.slot("s", "a");
        c.forget("s");
        assert!(!Arc::ptr_eq(&a, &c.slot("s", "a")));
    }

    #[tokio::test]
    async fn concurrent_owners_serialize_and_duplicate_sees_result() {
        let c = Arc::new(ChatIdempotency::default());
        let owner = c.slot("s", "a").lock_owned().await;
        let c2 = c.clone();
        let dup = tokio::spawn(async move {
            let g = c2.slot("s", "a").lock_owned().await;
            g.clone()
        });
        tokio::task::yield_now().await;
        let mut owner = owner;
        *owner = Some(accepted("t1"));
        drop(owner);
        assert_eq!(dup.await.unwrap(), Some(accepted("t1")));
    }

    #[tokio::test]
    async fn accept_once_runs_work_once_and_reports_duplicates() {
        let c = Arc::new(ChatIdempotency::default());
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let go = |c: Arc<ChatIdempotency>, runs: Arc<std::sync::atomic::AtomicUsize>| async move {
            c.accept_once::<(), _>("s", "a", async move {
                runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                Ok(accepted("t1"))
            })
            .await
        };
        let (a, b) = tokio::join!(go(c.clone(), runs.clone()), go(c.clone(), runs.clone()));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(a.0, b.0);
        assert_ne!(a.1, b.1, "exactly one is the duplicate");
    }

    #[tokio::test]
    async fn accept_once_survives_a_dropped_caller_and_failure_stores_nothing() {
        let c = Arc::new(ChatIdempotency::default());
        // Caller dropped mid-send: the spawned work still finishes and is stored.
        let c2 = c.clone();
        let caller = tokio::spawn(async move {
            let _ = c2
                .accept_once::<(), _>("s", "a", async {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    Ok(accepted("t1"))
                })
                .await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        caller.abort();
        let (stored, dup) = c
            .accept_once::<(), _>("s", "a", async { Ok(accepted("other")) })
            .await
            .unwrap();
        assert!(dup && stored.turn_id == "t1");
        // A failed send is not remembered.
        let err = c
            .accept_once::<&str, _>("s", "b", async { Err("boom") })
            .await;
        assert!(matches!(err, Err(AcceptError::Send("boom"))));
        let (ok, dup) = c
            .accept_once::<&str, _>("s", "b", async { Ok(accepted("t2")) })
            .await
            .unwrap();
        assert!(!dup && ok.turn_id == "t2");
    }

    #[tokio::test]
    async fn failed_owner_leaves_slot_empty_for_next() {
        let c = ChatIdempotency::default();
        drop(c.slot("s", "a").lock_owned().await); // owner failed: nothing stored
        assert!(c.slot("s", "a").lock_owned().await.is_none());
    }
}
