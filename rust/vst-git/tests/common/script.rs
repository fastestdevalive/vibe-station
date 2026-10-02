//! Test helper: install an executable script that is safe to exec immediately.

/// Write `body` (a `#!`-script) to `path`, make it executable, and return only
/// once it can actually be exec'd.
///
/// Writing then exec'ing a fresh file races with any other thread that forks
/// in the window between our `open(O_WRONLY)` and `close`: the child inherits
/// the write fd until it execs, and `exec` of a file with a writer fails with
/// ETXTBSY ("Text file busy"). cargo runs tests as threads of one process, so
/// that fork is another test's `Command::spawn`. A short settle-exec (the
/// guard line makes the script exit immediately and touch nothing) retries
/// until the window has closed, so the real runs never see ETXTBSY.
#[allow(clippy::incompatible_msrv)] // ErrorKind::ExecutableFileBusy is stable since 1.83; test-only helper
pub fn install_executable_script(path: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let (shebang, rest) = body.split_once('\n').unwrap_or((body, ""));
    let guarded = format!("{shebang}\n[ -n \"$VST_TEST_SETTLE\" ] && exit 0\n{rest}");
    std::fs::write(path, guarded).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::process::Command::new(path)
            .env("VST_TEST_SETTLE", "1")
            .status()
        {
            Ok(_) => return,
            Err(e)
                if e.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("settle-exec {}: {e}", path.display()),
        }
    }
}
