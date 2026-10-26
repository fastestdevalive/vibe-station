//! Cache headers for the SPA fallback (app update flow): Vite's content-hashed
//! `assets/` are immutable, and `index.html` is revalidated on every load so a
//! daemon restarted onto a new version never serves a stale bundle entry point.

use axum::http::header;
use axum::response::{IntoResponse, Response};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Vite's content-hashed bundle directory. A miss here is a 404, never
/// `index.html` (an old tab would otherwise parse HTML as a JS chunk).
pub(super) fn is_hashed_asset(path: &str) -> bool {
    path.starts_with("assets/")
}

/// A real file of the web UI; `path` is relative to the dist root.
pub(super) fn file_response(path: &str, mime: String, body: Vec<u8>) -> Response {
    if is_hashed_asset(path) {
        let headers = [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, IMMUTABLE.to_string()),
        ];
        (headers, body).into_response()
    } else {
        ([(header::CONTENT_TYPE, mime)], body).into_response()
    }
}

/// The SPA entry point.
pub(super) fn index_response(body: impl IntoResponse) -> Response {
    let headers = [
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        (header::CACHE_CONTROL, "no-cache"),
    ];
    (headers, body).into_response()
}
