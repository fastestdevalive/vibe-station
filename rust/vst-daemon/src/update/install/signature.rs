//! minisign / Ed25519 verification of the signed release manifest
//! (`SHA256SUMS` + `SHA256SUMS.minisig`).
//!
//! Only the non-prehashed `Ed` algorithm is accepted: `ring` has no BLAKE2b, so
//! minisign's prehashed `ED` mode cannot be verified here, and CI signs with
//! `minisign -S -l` (see `docs/UPDATE.md`). Both modes are plain
//! Ed25519 signatures by the same key, so rejecting `ED` is not a downgrade.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

// The `test-seams` feature lets an env var replace the pinned release
// keys. It is enabled only through vst-cli's [dev-dependencies] (debug test
// builds); refuse to compile it into an optimized build so it can never reach
// a shipped binary even if someone builds with `--all-targets --release` or
// passes the feature by hand. Release CI also greps the shipped binary for
// the env var name (release.yml, prep-sidecar.sh).
#[cfg(all(feature = "test-seams", not(debug_assertions)))]
compile_error!(
    "the `test-seams` feature is TEST ONLY and must never be enabled in a release \
     (non-debug-assertions) build: it lets VST_TEST_RELEASE_PUBKEYS replace the pinned release key"
);

/// Hard cap on a `.minisig` file.
pub const MAX_SIG_BYTES: usize = 4096;

/// One trusted release key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedKey {
    pub key_id: [u8; 8],
    pub public: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SigError {
    MalformedSig,
    UnknownKey,
    BadSignature,
}

impl std::fmt::Display for SigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SigError::MalformedSig => "signature file is malformed",
            SigError::UnknownKey => "signed with a key this build does not trust",
            SigError::BadSignature => "signature does not match the release key",
        })
    }
}

/// Raw key id (as stored in minisign files) of the throwaway PLACEHOLDER key
/// currently shipped in `release-keys/vst-release.pub`. Release CI refuses to
/// publish while the pinned file still carries this id
/// (`scripts/check-release-key-not-placeholder.sh`).
pub const PLACEHOLDER_KEY_ID: [u8; 8] = [0xdb, 0x60, 0x4b, 0xf9, 0x99, 0xeb, 0x74, 0xc6];

/// Parse a minisign `.pub` file (one or more `untrusted comment:` / key pairs).
pub fn parse_pubkey_file(s: &str) -> Result<Vec<PinnedKey>, SigError> {
    let mut keys = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("untrusted comment:") {
            continue;
        }
        let raw = STANDARD.decode(line).map_err(|_| SigError::MalformedSig)?;
        if raw.len() != 42 || &raw[0..2] != b"Ed" {
            return Err(SigError::MalformedSig);
        }
        let mut key_id = [0u8; 8];
        key_id.copy_from_slice(&raw[2..10]);
        let mut public = [0u8; 32];
        public.copy_from_slice(&raw[10..42]);
        keys.push(PinnedKey { key_id, public });
    }
    if keys.is_empty() {
        return Err(SigError::MalformedSig);
    }
    Ok(keys)
}

/// The keys compiled into this binary.
///
/// NOTE: while `release-keys/vst-release.pub` holds the PLACEHOLDER key, no
/// real release can verify; CI blocks publishing in that state.
pub fn pinned_keys() -> Vec<PinnedKey> {
    // Compiled only under the test-only `test-seams` feature (enabled by
    // vst-cli's dev-dependencies, never by a release build).
    #[cfg(feature = "test-seams")]
    if let Ok(v) = std::env::var("VST_TEST_RELEASE_PUBKEYS") {
        if let Ok(keys) = parse_pubkey_file(&v) {
            return keys;
        }
    }
    parse_pubkey_file(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/release-keys/vst-release.pub"
    )))
    .expect("release-keys/vst-release.pub must hold >=1 valid minisign key")
}

struct ParsedSig<'a> {
    key_id: [u8; 8],
    sig: [u8; 64],
    trusted_comment: &'a str,
    global_sig: [u8; 64],
}

