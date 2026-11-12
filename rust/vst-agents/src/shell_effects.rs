//! Write targets of a shell command line, for artifact capture.
//!
//! [`shell_write_targets`] is a pure, tolerant, panic-free reader of the COMMON
//! ways an agent writes a file through a shell tool (`> f`, `>> f`, `tee`,
//! `cp`/`mv`/`install`, `touch`, `dd of=`, `curl -o`, `wget -O`). It never
//! executes or expands anything: the only substitution is of `$VAR`/`${VAR}`
//! by a value assigned literally earlier in the same command line. Anything
//! it cannot resolve with certainty (command substitution, backticks, unset or
//! computed variables, globs, brace expansion, `~`) is SKIPPED, never guessed;
//! the capture pipeline then only keeps targets that really exist afterwards.
//!
//! Scoping is tracked conservatively: `( ... )` and the body of a function
//! definition restore `cd` and variables when they end; `popd`, `source`/`.`,
//! `eval`, a call of a defined function, `case` and anything that rebinds a
//! variable (`for`, `read`, `unset`, `let`, `$((x=..))`, `${x:=..}`) make the
//! affected state unknown (relative paths / that variable are then skipped).
//! Stderr redirects (`2>`) and targets ending in `.log`/`.pid`/`.lock` are noise
//! and never captured. `mv a b` yields a `Move` effect (the artifact pipeline
//! re-points `a`'s row; `a` is only a lookup key, never added).
//!
//! Deliberately not handled (the agent should `vst artifact add`): scripts and
//! language runtimes writing files, `sh -c '...'` nesting, aliases, pipeline
//! stages as subshells (`cd x | cmd`), interpolated paths, `rm`, `pushd`/`popd`
//! stacks (`popd` just forgets the directory).
//!
//! Bounds: a stored or resolved variable value over [`MAX_RESOLVED`] bytes is
//! UNRESOLVED (so any word using it is skipped), at most `MAX_VARS` variables
//! are kept, and all expansion and scope-snapshot work per command line is
//! charged against a fixed budget (`WORK_BUDGET`); when it runs out the rest of
//! the line is ignored. Everything else is linear in the command length, which
//! is capped at [`MAX_COMMAND_BYTES`]; at most [`MAX_TARGETS`] targets.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use vst_types::artifacts::FileEffect;

/// Commands longer than this are ignored entirely.
pub const MAX_COMMAND_BYTES: usize = 64 * 1024;
/// At most this many targets are returned.
pub const MAX_TARGETS: usize = 64;

/// Candidate files `command` writes (destinations only), in first-seen order,
/// deduplicated. Relative paths resolve against the tracked `cd` target, else
/// `cwd`; with neither known they are skipped.
pub fn shell_write_targets(command: &str, cwd: Option<&Path>) -> Vec<PathBuf> {
    run_command(command, cwd).into_iter().map(|t| t.0).collect()
}

/// [`shell_write_targets`] as effects: a `Write` per target, or a `Move` for
/// `mv` when both sides resolved to absolute paths.
pub fn shell_file_effects(command: &str, cwd: Option<&Path>) -> Vec<FileEffect> {
    run_command(command, cwd)
        .into_iter()
        .map(|(to, from)| {
            let to = to.to_string_lossy().into_owned();
            match from {
                Some(f) => FileEffect::moved(f.to_string_lossy().into_owned(), to),
                None => FileEffect::write(to),
            }
        })
        .collect()
}

/// (destination, move source) pairs.
fn run_command(command: &str, cwd: Option<&Path>) -> Vec<(PathBuf, Option<PathBuf>)> {
    run_bounded(command, cwd).out
}

/// Interpret `command` until it ends, [`MAX_TARGETS`] is reached or the work
/// budget is spent. Returns the whole [`Run`] so tests can read the work charged.
fn run_bounded(command: &str, cwd: Option<&Path>) -> Run {
    let mut run = Run::new(cwd);
    if command.len() > MAX_COMMAND_BYTES {
        return run;
    }
    for cmd in lex(command) {
        run.exec(cmd);
        if run.out.len() >= MAX_TARGETS || run.exhausted() {
            break;
        }
    }
    run
}

// ---------------------------------------------------------------- lexer ----

#[derive(Clone, Debug)]
enum Seg {
    Lit(String),
    Var { name: String, quoted: bool },
}

