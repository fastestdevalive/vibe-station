//! Strict parser for the signed release manifest (`SHA256SUMS`).
//!
//! Grammar (identical in `scripts/make-release-manifest.sh`):
//! ```text
//! # vibe-station release manifest v1
//! # tag=v<semver>
//! <64 lowercase hex>  <name>      (one per asset, sorted, >= 1)
//! ```
//! Always parse the SAME bytes that were signature-verified.

use std::collections::BTreeMap;

use crate::update::version;

/// Hard cap on the manifest size.
pub const MAX_MANIFEST_BYTES: usize = 65_536;

const HEADER: &str = "# vibe-station release manifest v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub tag: String,
    /// asset name -> 64 lowercase hex sha256
    pub entries: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestError {
    Malformed(String),
    VersionMismatch,
    Downgrade,
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::Malformed(m) => write!(f, "{m}"),
            ManifestError::VersionMismatch => f.write_str("release version does not match"),
            ManifestError::Downgrade => {
                f.write_str("release is not newer than the running version")
            }
        }
    }
}

fn bad(msg: &str) -> ManifestError {
    ManifestError::Malformed(msg.to_string())
}

fn valid_name(n: &str) -> bool {
    let b = n.as_bytes();
    if b.is_empty() || b.len() > 255 || !b[0].is_ascii_alphanumeric() {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'+' | b'-'))
}

fn valid_hex(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Manifest, ManifestError> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(bad("manifest too large"));
        }
        let s = std::str::from_utf8(bytes).map_err(|_| bad("not utf-8"))?;
        if s.contains('\r') || !s.ends_with('\n') {
            return Err(bad("bad line endings"));
        }
        let mut lines = s[..s.len() - 1].split('\n');
        if lines.next() != Some(HEADER) {
            return Err(bad("missing header"));
        }
        let tag = lines
            .next()
            .and_then(|l| l.strip_prefix("# tag="))
            .ok_or_else(|| bad("missing tag line"))?;
        if !tag.starts_with('v') || version::parse(tag).is_none() {
            return Err(bad("invalid tag"));
        }
        let mut entries = BTreeMap::new();
        for l in lines {
            let (hash, name) = l.split_once("  ").ok_or_else(|| bad("bad entry line"))?;
            if !valid_hex(hash) {
                return Err(bad("bad hash"));
            }
            if !valid_name(name) {
                return Err(bad("bad asset name"));
            }
            if entries.insert(name.to_string(), hash.to_string()).is_some() {
                return Err(bad("duplicate asset name"));
            }
        }
        if entries.is_empty() {
            return Err(bad("no entries"));
        }
        Ok(Manifest {
            tag: tag.to_string(),
            entries,
        })
    }

    /// Bind the signed tag to the requested version and require it to be
    /// strictly newer than the running one (replay/downgrade defence).
    pub fn bind(&self, expected_version: &str, running: &str) -> Result<(), ManifestError> {
        if self.tag != format!("v{expected_version}") {
            return Err(ManifestError::VersionMismatch);
        }
        if !version::update_available(running, expected_version) {
            return Err(ManifestError::Downgrade);
        }
        Ok(())
    }

    pub fn sha256_of(&self, name: &str) -> Option<&str> {
        self.entries.get(name).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const H2: &str = "0000000000000000000000000000000000000000000000000000000000000002";

    fn doc(tag: &str, lines: &[String]) -> String {
        format!(
            "{HEADER}\n# tag={tag}\n{}",
            lines.iter().map(|l| format!("{l}\n")).collect::<String>()
        )
    }

    fn e(h: &str, n: &str) -> String {
        format!("{h}  {n}")
    }

    #[test]
    fn parse() {
        let ok = doc("v0.3.0", &[e(H, "a.tar.gz"), e(H2, "b.deb")]);
        let m = Manifest::parse(ok.as_bytes()).unwrap();
        assert_eq!(m.tag, "v0.3.0");
        assert_eq!(m.sha256_of("a.tar.gz"), Some(H));
        assert_eq!(m.sha256_of("a.tar"), None);

        let up = H.replace('0', "A");
        let big = format!("{ok}{}", "#".repeat(MAX_MANIFEST_BYTES));
        let cases: Vec<(&str, String)> = vec![
            ("dup", doc("v0.3.0", &[e(H, "a"), e(H2, "a")])),
            ("upper", doc("v0.3.0", &[e(&up, "a")])),
            ("63", doc("v0.3.0", &[e(&H[1..], "a")])),
            ("no header", format!("# tag=v0.3.0\n{}\n", e(H, "a"))),
            ("dup header", format!("{HEADER}\n{}", ok)),
            (
                "reordered",
                format!("# tag=v0.3.0\n{HEADER}\n{}\n", e(H, "a")),
            ),
            ("extra #", format!("{}# note\n", ok)),
            ("blank", format!("{ok}\n")),
            ("cr", ok.replace('\n', "\r\n")),
            ("dotdot", doc("v0.3.0", &[e(H, "../x")])),
            ("slash", doc("v0.3.0", &[e(H, "a/b")])),
            ("hidden", doc("v0.3.0", &[e(H, ".hidden")])),
            ("zero", doc("v0.3.0", &[])),
            ("single space", doc("v0.3.0", &[format!("{H} a")])),
            ("big", big),
            ("no v", doc("0.3.0", &[e(H, "a")])),
            ("garbage tag", doc("vgarbage", &[e(H, "a")])),
            ("no final newline", ok.trim_end().to_string()),
        ];
        for (label, c) in cases {
            assert!(Manifest::parse(c.as_bytes()).is_err(), "accepted: {label}");
        }
    }

    #[test]
    fn bind() {
        let m = |tag: &str| Manifest::parse(doc(tag, &[e(H, "a")]).as_bytes()).unwrap();
        assert_eq!(
            m("v0.3.0").bind("0.3.0", "0.3.0"),
            Err(ManifestError::Downgrade)
        );
        assert_eq!(
            m("v0.2.0").bind("0.2.0", "0.3.0"),
            Err(ManifestError::Downgrade)
        );
        assert_eq!(m("v0.4.0").bind("0.4.0", "0.3.0"), Ok(()));
        assert_eq!(
            m("v0.3.0").bind("0.4.0", "0.3.0"),
            Err(ManifestError::VersionMismatch)
        );
        assert_eq!(
            m("v0.4.0").bind("0.4.0", "garbage"),
            Err(ManifestError::Downgrade)
        );
    }
}
