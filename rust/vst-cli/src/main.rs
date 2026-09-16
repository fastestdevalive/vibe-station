#![forbid(unsafe_code)]

use vst_cli::commands;
use vst_cli::output::die;
use vst_cli::program::{
    self, Command, DaemonCommand, FileCommand, ModeCommand, ProjectCommand, SessionCommand,
    WorktreeCommand,
};

#[tokio::main]
async fn main() {
    let cmd = program::parse_args(std::env::args());
    match cmd {
        Command::Version => {
            println!("{}", program::VERSION);
        }
        Command::Help => {
            println!("{} — {}", program::NAME, program::DESCRIPTION);
        }
        Command::Mode(mode_cmd) => match mode_cmd {
            ModeCommand::Ls { args } => {
                let opts = match commands::mode::ls::parse_mode_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::mode::ls::run_mode_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            ModeCommand::Add { args } => {
                let opts = match commands::mode::add::parse_mode_add_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::mode::add::run_mode_add(opts).await {
                    die(&err, Some(code));
                }
            }
            ModeCommand::Rm { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::mode::rm::run_mode_rm(&id).await {
                    die(&err, Some(code));
                }
            }
            ModeCommand::Unknown(args) => {
                die(
                    &format!("Unknown mode command: {}", args.join(" ")),
                    Some(1),
                );
            }
        },
        Command::Session(session_cmd) => match session_cmd {
            SessionCommand::Create { args } => {
                let opts = match commands::session::create::parse_session_create_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::create::run_session_create(opts).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Ls { args } => {
                let opts = match commands::session::ls::parse_session_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::ls::run_session_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Info { args } => {
                let opts = match commands::session::info::parse_session_info_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::info::run_session_info(opts).await {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Terminate { args } => {
                let id = args.first().cloned();
                if let Err((err, code)) =
                    commands::session::terminate::run_session_terminate(id).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Attach { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::session::attach::run_session_attach(&id).await {
                    if !err.is_empty() {
                        die(&err, Some(code));
                    } else {
                        std::process::exit(code);
                    }
                }
            }
            SessionCommand::Restore { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::session::restore::run_session_restore(&id).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Output { args } => {
                let opts = match commands::session::output::parse_session_output_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::output::run_session_output(opts).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Transcript { args } => {
                let opts =
                    match commands::session::transcript::parse_session_transcript_options(&args) {
                        Ok(o) => o,
                        Err(err) => die(&err, Some(1)),
                    };
                if let Err((err, code)) =
                    commands::session::transcript::run_session_transcript(opts).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Reset { args } => {
                let opts = match commands::session::reset::parse_session_reset_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::reset::run_session_reset(opts).await {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Handoff { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::session::handoff::run_session_handoff(&id).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Rename { args } => {
                let opts = match commands::session::rename::parse_session_rename_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::rename::run_session_rename(opts).await
                {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Send { args } => {
                let opts = match commands::session::send::parse_session_send_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::session::send::run_session_send(opts).await {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Stop { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::session::stop::run_session_stop(&id).await {
                    die(&err, Some(code));
                }
            }
            SessionCommand::Unknown(args) => {
                die(
                    &format!("Unknown session command: {}", args.join(" ")),
                    Some(1),
                );
            }
        },
        Command::Worktree(wt_cmd) => match wt_cmd {
            WorktreeCommand::Create { args } => {
                let opts = match commands::worktree::create::parse_worktree_create_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) =
                    commands::worktree::create::run_worktree_create(opts).await
                {
                    die(&err, Some(code));
                }
            }
            WorktreeCommand::Rm { args } => {
                let opts = match commands::worktree::rm::parse_worktree_rm_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::worktree::rm::run_worktree_rm(opts).await {
                    die(&err, Some(code));
                }
            }
            WorktreeCommand::Done { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::worktree::done::run_worktree_done(&id).await {
                    die(&err, Some(code));
                }
            }
            WorktreeCommand::Ls { args } => {
                let opts = match commands::worktree::ls::parse_worktree_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::worktree::ls::run_worktree_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            WorktreeCommand::Info { args } => {
                let opts = match commands::worktree::info::parse_worktree_info_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::worktree::info::run_worktree_info(opts).await {
                    die(&err, Some(code));
                }
            }
            WorktreeCommand::Rename { args } => {
                let opts = match commands::worktree::rename::parse_worktree_rename_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) =
                    commands::worktree::rename::run_worktree_rename(opts).await
                {
                    die(&err, Some(code));
                }
            }
            WorktreeCommand::Unknown(args) => {
                die(
                    &format!("Unknown worktree command: {}", args.join(" ")),
                    Some(1),
                );
            }
        },
        Command::Project(proj_cmd) => match proj_cmd {
            ProjectCommand::Add { args } => {
                let opts = match commands::project::add::parse_project_add_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::project::add::run_project_add(opts).await {
                    die(&err, Some(code));
                }
            }
            ProjectCommand::Create { args } => {
                let opts = match commands::project::create::parse_project_create_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::project::create::run_project_create(opts).await
                {
                    die(&err, Some(code));
                }
            }
            ProjectCommand::Rm { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::project::rm::run_project_rm(&id).await {
                    die(&err, Some(code));
                }
            }
            ProjectCommand::Ls { args } => {
                let opts = match commands::project::ls::parse_project_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::project::ls::run_project_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            ProjectCommand::Info { args } => {
                let opts = match commands::project::info::parse_project_info_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::project::info::run_project_info(opts).await {
                    die(&err, Some(code));
                }
            }
            ProjectCommand::Unknown(args) => {
                die(
                    &format!("Unknown project command: {}", args.join(" ")),
                    Some(1),
                );
            }
        },
        Command::File(file_cmd) => match file_cmd {
            FileCommand::Open { args } => {
                let opts = match commands::file::open::parse_file_open_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::file::open::run_file_open(opts).await {
                    die(&err, Some(code));
                }
            }
            FileCommand::Unknown(args) => {
                die(
                    &format!("Unknown file command: {}", args.join(" ")),
                    Some(1),
                );
            }
        },
        Command::Daemon(daemon_cmd) => match daemon_cmd {
            DaemonCommand::Status { json } => {
                let opts = commands::daemon::status::DaemonStatusOptions { json };
                if let Err((err, code)) = commands::daemon::status::run_daemon_status(opts).await {
                    die(&err, Some(code));
                }
            }
            DaemonCommand::Unknown(args) => {
                die(
                    &format!("Unknown daemon command: {}", args.join(" ")),
                    Some(1),
                );
            }
        },
        _ => {
            eprintln!("Command not yet implemented in Rust port");
        }
    }
}
