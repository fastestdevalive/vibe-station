//! Build-time guard for the `embed-ui` feature.
//!
//! `rust-embed`'s derive macro does not fail loudly when `#[folder = "..."]`
//! doesn't exist — it silently generates a struct that doesn't implement its
//! `Embed` trait at all, which surfaces as a confusing "no associated
//! function `get`" error pointing at the *call site*, not the missing
//! directory. This check gives a clear message instead, before that
//! confusing error ever has a chance to appear.
fn main() {
    if std::env::var("CARGO_FEATURE_EMBED_UI").is_err() {
        return;
    }

    // CARGO_MANIFEST_DIR is `<repo>/rust/vst-daemon` — `web-ui/dist` is two
    // levels up, same relative path the `#[folder = "../../web-ui/dist"]`
    // attribute in src/server.rs uses.
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let dist = std::path::Path::new(&manifest_dir).join("../../web-ui/dist");

    if !dist.is_dir() {
        panic!(
            "\n\n\
             error: building vst-daemon with --features embed-ui, but {} does not exist.\n\
             Build the web UI first:\n\
             \n    pnpm --filter @vibestation/web build\n\
             \n\
             (rust-embed's own failure mode here is a confusing \"no associated function `get`\"\n\
             error at the call site in server.rs — this check exists to fail clearly instead.)\n\n",
            dist.display()
        );
    }

    println!("cargo:rerun-if-changed={}", dist.display());
}
