//! CLI argument parsing and dispatch.
//!
//! Mirrors `cli/src/program.ts`. Exposes `build_program` / `run` to parse command line args
//! and dispatch to registered subcommands.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NAME: &str = "vst";
pub const DESCRIPTION: &str = "vibe-station — orchestrate parallel AI coding agents";

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
    Open(OpenArgs),
    Status(StatusArgs),
    Summary(SummaryArgs),
    Doctor(DoctorArgs),
    Unknown(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum DaemonCommand {
    Status { json: bool },
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
    Create { args: Vec<String> },
    Ls { args: Vec<String> },
    Info { args: Vec<String> },
    Terminate { args: Vec<String> },
    Attach { args: Vec<String> },
    Restore { args: Vec<String> },
    Output { args: Vec<String> },
    Transcript { args: Vec<String> },
    Reset { args: Vec<String> },
    Handoff { args: Vec<String> },
    Rename { args: Vec<String> },
    Send { args: Vec<String> },
    Stop { args: Vec<String> },
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
                Some("reset") => Command::Agent(AgentCommand::Reset { args: rest }),
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
