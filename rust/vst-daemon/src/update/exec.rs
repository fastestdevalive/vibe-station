//! Bounded child-process helper shared by install detection and the replace
//! smoke test: stdin is closed, stdout is captured, and the child is killed
//! once `timeout` elapses (a hung binary or a held dpkg lock must never block
//! the caller indefinitely).

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `ETXTBSY`: a just-written executable raced with a `fork` elsewhere.
const ETXTBSY: i32 = 26;

/// Run `prog args…`; the trimmed first stdout line on a zero exit within
/// `timeout`, else `None`. Spawn is retried briefly on `ETXTBSY`.
pub(crate) fn run_first_line(prog: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = None;
    for _ in 0..20 {
        match Command::new(prog)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) if e.raw_os_error() == Some(ETXTBSY) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(_) => return None,
        }
    }
    let mut child = child?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let out = child.wait_with_output().ok()?;
                let text = String::from_utf8_lossy(&out.stdout).into_owned();
                return text.lines().next().map(|l| l.trim().to_string());
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_out_a_hung_child_and_reads_a_good_one() {
        let t0 = Instant::now();
        assert!(run_first_line(Path::new("sleep"), &["30"], Duration::from_millis(300)).is_none());
        assert!(t0.elapsed() < Duration::from_secs(3));
        assert_eq!(
            run_first_line(Path::new("echo"), &["hi"], Duration::from_secs(5)).as_deref(),
            Some("hi")
        );
    }
}
