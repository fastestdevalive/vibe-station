use super::*;
use vst_types::artifacts::FileEffect;

const D: &str = "/tmp/claude-1000/-home-vst--vibe-station-projects-northstar-api-worktrees-napi-1/d619cac8-4ca2-48c7-ae90-1f95cce9adf6/scratchpad/outside-files";

fn t(cmd: &str) -> Vec<String> {
    shell_write_targets(cmd, None)
        .iter()
        .map(|p| p.display().to_string())
        .collect()
}

fn tc(cmd: &str, cwd: &str) -> Vec<String> {
    shell_write_targets(cmd, Some(Path::new(cwd)))
        .iter()
        .map(|p| p.display().to_string())
        .collect()
}

fn fixture(name: &str) -> String {
    let raw = match name {
        "1" => include_str!("../tests/fixtures/shell/real-command-1.json"),
        _ => include_str!("../tests/fixtures/shell/real-command-2.json"),
    };
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    v["toolInput"]["command"].as_str().unwrap().to_string()
}

#[test]
fn real_command_one_yields_three_files() {
    assert_eq!(
        t(&fixture("1")),
        vec![
            format!("{D}/hello.txt"),
            format!("{D}/notes.md"),
            format!("{D}/info.json")
        ]
    );
}

#[test]
fn real_command_two_yields_four_files() {
    assert_eq!(
        t(&fixture("2")),
        vec![
            format!("{D}/users.csv"),
            format!("{D}/greet.sh"),
            format!("{D}/config.yaml"),
            format!("{D}/greet.ts")
        ]
    );
}

#[test]
fn append_tee_cp_mv_touch() {
    assert_eq!(t("echo hi >> /tmp/a.md"), ["/tmp/a.md"]);
    assert_eq!(
        t("echo hi | tee -a /tmp/a.md /tmp/b.md"),
        ["/tmp/a.md", "/tmp/b.md"]
    );
    assert_eq!(t("cp a /tmp/b/"), ["/tmp/b/a"]);
    assert_eq!(t("cp a b /tmp/b"), ["/tmp/b/a", "/tmp/b/b"]);
    assert_eq!(t("cp -r src /tmp/dst"), ["/tmp/dst"]);
    assert_eq!(t("install -m 644 a.md /tmp/inst/"), ["/tmp/inst/a.md"]);
    assert_eq!(t("cp -t /tmp/d a.md"), ["/tmp/d/a.md"]);
    assert_eq!(tc("mv a b", "/work"), ["/work/b"]);
    assert!(t("mv a b").is_empty(), "relative without cwd is skipped");
    assert_eq!(t("touch /tmp/x.md /tmp/y.md"), ["/tmp/x.md", "/tmp/y.md"]);
    assert_eq!(t("echo x &> /tmp/all.md"), ["/tmp/all.md"]);
    assert_eq!(t("echo x 2>&1 > /tmp/o.md"), ["/tmp/o.md"]);
    assert_eq!(t("echo x >| /tmp/f.md"), ["/tmp/f.md"]);
}

