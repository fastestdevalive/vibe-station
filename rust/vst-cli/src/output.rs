use serde::Serialize;
use std::process;

/// Print formatted JSON value to stdout and exit 0.
pub fn print_json<T: Serialize>(value: &T) -> ! {
    match serde_json::to_string_pretty(value) {
        Ok(json) => println!("{json}"),
        Err(err) => eprintln!("error: failed to serialize json: {err}"),
    }
    process::exit(0);
}

/// Format table into lines.
pub fn format_table(headers: &[&str], rows: &[Vec<String>]) -> Vec<String> {
    let mut col_widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();

    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i < col_widths.len() {
                col_widths[i] = col_widths[i].max(cell.len());
            } else {
                col_widths.push(cell.len());
            }
        }
    }

    let mut lines = Vec::new();

    // Header line
    let header_line = headers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let width = col_widths.get(i).copied().unwrap_or(0);
            format!("{h:<width$}")
        })
        .collect::<Vec<_>>()
        .join("  ");
    lines.push(header_line);

    // Separator line: col widths in "─" joined by "──"
    let sep_line = col_widths
        .iter()
        .map(|&w| "─".repeat(w))
        .collect::<Vec<_>>()
        .join("──");
    lines.push(sep_line);

    // Data rows
    for row in rows {
        let row_line = row
            .iter()
            .enumerate()
            .map(|(i, cell)| {
                let width = col_widths.get(i).copied().unwrap_or(0);
                format!("{cell:<width$}")
            })
            .collect::<Vec<_>>()
            .join("  ");
        lines.push(row_line);
    }

    lines
}

/// Format and print an aligned tabular layout.
pub fn print_table(headers: &[&str], rows: &[Vec<String>]) {
    for line in format_table(headers, rows) {
        println!("{line}");
    }
}

/// Print formatted error to stderr with red prefix and exit with given code (default 1).
pub fn die(message: &str, code: Option<i32>) -> ! {
    eprintln!("\x1b[31merror:\x1b[0m {message}");
    process::exit(code.unwrap_or(1));
}

/// Print success message with green checkmark.
pub fn success(message: &str) {
    println!("\x1b[32m✓\x1b[0m {message}");
}

/// Print warning message with yellow warning sign.
pub fn warn(message: &str) {
    eprintln!("\x1b[33m⚠\x1b[0m {message}");
}
