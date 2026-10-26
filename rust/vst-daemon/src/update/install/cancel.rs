//! Cancellation handle shared by the install pipeline: an atomic flag plus a
//! [`tokio::sync::Notify`] so a cancel interrupts an in-flight network await
//! instead of waiting for the next chunk to arrive (which, on a half-open
//! connection, never happens).

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

#[derive(Debug, Default)]
pub struct CancelToken {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation and wake any awaiting [`CancelToken::cancelled`].
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // `notify_one` stores a permit, so a cancel that lands before the
        // waiter parks is not lost.
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once cancellation was requested.
    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            self.notify.notified().await;
        }
    }
}
