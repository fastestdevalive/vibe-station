#![forbid(unsafe_code)]

use vst_cli::commands;
use vst_cli::output::die;
use vst_cli::program::{
    self, AgentCommand, Command, DaemonCommand, FileCommand, FilesCommand, ModeCommand,
    ProjectCommand, TerminalCommand, WorktreeCommand,
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
        Command::Mode(mode_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("mode") {
                eprintln!("{hint}");
            }
            match mode_cmd {
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
            }
        },
        Command::Agent(agent_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("agent") {
                eprintln!("{hint}");
            }
            match agent_cmd {
            AgentCommand::Create { args } => {
                let opts = match commands::agent::create::parse_agent_create_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::create::run_agent_create(opts).await {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Ls { args } => {
                let opts = match commands::agent::ls::parse_session_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::ls::run_session_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Info { args } => {
                let opts = match commands::agent::info::parse_session_info_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::info::run_session_info(opts).await {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Terminate { args } => {
                let id = args.first().cloned();
                if let Err((err, code)) =
                    commands::agent::terminate::run_session_terminate(id).await
                {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Attach { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::agent::attach::run_session_attach(&id).await {
                    if !err.is_empty() {
                        die(&err, Some(code));
                    } else {
                        std::process::exit(code);
                    }
                }
            }
            AgentCommand::Restore { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::agent::restore::run_session_restore(&id).await
                {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Output { args } => {
                let opts = match commands::agent::output::parse_session_output_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::output::run_session_output(opts).await
                {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Transcript { args } => {
                let opts =
                    match commands::agent::transcript::parse_session_transcript_options(&args) {
                        Ok(o) => o,
                        Err(err) => die(&err, Some(1)),
                    };
                if let Err((err, code)) =
                    commands::agent::transcript::run_session_transcript(opts).await
                {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Reset { args } => {
                let opts = match commands::agent::reset::parse_session_reset_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::reset::run_session_reset(opts).await {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Handoff { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::agent::handoff::run_session_handoff(&id).await
                {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Rename { args } => {
                let opts = match commands::agent::rename::parse_session_rename_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::rename::run_session_rename(opts).await
                {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Send { args } => {
                let opts = match commands::agent::send::parse_session_send_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::send::run_session_send(opts).await {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Stop { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::agent::stop::run_session_stop(&id).await {
                    die(&err, Some(code));
                }
            }
            AgentCommand::Unknown(args) => {
                die(
                    &format!("Unknown agent command: {}", args.join(" ")),
                    Some(1),
                );
            }
            }
        },
        Command::Terminal(terminal_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("terminal") {
                eprintln!("{hint}");
            }
            match terminal_cmd {
            TerminalCommand::Create { args } => {
                let opts = match commands::terminal::create::parse_terminal_create_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::terminal::create::run_terminal_create(opts).await
                {
                    die(&err, Some(code));
                }
            }
            TerminalCommand::Ls { args } => {
                let opts = match commands::agent::ls::parse_session_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::ls::run_session_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            TerminalCommand::Info { args } => {
                let opts = match commands::agent::info::parse_session_info_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::info::run_session_info(opts).await {
                    die(&err, Some(code));
                }
            }
            TerminalCommand::Terminate { args } => {
                let id = args.first().cloned();
                if let Err((err, code)) =
                    commands::agent::terminate::run_session_terminate(id).await
                {
                    die(&err, Some(code));
                }
            }
            TerminalCommand::Attach { args } => {
                let id = args.first().cloned().unwrap_or_default();
                if let Err((err, code)) = commands::agent::attach::run_session_attach(&id).await {
                    if !err.is_empty() {
                        die(&err, Some(code));
                    } else {
                        std::process::exit(code);
                    }
                }
            }
            TerminalCommand::Output { args } => {
                let opts = match commands::agent::output::parse_session_output_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::output::run_session_output(opts).await
                {
                    die(&err, Some(code));
                }
            }
            TerminalCommand::Rename { args } => {
                let opts = match commands::agent::rename::parse_session_rename_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::agent::rename::run_session_rename(opts).await
                {
                    die(&err, Some(code));
                }
            }
            TerminalCommand::Unknown(args) => {
                die(
                    &format!("Unknown terminal command: {}", args.join(" ")),
                    Some(1),
                );
            }
            }
        },
        Command::Worktree(wt_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("worktree") {
                eprintln!("{hint}");
            }
            match wt_cmd {
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
            }
        },
        Command::Project(proj_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("project") {
                eprintln!("{hint}");
            }
            match proj_cmd {
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
            }
        },
        Command::File(file_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("file") {
                eprintln!("{hint}");
            }
            match file_cmd {
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
            }
        },
        Command::Files(files_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("files") {
                eprintln!("{hint}");
            }
            match files_cmd {
            FilesCommand::Ls { args } => {
                let opts = match commands::files::ls::parse_files_ls_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::files::ls::run_files_ls(opts).await {
                    die(&err, Some(code));
                }
            }
            FilesCommand::Open { args } => {
                let opts = match commands::files::open::parse_files_open_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::files::open::run_files_open(opts).await {
                    die(&err, Some(code));
                }
            }
            FilesCommand::Close { args } => {
                let opts = match commands::files::close::parse_files_close_options(&args) {
                    Ok(o) => o,
                    Err(err) => die(&err, Some(1)),
                };
                if let Err((err, code)) = commands::files::close::run_files_close(opts).await {
                    die(&err, Some(code));
                }
            }
            FilesCommand::Unknown(args) => {
                die(
                    &format!("Unknown files command: {}", args.join(" ")),
                    Some(1),
                );
            }
            }
        },
        Command::Daemon(daemon_cmd) => {
            if let Some(hint) = program::hint_if_dir_collision("daemon") {
                eprintln!("{hint}");
            }
            match daemon_cmd {
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
            }
        },
        Command::Open(args) => {
            let opts = match commands::open::parse_open_options(&args.args) {
                Ok(o) => o,
                Err(err) => die(&err, Some(1)),
            };
            if let Err((err, code)) = commands::open::run_open(opts).await {
                die(&err, Some(code));
            }
        }
        Command::Status(args) => {
            let opts = match commands::status::parse_status_options(&args.args) {
                Ok(o) => o,
                Err(err) => die(&err, Some(1)),
            };
            if let Err((err, code)) = commands::status::run_status(opts).await {
                die(&err, Some(code));
            }
        }
        Command::Summary(args) => {
            let opts = match commands::summary::parse_summary_options(&args.args) {
                Ok(o) => o,
                Err(err) => die(&err, Some(1)),
            };
            if let Err((err, code)) = commands::summary::run_summary(opts).await {
                die(&err, Some(code));
            }
        }
        Command::Doctor(args) => {
            if let Err(err) = commands::doctor::parse_doctor_options(&args.args) {
                die(&err, Some(1));
            }
            if let Err((err, code)) = commands::doctor::run_doctor().await {
                if !err.is_empty() {
                    die(&err, Some(code));
                } else {
                    std::process::exit(code);
                }
            }
        }
        _ => {
            eprintln!("Command not yet implemented in Rust port");
        }
    }
}
