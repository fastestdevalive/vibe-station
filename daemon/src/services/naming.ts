/**
 * Deterministic naming heuristic (F1) — a pure, synchronous slug derived from
 * a creation prompt. No LLM involvement; the CLI already resolves
 * `--prompt`/`--prompt-file` into one string before it reaches the daemon
 * (`resolveFileOrInline`), so this never needs to special-case the
 * prompt-file path.
 *
 * Run once, synchronously, at worktree/session creation whenever
 * `req.body.prompt` is non-empty (Requirement 3). Non-English/non-ASCII
 * prompts and empty/whitespace-only prompts both produce `""` — callers fall
 * back to the existing default label in that case (no i18n handling planned).
 *
 * ## Design
 *
 * The original version took "the first N words that aren't stopwords". Against
 * real prompts that produced names like `has-one-commit`, `like-change-default`
 * and `previous-started-vs-45`: prompts almost always open with throat-clearing
 * ("I would like to...", "The previous worktree that was started vs-45..."),
 * so the first surviving words are filler while the actual topic sits a clause
 * or two later. This version keeps the same contract but changes three things:
 *
 * 1. **Scrub harder before scoring.** Code fences, URLs, path-shaped tokens,
 *    filename-shaped tokens (`SPEC.md`, `BackgroundStep.kt` — otherwise `md`/
 *    `kt`/`spec` leak in) and ID/ref-shaped tokens (`vs-45`, `pr17`, `ch-61`,
 *    sha-ish hex) are removed. Contractions are expanded (`didn't` -> `did not`)
 *    so they collapse into stopwords instead of leaving `didn`/`t` fragments.
 * 2. **A much larger stopword list**, covering function words *and* the weak
 *    verbs/hedges/quantifiers that dominate conversational prompts (has, one,
 *    like, lot, times, see, started, good, get, realized, previous, ...).
 *    Strong action verbs (fix, add, implement, migrate, ...) are deliberately
 *    NOT stopwords — they make good names.
 * 3. **Score instead of taking the first N.** Each surviving word gets a cheap
 *    informativeness score: word length, how often it repeats in the prompt
 *    (topical words recur, filler usually doesn't), whether it appeared
 *    capitalised mid-sentence or in ALL CAPS (proper nouns / acronyms like
 *    `Android`, `SDK`, `BYOT`), minus a small penalty for how late it first
 *    appears (a mild tie-break toward the opening, not a hard rule). The top
 *    `maxWords` are then emitted in original prompt order so the slug still
 *    reads like a phrase.
 *
 * If the strict pass filters *everything* out (a prompt made entirely of
 * filler), a loose pass re-runs with only the structural filters, so we still
 * return something rather than falling back to a numbered default.
 *
 * Everything here stays pure/sync/allocation-cheap on purpose: callers invoke
 * it inline inside request handlers (`routes/worktrees.ts`,
 * `routes/sessions.ts`, `routes/projects.ts`).
 */

/**
 * Words that carry ~no naming signal. Function words plus the "conversational
 * glue" tier: weak verbs (get/see/make/try), hedges (maybe/actually), vague
 * nouns (thing/way/lot/time) and evaluative adjectives (good/quick/new).
 * Deliberately absent: fix, add, remove, implement, migrate, refactor, port,
 * upgrade, support, plan, report, ... — those describe the task.
 */
