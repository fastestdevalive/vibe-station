//! `ReadOutcome` (the hardened artifact reader's result) -> HTTP response.
//!
//! Shared by `GET /artifacts/:id/content` (`vst-daemon`) and the in-root
//! `get_file` routes when they serve an artifact outside the root, so both
//! emit the same bytes, status codes, error bodies and hardening headers
//! (plan 4.1/4.4).

use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use vst_artifacts::ReadOutcome;
use vst_types::rest::artifacts::{ArtifactContentError, ArtifactErrorCode};

/// Same value as `vst-daemon`'s `RAW_FILE_CSP` (a daemon test pins equality).
pub const ARTIFACT_CSP: &str =
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/// Header carrying the full size when a text body was cut at the 1 MiB cap.
pub const TRUNCATED_TOTAL_HEADER: &str = "x-vst-truncated-total";

/// `nosniff`, sandbox CSP and `no-store` on every artifact response.
fn harden(mut resp: Response) -> Response {
    let h = resp.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(ARTIFACT_CSP),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn error(
    status: StatusCode,
    code: ArtifactErrorCode,
    message: &str,
    size: Option<u64>,
    mime: Option<String>,
    detail: Option<String>,
) -> Response {
    let body = ArtifactContentError {
        error: code,
        message: message.to_string(),
        size,
        mime,
        detail,
    };
    harden((status, axum::Json(body)).into_response())
}

/// Render an outcome: 200 bytes, or the contract's error status + JSON body.
pub fn outcome_response(outcome: ReadOutcome) -> Response {
    match outcome {
        ReadOutcome::Text {
            bytes,
            total,
            truncated,
            etag,
        } => {
            let mut resp = (
                [(
                    header::CONTENT_TYPE,
                    "text/plain; charset=utf-8".to_string(),
                )],
                bytes,
            )
                .into_response();
            set_etag(&mut resp, &etag);
            if truncated {
                if let Ok(v) = HeaderValue::from_str(&total.to_string()) {
                    resp.headers_mut()
                        .insert(HeaderName::from_static(TRUNCATED_TOTAL_HEADER), v);
                }
            }
            harden(resp)
        }
        ReadOutcome::Image { bytes, mime, etag } => {
            let mut resp = ([(header::CONTENT_TYPE, mime)], bytes).into_response();
            set_etag(&mut resp, &etag);
            harden(resp)
        }
        ReadOutcome::NotFound => error(
            StatusCode::NOT_FOUND,
            ArtifactErrorCode::ArtifactNotFound,
            "No longer an artifact",
            None,
            None,
            None,
        ),
        ReadOutcome::Missing => error(
            StatusCode::GONE,
            ArtifactErrorCode::ArtifactMissing,
            "The file was deleted or moved",
            None,
            None,
            None,
        ),
        ReadOutcome::Denied => error(
            StatusCode::FORBIDDEN,
            ArtifactErrorCode::ArtifactDenied,
            "This file cannot be shown",
            None,
            None,
            None,
        ),
        ReadOutcome::Unreadable { detail } => error(
            StatusCode::FORBIDDEN,
            ArtifactErrorCode::ArtifactUnreadable,
            "The file cannot be read",
            None,
            None,
            Some(detail),
        ),
        ReadOutcome::Binary { size, mime } => error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ArtifactErrorCode::ArtifactBinary,
            "Binary file, preview unavailable",
            Some(size),
            Some(mime),
            None,
        ),
        ReadOutcome::TooLarge { size } => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            ArtifactErrorCode::ArtifactTooLarge,
            "File too large to preview",
            Some(size),
            None,
            None,
        ),
    }
}

fn set_etag(resp: &mut Response, etag: &str) {
    if let Ok(v) = HeaderValue::from_str(etag) {
        resp.headers_mut().insert(header::ETAG, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(o: ReadOutcome) -> StatusCode {
        outcome_response(o).status()
    }

    #[test]
    fn status_matrix() {
        assert_eq!(status(ReadOutcome::NotFound), StatusCode::NOT_FOUND);
        assert_eq!(status(ReadOutcome::Missing), StatusCode::GONE);
        assert_eq!(status(ReadOutcome::Denied), StatusCode::FORBIDDEN);
        assert_eq!(
            status(ReadOutcome::Unreadable {
                detail: "EACCES".into()
            }),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(ReadOutcome::Binary {
                size: 3,
                mime: "application/octet-stream".into()
            }),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            status(ReadOutcome::TooLarge { size: 99 }),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn every_response_is_hardened_and_truncation_is_reported() {
        let r = outcome_response(ReadOutcome::Text {
            bytes: b"hi".to_vec(),
            total: 5_000_000,
            truncated: true,
            etag: "\"e\"".into(),
        });
        let h = r.headers();
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::CONTENT_SECURITY_POLICY], ARTIFACT_CSP);
        assert_eq!(h[header::CACHE_CONTROL], "no-store");
        assert_eq!(h[TRUNCATED_TOTAL_HEADER], "5000000");
        assert_eq!(h[header::ETAG], "\"e\"");
        let r = outcome_response(ReadOutcome::Missing);
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    }
}
