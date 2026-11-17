//! The bundled CC0 wallpaper catalog: the one owner of wallpaper ids, names and
//! the upstream image URLs the fetcher is allowed to read.
//!
//! `assets/catalog.json` is a generated snapshot (`scripts/build-wallpaper-catalog.py`);
//! this module validates it at load time so a bad snapshot fails loudly at boot
//! instead of at the first image request.

use std::collections::HashSet;
use std::fmt;
use std::str::FromStr;

use thiserror::Error;
use vst_types::rest::wallpapers::{WallpaperCatalogResponse, WallpaperEntry};

/// Upstream hosts the fetcher may talk to. Every catalog URL must live on one.
pub const HOST_ALLOWLIST: &[&str] = &[
    "images.rawpixel.com",
    "cdn.stocksnap.io",
    "unlauncher-cdn.hundredgb.com",
];

const CATALOG_JSON: &str = include_str!("../assets/catalog.json");
const ID_PREFIX: &str = "wp-";
const ID_DIGITS: usize = 3;
const MODES: [&str; 3] = ["dark", "light", "any"];

/// Which upstream image a request wants. `Thumb` may be the same URL as `Full`
/// when the source has no separate thumbnail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageSize {
    Thumb,
    Full,
}

impl ImageSize {
    /// The wire spelling (`?size=thumb|full`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thumb => "thumb",
            Self::Full => "full",
        }
    }
}

impl fmt::Display for ImageSize {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ImageSize {
    type Err = CatalogError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "thumb" => Ok(Self::Thumb),
            "full" => Ok(Self::Full),
            other => Err(CatalogError::Invalid(format!(
                "unknown image size {other:?} (expected thumb or full)"
            ))),
        }
    }
}

/// Why a catalog could not be loaded.
#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("wallpaper catalog JSON is invalid: {0}")]
    Parse(String),
    #[error("wallpaper catalog is invalid: {0}")]
    Invalid(String),
}

/// A validated catalog snapshot. Cheap to clone (one response body).
#[derive(Clone, Debug)]
pub struct Catalog {
    response: WallpaperCatalogResponse,
}

impl Catalog {
    /// The snapshot compiled into the binary.
    ///
    /// # Errors
    /// `CatalogError` when the bundled JSON fails validation — it is
    /// `include_str!` data guarded by unit tests, so this means a broken build.
    pub fn bundled() -> Result<Self, CatalogError> {
        Self::from_json(CATALOG_JSON)
    }

    /// Parse and validate a catalog document (tests, tooling).
    ///
    /// # Errors
    /// `CatalogError::Parse` for malformed JSON, `CatalogError::Invalid` for a
    /// document that breaks the catalog rules (empty, bad id, duplicate id,
    /// unknown mode, or a URL that is not https / allowlisted / userinfo-free).
    pub fn from_json(text: &str) -> Result<Self, CatalogError> {
        let response: WallpaperCatalogResponse =
            serde_json::from_str(text).map_err(|err| CatalogError::Parse(err.to_string()))?;
        validate(&response)?;
        Ok(Self { response })
    }

    /// The wire shape served by `GET /api/wallpapers`.
    #[must_use]
    pub fn response(&self) -> &WallpaperCatalogResponse {
        &self.response
    }

    /// One entry by id, or `None` for an unknown / removed id.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&WallpaperEntry> {
        self.response.wallpapers.iter().find(|e| e.id == id)
    }

    /// The upstream URL to fetch for `id` and `size`; `None` for an unknown id.
    #[must_use]
    pub fn url_for(&self, id: &str, size: ImageSize) -> Option<&str> {
        let entry = self.get(id)?;
        Some(match size {
            ImageSize::Thumb => entry.thumbnail_url.as_str(),
            ImageSize::Full => entry.url.as_str(),
        })
    }

    /// Distinct upstream hosts used by the catalog, sorted. Feeds
    /// `FetchPolicy::allowed_hosts` so the fetcher can never leave the snapshot.
    #[must_use]
    pub fn hosts(&self) -> Vec<String> {
        let mut hosts = std::collections::BTreeSet::new();
        for entry in &self.response.wallpapers {
            for raw in [entry.url.as_str(), entry.thumbnail_url.as_str()] {
                if let Some(host) = reqwest::Url::parse(raw)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                {
                    hosts.insert(host);
                }
            }
        }
        hosts.into_iter().collect()
    }
}

