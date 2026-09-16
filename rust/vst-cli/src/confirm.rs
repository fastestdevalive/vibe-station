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

pub fn confirm_by_typing_name(name: &str, warning: &str) {
    let stdin = io::stdin();
    if let Err(err) = confirm_by_typing_name_with_reader(&mut stdin.lock(), name, warning) {
        die(&err, Some(1));
    }
}
