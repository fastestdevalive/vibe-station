//! Ports `naming.ts` — `slugifyPrompt`, a deterministic naming heuristic (F1).
//!
//! Pure / synchronous / allocation-cheap on purpose: callers invoke it inline
//! inside request handlers. The original took "the first N words that aren't
//! stopwords"; this version scrubs harder, scores each surviving word for
//! informativeness, and emits the top `maxWords` in original prompt order.

use std::collections::{HashMap, HashSet};

use fancy_regex::Regex;

/// Words that carry ~no naming signal. Deliberately absent: fix, add, remove,
/// implement, migrate, refactor, ... — those describe the task.
static STOPWORDS: &[&str] = &[
    // articles / determiners / quantifiers
    "a",
    "an",
    "the",
    "this",
    "that",
    "these",
    "those",
    "such",
    "some",
    "any",
    "all",
    "both",
    "each",
    "every",
    "other",
    "another",
    "same",
    "few",
    "several",
    "enough",
    "own",
    "none",
    "more",
    "most",
    "less",
    "least",
    "much",
    "many",
    "lot",
    "lots",
    "bunch",
    "couple",
    // pronouns
    "i",
    "me",
    "my",
    "mine",
    "we",
    "us",
    "our",
    "ours",
    "you",
    "your",
    "yours",
    "he",
    "she",
    "him",
    "her",
    "his",
    "hers",
    "they",
    "them",
    "their",
    "theirs",
    "it",
    "its",
    "who",
    "whom",
    "whose",
    "which",
    "what",
    "whatever",
    "whichever",
    "whoever",
    "someone",
    "somebody",
    "something",
    "anyone",
    "anybody",
    "anything",
    "everyone",
    "everybody",
    "everything",
    "nothing",
    "nobody",
    "one",
    "ones",
    "itself",
    "myself",
    "yourself",
    "themselves",
    // be / have / do / modals
    "am",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "having",
    "do",
    "does",
    "did",
    "doing",
    "done",
    "will",
    "would",
    "shall",
    "should",
    "can",
    "could",
    "may",
    "might",
    "must",
    "cannot",
    // prepositions / conjunctions / connectives
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "and",
    "or",
    "but",
    "as",
    "at",
    "by",
    "from",
    "into",
    "onto",
    "upon",
    "over",
    "under",
    "above",
    "below",
    "between",
    "across",
    "through",
    "throughout",
    "during",
    "before",
    "after",
    "while",
    "since",
    "until",
    "unless",
    "than",
    "then",
    "so",
    "if",
    "else",
    "because",
    "though",
    "although",
    "whether",
    "when",
    "where",
    "why",
    "how",
    "there",
    "here",
    "also",
    "too",
    "very",
    "just",
    "only",
    "not",
    "no",
    "nor",
    "yet",
    "still",
    "again",
    "back",
    "out",
    "off",
    "down",
    "around",
    "along",
    "per",
    "via",
    "about",
    "against",
    "toward",
    "towards",
    "within",
    "without",
    "among",
    "amongst",
    "up",
    // weak verbs / conversational glue
    "need",
    "needs",
    "needed",
    "want",
    "wants",
    "wanted",
    "make",
    "makes",
    "making",
    "made",
    "use",
    "uses",
    "using",
    "used",
    "get",
    "gets",
    "getting",
    "got",
    "gotten",
    "give",
    "gives",
    "given",
    "take",
    "takes",
    "taking",
    "taken",
    "put",
    "puts",
    "go",
    "goes",
    "going",
    "went",
    "come",
    "comes",
    "came",
    "see",
    "sees",
    "seeing",
    "seen",
    "look",
    "looks",
    "looking",
    "know",
    "knows",
    "knowing",
    "knew",
    "think",
    "thinks",
    "thinking",
    "thought",
    "say",
    "says",
    "said",
    "tell",
    "tells",
    "told",
    "ask",
    "asks",
    "asked",
    "asking",
    "try",
    "tries",
    "trying",
    "tried",
    "let",
    "lets",
    "letting",
    "feel",
    "feels",
    "free",
    "sure",
    "able",
    "please",
    "help",
    "helps",
    "helping",
    "work",
    "works",
    "working",
    "worked",
    "start",
    "starts",
    "started",
    "starting",
    "begin",
    "begins",
    "began",
    "run",
    "runs",
    "running",
    "ran",
    "keep",
    "keeps",
    "kept",
    "find",
    "finds",
    "finding",
    "found",
    "show",
    "shows",
    "showing",
    "shown",
    "ensure",
    "ensures",
    "seem",
    "seems",
    "seemed",
    "appear",
    "appears",
    "realize",
    "realized",
    "realise",
    "realised",
    "notice",
    "noticed",
    "mean",
    "means",
    "meant",
    "happen",
    "happens",
    "happening",
    "happened",
    "turn",
    "turns",
    "turned",
    "wonder",
    "wondering",
    "guess",
    "suppose",
    "consider",
    "considering",
    "touch",
    "touching",
    "touched",
    "follow",
    "follows",
    "following",
    "followed",
    "described",
    "describe",
    "describes",
    "introduce",
    "introduced",
    "introducing",
    // hedges / adverbs / evaluatives
    "good",
    "bad",
    "better",
    "best",
    "great",
    "nice",
    "fine",
    "okay",
    "ok",
    "yes",
    "yeah",
    "nope",
    "right",
    "wrong",
    "quick",
    "quickly",
    "fast",
    "slow",
    "small",
    "big",
    "large",
    "little",
    "tiny",
    "huge",
    "new",
    "old",
    "current",
    "currently",
    "previous",
    "previously",
    "prior",
    "next",
    "last",
    "first",
    "second",
    "third",
    "final",
    "finally",
    "actual",
    "actually",
    "basically",
    "maybe",
    "probably",
    "possibly",
    "likely",
    "definitely",
    "certainly",
    "honestly",
    "obviously",
    "simply",
    "exactly",
    "especially",
    "specific",
    "specifically",
    "explicitly",
    "really",
    "quite",
    "rather",
    "instead",
    "however",
    "additionally",
    "furthermore",
    "moreover",
    "overall",
    "generally",
    "usually",
    "often",
    "sometimes",
    "always",
    "never",
    "already",
    "soon",
    "later",
    "now",
    "today",
    "tomorrow",
    "yesterday",
    "etc",
    "eg",
    "ie",
    "thanks",
    "thank",
    "hi",
    "hello",
    "hey",
    "well",
    "like",
    "liked",
    "likes",
    "similar",
    "similarly",
    "different",
    "difference",
    "directly",
    // vague nouns
    "thing",
    "things",
    "stuff",
    "way",
    "ways",
    "time",
    "times",
    "case",
    "cases",
    "point",
    "points",
    "part",
    "parts",
    "kind",
    "kinds",
    "sort",
    "sorts",
    "bit",
    "bits",
    "idea",
    "ideas",
    "note",
    "notes",
    "word",
    "words",
    "list",
    "lists",
    "item",
    "items",
    "number",
    "numbers",
    "side",
    "sides",
    "end",
    "ends",
    "top",
    "bottom",
    // spelled-out small numbers
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    // apostrophe-less contractions
    "dont",
    "doesnt",
    "didnt",
    "cant",
    "wont",
    "isnt",
    "arent",
    "wasnt",
    "werent",
    "havent",
    "hasnt",
    "wouldnt",
    "couldnt",
    "shouldnt",
    "whats",
    "thats",
    // evaluative / meta adjectives
    "correct",
    "correctly",
    "proper",
    "properly",
    "appropriate",
    "acceptable",
    "relevant",
    "useful",
    "important",
    "existing",
    "whole",
    "entire",
    "full",
    "clear",
    "clearly",
    "carefully",
    "careful",
    "blindly",
    "silently",
    "half",
    "pager",
    "deep",
    "dive",
    "figure",
    "figures",
    "figured",
    "invoke",
    "invokes",
    "invoking",
    "invoked",
    // "the user" is the person typing the prompt in ~every prompt here
    "user",
    "users",
];