fn parse_minisig(s: &str) -> Result<ParsedSig<'_>, SigError> {
    if s.len() > MAX_SIG_BYTES || s.contains('\r') || !s.ends_with('\n') {
        return Err(SigError::MalformedSig);
    }
    let lines: Vec<&str> = s[..s.len() - 1].split('\n').collect();
    if lines.len() != 4 {
        return Err(SigError::MalformedSig);
    }
    let raw = STANDARD
        .decode(lines[1])
        .map_err(|_| SigError::MalformedSig)?;
    if raw.len() != 74 || &raw[0..2] != b"Ed" {
        return Err(SigError::MalformedSig);
    }
    let trusted_comment = lines[2]
        .strip_prefix("trusted comment: ")
        .ok_or(SigError::MalformedSig)?;
    let g = STANDARD
        .decode(lines[3])
        .map_err(|_| SigError::MalformedSig)?;
    if g.len() != 64 {
        return Err(SigError::MalformedSig);
    }
    let mut key_id = [0u8; 8];
    key_id.copy_from_slice(&raw[2..10]);
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&raw[10..74]);
    let mut global_sig = [0u8; 64];
    global_sig.copy_from_slice(&g);
    Ok(ParsedSig {
        key_id,
        sig,
        trusted_comment,
        global_sig,
    })
}

/// Verify `manifest` against `minisig` using one of `keys`. Checks both the
/// file signature and the global (trusted-comment) signature.
pub fn verify_manifest(manifest: &[u8], minisig: &str, keys: &[PinnedKey]) -> Result<(), SigError> {
    let p = parse_minisig(minisig)?;
    let key = keys
        .iter()
        .find(|k| k.key_id == p.key_id)
        .ok_or(SigError::UnknownKey)?;
    let pk = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key.public);
    pk.verify(manifest, &p.sig)
        .map_err(|_| SigError::BadSignature)?;
    let mut g = p.sig.to_vec();
    g.extend_from_slice(p.trusted_comment.as_bytes());
    pk.verify(&g, &p.global_sig)
        .map_err(|_| SigError::BadSignature)?;
    Ok(())
}

/// Test-only signing helpers. Compiled only for unit tests and the TEST-ONLY
/// `test-seams` feature (integration tests), never into a shipped binary.
#[cfg(any(test, feature = "test-seams"))]
pub mod test_support {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    pub fn keypair_from_seed(seed: [u8; 32], key_id: [u8; 8]) -> (PinnedKey, Ed25519KeyPair) {
        let kp = Ed25519KeyPair::from_seed_unchecked(&seed).expect("seed");
        let mut public = [0u8; 32];
        public.copy_from_slice(kp.public_key().as_ref());
        (PinnedKey { key_id, public }, kp)
    }

    pub fn sign_minisig(
        kp: &Ed25519KeyPair,
        key_id: [u8; 8],
        msg: &[u8],
        trusted_comment: &str,
    ) -> String {
        let sig = kp.sign(msg);
        let mut line = b"Ed".to_vec();
        line.extend_from_slice(&key_id);
        line.extend_from_slice(sig.as_ref());
        let mut g = sig.as_ref().to_vec();
        g.extend_from_slice(trusted_comment.as_bytes());
        let gsig = kp.sign(&g);
        format!(
            "untrusted comment: test signature\n{}\ntrusted comment: {}\n{}\n",
            STANDARD.encode(line),
            trusted_comment,
            STANDARD.encode(gsig.as_ref())
        )
    }

    /// SHA256SUMS manifest bytes (see `install/manifest.rs`): entries sorted by name, hashes of `body`.
    pub fn manifest_bytes(tag: &str, entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut e: Vec<_> = entries.to_vec();
        e.sort_by(|a, b| a.0.cmp(b.0));
        let mut out = format!("# vibe-station release manifest v1\n# tag={tag}\n");
        for (name, body) in e {
            out.push_str(&format!("{}  {}\n", hex_sha256(body), name));
        }
        out.into_bytes()
    }