const STOPWORDS = new Set([
  // articles / determiners / quantifiers
  "a","an","the","this","that","these","those","such","some","any","all","both",
  "each","every","other","another","same","few","several","enough","own","none",
  "more","most","less","least","much","many","lot","lots","bunch","couple",
  // pronouns
  "i","me","my","mine","we","us","our","ours","you","your","yours","he","she",
  "him","her","his","hers","they","them","their","theirs","it","its","who","whom",
  "whose","which","what","whatever","whichever","whoever","someone","somebody",
  "something","anyone","anybody","anything","everyone","everybody","everything",
  "nothing","nobody","one","ones","itself","myself","yourself","themselves",
  // be / have / do / modals
  "am","is","are","was","were","be","been","being","have","has","had","having",
  "do","does","did","doing","done","will","would","shall","should","can","could",
  "may","might","must","cannot",
  // prepositions / conjunctions / connectives
  "to","of","in","on","for","with","and","or","but","as","at","by","from","into",
  "onto","upon","over","under","above","below","between","across","through",
  "throughout","during","before","after","while","since","until","unless","than",
  "then","so","if","else","because","though","although","whether","when","where",
  "why","how","there","here","also","too","very","just","only","not","no","nor",
  "yet","still","again","back","out","off","down","around","along","per","via",
  "about","against","toward","towards","within","without","among","amongst","up",
  // weak verbs / conversational glue
  "need","needs","needed","want","wants","wanted","make","makes","making","made",
  "use","uses","using","used","get","gets","getting","got","gotten","give","gives",
  "given","take","takes","taking","taken","put","puts","go","goes","going","went",
  "come","comes","came","see","sees","seeing","seen","look","looks","looking",
  "know","knows","knowing","knew","think","thinks","thinking","thought","say",
  "says","said","tell","tells","told","ask","asks","asked","asking","try","tries",
  "trying","tried","let","lets","letting","feel","feels","free","sure","able",
  "please","help","helps","helping","work","works","working","worked","start",
  "starts","started","starting","begin","begins","began","run","runs","running",
  "ran","keep","keeps","kept","find","finds","finding","found","show","shows",
  "showing","shown","ensure","ensures","seem","seems","seemed","appear","appears",
  "realize","realized","realise","realised","notice","noticed","mean","means",
  "meant","happen","happens","happening","happened","turn","turns","turned",
  "wonder","wondering","guess","suppose","consider","considering","touch",
  "touching","touched","follow","follows","following","followed","described",
  "describe","describes","introduce","introduced","introducing",
  // hedges / adverbs / evaluatives
  "good","bad","better","best","great","nice","fine","okay","ok","yes","yeah",
  "nope","right","wrong","quick","quickly","fast","slow","small","big","large",
  "little","tiny","huge","new","old","current","currently","previous","previously",
  "prior","next","last","first","second","third","final","finally","actual",
  "actually","basically","maybe","probably","possibly","likely","definitely",
  "certainly","honestly","obviously","simply","exactly","especially","specific",
  "specifically","explicitly","really","quite","rather","instead","however",
  "additionally","furthermore","moreover","overall","generally","usually","often",
  "sometimes","always","never","already","soon","later","now","today","tomorrow",
  "yesterday","etc","eg","ie","thanks","thank","hi","hello","hey","well","like",
  "liked","likes","similar","similarly","different","difference","directly",
  // vague nouns
  "thing","things","stuff","way","ways","time","times","case","cases","point",
  "points","part","parts","kind","kinds","sort","sorts","bit","bits","idea",
  "ideas","note","notes","word","words","list","lists","item",
  "items","number","numbers","side","sides","end","ends","top","bottom",
  // spelled-out small numbers
  "two","three","four","five","six","seven","eight","nine","ten",
  // apostrophe-less contractions (the apostrophe form is normalised away above,
  // but people type these bare too)
  "dont","doesnt","didnt","cant","wont","isnt","arent","wasnt","werent",
  "havent","hasnt","wouldnt","couldnt","shouldnt","whats","thats",
  // evaluative / meta adjectives that describe quality, not subject matter
  "correct","correctly","proper","properly","appropriate","acceptable",
  "relevant","useful","important","existing","whole","entire","full","clear",
  "clearly","carefully","careful","blindly","silently","half","pager","deep",
  "dive","figure","figures","figured","invoke","invokes","invoking","invoked",
  // "the user" is the person typing the prompt in ~every prompt here
  "user","users",
]);

/**
 * Domain vocabulary that is true of *every* vibe-station prompt and therefore
 * distinguishes nothing. Separate from STOPWORDS so the two lists stay
 * independently reviewable.
 */
const NOISE = new Set([
  "session","sessions","agent","agents","subagent","subagents","worktree",
  "worktrees","task","tasks","code","codebase","codebases","project","projects",
  "repo","repos","repository","prompt","prompts","branch","branches","commit",
  "commits","claude","opus","sonnet","llm",
  // this tool's own name — never distinguishes one worktree from another
  "vst","vibe","vibestation","vibe-station",
]);