/// Domain vocabulary true of *every* vibe-station prompt (distinguishes nothing).
static NOISE: &[&str] = &[
    "session",
    "sessions",
    "agent",
    "agents",
    "subagent",
    "subagents",
    "worktree",
    "worktrees",
    "task",
    "tasks",
    "code",
    "codebase",
    "codebases",
    "project",
    "projects",
    "repo",
    "repos",
    "repository",
    "prompt",
    "prompts",
    "branch",
    "branches",
    "commit",
    "commits",
    "claude",
    "opus",
    "sonnet",
    "llm",
    "vst",
    "vibe",
    "vibestation",
    "vibe-station",
];

/// The subset of STOPWORDS that carries zero content even as a last resort.
static CORE_FUNCTION_WORDS: &[&str] = &[
    "a", "an", "the", "this", "that", "these", "those", "of", "to", "in", "on", "for", "and", "or",
    "but", "as", "at", "by", "from", "is", "are", "was", "were", "be", "been", "being",
];

/// `vs-45`, `pr17`, `ch-61`, `unl46` — a short prefix plus a number is an ID.
static ID_TOKEN: &str = r"^[a-z]{1,5}-?\d+[a-z0-9-]*$";
/// `3014443e`, `c41d680` — sha-ish: long, hex-only, containing at least one digit.
static HEXISH_TOKEN: &str = r"^(?=[0-9a-f]*\d)[0-9a-f]{6,}$";
/// `v1`, `v1.3`, `api2` — a bare version/number-suffixed stub.
static VERSIONISH_TOKEN: &str = r"^v?\d[\d-]*$";