#[test]
fn downloads_and_dd() {
    assert_eq!(t("curl -sSL -o /tmp/p.pdf https://x/y"), ["/tmp/p.pdf"]);
    assert_eq!(t("curl --output=/tmp/p.pdf https://x"), ["/tmp/p.pdf"]);
    assert!(t("curl -O https://x/y").is_empty());
    assert_eq!(t("wget -O /tmp/w.html https://x"), ["/tmp/w.html"]);
    assert_eq!(
        t("wget --output-document /tmp/w.html https://x"),
        ["/tmp/w.html"]
    );
    assert!(
        t("wget -o /tmp/log https://x").is_empty(),
        "wget -o is the log"
    );
    assert_eq!(t("curl -sLo /tmp/p.pdf https://x"), ["/tmp/p.pdf"]);
    assert_eq!(t("curl -sSLo /tmp/p.pdf https://x"), ["/tmp/p.pdf"]);
    assert_eq!(t("curl -sSLo/tmp/p.pdf https://x"), ["/tmp/p.pdf"]);
    assert_eq!(t("wget -qO /tmp/w.html https://x"), ["/tmp/w.html"]);
    assert_eq!(t("wget -qO/tmp/w.html https://x"), ["/tmp/w.html"]);
    assert!(t("wget -qo /tmp/w.txt https://x").is_empty());
    assert!(t("curl -sS https://x -H 'a: o' -O").is_empty());
    assert_eq!(
        t("curl --output-dir /tmp/d -o x.pdf https://x"),
        ["/tmp/d/x.pdf"]
    );
    assert_eq!(
        t("curl -o x.pdf --output-dir=/tmp/d/ https://x"),
        ["/tmp/d/x.pdf"]
    );
    assert!(t("curl --output-dir /tmp/d -o /abs/x.pdf https://x").is_empty());
    assert!(t("curl --output-dir $UNSET -o x.pdf https://x").is_empty());
    assert_eq!(
        t("dd if=/dev/zero of=/tmp/z.img bs=1 count=1"),
        ["/tmp/z.img"]
    );
}

#[test]
fn cd_tracking() {
    assert_eq!(t("cd /tmp/x && echo hi > y.md"), ["/tmp/x/y.md"]);
    assert_eq!(t("cd /tmp/x; echo hi > y.md"), ["/tmp/x/y.md"]);
    assert_eq!(tc("cd sub && echo hi > y.md", "/w"), ["/w/sub/y.md"]);
    assert!(t("cd sub && echo hi > y.md").is_empty());
    assert!(t("cd $UNKNOWN && echo hi > y.md").is_empty());
    assert_eq!(tc("echo hi > y.md", "/w"), ["/w/y.md"]);
}

#[test]
fn heredocs() {
    assert_eq!(t("cat > /tmp/f.md <<'EOF'\nhello\nEOF\n"), ["/tmp/f.md"]);
    assert_eq!(t("cat <<EOF > /tmp/g.md\nx\nEOF"), ["/tmp/g.md"]);
    assert_eq!(
        t("cat > /tmp/h.md <<-EOF\n\tx > /tmp/no\n\tEOF\ntouch /tmp/after"),
        ["/tmp/h.md", "/tmp/after"]
    );
    assert!(t("cat <<EOF\na > b\nEOF\n").is_empty());
    assert!(t("cat <<EOF\na > /tmp/b\nnever closed").is_empty());
    assert_eq!(
        t("cat > /tmp/a <<EOF\nx > /tmp/no\nEOF\necho > /tmp/b"),
        ["/tmp/a", "/tmp/b"]
    );
}

#[test]
fn variables() {
    assert_eq!(t("export P=/tmp/q; echo > $P/a.md"), ["/tmp/q/a.md"]);
    assert_eq!(
        t("P=/tmp/q\nQ=$P/sub\necho > \"${Q}/a.md\""),
        ["/tmp/q/sub/a.md"]
    );
    assert_eq!(t("P=/tmp/q; echo > ${P}/a.md"), ["/tmp/q/a.md"]);
    assert!(t("P=$(mktemp -d); echo > $P/a.md").is_empty());
    assert!(
        t("P=/tmp/q; P=$(mktemp); echo > $P/a.md").is_empty(),
        "reassignment unresolves"
    );
    assert!(
        t("P=\"a b\"; echo > $P/a.md").is_empty(),
        "unquoted split value"
    );
    assert_eq!(t("P=\"/tmp/a b\"; echo > \"$P/a.md\""), ["/tmp/a b/a.md"]);
    assert!(
        t("P=/tmp/q echo > $P/a.md").is_empty(),
        "prefix assignment is not applied"
    );
    assert!(t("P=~/x; echo > $P/a.md").is_empty());
    assert!(t("P=/tmp/*; echo > $P/a.md").is_empty());
}

