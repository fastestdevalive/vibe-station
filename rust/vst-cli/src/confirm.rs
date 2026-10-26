use std::io::{self, BufRead, Write};

use crate::output::die;

pub fn confirm_by_typing_name_with_reader<R: BufRead>(
    reader: &mut R,
    name: &str,
    warning: &str,
) -> Result<(), String> {
    eprintln!("{warning}");
    eprint!("Type \"{name}\" to confirm: ");
    let _ = io::stderr().flush();

    let mut input = String::new();
    if reader.read_line(&mut input).is_err() {
        return Err("Cancelled.".to_string());
    }

    let trimmed = input.trim_end_matches(['\r', '\n']);
    if trimmed != name {
        return Err("Cancelled.".to_string());
    }
    Ok(())
}

/// `[Y/n]` prompt on stderr: empty, `y` or `yes` (case-insensitive) is true;
/// anything else, EOF or a read error is false.
pub fn confirm_yes_default<R: BufRead>(reader: &mut R, prompt: &str) -> bool {
    eprint!("{prompt} [Y/n] ");
    let _ = io::stderr().flush();
    let mut input = String::new();
    match reader.read_line(&mut input) {
        Ok(0) | Err(_) => false,
        Ok(_) => {
            let t = input.trim();
            t.is_empty() || t.eq_ignore_ascii_case("y") || t.eq_ignore_ascii_case("yes")
        }
    }
}

pub fn confirm_by_typing_name(name: &str, warning: &str) {
    let stdin = io::stdin();
    if let Err(err) = confirm_by_typing_name_with_reader(&mut stdin.lock(), name, warning) {
        die(&err, Some(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn ask(input: &str) -> bool {
        confirm_yes_default(&mut Cursor::new(input.as_bytes().to_vec()), "Go?")
    }

    #[test]
    fn yes_default_accepts_empty_y_yes() {
        for i in ["\n", "y\n", "Y\n", "yes\n", " YES \n"] {
            assert!(ask(i), "{i:?}");
        }
    }

    #[test]
    fn yes_default_rejects_others_and_eof() {
        for i in ["n\n", "no\n", "confirm\n", ""] {
            assert!(!ask(i), "{i:?}");
        }
    }
}
