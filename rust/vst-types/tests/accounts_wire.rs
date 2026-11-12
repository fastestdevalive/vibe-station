//! Wire round-trip tests for the accounts contract (`vst-types`).
//!
//! These were unit tests inside `src/accounts.rs`; they live here so that file
//! stays under the plan's 400-line cap. Same names, same assertions.

use serde_json::json;

use vst_types::*;

#[test]
fn accounts_wire_roundtrip() {
    let summary = AccountSummary {
        id: "acc_1a2b3c4d".into(),
        cli: "fakecli".into(),
        label: Some("Work".into()),
        display_name: "Work".into(),
        email: None,
        plan: Some("Max".into()),
        method: AccountMethod::SignIn,
        auth: AccountAuth::SignedIn,
        is_default: true,
        limited: Some(AccountLimited {
            window_id: "five_hour".into(),
            resets_at: Some("2026-01-01T00:00:00Z".into()),
            source: LimitedSource::Poller,
        }),
        created_at: Some("2026-01-01T00:00:00Z".into()),
        dir: None,
        created_by_us: false,
        pending: false,
        sign_in: None,
    };
    assert_eq!(
        serde_json::to_value(&summary).unwrap(),
        json!({
            "id": "acc_1a2b3c4d",
            "cli": "fakecli",
            "label": "Work",
            "displayName": "Work",
            "email": null,
            "plan": "Max",
            "method": "sign_in",
            "auth": "signed_in",
            "isDefault": true,
            "limited": {
                "windowId": "five_hour",
                "resetsAt": "2026-01-01T00:00:00Z",
                "source": "poller"
            },
            "createdAt": "2026-01-01T00:00:00Z",
            "dir": null,
            "createdByUs": false,
            "pending": false,
            "signIn": null
        })
    );
    let back: AccountSummary = serde_json::from_value(json!({
        "id": "system",
        "cli": "fakecli",
        "displayName": "System login",
        "method": "system",
        "isDefault": false
    }))
    .unwrap();
    assert_eq!(back.label, None);
    assert_eq!(back.auth, AccountAuth::Unknown);
    assert_eq!(back.limited, None);
    assert_eq!(back.created_at, None);
    assert_eq!(
        serde_json::to_value(&summary).unwrap()["limited"]["source"],
        json!("poller")
    );
    assert_eq!(
        serde_json::to_value(AccountAuth::SignedOut).unwrap(),
        json!("signed_out")
    );
    assert_eq!(
        serde_json::to_value(AccountMethod::ApiKey).unwrap(),
        json!("api_key")
    );
    assert_eq!(
        serde_json::to_value(SignInState::Duplicate).unwrap(),
        json!("duplicate")
    );
}

#[test]
fn api_key_debug_is_redacted() {
    let key = ApiKey::from("sk-secret".to_string());
    let debug = format!("{key:?}");
    assert!(!debug.contains("sk-secret"));
    assert_eq!(debug, "ApiKey(<redacted>)");
    assert_eq!(key.expose(), "sk-secret");
}

#[test]
fn normalize_account_id_maps_system_and_empty_to_none() {
    assert_eq!(normalize_account_id(None), None);
    assert_eq!(normalize_account_id(Some("")), None);
    assert_eq!(normalize_account_id(Some("  ")), None);
    assert_eq!(normalize_account_id(Some("system")), None);
    assert_eq!(
        normalize_account_id(Some(" acc_1a2b3c4d ")),
        Some("acc_1a2b3c4d".to_string())
    );
}