#[test]
fn quoting_and_wrappers() {
    assert_eq!(
        t("echo x > \"/tmp/with space/a b.md\""),
        ["/tmp/with space/a b.md"]
    );
    assert_eq!(t("echo x > '/tmp/s q/a.md'"), ["/tmp/s q/a.md"]);
    assert_eq!(t("echo x > /tmp/a\\ b.md"), ["/tmp/a b.md"]);
    assert_eq!(t("sudo -u bob tee /tmp/a.md"), ["/tmp/a.md"]);
    assert_eq!(t("env FOO=1 nice -n 5 time cp a /tmp/dst/"), ["/tmp/dst/a"]);
    assert_eq!(t("/usr/bin/tee /tmp/a.md"), ["/tmp/a.md"]);
    assert_eq!(t("if true; then echo x > /tmp/a.md; fi"), ["/tmp/a.md"]);
    assert_eq!(
        t("echo a > /tmp/a && echo b > /tmp/a || echo c > /tmp/a"),
        ["/tmp/a"]
    );
    assert_eq!(t("printf x \\\n > /tmp/cont.md"), ["/tmp/cont.md"]);
}

#[test]
fn negatives() {
    for cmd in [
        "echo hi > /dev/null",
        "cmd 2>&1",
        "cmd > /dev/stderr",
        "echo x > /proc/self/foo",
        "echo hi > \"$UNSET/x\"",
        "echo hi > \"$(mktemp)\"",
        "echo hi > `mktemp`",
        "echo hi > $((1+2)).md",
        "echo hi > ${X:-/tmp}/a",
        "echo a > *.md",
        "echo a > /tmp/{a,b}.md",
        "echo a > ~/x.md",
        "echo a > $HOME/x.md",
        "echo '>' x",
        "echo \"a > b\"",
        "# a > b",
        "echo ok # > /tmp/no",
        "ls",
        "ls -la /tmp",
        "rm -rf x",
        "cat f | wc -l",
        "cat < /tmp/in.md",
        "grep a <<< 'x > y'",
        "echo hi > /tmp/unterminated\"",
        "echo hi > \"/tmp/unterminated",
        "tee",
        "cp onlyone",
        "install -d /tmp/newdir",
        "python3 -c \"open('/tmp/a','w')\"",
    ] {
        assert!(t(cmd).is_empty(), "{cmd:?} -> {:?}", t(cmd));
    }
}

#[test]
fn caps_and_dedupe() {
    assert!(t("").is_empty());
    assert!(t(&format!(
        "echo > /tmp/a # {}",
        "x".repeat(MAX_COMMAND_BYTES)
    ))
    .is_empty());
    let many: String = (0..200).map(|i| format!("echo > /tmp/f{i}\n")).collect();
    let got = t(&many);
    assert_eq!(got.len(), MAX_TARGETS);
    assert_eq!(got[0], "/tmp/f0");
    assert_eq!(t("echo > /tmp/a; echo >> /tmp/a; touch /tmp/a"), ["/tmp/a"]);
}

#[test]
fn garbage_never_panics() {
    let alphabet: Vec<char> = "ab $>&|;<()\"'`\\\n\t#~*?[]{}=-/.0123EOFé€😀\u{0}\u{202e}"
        .chars()
        .collect();
    let frags = [
        "<<-",
        "${",
        "cp -t ",
        "dd of=",
        "for f in ",
        "read f;",
        "(( x = 1 ))",
        "[[ a > b ]]",
        "f() {",
        "}",
        "case x in a)",
        "$((f=2))",
        "popd;",
        "curl -sLo ",
        "wget -qO ",
        "2> ",
        "mv a b;",
    ];
    let mut seed: u64 = 0x9e3779b97f4a7c15;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    for _ in 0..20_000 {
        let mut s = String::new();
        let len = next() % 300;
        for _ in 0..len {
            if next() % 9 == 0 {
                s.push_str(frags[next() % frags.len()]);
            } else {
                s.push(alphabet[next() % alphabet.len()]);
            }
        }
        let _ = shell_write_targets(&s, Some(Path::new("/w")));
        let _ = shell_write_targets(&s, None);
    }
    for s in [
        "\u{0}", "é > ü", "<<", "<<-", ">&", "$", "${", "$(", "'", "\"", "`", "\\", "&>", "cd",
        "cp", "cp -t",
    ] {
        let _ = shell_write_targets(s, None);
    }
}