    fn hex_sha256(data: &[u8]) -> String {
        let d = ring::digest::digest(&ring::digest::SHA256, data);
        d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    const KID: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    #[test]
    fn sig_error_display_is_human_text() {
        for e in [
            SigError::MalformedSig,
            SigError::UnknownKey,
            SigError::BadSignature,
        ] {
            let t = e.to_string();
            assert!(
                !format!("{e:?}").is_empty() && !t.contains(&format!("{e:?}")),
                "{t}"
            );
        }
        assert_eq!(
            SigError::BadSignature.to_string(),
            "signature does not match the release key"
        );
    }

    fn setup() -> (Vec<PinnedKey>, ring::signature::Ed25519KeyPair, Vec<u8>) {
        let (k, kp) = keypair_from_seed([7u8; 32], KID);
        let m = manifest_bytes("v0.4.0", &[("a.tar.gz", b"x")]);
        (vec![k], kp, m)
    }

    /// Rebuild a minisig from a decoded 74-byte sig line + other lines.
    fn with_line2(sig: &str, raw: &[u8]) -> String {
        let mut l: Vec<String> = sig.lines().map(String::from).collect();
        l[1] = STANDARD.encode(raw);
        l.join("\n") + "\n"
    }

    fn line_raw(sig: &str, n: usize) -> Vec<u8> {
        STANDARD.decode(sig.lines().nth(n).unwrap()).unwrap()
    }

    fn with_line(sig: &str, n: usize, new: &str) -> String {
        let mut l: Vec<String> = sig.lines().map(String::from).collect();
        l[n] = new.into();
        l.join("\n") + "\n"
    }

    #[test]
    fn valid_sig_verifies() {
        let (keys, kp, m) = setup();
        let s = sign_minisig(&kp, KID, &m, "vibe-station v0.4.0");
        assert_eq!(verify_manifest(&m, &s, &keys), Ok(()));
    }

    #[test]
    fn bad_sig_rejected() {
        let (keys, kp, m) = setup();
        let s = sign_minisig(&kp, KID, &m, "vibe-station v0.4.0");
        let mut raw = line_raw(&s, 1);
        raw[20] ^= 1;
        assert_eq!(
            verify_manifest(&m, &with_line2(&s, &raw), &keys),
            Err(SigError::BadSignature)
        );
        let mut g = line_raw(&s, 3);
        g[5] ^= 1;
        assert_eq!(
            verify_manifest(&m, &with_line(&s, 3, &STANDARD.encode(g)), &keys),
            Err(SigError::BadSignature)
        );
        let tc = with_line(&s, 2, "trusted comment: vibe-station v0.9.9");
        assert_eq!(verify_manifest(&m, &tc, &keys), Err(SigError::BadSignature));
    }

    #[test]
    fn tampered_manifest_rejected() {
        let (keys, kp, m) = setup();
        let s = sign_minisig(&kp, KID, &m, "c");
        let other = manifest_bytes("v0.4.0", &[("a.tar.gz", b"y")]);
        assert_eq!(
            verify_manifest(&other, &s, &keys),
            Err(SigError::BadSignature)
        );
    }

    #[test]
    fn wrong_key_rejected() {
        let (_, kp, m) = setup();
        let s = sign_minisig(&kp, KID, &m, "c");
        let (y, _) = keypair_from_seed([9u8; 32], [9; 8]);
        assert_eq!(verify_manifest(&m, &s, &[y]), Err(SigError::UnknownKey));
        let (z, _) = keypair_from_seed([9u8; 32], KID);
        assert_eq!(verify_manifest(&m, &s, &[z]), Err(SigError::BadSignature));
        assert_eq!(verify_manifest(&m, &s, &[]), Err(SigError::UnknownKey));
    }

    #[test]
    fn non_ed_alg_rejected() {
        let (keys, kp, m) = setup();
        let s = sign_minisig(&kp, KID, &m, "c");
        for alg in [b"ED", b"Xx"] {
            let mut raw = line_raw(&s, 1);
            raw[0..2].copy_from_slice(alg);
            assert_eq!(
                verify_manifest(&m, &with_line2(&s, &raw), &keys),
                Err(SigError::MalformedSig)
            );
        }
    }

    #[test]
    fn malformed_inputs_never_ok() {
        let (keys, kp, m) = setup();
        let s = sign_minisig(&kp, KID, &m, "c");
        let raw = line_raw(&s, 1);
        let mut cases: Vec<String> = vec![
            String::new(),
            s.lines().take(3).collect::<Vec<_>>().join("\n") + "\n",
            s.clone() + "extra\n",
            s.replace('\n', "\r\n"),
            with_line(&s, 2, "comment: c"),
            with_line(&s, 1, "!!!notbase64!!!"),
            with_line2(&s, &raw[..73]),
            {
                let mut r = raw.clone();
                r.push(0);
                with_line2(&s, &r)
            },
            with_line(&s, 3, &STANDARD.encode([0u8; 63])),
            s.trim_end().to_string(), // no final newline
        ];
        cases.push(format!("{s}{}", "a".repeat(MAX_SIG_BYTES)));
        for c in cases {
            assert!(verify_manifest(&m, &c, &keys).is_err(), "accepted: {c:?}");
        }
    }

    #[test]
    fn real_minisign_fixture_verifies() {
        let keys = parse_pubkey_file(include_str!("testdata/t.pub")).unwrap();
        let r = verify_manifest(
            include_bytes!("testdata/SHA256SUMS"),
            include_str!("testdata/SHA256SUMS.minisig"),
            &keys,
        );
        assert_eq!(r, Ok(()));
        assert!(parse_pubkey_file("").is_err());
    }

    #[test]
    fn placeholder_key_id_matches_throwaway_fixture() {
        let keys = parse_pubkey_file(include_str!("testdata/t.pub")).unwrap();
        assert_eq!(keys[0].key_id, PLACEHOLDER_KEY_ID);
    }

    /// Pubkey tokens of the `PINNED_PUBKEYS="..."` assignment in install.sh
    /// (the value may span lines and hold several whitespace-separated keys).
    fn install_sh_pinned(sh: &str) -> Vec<String> {
        let rest = sh
            .split_once("\nPINNED_PUBKEYS=\"")
            .expect("install.sh has a PINNED_PUBKEYS=\"...\" assignment")
            .1;
        let value = rest.split_once('"').expect("unterminated PINNED_PUBKEYS").0;
        value.split_whitespace().map(str::to_owned).collect()
    }

    /// `None` when both sides hold the same key set; otherwise a message
    /// listing keys missing from either side.
    fn pin_drift(compiled: &[&str], script: &[String]) -> Option<String> {
        let a: std::collections::BTreeSet<&str> = compiled.iter().copied().collect();
        let b: std::collections::BTreeSet<&str> = script.iter().map(String::as_str).collect();
        if a == b {
            return None;
        }
        let only_compiled: Vec<_> = a.difference(&b).collect();
        let only_script: Vec<_> = b.difference(&a).collect();
        Some(format!(
            "pinned release keys drifted: only in release-keys/vst-release.pub: {only_compiled:?}; \
             only in scripts/install.sh PINNED_PUBKEYS: {only_script:?}"
        ))
    }

    #[test]
    fn pin_drift_detects_appended_key_both_directions() {
        let script = vec!["RWaaa".to_owned()];
        assert_eq!(pin_drift(&["RWaaa"], &script), None);
        let appended = vec!["RWaaa".to_owned(), "RWbbb".to_owned()];
        let msg = pin_drift(&["RWaaa"], &appended).expect("script-only key is drift");
        assert!(msg.contains("RWbbb"), "{msg}");
        let msg = pin_drift(&["RWaaa", "RWbbb"], &script).expect("compiled-only key is drift");
        assert!(msg.contains("RWbbb"), "{msg}");
    }

    #[test]
    fn pinned_keys_parse_and_match_install_sh() {
        assert!(!pinned_keys().is_empty());
        let pub_file = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/release-keys/vst-release.pub"
        ));
        let sh = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../scripts/install.sh"
        ))
        .expect("scripts/install.sh");
        let key_lines: Vec<&str> = pub_file.lines().filter(|l| l.starts_with("RW")).collect();
        assert!(!key_lines.is_empty());
        if let Some(msg) = pin_drift(&key_lines, &install_sh_pinned(&sh)) {
            panic!("{msg}");
        }
    }
}