/**
 * The subset of STOPWORDS that carries zero content even as a last resort —
 * bare grammatical connectors (articles, core prepositions/conjunctions, the
 * verb "to be", demonstratives). Ordinary STOPWORDS are dropped from the
 * strict pass but let through the loose fallback pass (see `slugifyPrompt`)
 * so an all-filler prompt still surfaces *something*; this smaller set stays
 * excluded even in the loose pass, since a slug that's just "the" is no
 * better than no name at all.
 */
const CORE_FUNCTION_WORDS = new Set([
  "a","an","the","this","that","these","those",
  "of","to","in","on","for","and","or","but","as","at","by","from",
  "is","are","was","were","be","been","being",
]);

/** `vs-45`, `pr17`, `ch-61`, `unl46` — a short prefix plus a number is an ID, not a description. */
const ID_TOKEN = /^[a-z]{1,5}-?\d+[a-z0-9-]*$/;
/** `3014443e`, `c41d680` — sha-ish: long, hex-only, and containing at least one digit. */
const HEXISH_TOKEN = /^(?=[0-9a-f]*\d)[0-9a-f]{6,}$/;
/** `v1`, `v1.3`, `api2` — a bare version/number-suffixed stub. */
const VERSIONISH_TOKEN = /^v?\d[\d-]*$/;

/**
 * Strip everything that is markup/reference rather than prose. Case is
 * preserved because capitalisation is used as a scoring signal downstream.
 */