// ---- review regressions -----------------------------------------------------

/// Fastest of up to five runs. The callers bound 3 to 14 ms of real work (debug
/// build) at 0.5 to 1 s to catch superlinear work, which is slow on every run;
/// a test thread stalled by a loaded host is slow on one, so only the former
/// can fail all five. Stops at the first run under every caller's bound.
fn timed(cmd: &str) -> (Vec<String>, std::time::Duration) {
    let run = || {
        let t0 = std::time::Instant::now();
        (t(cmd), t0.elapsed())
    };
    let mut best = run();
    for _ in 0..4 {
        if best.1.as_millis() < 250 {
            break;
        }
        let next = run();
        if next.1 < best.1 {
            best = next;
        }
    }
    best
}

#[test]
fn doubling_variable_expansion_is_bounded() {
    // The review's 201-byte command: 26 doublings of a 16-byte value.
    let cmd = format!("a=xxxxxxxxxxxxxxxx;{}", " a=$a$a;".repeat(26));
    assert!(cmd.len() < 256);
    let (out, took) = timed(&cmd);
    assert!(out.is_empty());
    assert!(took.as_millis() < 1000, "{took:?}");
    // Many more doublings still just leave `a` unresolved.
    let cmd = format!(
        "a=xxxxxxxxxxxxxxxx;{} echo > /tmp/$a",
        " a=$a$a;".repeat(40)
    );
    let (out, took) = timed(&cmd);
    assert!(out.is_empty() && took.as_millis() < 1000, "{took:?}");
}

#[test]
fn huge_value_with_thousands_of_references_is_bounded() {
    // 20 doublings (16 MB if unbounded) then 5000 references.
    let cmd = format!(
        "a=xxxxxxxxxxxxxxxx;{}{}",
        " a=$a$a;".repeat(20),
        " echo $a;".repeat(5000)
    );
    assert!(cmd.len() < MAX_COMMAND_BYTES);
    let (out, took) = timed(&cmd);
    assert!(out.is_empty());
    assert!(took.as_millis() < 1000, "{took:?}");
}

#[test]
fn values_at_the_cap_resolve_and_one_more_byte_does_not() {
    let ok = "x".repeat(MAX_RESOLVED - 5); // "/tmp/" + value = 4096 - ... below cap
    assert_eq!(t(&format!("a={ok}; echo > /tmp/$a")).len(), 1);
    let big = "x".repeat(MAX_RESOLVED);
    assert_eq!(
        t(&format!("a={big}; echo > /$a")).len(),
        0,
        "expansion over cap"
    );
    let huge = "x".repeat(MAX_RESOLVED + 1);
    assert!(t(&format!("a={huge}; echo > $a")).is_empty());
    // A value stored then grown past the cap is dropped, not kept at 4096.
    let half = "y".repeat(MAX_RESOLVED / 2 + 1);
    assert!(
        t(&format!(
            "a={half}; b=$a$a; echo > /tmp/$b; echo > /tmp/$a.md"
        ))
        .len()
            == 1
    );
}

/// Work charged for `cmd`, and whether the run stopped because the budget ran out.
fn work(cmd: &str) -> (usize, bool) {
    let run = run_bounded(cmd, None);
    (run.work.get(), run.exhausted())
}

