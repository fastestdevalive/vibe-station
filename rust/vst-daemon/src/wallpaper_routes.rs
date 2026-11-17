//! Thin REST handlers for the wallpaper catalog and its images
//! (`GET /api/wallpapers`, `GET /api/wallpapers/:id/image`). Mounted under
//! `/api` by `server.rs`.
//!
//! Every rule — the bundled catalog, the upstream allowlist, caps, the disk
//! cache and backoff — lives in `vst-wallpapers`; these handlers only parse,
//! call [`vst_wallpapers::WallpaperHandle`] and serialise.

use axum::body::Body;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use vst_types::rest::wallpapers::{WallpaperCatalogResponse, WallpaperErrorCode};
use vst_wallpapers::{ImageError, ImageSize, ServedImage};

use crate::server::AppState;

/// A cached image may be reused for a day; auth cookies keep it private.
const CACHE_CONTROL: &str = "private, max-age=86400";

/// The wallpaper routes, relative to `/api`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/wallpapers", get(list_wallpapers))
        .route("/wallpapers/:id/image", get(wallpaper_image))
}

async fn list_wallpapers(State(state): State<AppState>) -> Json<WallpaperCatalogResponse> {
    // A borrow cannot outlive the handler's return type; the catalog is small
    // and cloned once per request.
    Json(state.wallpapers.catalog().clone())
}

#[derive(Debug, Deserialize)]
struct ImageQuery {
    size: Option<String>,
}

async fn wallpaper_image(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: Result<Query<ImageQuery>, QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let Ok(Query(query)) = query else {
        return error_response(
            StatusCode::BAD_REQUEST,
            WallpaperErrorCode::ValidationError,
            "Invalid query string",
        );
    };
    let size = match query.size.as_deref() {
        None | Some("full") => ImageSize::Full,
        Some("thumb") => ImageSize::Thumb,
        Some(other) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                WallpaperErrorCode::ValidationError,
                &format!("Unknown size {other:?} (expected thumb or full)"),
            );
        }
    };

    match state.wallpapers.image(&id, size).await {
        Ok(image) => image_response(image, &headers),
        Err(e) => image_error(e),
    }
}

fn error_response(status: StatusCode, code: WallpaperErrorCode, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": code, "message": message })),
    )
        .into_response()
}

fn image_error(e: ImageError) -> Response {
    match e {
        ImageError::UnknownId => error_response(
            StatusCode::NOT_FOUND,
            WallpaperErrorCode::WallpaperNotFound,
            "Unknown wallpaper",
        ),
        // `Unavailable` carries a fetch-error kind (never a URL or body).
        ImageError::Unavailable(kind) => error_response(
            StatusCode::BAD_GATEWAY,
            WallpaperErrorCode::WallpaperUnavailable,
            &format!("Wallpaper unavailable ({kind})"),
        ),
        ImageError::BackingOff { retry_after_secs } => {
            let mut response = error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                WallpaperErrorCode::WallpaperBackingOff,
                "Wallpaper fetch is backing off",
            );
            let retry_after = HeaderValue::from_str(&retry_after_secs.to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("5"));
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, retry_after);
            response
        }
    }
}

fn image_response(image: ServedImage, request_headers: &HeaderMap) -> Response {
    let etag = image.etag;
    if if_none_match_matches(request_headers, &etag) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .header(header::CACHE_CONTROL, CACHE_CONTROL)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, image.content_type)
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, CACHE_CONTROL)
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header("x-content-type-options", "nosniff")
        .body(Body::from(
            std::sync::Arc::try_unwrap(image.bytes).unwrap_or_else(|shared| (*shared).clone()),
        ))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `If-None-Match` uses the weak comparison: `W/"x"` and `"x"` both match.
fn if_none_match_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim().trim_start_matches("W/");
                candidate == "*" || candidate == etag
            })
        })
}