#[test]
fn account_record_roundtrips_with_defaults() {
    let rec: AccountRecord = serde_json::from_value(json!({
        "id": "acc_1a2b3c4d",
        "cli": "fakecli",
        "method": "sign_in",
        "createdAt": "2026-01-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(rec.label, None);
    assert_eq!(rec.auth, AccountAuth::Unknown);
    assert!(!rec.pending);
    assert_eq!(
        serde_json::to_value(&rec).unwrap()["pending"],
        json!(false),
        "pending must stay serialized so the registry round-trips"
    );
}

#[test]
fn record_without_dir_defaults() {
    let rec: AccountRecord = serde_json::from_value(json!({
        "id": "acc_1a2b3c4d",
        "cli": "claude",
        "method": "sign_in",
        "createdAt": "2026-01-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(rec.dir, None);
    assert!(!rec.created_by_us);
}

#[test]
fn summary_new_fields_camel_case() {
    let back: AccountSummary = serde_json::from_value(json!({
        "id": "acc_1a2b3c4d",
        "cli": "claude",
        "displayName": "acc_1a2b3c4d",
        "method": "sign_in",
        "isDefault": false,
        "dir": "~/.claude-work",
        "createdByUs": true,
        "pending": true,
        "signIn": { "command": "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login", "hint": null }
    }))
    .unwrap();
    assert_eq!(back.dir.as_deref(), Some("~/.claude-work"));
    assert!(back.created_by_us);
    assert!(back.pending);
    let steps = back.sign_in.expect("signIn parsed");
    assert_eq!(
        steps.command.as_deref(),
        Some("CLAUDE_CONFIG_DIR=~/.claude-work claude auth login")
    );
    assert_eq!(steps.hint, None);
    let plain: AccountSummary = serde_json::from_value(json!({
        "id": "system",
        "cli": "claude",
        "displayName": "System login",
        "method": "system",
        "isDefault": true
    }))
    .unwrap();
    assert_eq!(plain.dir, None);
    assert!(!plain.created_by_us);
    assert!(!plain.pending);
    assert_eq!(plain.sign_in, None);
}

#[test]
fn remove_response_folder_deleted_defaults_false() {
    let old: RemoveAccountResponse =
        serde_json::from_value(json!({ "ok": true, "stoppedSessionIds": [] })).unwrap();
    assert!(!old.folder_deleted);
    assert_eq!(
        serde_json::to_value(&old).unwrap()["folderDeleted"],
        json!(false)
    );
}

#[test]
fn collapse_home_cases() {
    let home = std::path::Path::new("/home/u");
    let show = |p: &str| collapse_home(std::path::Path::new(p), home);
    assert_eq!(show("/home/u/.claude-work"), "~/.claude-work");
    assert_eq!(show("/home/u"), "~");
    assert_eq!(show("/opt/tools/x"), "/opt/tools/x");
    assert_eq!(
        show("/home/ux/.claude"),
        "/home/ux/.claude",
        "a sibling sharing a name prefix is NOT inside home"
    );
}

#[test]
fn account_folder_wire_shapes() {
    let body: AccountFolderBody =
        serde_json::from_value(json!({"cli": "claude", "mode": "choose", "dir": "~/x"})).unwrap();
    assert_eq!(body.mode, AccountFolderMode::Choose);
    assert_eq!(body.dir.as_deref(), Some("~/x"));
    assert_eq!(body.label, None);
    let body: AccountFolderBody =
        serde_json::from_value(json!({"cli": "claude", "mode": "create"})).unwrap();
    assert_eq!(body.mode, AccountFolderMode::Create);
    assert_eq!(body.dir, None);

    let v = serde_json::to_value(ValidateAccountPathResponse {
        dir: "~/x".into(),
        exists: true,
        is_empty: false,
        looks_valid: true,
    })
    .unwrap();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["dir", "exists", "isEmpty", "looksValid"]);

    let account: AccountSummary = serde_json::from_value(json!({
        "id": "acc_1", "cli": "claude", "displayName": "A",
        "method": "sign_in", "isDefault": false
    }))
    .unwrap();
    let v = serde_json::to_value(AddFolderAccountResponse {
        account,
        signed_in: true,
    })
    .unwrap();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["account", "signedIn"]);
}

#[test]
fn account_link_first_run_note_roundtrips_and_defaults() {
    let link = vst_types::rest::modes::AccountLink {
        field_label: "Folder".into(),
        field_note: None,
        example_dir: "~/.x".into(),
        system_dir: None,
        supports_api_key: false,
        verifies_identity: true,
        first_run_note: Some("Answer once.".into()),
    };
    let value = serde_json::to_value(&link).unwrap();
    assert_eq!(value["firstRunNote"], "Answer once.");
    assert_eq!(
        serde_json::from_value::<vst_types::rest::modes::AccountLink>(value).unwrap(),
        link
    );
    let old = json!({
        "fieldLabel": "Folder", "fieldNote": null, "exampleDir": "~/.x",
        "systemDir": null, "supportsApiKey": false, "verifiesIdentity": true
    });
    assert_eq!(
        serde_json::from_value::<vst_types::rest::modes::AccountLink>(old)
            .unwrap()
            .first_run_note,
        None
    );
}