#[test]
fn many_references_and_scopes_stay_within_the_work_budget() {
    // Asserted on the work counter, not the clock: this test's ~170 ms of real
    // work (debug build) sat within 6x of the old 1 s wall-clock bound, and a
    // loaded CI host stretched it past that (1.1 s and 3.2 s observed). The
    // counter is the same on every machine. A run stops at the first command
    // that takes it over the budget, so it can overshoot by one charge at most.
    let v = "z".repeat(4000);
    // 3000 references to a 4000-byte value: 12 MB if unbounded.
    let (w, exhausted) = work(&format!("a={v};{}", " echo > /tmp/$a ;".repeat(3000)));
    assert!(exhausted && w <= WORK_BUDGET + MAX_RESOLVED, "{w}");
    // 2500 subshell snapshots of that value: 10 MB if unbounded.
    let (w, exhausted) = work(&format!("a={v};{}", " ( echo > /tmp/x.md ) ;".repeat(2500)));
    assert!(exhausted && w <= WORK_BUDGET + MAX_RESOLVED + 128, "{w}");
    // Unclosed nesting is cut off by the depth cap, long before the budget.
    let cmd = format!("a=1;{} cd /tmp; echo > rel.md", "( ".repeat(5000));
    let (w, exhausted) = work(&cmd);
    assert!(!exhausted && w <= MAX_GROUP_DEPTH * 128, "{w}");
    assert!(t(&cmd).is_empty());
}

#[test]
fn subshell_scope_does_not_leak() {
    assert_eq!(
        tc("( cd /tmp/sub && echo > a.md ); echo > b.md", "/w"),
        ["/tmp/sub/a.md", "/w/b.md"]
    );
    assert_eq!(t("P=/tmp/q; ( P=/etc ); echo > $P/a.md"), ["/tmp/q/a.md"]);
    assert_eq!(t("( P=/tmp/in; echo > $P/a.md )"), ["/tmp/in/a.md"]);
    assert!(t("( P=/tmp/in ); echo > $P/a.md").is_empty());
    // A plain group shares state.
    assert_eq!(t("{ cd /tmp/g; }; echo > a.md"), ["/tmp/g/a.md"]);
    assert_eq!(tc("{ cd /tmp/g; }; echo > a.md", "/w"), ["/tmp/g/a.md"]);
    // Nested.
    assert_eq!(
        tc("( ( cd /a ); echo > b.md ); echo > c.md", "/w"),
        ["/w/b.md", "/w/c.md"]
    );
    // A stray `)` (case pattern) does not panic or pop anything.
    assert_eq!(t("case x in a) echo > /tmp/c.md;; esac"), ["/tmp/c.md"]);
}

#[test]
fn case_makes_scoping_unknown() {
    assert!(tc("case $x in a) cd /y;; esac; echo > f.md", "/w").is_empty());
    assert!(t("P=/q; case x in a) P=/e;; esac; echo > $P/f.md").is_empty());
}

#[test]
fn popd_pushd_and_unknown_cd() {
    assert!(t("cd /tmp/x; pushd /tmp/y; popd; echo > a.md").is_empty());
    assert_eq!(t("cd /tmp/x; pushd /tmp/y; echo > a.md"), ["/tmp/y/a.md"]);
    assert!(t("cd /tmp/x; pushd; echo > a.md").is_empty());
    assert_eq!(
        t("cd /tmp/x; popd; echo > /tmp/abs.md"),
        ["/tmp/abs.md"],
        "absolute targets survive an unknown cwd"
    );
}