fn validate(response: &WallpaperCatalogResponse) -> Result<(), CatalogError> {
    if response.wallpapers.is_empty() {
        return Err(CatalogError::Invalid("catalog has no wallpapers".into()));
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for entry in &response.wallpapers {
        if !is_wallpaper_id(&entry.id) {
            return Err(CatalogError::Invalid(format!(
                "id {:?} is not wp-NNN",
                entry.id
            )));
        }
        if !seen.insert(entry.id.as_str()) {
            return Err(CatalogError::Invalid(format!(
                "duplicate id {:?}",
                entry.id
            )));
        }
        if !MODES.contains(&entry.mode.as_str()) {
            return Err(CatalogError::Invalid(format!(
                "id {:?} has unknown mode {:?}",
                entry.id, entry.mode
            )));
        }
        check_url(&entry.id, "url", &entry.url)?;
        check_url(&entry.id, "thumbnailUrl", &entry.thumbnail_url)?;
    }
    Ok(())
}

fn is_wallpaper_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix(ID_PREFIX) else {
        return false;
    };
    rest.len() == ID_DIGITS && rest.bytes().all(|b| b.is_ascii_digit())
}

fn check_url(id: &str, field: &str, raw: &str) -> Result<(), CatalogError> {
    let parsed = reqwest::Url::parse(raw)
        .map_err(|err| CatalogError::Invalid(format!("{id} {field} is not a URL: {err}")))?;
    if parsed.scheme() != "https" {
        return Err(CatalogError::Invalid(format!("{id} {field} is not https")));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CatalogError::Invalid(format!(
            "{id} {field} carries userinfo"
        )));
    }
    let Some(host) = parsed.host_str() else {
        return Err(CatalogError::Invalid(format!("{id} {field} has no host")));
    };
    if !HOST_ALLOWLIST.contains(&host) {
        return Err(CatalogError::Invalid(format!(
            "{id} {field} host {host:?} is not allowlisted"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW_URL: &str = "https://images.rawpixel.com/a.jpg";

    fn entry_json(id: &str, url: &str, thumbnail_url: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "name": "Test wallpaper",
            "category": "places",
            "mode": "any",
            "url": url,
            "thumbnailUrl": thumbnail_url,
            "width": 683,
            "height": 1024,
            "license": "CC0",
        })
    }

    fn document(entries: &[serde_json::Value]) -> String {
        serde_json::json!({ "version": 1, "wallpapers": entries }).to_string()
    }

    #[test]
    fn bundled_catalog_has_31_unique_ids() {
        let catalog = Catalog::bundled().expect("bundled catalog is valid");
        let response = catalog.response();
        assert_eq!(response.version, 1);
        assert_eq!(response.wallpapers.len(), 31);
        let ids: Vec<&str> = response
            .wallpapers
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(ids.first().copied(), Some("wp-001"));
        assert_eq!(ids.last().copied(), Some("wp-031"));
        let unique: HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), 31, "ids must be unique");
    }

    #[test]
    fn bundled_urls_are_https_allowlisted_hosts() {
        let catalog = Catalog::bundled().expect("bundled catalog is valid");
        for entry in &catalog.response().wallpapers {
            for raw in [&entry.url, &entry.thumbnail_url] {
                let url = reqwest::Url::parse(raw).expect("catalog URL parses");
                assert_eq!(url.scheme(), "https", "{} {raw}", entry.id);
                assert!(url.username().is_empty(), "{} has userinfo", entry.id);
                assert!(url.password().is_none(), "{} has userinfo", entry.id);
                let host = url.host_str().expect("catalog URL has a host");
                assert!(
                    HOST_ALLOWLIST.contains(&host),
                    "{} host {host} is not allowlisted",
                    entry.id
                );
            }
        }
        let hosts = catalog.hosts();
        assert_ne!(hosts.len(), 0);
        assert!(hosts
            .iter()
            .all(|host| HOST_ALLOWLIST.contains(&host.as_str())));
    }

    #[test]
    fn url_for_unknown_id_is_none() {
        let catalog = Catalog::bundled().expect("bundled catalog is valid");
        assert!(catalog.get("wp-999").is_none());
        assert!(catalog.url_for("wp-999", ImageSize::Full).is_none());
        assert!(catalog.url_for("wp-999", ImageSize::Thumb).is_none());
        assert!(catalog.url_for("nonsense", ImageSize::Full).is_none());
        assert_eq!(
            catalog.url_for("wp-001", ImageSize::Full),
            Some(catalog.get("wp-001").unwrap().url.as_str())
        );
    }

    #[test]
    fn thumb_falls_back_to_full_url_when_equal() {
        let catalog = Catalog::from_json(&document(&[entry_json("wp-001", RAW_URL, RAW_URL)]))
            .expect("single-entry catalog is valid");
        assert_eq!(catalog.url_for("wp-001", ImageSize::Thumb), Some(RAW_URL));
        assert_eq!(catalog.url_for("wp-001", ImageSize::Full), Some(RAW_URL));
    }

    #[test]
    fn rejects_http_url() {
        let err = Catalog::from_json(&document(&[entry_json(
            "wp-001",
            "http://images.rawpixel.com/a.jpg",
            RAW_URL,
        )]))
        .expect_err("http URL must be rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn rejects_host_not_in_allowlist() {
        let err = Catalog::from_json(&document(&[entry_json(
            "wp-001",
            "https://evil.example/a.jpg",
            RAW_URL,
        )]))
        .expect_err("unknown host must be rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn rejects_url_with_userinfo() {
        let err = Catalog::from_json(&document(&[entry_json(
            "wp-001",
            "https://user:secret@images.rawpixel.com/a.jpg",
            RAW_URL,
        )]))
        .expect_err("userinfo must be rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn rejects_duplicate_ids() {
        let err = Catalog::from_json(&document(&[
            entry_json("wp-001", RAW_URL, RAW_URL),
            entry_json("wp-001", RAW_URL, RAW_URL),
        ]))
        .expect_err("duplicate ids must be rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn rejects_unknown_mode() {
        let mut entry = entry_json("wp-001", RAW_URL, RAW_URL);
        entry["mode"] = serde_json::json!("sepia");
        let err = Catalog::from_json(&document(&[entry])).expect_err("unknown mode is rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn rejects_empty_catalog() {
        let err = Catalog::from_json(&document(&[])).expect_err("empty catalog is rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn rejects_id_not_matching_wp_nnn() {
        let err = Catalog::from_json(&document(&[entry_json("wallpaper-1", RAW_URL, RAW_URL)]))
            .expect_err("bad id shape is rejected");
        assert!(matches!(err, CatalogError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn author_unknown_is_none() {
        let catalog = Catalog::bundled().expect("bundled catalog is valid");
        for entry in &catalog.response().wallpapers {
            if let Some(author) = &entry.author {
                assert!(
                    !author.eq_ignore_ascii_case("unknown"),
                    "{} kept the placeholder author",
                    entry.id
                );
            }
        }
        // wp-001's mobile author is "unknown", so the snapshot has no author.
        assert_eq!(catalog.get("wp-001").unwrap().author, None);

        let mut entry = entry_json("wp-001", RAW_URL, RAW_URL);
        entry["author"] = serde_json::Value::Null;
        let catalog = Catalog::from_json(&document(&[entry])).expect("null author is valid");
        assert_eq!(catalog.get("wp-001").unwrap().author, None);
    }

    #[test]
    fn image_size_parses_thumb_and_full_only() {
        assert!(matches!("thumb".parse::<ImageSize>(), Ok(ImageSize::Thumb)));
        assert!(matches!("full".parse::<ImageSize>(), Ok(ImageSize::Full)));
        for bad in ["large", "", "Thumb", "FULL", "thumb "] {
            assert!(
                bad.parse::<ImageSize>().is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert_eq!(ImageSize::Thumb.to_string(), "thumb");
        assert_eq!(ImageSize::Full.to_string(), "full");
        assert_eq!(ImageSize::Thumb.as_str(), "thumb");
    }
}
