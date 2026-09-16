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
    Session(SessionCommand),
    Mode(ModeCommand),
    File(FileCommand),
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
pub enum SessionCommand {
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
        "session" => {
            let sub = iter.next();
            let rest: Vec<String> = iter.collect();
            match sub.as_deref() {
                Some("create") => Command::Session(SessionCommand::Create { args: rest }),
                Some("ls") => Command::Session(SessionCommand::Ls { args: rest }),
                Some("info") => Command::Session(SessionCommand::Info { args: rest }),
                Some("terminate") => Command::Session(SessionCommand::Terminate { args: rest }),
                Some("attach") => Command::Session(SessionCommand::Attach { args: rest }),
                Some("restore") => Command::Session(SessionCommand::Restore { args: rest }),
                Some("output") => Command::Session(SessionCommand::Output { args: rest }),
                Some("transcript") => Command::Session(SessionCommand::Transcript { args: rest }),
                Some("reset") => Command::Session(SessionCommand::Reset { args: rest }),
                Some("handoff") => Command::Session(SessionCommand::Handoff { args: rest }),
                Some("rename") => Command::Session(SessionCommand::Rename { args: rest }),
                Some("send") => Command::Session(SessionCommand::Send { args: rest }),
                Some("stop") => Command::Session(SessionCommand::Stop { args: rest }),
                Some(other) => {
                    let mut r = vec![other.to_string()];
                    r.extend(rest);
                    Command::Session(SessionCommand::Unknown(r))
                }
                None => Command::Session(SessionCommand::Unknown(vec![])),
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
        other => {
            let mut all = vec![other.to_string()];
            all.extend(iter);
            Command::Unknown(all)
        }
    }
}