#[test]
fn rebinding_invalidates_the_variable() {
    for cmd in [
        "f=/tmp/fixed; for f in a b; do echo > $f.md; done",
        "f=/tmp/fixed; for f in a b; do echo > /tmp/$f.md; done",
        "f=/tmp/fixed; while read f; do echo > $f.md; done",
        "f=/tmp/fixed; read f; echo > $f.md",
        "f=/tmp/fixed; read -r -p x f; echo > $f.md",
        "f=/tmp/fixed; unset f; echo > $f.md",
        "f=/tmp/fixed; echo $((f=2)); echo > $f.md",
        "f=/tmp/fixed; (( f = 2 )); echo > $f.md",
        "f=/tmp/fixed; echo ${f:=x}; echo > $f.md",
        "f=/tmp/fixed; let f=2; echo > $f.md",
        "f=/tmp/fixed; printf -v f x; echo > $f.md",
        "f=/tmp/fixed; mapfile f < x; echo > $f.md",
        "f=/tmp/fixed; select f in a; do echo > $f.md; done",
        "f=/tmp/fixed; getopts ab f; echo > $f.md",
        "f=/tmp/fixed; eval 'f=/etc'; echo > $f.md",
        "f=/tmp/fixed; source ./x; echo > $f.md",
        "f=/tmp/fixed; local f; echo > $f.md",
    ] {
        assert!(t(cmd).is_empty(), "{cmd:?} -> {:?}", t(cmd));
    }
    // Comparisons are not assignments; unrelated variables survive.
    assert_eq!(t("f=/tmp/k; (( 1 > 0 )); echo > $f.md"), ["/tmp/k.md"]);
    assert_eq!(t("f=/tmp/k; g=1; unset g; echo > $f.md"), ["/tmp/k.md"]);
    assert_eq!(
        t("f=/tmp/k; for g in a; do echo > $f.md; done"),
        ["/tmp/k.md"]
    );
}

#[test]
fn function_bodies_do_not_apply_assignments() {
    assert_eq!(
        t("f=/tmp/fixed; g() { f=/etc; }; echo > $f.md"),
        ["/tmp/fixed.md"]
    );
    assert_eq!(
        t("f=/tmp/fixed; function g { f=/etc; }; echo > $f.md"),
        ["/tmp/fixed.md"]
    );
    assert_eq!(
        t("f=/tmp/fixed\ng() {\n f=/etc\n cd /x\n}\necho > $f.md"),
        ["/tmp/fixed.md"]
    );
    // Calling it makes everything unknown (the body may have run anything).
    assert!(t("f=/tmp/fixed; g() { f=/etc; }; g; echo > $f.md").is_empty());
    assert!(tc("g() { cd /x; }; g; echo > a.md", "/w").is_empty());
}

#[test]
fn stderr_and_noise_files_are_not_captured() {
    assert!(t("cmd 2> /tmp/err.md").is_empty());
    assert!(t("cmd 2>> /tmp/err.md").is_empty());
    assert_eq!(t("cmd 2> /tmp/err.md > /tmp/out.md"), ["/tmp/out.md"]);
    for cmd in [
        "cmd > /tmp/build.log 2>&1",
        "cmd &> /tmp/all.log",
        "cmd > /tmp/x.LOG",
        "echo $$ > /tmp/x.pid",
        "exec > /tmp/all.lock",
        "tee /tmp/t.log",
        "cp a /tmp/b.log",
        "cmd > /tmp/*.log",
    ] {
        assert!(t(cmd).is_empty(), "{cmd:?}");
    }
    assert_eq!(t("cmd > /tmp/logs/out.md"), ["/tmp/logs/out.md"]);
    assert_eq!(t("cmd > /tmp/build.log.md"), ["/tmp/build.log.md"]);
}

#[test]
fn comparison_operators_are_not_redirects() {
    assert!(tc("[[ x > y ]]", "/w").is_empty());
    assert!(tc("[[ x < y ]] && echo ok", "/w").is_empty());
    assert!(tc("if (( count > max )); then echo hi; fi", "/w").is_empty());
    assert!(tc("while (( i < 3 )); do :; done", "/w").is_empty());
    assert_eq!(tc("if [[ -f x ]]; then echo > o.md; fi", "/w"), ["/w/o.md"]);
    assert_eq!(tc("[[ a > b ]]; echo > o.md", "/w"), ["/w/o.md"]);
    assert_eq!(
        tc("[ a ] > o.md", "/w"),
        ["/w/o.md"],
        "single bracket is a real command"
    );
}

