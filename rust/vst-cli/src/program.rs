//! CLI argument parsing and dispatch.
//!
//! Mirrors `cli/src/program.ts`. Exposes `build_program` / `run` to parse command line args
//! and dispatch to registered subcommands.

pub const NAME: &str = "vst";
pub const DESCRIPTION: &str = "vibe-station — orchestrate parallel AI coding agents";

/// Text printed by `vst --help` / `vst help` / `vst daemon --help`.
pub const USAGE: &str = "\
Usage: vst <command> [args]

Commands:
  daemon     status | run | stop | restart
  project    add | create | rm | ls | info
  worktree   create | rm | done | ls | info | rename
  agent      create | ls | info | terminate | attach | restore | output |
             transcript | reset | handoff | rename | send | stop
  terminal   create | ls | info | terminate | attach | output | rename
  mode       ls | add | rm
  file       open
  files      ls | open | close
  artifact   add | list | pin
  comment    list | show
  open       open a path in the UI
  status     daemon and session status
  summary    summarize sessions
  doctor     check the local environment
  update     [--check | --yes | --skip <v> | --unskip <v>]  update vibe-station
  <path>     shorthand for `vst open <path>`

Options:
  -v, --version   print the version
  -h, --help      print this help";

/// Text printed by `vst update --help` (documents the manual undo).
pub const UPDATE_USAGE: &str = "\
Usage: vst update [--check | --yes | --skip <version> | --unskip <version>]

  (no flag)          check, show the changelog, ask to type \"confirm\", install
  --check            only check: exit 0 up to date, 10 update available, 1 error
  -y, --yes          install without the prompt (required when stdin is not a terminal)
  --skip <version>   hide <version> from the update chip; --unskip reverses it

Undo an update by hand: in the install directory, for each updated file,
run `mv .<name>.prev <name>`.";

/// Text printed by `vst daemon restart --help`.
pub const RESTART_USAGE: &str = "\
Usage: vst daemon restart [--yes]

Restart the running daemon (asks first if sessions would be interrupted; tmux sessions keep running).";

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Version,
    Help,
    Daemon(DaemonCommand),
    Project(ProjectCommand),
    Worktree(WorktreeCommand),
    Agent(AgentCommand),
    Terminal(TerminalCommand),
    Mode(ModeCommand),
    File(FileCommand),
    Files(FilesCommand),
    Artifact(ArtifactCommand),
    Comment(CommentCommand),
    Open(OpenArgs),
    Status(StatusArgs),
    Summary(SummaryArgs),
    Doctor(DoctorArgs),
    Update(UpdateArgs),
    Unknown(Vec<String>),
}

/// `vst update` flags.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct UpdateArgs {
    pub check: bool,
    pub yes: bool,
    pub skip: Option<String>,
    pub unskip: Option<String>,
    /// `-h` / `--help`: print usage, do nothing else.
    pub help: bool,
    /// First unrecognised token, if any.
    pub bad_arg: Option<String>,
}

fn parse_update_args(iter: impl Iterator<Item = String>) -> UpdateArgs {
    let mut a = UpdateArgs::default();
    let mut it = iter.peekable();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "-h" | "--help" => a.help = true,
            "--check" => a.check = true,
            "--yes" | "-y" => a.yes = true,
            "--skip" => a.skip = it.next(),
            "--unskip" => a.unskip = it.next(),
            _ => {
                if let Some(v) = tok.strip_prefix("--skip=") {
                    a.skip = Some(v.to_string());
                } else if let Some(v) = tok.strip_prefix("--unskip=") {
                    a.unskip = Some(v.to_string());
                } else if a.bad_arg.is_none() {
                    a.bad_arg = Some(tok);
                }
            }
        }
    }
    a
}