/// Cap on how much of `prompt` we bother scrubbing (quadratic-regex guard).
const MAX_SCRUB_LEN: usize = 4000;

fn scrub(prompt: &str) -> String {
    let mut s = prompt.to_string();
    // Fenced code blocks
    s = Regex::new(r"```[\s\S]*?```")
        .unwrap()
        .replace_all(&s, " ")
        .into_owned();
    // Inline code spans
    s = Regex::new(r"`[^`]*`")
        .unwrap()
        .replace_all(&s, " ")
        .into_owned();
    // URLs
    s = Regex::new(r"https?://\S+")
        .unwrap()
        .replace_all(&s, " ")
        .into_owned();
    // Path-shaped tokens
    s = Regex::new(r"\S*/\S+")
        .unwrap()
        .replace_all(&s, " ")
        .into_owned();
    // Filename-shaped tokens (SPEC.md, Foo.kt)
    s = Regex::new(r"[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?![\w.])")
        .unwrap()
        .replace_all(&s, " ")
        .into_owned();
    // Contractions -> expanded ("didn't" -> "did not")
    s = Regex::new(r"(?i)n['’]t\b")
        .unwrap()
        .replace_all(&s, " not")
        .into_owned();
    // Possessives / contractions -> bare stem
    s = Regex::new(r"(?i)['’](s|re|ve|ll|d|m)\b")
        .unwrap()
        .replace_all(&s, "")
        .into_owned();
    // Any leftover apostrophes glue rather than split
    s = s.replace(['\'', '’'], "");
    s
}