/// One shell word. `bad` = contains something never resolved (substitution,
/// glob, brace, tilde, unterminated quote).
#[derive(Clone, Debug, Default)]
struct Word {
    segs: Vec<Seg>,
    bad: bool,
    /// Contains an arithmetic assignment or `${x=..}`: variables become unknown.
    clear: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum RedirKind {
    /// `>` `>>` `>|` `&>` `&>>`: the next word is written.
    Write,
    /// `<` `<<<` `<>`: the next word is consumed and ignored.
    Skip,
}

#[derive(Debug)]
enum Item {
    Word(Word),
    Redir(RedirKind),
    /// `(( x = 1 ))`: an arithmetic command that assigns.
    Clear,
    /// Sole item of a command: `(` starts a subshell.
    Open,
    /// Sole item of a command: `)` ends it.
    Close,
    /// Sole item of a command: `name()` function definition.
    FuncDef(String),
}

/// The text of a word made of one literal segment (quoting removed).
fn raw_lit(w: &Word) -> Option<&str> {
    match w.segs.as_slice() {
        [Seg::Lit(s)] => Some(s),
        _ => None,
    }
}

fn is_func_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

/// Words after which a new command begins.
const LEADING_KEYWORDS: &[&str] = &["if", "while", "until", "elif", "then", "do", "else", "!"];

fn is_ident(s: &str) -> bool {
    let mut it = s.chars();
    matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && it.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

struct Lexer {
    c: Vec<char>,
    i: usize,
    cmds: Vec<Vec<Item>>,
    cur: Vec<Item>,
    word: Word,
    started: bool,
    lit: String,
    pending_heredocs: Vec<(String, bool)>,
    /// Inside `[[ ... ]]`, where `<`/`>` compare instead of redirecting.
    in_test: bool,
}

/// Split into simple commands (each a list of words and redirections).
fn lex(src: &str) -> Vec<Vec<Item>> {
    let mut lx = Lexer {
        c: src.chars().collect(),
        i: 0,
        cmds: Vec::new(),
        cur: Vec::new(),
        word: Word::default(),
        started: false,
        lit: String::new(),
        pending_heredocs: Vec::new(),
        in_test: false,
    };
    lx.run();
    lx.cmds
}

impl Lexer {
    fn peek(&self, off: usize) -> Option<char> {
        self.c.get(self.i + off).copied()
    }

    fn flush_lit(&mut self) {
        if !self.lit.is_empty() {
            let s = std::mem::take(&mut self.lit);
            self.word.segs.push(Seg::Lit(s));
        }
    }

    fn end_word(&mut self) {
        if !self.started {
            return;
        }
        self.flush_lit();
        let mut w = std::mem::take(&mut self.word);
        match raw_lit(&w) {
            Some("[[") if self.at_command_start() => self.in_test = true,
            Some("]]") => self.in_test = false,
            _ => {}
        }
        // A bare `{` / `}` is a shell group keyword, not a brace expansion.
        if w.bad && matches!(w.segs.as_slice(), [Seg::Lit(s)] if s == "{" || s == "}") {
            w.bad = false;
        }
        self.cur.push(Item::Word(w));
        self.started = false;
    }

    /// The words so far are empty or only leading keywords (`if`, `while`, ...).
    fn at_command_start(&self) -> bool {
        self.cur.iter().all(|it| match it {
            Item::Word(w) => raw_lit(w).is_some_and(|t| LEADING_KEYWORDS.contains(&t)),
            _ => false,
        })
    }

    /// At `(`: arithmetic command, function definition, or subshell.
    fn open_paren(&mut self) {
        self.end_word();
        if self.peek(1) == Some('(') && self.at_command_start() {
            self.i += 2;
            let mut depth = 2usize;
            let mut assigns = false;
            while let Some(q) = self.peek(0) {
                self.i += 1;
                match q {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    '=' => assigns = true,
                    _ => {}
                }
            }
            if assigns {
                self.cur.push(Item::Clear);
            }
            return;
        }
        self.i += 1;
        let name = match self.cur.as_slice() {
            [Item::Word(w)] => raw_lit(w).filter(|n| is_func_name(n)).map(str::to_string),
            _ => None,
        };
        if let Some(name) = name {
            let mut j = 0;
            while matches!(self.peek(j), Some(' ') | Some('\t')) {
                j += 1;
            }
            if self.peek(j) == Some(')') {
                self.i += j + 1;
                self.cur.clear();
                self.cmds.push(vec![Item::FuncDef(name)]);
                return;
            }
        }
        self.end_command();
        self.cmds.push(vec![Item::Open]);
    }

    fn end_command(&mut self) {
        self.end_word();
        if !self.cur.is_empty() {
            let c = std::mem::take(&mut self.cur);
            self.cmds.push(c);
        }
    }

    fn push_redir(&mut self, k: RedirKind) {
        self.end_word();
        self.cur.push(Item::Redir(k));
    }

    fn run(&mut self) {
        while let Some(ch) = self.peek(0) {
            match ch {
                ' ' | '\t' | '\r' => {
                    self.i += 1;
                    self.end_word();
                }
                '\n' => {
                    self.i += 1;
                    self.end_command();
                    self.in_test = false;
                    self.skip_heredoc_bodies();
                }
                '#' if !self.started => {
                    while !matches!(self.peek(0), None | Some('\n')) {
                        self.i += 1;
                    }
                }
                ';' => {
                    self.i += 1;
                    self.end_command();
                }
                '(' => self.open_paren(),
                ')' => {
                    self.i += 1;
                    self.end_command();
                    self.cmds.push(vec![Item::Close]);
                }
                '|' => {
                    self.i += 1;
                    if matches!(self.peek(0), Some('|') | Some('&')) {
                        self.i += 1;
                    }
                    self.end_command();
                }
                '&' => {
                    self.i += 1;
                    if self.peek(0) == Some('>') {
                        self.i += 1;
                        if self.peek(0) == Some('>') {
                            self.i += 1;
                        }
                        self.push_redir(RedirKind::Write);
                    } else {
                        if self.peek(0) == Some('&') {
                            self.i += 1;
                        }
                        self.end_command();
                    }
                }
                '>' | '<' if !self.in_test => self.redirect(ch),
                _ => self.word_char(ch),
            }
        }
        self.end_command();
    }

    /// `>`/`<` family. A preceding all-digit word is an fd number.
    fn redirect(&mut self, ch: char) {
        let mut fd: Option<u32> = None;
        if self.started
            && self.word.segs.is_empty()
            && !self.lit.is_empty()
            && !self.word.bad
            && self.lit.chars().all(|c| c.is_ascii_digit())
        {
            fd = self.lit.parse().ok();
            self.lit.clear();
            self.started = false;
        }
        self.i += 1;
        if ch == '>' {
            // Stderr (`2>`) is diagnostics, never a deliverable.
            let kind = if fd == Some(2) {
                RedirKind::Skip
            } else {
                RedirKind::Write
            };
            match self.peek(0) {
                Some('>') | Some('|') => self.i += 1,
                Some('&') => {
                    // `>&N` / `>&-` duplicate or close an fd; `>&word` writes `word`.
                    let n = self.peek(1);
                    if matches!(n, Some(d) if d.is_ascii_digit() || d == '-') {
                        self.i += 2;
                        while matches!(self.peek(0), Some(d) if d.is_ascii_digit()) {
                            self.i += 1;
                        }
                        self.end_word();
                        return;
                    }
                    self.i += 1;
                }
                _ => {}
            }
            self.push_redir(kind);
            return;
        }
        match self.peek(0) {
            Some('<') => {
                self.i += 1;
                match self.peek(0) {
                    Some('<') => {
                        self.i += 1;
                        self.push_redir(RedirKind::Skip); // here-string
                    }
                    _ => {
                        let strip = self.peek(0) == Some('-');
                        if strip {
                            self.i += 1;
                        }
                        self.end_word();
                        let delim = self.read_heredoc_delim();
                        self.pending_heredocs.push((delim, strip));
                    }
                }
            }
            Some('&') => {
                // `<&N` duplicates an input fd.
                self.i += 1;
                while matches!(self.peek(0), Some(d) if d.is_ascii_digit() || d == '-') {
                    self.i += 1;
                }
                self.end_word();
            }
            Some('>') => {
                self.i += 1;
                self.push_redir(RedirKind::Skip);
            }
            _ => self.push_redir(RedirKind::Skip),
        }
    }

    /// The raw delimiter after `<<`, quotes and backslashes removed.
    fn read_heredoc_delim(&mut self) -> String {
        while matches!(self.peek(0), Some(' ') | Some('\t')) {
            self.i += 1;
        }
        let mut d = String::new();
        while let Some(ch) = self.peek(0) {
            match ch {
                ' ' | '\t' | '\n' | ';' | '&' | '|' | '<' | '>' | '(' | ')' => break,
                '\'' | '"' => {
                    self.i += 1;
                    while let Some(q) = self.peek(0) {
                        self.i += 1;
                        if q == ch {
                            break;
                        }
                        d.push(q);
                    }
                }
                '\\' => {
                    self.i += 1;
                    if let Some(n) = self.peek(0) {
                        d.push(n);
                        self.i += 1;
                    }
                }
                _ => {
                    d.push(ch);
                    self.i += 1;
                }
            }
        }
        d
    }

    /// After a newline: consume each pending heredoc body up to its delimiter
    /// line (leading tabs ignored for `<<-`). Unterminated: to end of input.
    fn skip_heredoc_bodies(&mut self) {
        let pending = std::mem::take(&mut self.pending_heredocs);
        for (delim, strip) in pending {
            loop {
                if self.i >= self.c.len() {
                    return;
                }
                let start = self.i;
                while !matches!(self.peek(0), None | Some('\n')) {
                    self.i += 1;
                }
                let line: String = self.c[start..self.i].iter().collect();
                if self.i < self.c.len() {
                    self.i += 1;
                }
                let line = if strip {
                    line.trim_start_matches('\t')
                } else {
                    line.as_str()
                };
                if line == delim {
                    break;
                }
            }
        }
    }

    fn word_char(&mut self, ch: char) {
        match ch {
            '\\' => {
                self.i += 1;
                match self.peek(0) {
                    Some('\n') => self.i += 1, // line continuation
                    Some(n) => {
                        self.started = true;
                        self.lit.push(n);
                        self.i += 1;
                    }
                    None => {}
                }
            }
            '\'' => {
                self.started = true;
                self.i += 1;
                let mut closed = false;
                while let Some(q) = self.peek(0) {
                    self.i += 1;
                    if q == '\'' {
                        closed = true;
                        break;
                    }
                    self.lit.push(q);
                }
                if !closed {
                    self.word.bad = true;
                }
            }
            '"' => {
                self.started = true;
                self.i += 1;
                self.double_quoted();
            }
            '`' => {
                self.started = true;
                self.word.bad = true;
                self.i += 1;
                while let Some(q) = self.peek(0) {
                    self.i += 1;
                    if q == '`' {
                        break;
                    }
                }
            }
            '$' => {
                self.started = true;
                self.dollar(false);
            }
            '*' | '?' | '[' => {
                self.started = true;
                self.word.bad = true;
                self.lit.push(ch);
                self.i += 1;
            }
            '{' | '}' => {
                self.started = true;
                self.word.bad = true;
                self.lit.push(ch);
                self.i += 1;
            }
            '~' => {
                let after_eq = self.lit.ends_with('=');
                if !self.started || after_eq {
                    self.word.bad = true;
                }
                self.started = true;
                self.lit.push(ch);
                self.i += 1;
            }
            _ => {
                self.started = true;
                self.lit.push(ch);
                self.i += 1;
            }
        }
    }

    fn double_quoted(&mut self) {
        let mut closed = false;
        while let Some(q) = self.peek(0) {
            match q {
                '"' => {
                    self.i += 1;
                    closed = true;
                    break;
                }
                '\\' => {
                    self.i += 1;
                    match self.peek(0) {
                        Some('\n') => self.i += 1,
                        Some(n @ ('$' | '"' | '\\' | '`')) => {
                            self.lit.push(n);
                            self.i += 1;
                        }
                        _ => self.lit.push('\\'),
                    }
                }
                '`' => {
                    self.word.bad = true;
                    self.i += 1;
                    while let Some(b) = self.peek(0) {
                        self.i += 1;
                        if b == '`' {
                            break;
                        }
                    }
                }
                '$' => self.dollar(true),
                _ => {
                    self.lit.push(q);
                    self.i += 1;
                }
            }
        }
        if !closed {
            self.word.bad = true;
        }
    }

    /// At a `$`.
    fn dollar(&mut self, quoted: bool) {
        self.i += 1;
        match self.peek(0) {
            Some('(') => {
                self.word.bad = true;
                let arith = self.peek(1) == Some('(');
                let mut depth = 0usize;
                while let Some(q) = self.peek(0) {
                    self.i += 1;
                    if arith && q == '=' {
                        self.word.clear = true;
                    }
                    match q {
                        '(' => depth += 1,
                        ')' => {
                            depth = depth.saturating_sub(1);
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some('{') => {
                self.i += 1;
                let mut name = String::new();
                let mut closed = false;
                while let Some(q) = self.peek(0) {
                    self.i += 1;
                    if q == '}' {
                        closed = true;
                        break;
                    }
                    name.push(q);
                }
                if closed && is_ident(&name) {
                    self.flush_lit();
                    self.word.segs.push(Seg::Var { name, quoted });
                } else {
                    self.word.bad = true;
                    if name.contains('=') {
                        self.word.clear = true; // `${x:=v}` assigns
                    }
                }
            }
            Some(c) if c.is_ascii_alphabetic() || c == '_' => {
                let mut name = String::new();
                while let Some(q) = self.peek(0) {
                    if q.is_ascii_alphanumeric() || q == '_' {
                        name.push(q);
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                self.flush_lit();
                self.word.segs.push(Seg::Var { name, quoted });
            }
            Some('\'') if !quoted => {
                self.word.bad = true;
                self.i += 1;
                while let Some(q) = self.peek(0) {
                    self.i += 1;
                    if q == '\\' {
                        self.i += 1;
                    } else if q == '\'' {
                        break;
                    }
                }
            }
            Some(c) if c.is_ascii_digit() || "?$@*#!-".contains(c) => {
                self.word.bad = true;
                self.i += 1;
            }
            _ => self.lit.push('$'),
        }
    }
}

// ------------------------------------------------------------ interpreter ----

/// A stored or resolved value longer than this is UNRESOLVED (PATH_MAX; also the
/// `vst-artifacts` `is_sane_path` limit). Bounds memory and per-reference cost.
pub const MAX_RESOLVED: usize = 4096;
/// Distinct variables kept; a new one beyond this stays unresolved.
const MAX_VARS: usize = 64;
/// Nested `( ... )` / function-body groups tracked before giving up on scoping.
const MAX_GROUP_DEPTH: usize = 32;
/// Bytes of expansion output and scope snapshots one command line may cost.
const WORK_BUDGET: usize = 8 * 1024 * 1024;

type Vars = HashMap<String, String>;

/// An open `( ... )` (`paren`) or `{ ... }` group. Only subshells and function
/// bodies save state; a plain `{ }` group shares it with its parent.
struct Group {
    paren: bool,
    saved: Option<(Option<PathBuf>, Vars)>,
}

struct Run {
    vars: Vars,
    cwd: Option<PathBuf>,
    out: Vec<(PathBuf, Option<PathBuf>)>,
    seen: HashSet<PathBuf>,
    groups: Vec<Group>,
    funcs: HashSet<String>,
    /// A `name()` was just read: the next command's leading `{` opens its body.
    func_pending: bool,
    func_armed: bool,
    /// Scoping can no longer be trusted (`case`, too-deep nesting): relative
    /// paths and variables are never used again.
    confused: bool,
    work: Cell<usize>,
}

const WRAPPERS: &[&str] = &[
    "env", "sudo", "command", "time", "nice", "nohup", "builtin", "exec",
];
const KEYWORDS: &[&str] = &[
    "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}",
];
const DECLARERS: &[&str] = &["export", "readonly", "declare", "local", "typeset"];
/// Commands that (re)bind the variables named by their arguments.
const REBINDERS: &[&str] = &[
    "read",
    "unset",
    "mapfile",
    "readarray",
    "getopts",
    "let",
    "for",
    "select",
];
/// Files that are noise, not deliverables, when written by a shell command.
const NOISE_EXTS: &[&str] = &["log", "pid", "lock"];

impl Run {
    fn new(cwd: Option<&Path>) -> Self {
        Run {
            vars: HashMap::new(),
            cwd: cwd.map(Path::to_path_buf),
            out: Vec::new(),
            seen: HashSet::new(),
            groups: Vec::new(),
            funcs: HashSet::new(),
            func_pending: false,
            func_armed: false,
            confused: false,
            work: Cell::new(0),
        }
    }

    fn exhausted(&self) -> bool {
        self.work.get() > WORK_BUDGET
    }

    /// Charge `n` bytes of work; false once the budget is spent.
    fn charge(&self, n: usize) -> bool {
        let w = self.work.get().saturating_add(n);
        self.work.set(w);
        w <= WORK_BUDGET
    }

    /// Forget every variable and the directory (state became unknowable).
    fn forget_state(&mut self) {
        self.vars.clear();
        self.cwd = None;
    }

    fn give_up_on_scoping(&mut self) {
        self.confused = true;
        self.forget_state();
    }

    // ---- scopes

    fn push_group(&mut self, paren: bool, save: bool) {
        if self.groups.len() >= MAX_GROUP_DEPTH {
            self.give_up_on_scoping();
            return;
        }
        let saved = if save {
            let bytes: usize = self.vars.iter().map(|(k, v)| k.len() + v.len()).sum();
            self.charge(bytes + 64);
            Some((self.cwd.clone(), self.vars.clone()))
        } else {
            None
        };
        self.groups.push(Group { paren, saved });
    }

    fn restore(&mut self, saved: Option<(Option<PathBuf>, Vars)>) {
        if let Some((cwd, vars)) = saved {
            self.cwd = cwd;
            self.vars = vars;
        }
    }

    /// `}`: ends the innermost brace group.
    fn pop_brace(&mut self) {
        if self.groups.last().is_some_and(|g| !g.paren) {
            let g = self.groups.pop();
            self.restore(g.and_then(|g| g.saved));
        }
    }

    /// `)`: ends the innermost subshell (a stray `)` is ignored).
    fn close_paren(&mut self) {
        if !self.groups.iter().any(|g| g.paren) {
            return;
        }
        while let Some(g) = self.groups.pop() {
            if g.paren {
                self.restore(g.saved);
                return;
            }
        }
    }

    fn exec(&mut self, cmd: Vec<Item>) {
        match cmd.as_slice() {
            [Item::Open] => self.push_group(true, true),
            [Item::Close] => self.close_paren(),
            [Item::FuncDef(n)] => {
                self.funcs.insert(n.clone());
                self.func_pending = true;
            }
            _ => {
                self.func_armed = std::mem::take(&mut self.func_pending);
                self.command(cmd);
            }
        }
    }

    // ---- words

    fn resolve(&self, w: &Word) -> Option<String> {
        if w.bad {
            return None;
        }
        let mut s = String::new();
        for seg in &w.segs {
            let part: &str = match seg {
                Seg::Lit(l) => l,
                Seg::Var { name, quoted } => {
                    let v = self.vars.get(name)?;
                    if !quoted && v.chars().any(|c| c.is_whitespace() || "*?[".contains(c)) {
                        return None;
                    }
                    v
                }
            };
            if s.len() + part.len() > MAX_RESOLVED || !self.charge(part.len()) {
                return None;
            }
            s.push_str(part);
        }
        self.charge(1).then_some(s)
    }

    /// `NAME=value` word: (name, resolved value or None when unresolved).
    fn assignment(&self, w: &Word) -> Option<(String, Option<String>)> {
        let Some(Seg::Lit(first)) = w.segs.first() else {
            return None;
        };
        let eq = first.find('=')?;
        let raw_name = &first[..eq];
        let (name, append) = match raw_name.strip_suffix('+') {
            Some(n) => (n, true),
            None => (raw_name, false),
        };
        if !is_ident(name) {
            return None;
        }
        let mut value = Word {
            segs: Vec::new(),
            bad: w.bad,
            clear: false,
        };
        let rest = &first[eq + 1..];
        if !rest.is_empty() {
            value.segs.push(Seg::Lit(rest.to_string()));
        }
        value.segs.extend(w.segs.iter().skip(1).cloned());
        let resolved = if append { None } else { self.resolve(&value) };
        Some((name.to_string(), resolved))
    }

    fn apply_assignment(&mut self, w: &Word) -> bool {
        match self.assignment(w) {
            Some((name, Some(v))) if !self.confused => {
                if self.vars.contains_key(&name) || self.vars.len() < MAX_VARS {
                    self.vars.insert(name, v);
                }
                true
            }
            Some((name, _)) => {
                self.vars.remove(&name);
                true
            }
            None => false,
        }
    }

    /// Forget the variable a word names: its leading identifier (`f`, `f=2`).
    fn forget_word(&mut self, w: &Word) {
        let Some(Seg::Lit(l)) = w.segs.first() else {
            return;
        };
        let end = l
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(l.len());
        if is_ident(&l[..end]) {
            self.vars.remove(&l[..end]);
        }
    }

    fn abs(&self, p: &str) -> Option<PathBuf> {
        if p.is_empty() || p == "-" || p.contains('\0') {
            return None;
        }
        let path = if p.starts_with('/') {
            PathBuf::from(p)
        } else if self.confused {
            return None;
        } else {
            self.cwd.as_ref()?.join(p)
        };
        if under_dev_or_proc(&path) {
            return None;
        }
        Some(path)
    }

    fn add(&mut self, to: Option<PathBuf>, from: Option<PathBuf>) {
        let Some(p) = to else { return };
        let noisy = p
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|e| NOISE_EXTS.iter().any(|n| e.eq_ignore_ascii_case(n)));
        if !noisy && self.out.len() < MAX_TARGETS && self.seen.insert(p.clone()) {
            self.out.push((p, from));
        }
    }

    fn add_str(&mut self, s: &str) {
        let p = self.abs(s);
        self.add(p, None);
    }

    fn command(&mut self, items: Vec<Item>) {
        let mut argv: Vec<Word> = Vec::new();
        let mut redirs: Vec<(RedirKind, Option<Word>)> = Vec::new();
        let mut pending: Option<RedirKind> = None;
        let mut clear = false;
        for it in items {
            match it {
                Item::Redir(k) => {
                    if let Some(prev) = pending.replace(k) {
                        redirs.push((prev, None));
                    }
                }
                Item::Word(w) => {
                    clear |= w.clear;
                    match pending.take() {
                        Some(k) => redirs.push((k, Some(w))),
                        None => argv.push(w),
                    }
                }
                Item::Clear => clear = true,
                Item::Open | Item::Close | Item::FuncDef(_) => {}
            }
        }
        if clear {
            self.vars.clear();
        }
        // Redirect targets resolve against the state before this command.
        for (k, w) in &redirs {
            if let (RedirKind::Write, Some(w)) = (k, w) {
                if let Some(s) = self.resolve(w) {
                    self.add_str(&s);
                }
            }
        }
        self.simple(argv);
    }

    fn simple(&mut self, argv: Vec<Word>) {
        // Leading keywords and `NAME=value` prefixes.
        let mut k = 0;
        let mut prefix: Vec<usize> = Vec::new();
        while k < argv.len() {
            let text = self.resolve(&argv[k]);
            match text.as_deref() {
                Some("{") => {
                    let func = std::mem::take(&mut self.func_armed);
                    self.push_group(false, func);
                    k += 1;
                }
                Some("}") => {
                    self.pop_brace();
                    k += 1;
                }
                Some(t) if KEYWORDS.contains(&t) => k += 1,
                _ if self.assignment(&argv[k]).is_some() => {
                    prefix.push(k);
                    k += 1;
                }
                _ => break,
            }
        }
        if k >= argv.len() {
            for i in prefix {
                self.apply_assignment(&argv[i]);
            }
            return;
        }
        let mut name = match self.resolve(&argv[k]) {
            Some(n) => base_name(&n),
            None => return,
        };
        // Strip wrappers (`env`, `sudo`, `time`, ...).
        while WRAPPERS.contains(&name.as_str()) {
            k += 1;
            let value_flags: &[&str] = match name.as_str() {
                "sudo" => &["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t"],
                "env" => &["-u", "-C", "-S"],
                "nice" => &["-n"],
                _ => &[],
            };
            while k < argv.len() {
                let Some(t) = self.resolve(&argv[k]) else {
                    return;
                };
                if t == "--" {
                    k += 1;
                    break;
                }
                let is_assign = name == "env" && self.assignment(&argv[k]).is_some();
                if t.starts_with('-') && t.len() > 1 || is_assign {
                    k += 1;
                    if value_flags.contains(&t.as_str()) && k < argv.len() {
                        k += 1;
                    }
                } else {
                    break;
                }
            }
            match argv.get(k).and_then(|w| self.resolve(w)) {
                Some(n) => name = base_name(&n),
                None => return,
            }
        }
        let rest = &argv[k + 1..];
        let args: Vec<Option<String>> = rest.iter().map(|w| self.resolve(w)).collect();
        if self.funcs.contains(&name) {
            self.forget_state(); // a function body may have run anything
            return;
        }
        match name.as_str() {
            "cd" | "pushd" => self.cd(&args),
            "popd" => self.cwd = None,
            "case" => self.give_up_on_scoping(),
            "eval" | "source" | "." => self.forget_state(),
            "function" => {
                if let Some(Some(f)) = args.first() {
                    self.funcs.insert(f.clone());
                }
                if args.iter().flatten().any(|a| a == "{") {
                    self.push_group(false, true);
                }
            }
            "printf" => {
                if let Some(i) = args.iter().position(|a| a.as_deref() == Some("-v")) {
                    if let Some(w) = rest.get(i + 1) {
                        self.forget_word(w);
                    }
                }
            }
            n if REBINDERS.contains(&n) => {
                // `for f in`/`select f in` bind only the first word.
                let words = if n == "for" || n == "select" {
                    &rest[..rest.len().min(1)]
                } else {
                    rest
                };
                for w in words {
                    self.forget_word(w);
                }
            }
            n if DECLARERS.contains(&n) => {
                for w in rest {
                    if !self.apply_assignment(w) && n == "local" {
                        self.forget_word(w); // `local f` starts unset
                    }
                }
            }
            "tee" => {
                for a in positionals(&args, &[]).into_iter().flatten() {
                    self.add_str(&a);
                }
            }
            "touch" => {
                for a in positionals(&args, &["-d", "-t", "-r", "--date", "--reference"])
                    .into_iter()
                    .flatten()
                {
                    self.add_str(&a);
                }
            }
            "cp" | "mv" | "install" => self.copy_like(&name, &args),
            "dd" => {
                for a in args.iter().flatten() {
                    if let Some(of) = a.strip_prefix("of=") {
                        self.add_str(of);
                    }
                }
            }
            "curl" => self.download_target(&args, &CURL),
            "wget" => self.download_target(&args, &WGET),
            _ => {}
        }
    }

    fn cd(&mut self, args: &[Option<String>]) {
        let pos = positionals(args, &[]);
        let target = match pos.as_slice() {
            [Some(d)] if !d.is_empty() && d != "-" && !self.confused => d.clone(),
            _ => {
                self.cwd = None;
                return;
            }
        };
        self.cwd = if target.starts_with('/') {
            Some(PathBuf::from(target))
        } else {
            self.cwd.as_ref().map(|c| c.join(target))
        };
    }

    fn copy_like(&mut self, name: &str, args: &[Option<String>]) {
        let mut target_dir: Option<Option<String>> = None;
        let mut pos: Vec<Option<String>> = Vec::new();
        let mut no_more_flags = false;
        let value_flags: &[&str] = if name == "install" {
            &[
                "-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix",
            ]
        } else {
            &["-S", "--suffix"]
        };
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            i += 1;
            let Some(t) = a else {
                pos.push(None);
                continue;
            };
            if !no_more_flags && t == "--" {
                no_more_flags = true;
            } else if !no_more_flags && t.starts_with('-') && t.len() > 1 {
                if t == "-t" || t == "--target-directory" {
                    target_dir = Some(args.get(i).cloned().flatten());
                    i += 1;
                } else if let Some(d) = t.strip_prefix("--target-directory=") {
                    target_dir = Some(Some(d.to_string()));
                } else if name == "install" && (t == "-d" || t == "--directory") {
                    return; // creates directories only
                } else if value_flags.contains(&t.as_str()) {
                    i += 1;
                }
            } else {
                pos.push(a.clone());
            }
        }
        let is_mv = name == "mv";
        if let Some(dir) = target_dir {
            let Some(dir) = dir else { return };
            for s in pos.iter().flatten() {
                self.add_into_dir(&dir, s, is_mv);
            }
            return;
        }
        let Some(dest) = pos.pop() else { return };
        if pos.is_empty() {
            return;
        }
        let Some(dest) = dest else { return };
        if dest.ends_with('/') || pos.len() > 1 {
            for s in pos.iter().flatten() {
                self.add_into_dir(&dest, s, is_mv);
            }
        } else if is_mv {
            let from = pos[0].as_deref().and_then(|s| self.abs(s));
            let to = self.abs(&dest);
            self.add(to, from);
        } else {
            self.add_str(&dest);
        }
    }

    fn add_into_dir(&mut self, dir: &str, source: &str, is_mv: bool) {
        let Some(file) = Path::new(source.trim_end_matches('/')).file_name() else {
            return;
        };
        let Some(d) = self.abs(dir) else { return };
        let from = if is_mv { self.abs(source) } else { None };
        self.add(Some(d.join(file)), from);
    }

    /// The output file of `curl -o` / `wget -O`: `-o X`, `-oX`, clusters such as
    /// `-sSLo X`, `--output X`, `--output=X`. A relative curl value resolves
    /// against `--output-dir`; an absolute one beside it is skipped (unsure).
    fn download_target(&mut self, args: &[Option<String>], o: &Download) {
        let mut out_dir: Option<Option<String>> = None;
        let mut values: Vec<Option<String>> = Vec::new();
        let mut i = 0;
        while i < args.len() {
            let Some(t) = &args[i] else {
                i += 1;
                continue;
            };
            i += 1;
            if t == "--" {
                break;
            }
            if t.starts_with("--") {
                if t == o.long {
                    values.push(args.get(i).cloned().flatten());
                    i += 1;
                } else if let Some(v) = t.strip_prefix(&format!("{}=", o.long)) {
                    values.push(Some(v.to_string()));
                } else if let Some(dl) = o.dir_long {
                    if t == dl {
                        out_dir = Some(args.get(i).cloned().flatten());
                        i += 1;
                    } else if let Some(v) = t.strip_prefix(&format!("{dl}=")) {
                        out_dir = Some(Some(v.to_string()));
                    }
                }
            } else if t.len() > 1 && t.starts_with('-') {
                // `-` is ASCII, so slicing at 1 is a char boundary.
                let cluster = &t[1..];
                for (idx, ch) in cluster.char_indices() {
                    if ch == o.short {
                        let rest = &cluster[idx + ch.len_utf8()..];
                        if rest.is_empty() {
                            values.push(args.get(i).cloned().flatten());
                            i += 1;
                        } else {
                            values.push(Some(rest.to_string()));
                        }
                        break;
                    }
                    if !o.bools.contains(ch) {
                        break;
                    }
                }
            }
        }
        for v in values.into_iter().flatten() {
            match &out_dir {
                None => self.add_str(&v),
                Some(Some(d)) if !v.starts_with('/') => {
                    self.add_str(&format!("{}/{v}", d.trim_end_matches('/')));
                }
                Some(_) => {}
            }
        }
    }
}

/// Option shape of a downloader's output-file flag.
struct Download {
    long: &'static str,
    short: char,
    /// Flags that take no argument and may precede `short` in a cluster.
    bools: &'static str,
    dir_long: Option<&'static str>,
}

const CURL: Download = Download {
    long: "--output",
    short: 'o',
    bools: "sSLfkvgiIN#O0123Z",
    dir_long: Some("--output-dir"),
};
const WGET: Download = Download {
    long: "--output-document",
    short: 'O',
    bools: "qvcnNkprdEFbm",
    dir_long: None,
};

/// Does the lexically normalised path start with `/dev` or `/proc`?
fn under_dev_or_proc(path: &Path) -> bool {
    let mut stack: Vec<&OsStr> = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(n) => stack.push(n),
            Component::ParentDir => {
                stack.pop();
            }
            _ => {}
        }
    }
    matches!(stack.first(), Some(f) if *f == "dev" || *f == "proc")
}

/// Non-flag arguments (`--` ends flags); `value_flags` consume the next word.
/// Unresolved words stay as `None` so positions are kept.
fn positionals(args: &[Option<String>], value_flags: &[&str]) -> Vec<Option<String>> {
    let mut out = Vec::new();
    let mut flags_done = false;
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
            continue;
        }
        match a {
            Some(t) if !flags_done && t == "--" => flags_done = true,
            Some(t) if !flags_done && t.starts_with('-') && t.len() > 1 => {
                skip = value_flags.contains(&t.as_str());
            }
            other => out.push(other.clone()),
        }
    }
    out
}

fn base_name(s: &str) -> String {
    s.rsplit('/').next().unwrap_or(s).to_string()
}

#[cfg(test)]
#[path = "shell_effects_tests.rs"]
mod tests;

/// The Rich Chat prompt promises these captured forms; a command added to the
/// parser (the `match name` arms above) must be added to the asset too.
#[cfg(test)]
#[test]
fn rich_chat_prompt_names_every_captured_command() {
    let asset = include_str!("../assets/agent-subagent-richchat.md");
    for needle in [
        "tee", "cp", "mv", "install", "touch", "dd of=", "curl -o", "wget -O",
    ] {
        assert!(asset.contains(needle), "prompt does not mention `{needle}`");
    }
}
