//! 1.T13 (R84): comment text, quotes and messages never reach the logs. Its own
//! test binary so a process-global subscriber sees every event.

mod common;

use std::sync::{Arc, Mutex};

use common::{body, Env};
use vst_types::rest::review::{AttachBody, DetachBody, PatchCommentBody, RenderBody};

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Buf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
    type Writer = Buf;
    fn make_writer(&'a self) -> Buf {
        self.clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_comment_body_reaches_the_logs_at_debug_or_above() {
    let buf = Buf::default();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_max_level(tracing::Level::DEBUG)
            .finish(),
    )
    .unwrap();

    let env = Env::new().await;
    let mut b = body("c1", "src/lib.rs", 3);
    b.text = "SECRET-COMMENT-TEXT".into();
    b.quote = "SECRET-QUOTE".into();
    env.review.create(&env.wt, b).await.unwrap();
    env.review
        .patch(
            "c1",
            PatchCommentBody {
                text: "SECRET-EDITED-TEXT".into(),
                version: None,
            },
        )
        .await
        .unwrap();
    env.review
        .attach(
            &env.wt,
            AttachBody {
                composer_key: "session:s".into(),
                comment_ids: None,
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    env.review
        .detach(
            &env.wt,
            DetachBody {
                composer_key: None,
                comment_ids: None,
            },
        )
        .await
        .unwrap();
    env.review
        .render(
            &env.wt,
            RenderBody {
                comment_ids: None,
                message: Some("SECRET-MESSAGE".into()),
            },
        )
        .await
        .unwrap();
    // Rejected input is logged (if at all) without its body either.
    let mut bad = body("c2", "bad\npath", 1);
    bad.text = "SECRET-REJECTED".into();
    let _ = env.review.create(&env.wt, bad).await;
    env.advance(3600);
    env.review.sweep_leases().await;
    env.review.delete("c1").await.unwrap();
    env.review.flush_events();

    let logged = String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned();
    assert!(
        logged.contains("comment created"),
        "the capture must see the create log, or this test proves nothing:\n{logged}"
    );
    for secret in [
        "SECRET-COMMENT-TEXT",
        "SECRET-QUOTE",
        "SECRET-EDITED-TEXT",
        "SECRET-MESSAGE",
        "SECRET-REJECTED",
    ] {
        assert!(
            !logged.contains(secret),
            "{secret} leaked into logs:\n{logged}"
        );
    }
}

/// Static guard next to the runtime one: no logging macro in this crate names a
/// body-carrying field or interpolates one.
#[test]
fn no_logging_macro_in_the_crate_mentions_a_body() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(src).unwrap() {
        let path = entry.unwrap().path();
        let text = std::fs::read_to_string(&path).unwrap();
        // Join each macro call (they wrap across lines) up to its closing `);`.
        let mut rest = text.as_str();
        while let Some(i) = ["info!(", "warn!(", "error!(", "debug!(", "trace!("]
            .iter()
            .filter_map(|m| rest.find(m))
            .min()
        {
            let tail = &rest[i..];
            let end = tail.find(");").unwrap_or(tail.len());
            let call = &tail[..end];
            for banned in ["text", "quote", "message", "body", "snapshot", "paste"] {
                assert!(
                    !call
                        .split(|c: char| !c.is_alphanumeric() && c != '_')
                        .any(|w| w == banned),
                    "{}: logging call mentions `{banned}`: {call}",
                    path.display()
                );
            }
            rest = &tail[end..];
        }
    }
}
