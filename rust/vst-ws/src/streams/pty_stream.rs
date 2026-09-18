//! `PtySessionStream` — adapts `vst_proc::PtyHandle` (direct-pty mode) to the
//! WS `SessionStream` trait.

use vst_proc::PtyHandle;

use crate::connection::SessionStream;
use crate::Error;

/// A direct-PTY stream backed by a shared `vst_proc::PtyHandle`.
///
/// Multiple subscribers share one PTY/stream; the registry in `vst-ws` owns the
/// "at most one live handle per `(connection, session)` key" liveness
/// bookkeeping (per `vst_proc::pty`'s contract).
#[derive(Clone)]
pub struct PtySessionStream {
    pty: PtyHandle,
}

impl PtySessionStream {
    pub fn new(pty: PtyHandle) -> Self {
        PtySessionStream { pty }
    }
}

impl std::fmt::Debug for PtySessionStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtySessionStream")
            .field("pty", &self.pty)
            .finish()
    }
}

#[async_trait::async_trait]
impl SessionStream for PtySessionStream {
    async fn attach(&self, cols: i64, rows: i64, subscriber_id: &str) -> Result<(), Error> {
        self.pty
            .attach(
                cols.clamp(1, u16::MAX as i64) as u16,
                rows.clamp(1, u16::MAX as i64) as u16,
                subscriber_id,
            )
            .await
            .map_err(Error::Proc)
    }

    fn write(&self, data: &str) {
        self.pty.write(data);
    }

    /// Direct-PTY resize is a local `ioctl` (no subprocess), so this is `async`
    /// only to satisfy the trait — it never actually yields.
    async fn resize(&self, cols: i64, rows: i64, subscriber_id: Option<&str>) {
        self.pty.resize(
            cols.clamp(1, u16::MAX as i64) as u16,
            rows.clamp(1, u16::MAX as i64) as u16,
            subscriber_id,
        );
    }

    async fn detach(&self, subscriber_id: &str) -> Result<(), Error> {
        self.pty.detach(subscriber_id).await.map_err(Error::Proc)
    }

    fn on_chunk(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.pty.on_chunk()
    }
    fn on_close(&self) -> tokio::sync::broadcast::Receiver<()> {
        self.pty.on_close()
    }
    fn on_opened(&self) -> tokio::sync::broadcast::Receiver<()> {
        self.pty.on_opened()
    }
    fn on_error(&self) -> tokio::sync::broadcast::Receiver<String> {
        let (_t, rx) = tokio::sync::broadcast::channel(16);
        rx
    }
}
