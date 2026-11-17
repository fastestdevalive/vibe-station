#![forbid(unsafe_code)]
//! `vst-wallpapers` — the single owner of the wallpaper catalog and its image
//! cache: the bundled catalog snapshot, one bounded allowlisted fetcher, the
//! on-disk cache, and the handle that turns a catalog id + size into served
//! bytes (`WallpaperHandle`, wrapped by the daemon's thin `/api/wallpapers*`
//! routes).
//!
//! Dependency direction (AGENTS.md): this crate depends on `vst-types` only;
//! no other library crate depends on this one.

pub mod cache;
pub mod catalog;
pub mod fetcher;
pub mod handle;

pub use catalog::{Catalog, CatalogError, ImageSize};
pub use fetcher::{FetchError, FetchPolicy, FetchedImage, ImageFetcher, ReqwestFetcher};
pub use handle::{ImageError, ServedImage, WallpaperHandle};