/// Words the author signalled as proper nouns or acronyms.
fn collect_emphasized(scrubbed: &str) -> (HashSet<String>, HashSet<String>) {
    let mut emphasized = HashSet::new();
    let mut acronyms = HashSet::new();
    let re = Regex::new(r"[A-Za-z][A-Za-z0-9-]*").unwrap();
    for m in re.find_iter(scrubbed) {
        let Ok(m) = m else { continue };
        let word = m.as_str();
        let char_len = word.chars().count();
        if char_len < 2 {
            continue;
        }
        let upper = word.to_uppercase();
        if word == upper && word.chars().filter(|c| c.is_ascii_uppercase()).count() >= 2 {
            emphasized.insert(word.to_lowercase());
            acronyms.insert(word.to_lowercase());
            continue;
        }
        let head = word.chars().next().unwrap();
        if !head.is_ascii_uppercase() {
            continue;
        }
        // Walk back to the previous non-space char; a capital right after
        // sentence-ending/structural punctuation is just normal capitalisation.
        let mut i = m.start();
        let bytes = scrubbed.as_bytes();
        while i > 0 && bytes[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i == 0 {
            continue;
        }
        if is_sentence_punct(bytes[i - 1]) {
            continue;
        }
        emphasized.insert(word.to_lowercase());
    }
    (emphasized, acronyms)
}

fn is_sentence_punct(b: u8) -> bool {
    matches!(
        b,
        b'.' | b'!' | b'?' | b':' | b';' | b'#' | b'*' | b'-' | b'[' | b'(' | b'{' | b'"' | b'\''
    )
}

/// Structural rejects — applied in both the strict and the loose pass.
fn is_structural_junk(word: &str, acronyms: &HashSet<String>) -> bool {
    let char_len = word.chars().count();
    if char_len <= 2 && !acronyms.contains(word) {
        return true;
    }
    if word.split('-').any(|part| part.chars().count() > 14) {
        return true;
    }
    if word.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    let id_re = Regex::new(ID_TOKEN).unwrap();
    let hex_re = Regex::new(HEXISH_TOKEN).unwrap();
    let ver_re = Regex::new(VERSIONISH_TOKEN).unwrap();
    id_re.is_match(word).unwrap_or(false)
        || hex_re.is_match(word).unwrap_or(false)
        || ver_re.is_match(word).unwrap_or(false)
}

/// Slugify a creation prompt into a deterministic display label.
///
/// Defaults to `max_words = 3`, `max_len = 60`. Returns `""` for prompts whose
/// every survivor is pure filler — callers fall back to the existing default
/// label in that case.
pub fn slugify_prompt(prompt: &str) -> String {
    slugify_prompt_with(prompt, 3, 60)
}

/// [`slugify_prompt`] with explicit word/length caps.
pub fn slugify_prompt_with(prompt: &str, max_words: usize, max_len: usize) -> String {
    let capped: String = if prompt.chars().count() > MAX_SCRUB_LEN {
        prompt.chars().take(MAX_SCRUB_LEN).collect()
    } else {
        prompt.to_string()
    };
    let scrubbed = scrub(&capped);
    let (emphasized, acronyms) = collect_emphasized(&scrubbed);

    let words: Vec<String> = scrubbed
        .to_lowercase()
        .replace(
            |c: char| {
                !(c.is_ascii_lowercase() || c.is_ascii_digit() || c.is_whitespace() || c == '-')
            },
            " ",
        )
        .split_whitespace()
        .map(|w| w.trim_matches('-').to_string())
        .filter(|w| !w.is_empty())
        .collect();

    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();
    let noise: HashSet<&str> = NOISE.iter().copied().collect();
    let core: HashSet<&str> = CORE_FUNCTION_WORDS.iter().copied().collect();

    let keep = |w: &str, strict: bool| -> bool {
        !is_structural_junk(w, &acronyms)
            && !noise.contains(w)
            && (strict && !stopwords.contains(w) || !strict && !core.contains(w))
    };

    let mut content: Vec<String> = words.iter().filter(|w| keep(w, true)).cloned().collect();
    if content.is_empty() {
        content = words.iter().filter(|w| keep(w, false)).cloned().collect();
    }
    if content.is_empty() {
        return String::new();
    }

    // First-occurrence index (reading order) + repetition count per unique word.
    let mut first_at: HashMap<String, usize> = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (i, w) in content.iter().enumerate() {
        first_at.entry(w.clone()).or_insert(i);
        *counts.entry(w.clone()).or_insert(0) += 1;
    }

    let total = content.len();
    let mut scored: Vec<(String, usize, f64)> = Vec::new();
    for word in first_at.keys() {
        let at = first_at[word];
        let len = word.chars().count();
        let score = 1.0
            + (len.min(10) as f64) / 8.0
            + if emphasized.contains(word) { 0.8 } else { 0.0 }
            + (counts[word].saturating_sub(1)).min(4) as f64 * 0.7
            - if word.ends_with("ly") && len >= 6 {
                0.8
            } else {
                0.0
            }
            - (at as f64 / total as f64) * 0.6;
        scored.push((word.clone(), at, score));
    }

    scored.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });

    // Take the best `maxWords`, skipping anything already covered by a
    // hyphenated pick.
    let mut picked: Vec<(String, usize)> = Vec::new();
    for (word, at, _score) in &scored {
        if picked.len() >= max_words {
            break;
        }
        let parts: Vec<&str> = word.split('-').collect();
        let overlaps = picked.iter().any(|(p_word, _)| {
            let p_parts: Vec<&str> = p_word.split('-').collect();
            parts.iter().any(|x| p_parts.contains(x))
        });
        if overlaps {
            continue;
        }
        picked.push((word.clone(), *at));
    }
    picked.sort_by_key(|(_, at)| *at);

    // Trim whole words to fit max_len; only hard-slice if a single word overflows.
    let mut parts: Vec<String> = picked.into_iter().map(|(w, _)| w).collect();
    while parts.len() > 1 && parts.join("-").len() > max_len {
        parts.pop();
    }
    let slug = parts.join("-");
    if slug.chars().count() > max_len {
        let sliced: String = slug.chars().take(max_len).collect();
        sliced.trim_end_matches('-').to_string()
    } else {
        slug
    }
}