#[derive(Clone, Debug, PartialEq)]
pub enum DaemonCommand {
    Status {
        json: bool,
    },
    /// `vst daemon run` — serve as the daemon. Normally intercepted before
    /// `parse_args` even runs (see `dispatch::resolve_entry_mode`), so this
    /// arm is a defensive fallback, not the primary dispatch path.
    Run,
    /// `vst daemon stop` — request a graceful shutdown of a running daemon.
    Stop,
    /// `vst daemon restart [--yes]` — request a graceful restart of a running daemon.
    Restart {
        yes: bool,
        help: bool,
    },
    /// Hidden command: `vst daemon _restart-watch` (spawned by the daemon; the
    /// flags are `WatchArgs`' contract, parse errors exit 2).
    RestartWatch(Result<vst_daemon::update::WatchArgs, String>),
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProjectCommand {
    Add { args: Vec<String> },
    Create { args: Vec<String> },
    Rm { args: Vec<String> },
    Ls { args: Vec<String> },
    Info { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum WorktreeCommand {
    Create { args: Vec<String> },
    Rm { args: Vec<String> },
    Done { args: Vec<String> },
    Ls { args: Vec<String> },
    Info { args: Vec<String> },
    Rename { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgentCommand {
    Create {
        args: Vec<String>,
    },
    Ls {
        args: Vec<String>,
    },
    Info {
        args: Vec<String>,
    },
    Terminate {
        args: Vec<String>,
    },
    Attach {
        args: Vec<String>,
    },
    Restore {
        args: Vec<String>,
    },
    Output {
        args: Vec<String>,
    },
    Transcript {
        args: Vec<String>,
    },
    StartFresh {
        args: Vec<String>,
    },
    /// Alias: `start-fresh --carry=none` (acts like `/clear`).
    Clear {
        args: Vec<String>,
    },
    Switch {
        args: Vec<String>,
    },
    Previous {
        args: Vec<String>,
    },
    Handoff {
        args: Vec<String>,
    },
    Rename {
        args: Vec<String>,
    },
    Send {
        args: Vec<String>,
    },
    Stop {
        args: Vec<String>,
    },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum TerminalCommand {
    Create { args: Vec<String> },
    Ls { args: Vec<String> },
    Info { args: Vec<String> },
    Terminate { args: Vec<String> },
    Attach { args: Vec<String> },
    Output { args: Vec<String> },
    Rename { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModeCommand {
    Ls { args: Vec<String> },
    Add { args: Vec<String> },
    Rm { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum FileCommand {
    Open { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum FilesCommand {
    Ls { args: Vec<String> },
    Open { args: Vec<String> },
    Close { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArtifactCommand {
    Add { args: Vec<String> },
    List { args: Vec<String> },
    Pin { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum CommentCommand {
    List { args: Vec<String> },
    Show { args: Vec<String> },
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenArgs {
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatusArgs {
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SummaryArgs {
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DoctorArgs {
    pub args: Vec<String>,
}

pub fn parse_args<I, T>(args: I) -> Command
where
    I: IntoIterator<Item = T>,
    T: Into<String>,
{
    let mut iter = args.into_iter().map(Into::into).skip(1); // skip program name
    let first = match iter.next() {
        Some(f) => f,
        None => return Command::Help,
    };

    match first.as_str() {
        "-v" | "--version" | "version" => Command::Version,
        "-h" | "--help" | "help" => Command::Help,
        "daemon" => {
            let sub = iter.next();
            match sub.as_deref() {
                Some("status") => {
                    let mut json = false;
                    for arg in iter {
                        if arg == "--json" {
                            json = true;
                        }
                    }
                    Command::Daemon(DaemonCommand::Status { json })
                }
                Some("-h" | "--help") => Command::Help,
                Some("run") => Command::Daemon(DaemonCommand::Run),
                Some("stop") => Command::Daemon(DaemonCommand::Stop),
                Some("restart") => {
                    let mut yes = false;
                    let mut help = false;
                    for arg in iter {
                        if arg == "--yes" || arg == "-y" {
                            yes = true;
                        } else if arg == "--help" || arg == "-h" {
                            help = true;
                        }
                    }
                    Command::Daemon(DaemonCommand::Restart { yes, help })
                }
                Some("_restart-watch") => Command::Daemon(DaemonCommand::RestartWatch(
                    vst_daemon::update::WatchArgs::parse(iter),
                )),
                Some(other) => {
                    let mut rest = vec![other.to_string()];
                    rest.extend(iter);
                    Command::Daemon(DaemonCommand::Unknown(rest))
                }
                None => Command::Daemon(DaemonCommand::Unknown(vec![])),
            }
        }
        "project" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("add") => Command::Project(ProjectCommand::Add { args: rest }),
                Some("create") => Command::Project(ProjectCommand::Create { args: rest }),
                Some("rm") => Command::Project(ProjectCommand::Rm { args: rest }),
                Some("ls") => Command::Project(ProjectCommand::Ls { args: rest }),
                Some("info") => Command::Project(ProjectCommand::Info { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Project(ProjectCommand::Unknown(r))
                }
                None => Command::Project(ProjectCommand::Unknown(vec![])),
            }
        }
        "worktree" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("create") => Command::Worktree(WorktreeCommand::Create { args: rest }),
                Some("rm") => Command::Worktree(WorktreeCommand::Rm { args: rest }),
                Some("done") => Command::Worktree(WorktreeCommand::Done { args: rest }),
                Some("ls") => Command::Worktree(WorktreeCommand::Ls { args: rest }),
                Some("info") => Command::Worktree(WorktreeCommand::Info { args: rest }),
                Some("rename") => Command::Worktree(WorktreeCommand::Rename { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Worktree(WorktreeCommand::Unknown(r))
                }
                None => Command::Worktree(WorktreeCommand::Unknown(vec![])),
            }
        }
        "agent" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("create") => Command::Agent(AgentCommand::Create { args: rest }),
                Some("ls") => Command::Agent(AgentCommand::Ls { args: rest }),
                Some("info") => Command::Agent(AgentCommand::Info { args: rest }),
                Some("terminate") => Command::Agent(AgentCommand::Terminate { args: rest }),
                Some("attach") => Command::Agent(AgentCommand::Attach { args: rest }),
                Some("restore") => Command::Agent(AgentCommand::Restore { args: rest }),
                Some("output") => Command::Agent(AgentCommand::Output { args: rest }),
                Some("transcript") => Command::Agent(AgentCommand::Transcript { args: rest }),
                Some("start-fresh") => Command::Agent(AgentCommand::StartFresh { args: rest }),
                Some("clear") => Command::Agent(AgentCommand::Clear { args: rest }),
                Some("switch") => Command::Agent(AgentCommand::Switch { args: rest }),
                Some("previous") => Command::Agent(AgentCommand::Previous { args: rest }),
                Some("handoff") => Command::Agent(AgentCommand::Handoff { args: rest }),
                Some("rename") => Command::Agent(AgentCommand::Rename { args: rest }),
                Some("send") => Command::Agent(AgentCommand::Send { args: rest }),
                Some("stop") => Command::Agent(AgentCommand::Stop { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Agent(AgentCommand::Unknown(r))
                }
                None => Command::Agent(AgentCommand::Unknown(vec![])),
            }
        }
        "terminal" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("create") => Command::Terminal(TerminalCommand::Create { args: rest }),
                Some("ls") => Command::Terminal(TerminalCommand::Ls { args: rest }),
                Some("info") => Command::Terminal(TerminalCommand::Info { args: rest }),
                Some("terminate") => Command::Terminal(TerminalCommand::Terminate { args: rest }),
                Some("attach") => Command::Terminal(TerminalCommand::Attach { args: rest }),
                Some("output") => Command::Terminal(TerminalCommand::Output { args: rest }),
                Some("rename") => Command::Terminal(TerminalCommand::Rename { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Terminal(TerminalCommand::Unknown(r))
                }
                None => Command::Terminal(TerminalCommand::Unknown(vec![])),
            }
        }
        "mode" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("ls") => Command::Mode(ModeCommand::Ls { args: rest }),
                Some("add") => Command::Mode(ModeCommand::Add { args: rest }),
                Some("rm") => Command::Mode(ModeCommand::Rm { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Mode(ModeCommand::Unknown(r))
                }
                None => Command::Mode(ModeCommand::Unknown(vec![])),
            }
        }
        "file" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("open") => Command::File(FileCommand::Open { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::File(FileCommand::Unknown(r))
                }
                None => Command::File(FileCommand::Unknown(vec![])),
            }
        }
        "files" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("ls") => Command::Files(FilesCommand::Ls { args: rest }),
                Some("open") => Command::Files(FilesCommand::Open { args: rest }),
                Some("close") => Command::Files(FilesCommand::Close { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Files(FilesCommand::Unknown(r))
                }
                None => Command::Files(FilesCommand::Unknown(vec![])),
            }
        }
        "artifact" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("add") => Command::Artifact(ArtifactCommand::Add { args: rest }),
                Some("list" | "ls") => Command::Artifact(ArtifactCommand::List { args: rest }),
                Some("pin") => Command::Artifact(ArtifactCommand::Pin { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Artifact(ArtifactCommand::Unknown(r))
                }
                None => Command::Artifact(ArtifactCommand::Unknown(vec![])),
            }
        }
        "comment" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("list" | "ls") => Command::Comment(CommentCommand::List { args: rest }),
                Some("show") => Command::Comment(CommentCommand::Show { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Comment(CommentCommand::Unknown(r))
                }
                None => Command::Comment(CommentCommand::Unknown(vec![])),
            }
        }
        "open" => Command::Open(OpenArgs {
            args: iter.collect(),
        }),
        "status" => Command::Status(StatusArgs {
            args: iter.collect(),
        }),
        "summary" => Command::Summary(SummaryArgs {
            args: iter.collect(),
        }),
        "doctor" => Command::Doctor(DoctorArgs {
            args: iter.collect(),
        }),
        "update" => Command::Update(parse_update_args(iter)),
        // R7: real subcommand names are already matched above this arm, so `other`
        // here is guaranteed to not be a known subcommand — dispatch it as a bare
        // path through the same OpenArgs the "open" subcommand uses. A `-`-prefixed
        // token is never a path — leave it as Unknown so it errors as a bad flag,
        // not a confusing "Unknown option" from inside open.rs's own parser.
        other if !other.starts_with('-') => Command::Open(OpenArgs {
            args: std::iter::once(other.to_string()).chain(iter).collect(),
        }),
        other => {
            let mut all = vec![other.to_string()];
            all.extend(iter);
            Command::Unknown(all)
        }
    }
}

/// Pure helper: if a directory with the given name exists in the current
/// working directory, returns a hint telling the user to use `vst open <name>`
/// instead of the (higher-precedence) subcommand of the same name. Returns
/// `None` when no such directory exists.
pub fn hint_if_dir_collision(name: &str) -> Option<String> {
    if std::path::Path::new(name).is_dir() {
        Some(format!(
            "hint: \"{name}\" is also a directory here — use \"vst open {name}\" to open it instead"
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_help_parses_without_bad_arg() {
        match parse_args(["vst", "update", "--help"]) {
            Command::Update(a) => {
                assert!(a.help);
                assert_eq!(a.bad_arg, None);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn restart_help_parses_and_does_not_set_yes() {
        assert_eq!(
            parse_args(["vst", "daemon", "restart", "--help"]),
            Command::Daemon(DaemonCommand::Restart {
                yes: false,
                help: true
            })
        );
        assert_eq!(
            parse_args(["vst", "daemon", "restart", "-y"]),
            Command::Daemon(DaemonCommand::Restart {
                yes: true,
                help: false
            })
        );
    }

    #[test]
    fn usage_lists_update_and_restart() {
        assert!(USAGE.contains("update"));
        assert!(USAGE.contains("restart"));
        assert!(UPDATE_USAGE.contains("mv .<name>.prev <name>"));
    }

    #[test]
    fn restart_watch_parses_what_the_daemon_builds() {
        let args = vst_daemon::update::WatchArgs {
            expect_version: "9.9.9".into(),
            port: 7421,
            pid: 77,
            bin_dir: "/b".into(),
            vst_home: "/h".into(),
            db_snapshot: "/h/.prev/vibe-station.db".into(),
            old_boot_id: "boot".into(),
            nonce: None,
        };
        let argv: Vec<String> = std::iter::once("vst".to_string())
            .chain(args.to_args())
            .collect();
        assert_eq!(
            parse_args(argv),
            Command::Daemon(DaemonCommand::RestartWatch(Ok(args)))
        );
        // A zero port is an error (exit 2 in main), not "watch port 0".
        let bad = parse_args([
            "vst",
            "daemon",
            "_restart-watch",
            "--port",
            "0",
            "--pid",
            "1",
        ]);
        assert!(matches!(
            bad,
            Command::Daemon(DaemonCommand::RestartWatch(Err(_)))
        ));
    }
}
