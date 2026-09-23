use crate::preflight::preflight;
use crate::send_message::{run_send, SendOptions};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionSendOptions {
    pub id: String,
    pub message: Vec<String>,
    pub send_options: SendOptions,
}

pub fn parse_session_send_options(args: &[String]) -> Result<SessionSendOptions, String> {
    let mut opts = SessionSendOptions {
        id: String::new(),
        message: Vec::new(),
        send_options: SendOptions {
            file: None,
            attach: Vec::new(),
            queue: false,
            wait: true, // default is true
            timeout: Some("60000".to_string()),
        },
    };

    let mut positional = Vec::new();
    let mut iter = args.iter().peekable();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--file" => {
                opts.send_options.file = Some(
                    iter.next()
                        .cloned()
                        .ok_or_else(|| "--file requires an argument".to_string())?,
                );
            }
            s if s.starts_with("--file=") => {
                opts.send_options.file = Some(s.trim_start_matches("--file=").to_string());
            }
            "--attach" => {
                let val = iter
                    .next()
                    .cloned()
                    .ok_or_else(|| "--attach requires an argument".to_string())?;
                opts.send_options.attach.push(val);
            }
            s if s.starts_with("--attach=") => {
                opts.send_options
                    .attach
                    .push(s.trim_start_matches("--attach=").to_string());
            }
            "--queue" => {
                opts.send_options.queue = true;
            }
            "--wait" => {
                opts.send_options.wait = true;
            }
            "--no-wait" => {
                opts.send_options.wait = false;
            }
            "--timeout" => {
                opts.send_options.timeout = iter.next().cloned();
            }
            s if s.starts_with("--timeout=") => {
                opts.send_options.timeout = Some(s.trim_start_matches("--timeout=").to_string());
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown option: {other}"));
            }
            other => {
                positional.push(other.to_string());
            }
        }
    }

    if positional.is_empty() {
        return Err("Session ID is required".to_string());
    }

    opts.id = positional.remove(0);
    opts.message = positional;

    Ok(opts)
}

pub async fn run_session_send(opts: SessionSendOptions) -> Result<(), (String, i32)> {
    preflight().await;

    run_send(&opts.id, &opts.message, &opts.send_options)
        .await
        .map_err(|e| (e.to_string(), 1))?;

    Ok(())
}
