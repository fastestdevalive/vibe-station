//! Behavior contract for `naming.ts` (`slugifyPrompt`, part 03-git-worktree).
//! Ported from `daemon/src/__tests__/naming.test.ts`.

use std::time::Instant;

use vst_git::naming::{slugify_prompt, slugify_prompt_with};

#[test]
fn derives_a_2_word_slug_dropping_stopwords_and_noise() {
    assert_eq!(
        slugify_prompt("Implement the login flow described in SPEC.md"),
        "implement-login-flow"
    );
}

#[test]
fn strips_path_shaped_tokens_entirely() {
    let slug = slugify_prompt("Review the diff at /tmp/pr.diff and summarise findings.");
    assert!(!slug.contains("tmp"));
    assert!(!slug.contains("pr"));
}

#[test]
fn empty_or_whitespace_prompt_is_empty() {
    assert_eq!(slugify_prompt(""), "");
    assert_eq!(slugify_prompt("   \n\t  "), "");
}

#[test]
fn non_ascii_only_prompt_is_empty() {
    assert_eq!(slugify_prompt("ログインフローを実装してください"), "");
}

#[test]
fn output_length_never_exceeds_60_chars_for_a_long_run_on_prompt() {
    let long_prompt = (0..40)
        .map(|i| format!("wordnumber{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    let slug = slugify_prompt_with(&long_prompt, 40, 60);
    assert!(slug.len() <= 60);
}

#[test]
fn caps_at_max_words_by_default() {
    let slug = slugify_prompt("refactor the authentication middleware logging pipeline completely");
    assert!(slug.split('-').count() <= 3);
}

#[test]
fn strips_code_fences_and_urls() {
    let slug =
        slugify_prompt("```const x = 1;``` fix the bug at https://example.com/issue/123 please");
    assert!(!slug.contains("const"));
    assert!(!slug.contains("example"));
}

#[test]
fn never_leaks_worktree_or_pr_shaped_id_tokens() {
    for id in ["vs-45", "pr17", "ch-61", "unl46", "vs45"] {
        let slug = slugify_prompt(&format!(
            "Fix the flaky migration test in {id} before release"
        ));
        assert!(!slug.contains(id));
        let stripped = id.replace('-', "");
        assert!(!slug.contains(&stripped));
        let alpha: String = id.chars().filter(|c| c.is_ascii_alphabetic()).collect();
        assert!(!slug.split('-').any(|p| p == alpha));
    }
}

#[test]
fn real_prompt_no_longer_produces_previous_started_vs_45() {
    let prompt = "The previous worktree that was started vs-45, didn't get a good name. Looks like the name \
        thing that we introduced is not working correctly. Can you please explore the issue and \
        refer to opus subagent to help with a better name genration.\n\nAdditionally, I realized \
        that there are many words that still creep into the name which shouldn't have been. If you \
        have accesss to the intro prompts for the last 20 sessions, can you try to call the method \
        against them and see the output. Create a table and then see if they are acceptable or not.";
    let slug = slugify_prompt(prompt);
    assert!(!slug.contains("vs-45"));
    assert!(!slug.contains("previous"));
    assert!(!slug.contains("started"));
    assert!(slug.contains("name"));
}

#[test]
fn real_prompt_picks_the_topic_not_the_filler() {
    let prompt = "I would like to change the default values for whenver the edge glow and selector glow are \
        enabled\n\nThe edge glow:\nEdges: L+R\nCorner: 24 DP\nThickness: 1dp\n\nAnd gradient should \
        be themed. For selector glow:\nAnimation: Moving gradient\nGradient: Same as above\n\
        Selector thickness: 2dp";
    let slug = slugify_prompt(prompt);
    assert_ne!(slug, "like-change-default");
    assert!(slug.contains("glow"));
}

#[test]
fn real_prompt_avoids_has_one_commit() {
    let prompt = "I am on this worktree: http://100.102.0.25:5173/worktree/ch-54. That worktree has just one \
        commit on the branch but the VCS tab in vst is showing many many commits. Why is that? \
        Whats going on?";
    let slug = slugify_prompt(prompt);
    assert_ne!(slug, "has-one-commit");
    assert!(slug.contains("vcs"));
}

#[test]
fn drops_filename_shaped_tokens_rather_than_leaking_their_extension() {
    let slug = slugify_prompt("Add the missing preview pane to BackgroundStep.kt for onboarding");
    assert!(!slug.split('-').any(|p| p == "kt"));
}

#[test]
fn expands_contractions_instead_of_leaving_didn_or_t_fragments() {
    let slug = slugify_prompt("The deploy didn't publish the release manifest, please investigate");
    assert!(!slug.split('-').any(|p| p == "didn"));
    assert!(!slug.split('-').any(|p| p == "t"));
}

#[test]
fn prefers_a_repeated_topical_term_over_leading_filler() {
    let slug = slugify_prompt(
        "I was just thinking that maybe we should take a look at this. The throttling logic is \
        wrong: throttling kicks in too early and throttling never resets.",
    );
    assert!(slug.contains("throttling"));
}

#[test]
fn keeps_2_letter_all_caps_acronyms_but_not_2_letter_ordinary_words() {
    let slug = slugify_prompt("Redesign the UI for the onboarding carousel");
    assert!(slug.split('-').any(|p| p == "ui"));
}

#[test]
fn does_not_repeat_a_word_already_covered_by_a_hyphenated_pick() {
    let slug = slugify_prompt(
        "Add moving-backgrounds support: we want customizable backgrounds with animated backgrounds.",
    );
    let parts: Vec<&str> = slug.split('-').collect();
    let unique: std::collections::HashSet<&&str> = parts.iter().collect();
    assert_eq!(unique.len(), parts.len());
}

#[test]
fn a_pure_filler_prompt_still_yields_something() {
    assert_ne!(
        slugify_prompt("Can you please just have a look at this and see how it goes?"),
        ""
    );
}

#[test]
fn is_deterministic() {
    let p = "Migrate the workspace persistence layer from localStorage into the daemon sqlite db";
    assert_eq!(slugify_prompt(p), slugify_prompt(p));
}

#[test]
fn prompt_of_nothing_but_core_function_words_is_empty() {
    assert_eq!(slugify_prompt("the a an of to"), "");
}

#[test]
fn does_not_hang_on_a_long_whitespace_sparse_prompt() {
    let pathological = "a.b-".repeat(20_000);
    let start = Instant::now();
    slugify_prompt(&pathological);
    assert!(start.elapsed().as_millis() < 500);
}
