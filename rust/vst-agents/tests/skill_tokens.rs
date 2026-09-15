//! Behavior contract for `vst_agents::skill_tokens` — ports
//! `daemon/src/__tests__/skillTokens.test.ts` (the shared 7A.1 round-trip +
//! per-vector + edge-case suite).

use vst_agents::skill_tokens::{parse_skill_segments, serialize_skill_segments, SkillSegment};

const VECTORS: &[&str] = &[
    "hello world",
    "{/code-review}",
    "{/code-review high --fix}",
    "Can you use {/code-review high --fix} to do this. Also use {/simplify}.",
    "a \\{ literal brace",
    "{/x args with \\} brace}",
    "back\\\\slash",
    "{/plugin:skill-name arg}",
    "{/apps/web:deploy arg}",
    "{/unknown-skill args}",
];

#[test]
fn round_trip_parse_serialize_fixpoint() {
    for x in VECTORS {
        let once = parse_skill_segments(x);
        let twice = parse_skill_segments(&serialize_skill_segments(&once));
        assert_eq!(twice, once, "vector: {x}");
    }
}

#[test]
fn plain_prose_is_zero_tokens() {
    let segs = parse_skill_segments("hello world");
    assert_eq!(segs.iter().filter(|s| s.is_token()).count(), 0);
}

#[test]
fn bare_token() {
    assert_eq!(
        parse_skill_segments("{/code-review}"),
        vec![SkillSegment::Token {
            name: "code-review".into(),
            args: String::new()
        }]
    );
}

#[test]
fn token_with_args() {
    assert_eq!(
        parse_skill_segments("{/code-review high --fix}"),
        vec![SkillSegment::Token {
            name: "code-review".into(),
            args: "high --fix".into()
        }]
    );
}

#[test]
fn two_tokens_mid_sentence() {
    let segs = parse_skill_segments(
        "Can you use {/code-review high --fix} to do this. Also use {/simplify}.",
    );
    let tokens: Vec<_> = segs.into_iter().filter(|s| s.is_token()).collect();
    assert_eq!(
        tokens,
        vec![
            SkillSegment::Token {
                name: "code-review".into(),
                args: "high --fix".into()
            },
            SkillSegment::Token {
                name: "simplify".into(),
                args: String::new()
            }
        ]
    );
}

#[test]
fn escaped_brace_in_text() {
    assert_eq!(
        parse_skill_segments("a \\{ literal brace"),
        vec![SkillSegment::Text("a { literal brace".into())]
    );
}

#[test]
fn escaped_close_brace_inside_args() {
    assert_eq!(
        parse_skill_segments("{/x args with \\} brace}"),
        vec![SkillSegment::Token {
            name: "x".into(),
            args: "args with } brace".into()
        }]
    );
}

#[test]
fn escaped_backslash_in_text() {
    assert_eq!(
        parse_skill_segments("back\\\\slash"),
        vec![SkillSegment::Text("back\\slash".into())]
    );
}

#[test]
fn name_with_colon_tokenizes() {
    assert_eq!(
        parse_skill_segments("{/plugin:skill-name arg}"),
        vec![SkillSegment::Token {
            name: "plugin:skill-name".into(),
            args: "arg".into()
        }]
    );
}

#[test]
fn name_with_slash_tokenizes() {
    assert_eq!(
        parse_skill_segments("{/apps/web:deploy arg}"),
        vec![SkillSegment::Token {
            name: "apps/web:deploy".into(),
            args: "arg".into()
        }]
    );
}

#[test]
fn unknown_skill_still_tokenizes() {
    assert_eq!(
        parse_skill_segments("{/unknown-skill args}"),
        vec![SkillSegment::Token {
            name: "unknown-skill".into(),
            args: "args".into()
        }]
    );
}

#[test]
fn unterminated_token_degrades_to_text() {
    assert_eq!(
        parse_skill_segments("{/no-close still typing"),
        vec![SkillSegment::Text("{/no-close still typing".into())]
    );
}

#[test]
fn lone_backslash_not_followed_by_escape_preserved() {
    assert_eq!(
        parse_skill_segments("C:\\Users\\name"),
        vec![SkillSegment::Text("C:\\Users\\name".into())]
    );
}

#[test]
fn serialize_round_trips_literal_braces_in_args() {
    let segs = vec![SkillSegment::Token {
        name: "x".into(),
        args: "a{b}c".into(),
    }];
    let s = serialize_skill_segments(&segs);
    assert_eq!(parse_skill_segments(&s), segs);
}

#[test]
fn empty_input_is_no_segments() {
    assert_eq!(parse_skill_segments(""), Vec::<SkillSegment>::new());
}