#[test]
fn dev_and_proc_filtered_after_normalisation() {
    for cmd in [
        "echo > //dev/null",
        "echo > /./dev/null",
        "echo > /tmp/../dev/x",
        "echo > /tmp/../proc/self/x",
        "echo > /dev/../dev/tty",
    ] {
        assert!(t(cmd).is_empty(), "{cmd:?}");
    }
    assert!(tc("echo > ../dev/x", "/w").is_empty());
    assert_eq!(t("echo > /devices/x.md"), ["/devices/x.md"]);
    assert_eq!(t("echo > /dev/../tmp/x.md"), ["/dev/../tmp/x.md"]);
}

#[test]
fn keyword_and_wrapper_strips_are_linear() {
    let (out, took) = timed(&format!("{}echo > /tmp/a.md", "if ".repeat(20_000)));
    assert_eq!(out, ["/tmp/a.md"]);
    assert!(took.as_millis() < 500, "{took:?}");
    let (_, took) = timed(&format!("env {}cp a /tmp/d/", "-i ".repeat(20_000)));
    assert!(took.as_millis() < 500, "{took:?}");
}

#[test]
fn mv_yields_move_effects_when_both_sides_resolve() {
    let fx = |c: &str, cwd: Option<&str>| shell_file_effects(c, cwd.map(Path::new));
    assert_eq!(
        fx("mv /tmp/a.md /tmp/b.md", None),
        vec![FileEffect::moved("/tmp/a.md", "/tmp/b.md")]
    );
    assert_eq!(
        fx("mv a.md b.md", Some("/w")),
        vec![FileEffect::moved("/w/a.md", "/w/b.md")]
    );
    assert_eq!(
        fx("mv /tmp/a.md /tmp/d/", None),
        vec![FileEffect::moved("/tmp/a.md", "/tmp/d/a.md")]
    );
    assert_eq!(
        fx("mv -t /tmp/d /tmp/a.md /tmp/b.md", None),
        vec![
            FileEffect::moved("/tmp/a.md", "/tmp/d/a.md"),
            FileEffect::moved("/tmp/b.md", "/tmp/d/b.md")
        ]
    );
    // Unresolved source: only the destination is a (Write) candidate.
    assert_eq!(
        fx("mv $UNSET /tmp/b.md", None),
        vec![FileEffect::write("/tmp/b.md")],
        "unresolved source: only the destination"
    );
    assert_eq!(
        fx("mv a.md /tmp/b.md", None),
        vec![FileEffect::write("/tmp/b.md")],
        "relative source with no cwd"
    );
    // cp stays a plain Write of the destination; the source is never named.
    assert_eq!(
        fx("cp /etc/passwd /tmp/x", None),
        vec![FileEffect::write("/tmp/x")]
    );
    assert_eq!(t("mv a b /tmp/d"), ["/tmp/d/a", "/tmp/d/b"]);
}

#[test]
fn sources_and_secrets_are_never_nominated() {
    assert_eq!(t("cp ~/.ssh/id_rsa /tmp/x"), ["/tmp/x"]);
    assert_eq!(t("cp /etc/passwd /tmp/x/"), ["/tmp/x/passwd"]);
    assert_eq!(
        shell_file_effects("mv /home/u/.ssh/id_rsa /tmp/x", None),
        vec![FileEffect::moved("/home/u/.ssh/id_rsa", "/tmp/x")],
        "a move source is a row lookup key only"
    );
    assert!(t("cat /etc/shadow").is_empty());
    assert!(t("touch -r /etc/passwd").is_empty());
}

#[test]
fn bare_backup_flag_does_not_swallow_the_next_path() {
    let fx = |c: &str| shell_file_effects(c, Some(Path::new("/w")));
    assert_eq!(
        fx("cp --backup a.md b.md"),
        vec![FileEffect::write("/w/b.md")]
    );
    assert_eq!(
        fx("mv --backup a b"),
        vec![FileEffect::moved("/w/a", "/w/b")]
    );
}
