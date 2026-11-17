//! Wallpaper catalog wire types (`GET /api/wallpapers` and the image route's
//! error body).
//!
//! The catalog is a bundled snapshot owned by `vst-wallpapers`; this module is
//! the only shape clients see. Hand-mirrored in `web-ui/src/api/types.ts`.

use serde::{Deserialize, Serialize};

/// One CC0 wallpaper. `id` is the mobile id (`wp-001`..`wp-031`) and is the
/// stable identity used by every per-client preference.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperEntry {
    pub id: String,
    pub name: String,
    /// `"places"` | `"abstract"` (free-form upstream category).
    pub category: String,
    /// `"dark"` | `"light"` | `"any"`.
    pub mode: String,
    /// Upstream full-size image (https).
    pub url: String,
    /// Upstream thumbnail; equals `url` when the source has no separate thumb.
    pub thumbnail_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_size_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_sha: Option<String>,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// `None` when the source lists the author as "unknown".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_page: Option<String>,
}

/// `GET /api/wallpapers`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WallpaperCatalogResponse {
    pub version: u32,
    pub wallpapers: Vec<WallpaperEntry>,
}

/// Machine-readable wallpaper image error codes (the route's JSON `error`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WallpaperErrorCode {
    WallpaperNotFound,
    WallpaperUnavailable,
    WallpaperBackingOff,
    ValidationError,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry() -> WallpaperEntry {
        WallpaperEntry {
            id: "wp-001".into(),
            name: "Railroads in fog".into(),
            category: "places".into(),
            mode: "any".into(),
            url: "https://images.rawpixel.com/a.jpg".into(),
            thumbnail_url: "https://images.rawpixel.com/a.jpg".into(),
            full_size_sha: Some("abc".into()),
            thumbnail_sha: None,
            width: 683,
            height: 1024,
            license: Some("CC0".into()),
            author: None,
            source_page: None,
        }
    }

    #[test]
    fn catalog_response_serialises_camel_case_and_omits_none() {
        let response = WallpaperCatalogResponse {
            version: 1,
            wallpapers: vec![entry()],
        };
        let value = serde_json::to_value(&response).unwrap();
        let entry = &value["wallpapers"][0];
        assert_eq!(value["version"], json!(1));
        assert_eq!(entry["id"], json!("wp-001"));
        assert_eq!(entry["fullSizeSha"], json!("abc"));
        assert_eq!(
            entry["thumbnailUrl"],
            json!("https://images.rawpixel.com/a.jpg")
        );
        for omitted in ["thumbnailSha", "author", "sourcePage"] {
            assert!(
                entry.get(omitted).is_none(),
                "{omitted} must be omitted when None"
            );
        }
        // Round-trip through the same shape (missing Options default to None).
        let back: WallpaperCatalogResponse = serde_json::from_value(value).unwrap();
        assert_eq!(back, response);
    }

    #[test]
    fn error_codes_are_screaming_snake_case() {
        for (code, text) in [
            (WallpaperErrorCode::WallpaperNotFound, "WALLPAPER_NOT_FOUND"),
            (
                WallpaperErrorCode::WallpaperUnavailable,
                "WALLPAPER_UNAVAILABLE",
            ),
            (
                WallpaperErrorCode::WallpaperBackingOff,
                "WALLPAPER_BACKING_OFF",
            ),
            (WallpaperErrorCode::ValidationError, "VALIDATION_ERROR"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(text));
        }
    }
}