function scrub(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code spans (usually paths/identifiers)
    .replace(/https?:\/\/\S+/g, " ") // URLs
    .replace(/\S*\/\S+/g, " ") // path-shaped tokens (avoids "tmp"/"pr" leaking from /tmp/pr.diff)
    .replace(/[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?![\w.])/g, " ") // filename-shaped tokens (SPEC.md, Foo.kt)
    .replace(/n['’]t\b/gi, " not") // didn't -> did not (both stopwords)
    .replace(/['’](s|re|ve|ll|d|m)\b/gi, "") // possessives / contractions -> bare stem
    .replace(/['’]/g, ""); // any leftover apostrophes glue rather than split
}

/**
 * Words the author signalled as proper nouns or acronyms: ALL-CAPS runs, or a
 * capitalised word that is NOT at a sentence/line/bullet start. Cheap stand-in
 * for "this is a domain term" without any POS tagging.
 */
function collectEmphasized(scrubbed: string): { emphasized: Set<string>; acronyms: Set<string> } {
  const emphasized = new Set<string>();
  const acronyms = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    const word = m[0];
    if (word.length < 2) continue;
    if (word === word.toUpperCase() && /[A-Z]{2,}/.test(word)) {
      // ALL CAPS: SDK, PRD, UI, BYOT. Tracked separately so short acronyms can
      // survive the >2-chars length floor that filters ordinary noise.
      emphasized.add(word.toLowerCase());
      acronyms.add(word.toLowerCase());
      continue;
    }
    const head = word.charAt(0);
    if (head !== head.toUpperCase()) continue;
    // Walk back to the previous non-space character; a capital right after
    // sentence-ending/structural punctuation is just normal capitalisation.
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(scrubbed.charAt(i))) i--;
    if (i < 0) continue;
    if (/[.!?:;#*\-–—([{"']/.test(scrubbed.charAt(i))) continue;
    emphasized.add(word.toLowerCase());
  }
  return { emphasized, acronyms };
}

/**
 * Structural rejects — applied in both the strict and the loose pass.
 * `acronyms` lets 2-letter ALL-CAPS terms (UI, UX, CI, DB) through the length
 * floor while ordinary 2-letter words stay out.
 */
function isStructuralJunk(word: string, acronyms: Set<string>): boolean {
  return (
    (word.length <= 2 && !acronyms.has(word)) ||
    // Run-together CamelCase identifiers (UserByotTemplates) make ugly slugs.
    // Measured per hyphen component so real compounds (multi-platform) survive.
    word.split("-").some((part) => part.length > 14) ||
    /^\d+$/.test(word) ||
    ID_TOKEN.test(word) ||
    HEXISH_TOKEN.test(word) ||
    VERSIONISH_TOKEN.test(word)
  );
}

/**
 * Cap on how much of `prompt` we bother scrubbing. `scrub()`'s path/filename
 * regexes are quadratic on long whitespace-free input (e.g. a pasted minified
 * blob or a `--prompt-file` dump — `prompt` has no upstream max length), and
 * this function runs synchronously inside the create-worktree/create-session
 * request handlers, so an unbounded prompt can stall the daemon's event loop.
 * Naming only ever needs the opening context anyway.
 */
const MAX_SCRUB_LEN = 4000;

export function slugifyPrompt(prompt: string, maxWords = 3, maxLen = 60): string {
  const capped = prompt.length > MAX_SCRUB_LEN ? prompt.slice(0, MAX_SCRUB_LEN) : prompt;
  const scrubbed = scrub(capped);
  const { emphasized, acronyms } = collectEmphasized(scrubbed);

  const words = scrubbed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ") // remaining punctuation -> spaces
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, "")) // trim stray leading/trailing hyphens
    .filter(Boolean);

  const keep = (w: string, strict: boolean) =>
    !isStructuralJunk(w, acronyms) &&
    !NOISE.has(w) &&
    (strict ? !STOPWORDS.has(w) : !CORE_FUNCTION_WORDS.has(w));

  // Strict pass first; fall back to a looser filter when a prompt is pure
  // filler, so we still beat "no name at all". The loose pass drops the full
  // ~450-word STOPWORDS list (it exists precisely so *some* word survives)
  // but still excludes CORE_FUNCTION_WORDS — otherwise an all-filler prompt
  // like "the a an of to" would loose-pass its way to a slug of just "the",
  // which is no better than no name at all.
  let content = words.filter((w) => keep(w, true));
  if (content.length === 0) content = words.filter((w) => keep(w, false));
  if (content.length === 0) return ""; // caller falls back to the existing default label

  // First-occurrence index (reading order) + repetition count per unique word.
  const firstAt = new Map<string, number>();
  const counts = new Map<string, number>();
  content.forEach((w, i) => {
    if (!firstAt.has(w)) firstAt.set(w, i);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  });

  // Cheap informativeness score. Repetition is the strongest signal (a prompt's
  // real subject gets mentioned again; filler usually doesn't), so it outweighs
  // both word length and reading position.
  const total = content.length;
  const scored = [...firstAt.keys()].map((word) => {
    const at = firstAt.get(word)!;
    const score =
      1 +
      Math.min(word.length, 10) / 8 + // longer words carry more meaning, capped
      (emphasized.has(word) ? 0.8 : 0) + // proper noun / acronym
      Math.min((counts.get(word) ?? 1) - 1, 4) * 0.7 - // topical words recur
      (/ly$/.test(word) && word.length >= 6 ? 0.8 : 0) - // -ly adverbs describe manner, not subject
      (at / total) * 0.6; // mild preference for the opening, not a hard rule
    return { word, at, score };
  });

  scored.sort((a, b) => b.score - a.score || a.at - b.at);

  // Take the best `maxWords`, skipping anything already covered by a
  // hyphenated pick (avoids "moving-backgrounds-customizable-backgrounds").
  const picked: { word: string; at: number }[] = [];
  for (const cand of scored) {
    if (picked.length >= maxWords) break;
    const parts = cand.word.split("-");
    const overlaps = picked.some((p) => {
      const pParts = p.word.split("-");
      return parts.some((x) => pParts.includes(x));
    });
    if (overlaps) continue;
    picked.push({ word: cand.word, at: cand.at });
  }
  picked.sort((a, b) => a.at - b.at); // emit in prompt order so it reads as a phrase

  // Trim whole words to fit maxLen; only hard-slice if a single word overflows.
  const parts = picked.map((p) => p.word);
  while (parts.length > 1 && parts.join("-").length > maxLen) parts.pop();
  const slug = parts.join("-");
  return slug.length > maxLen ? slug.slice(0, maxLen).replace(/-+$/, "") : slug;
}
