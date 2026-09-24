//! UTF-16 code unit column math for LSP 3.17 positions.

/// Convert a 0-based UTF-16 code unit offset within a line to a byte offset.
/// Clamps to `line.len()` if `utf16_col` exceeds the line's UTF-16 length.
pub fn utf16_col_to_byte_offset(line: &str, utf16_col: u32) -> usize {
    let mut current_utf16: u32 = 0;
    for (byte_offset, ch) in line.char_indices() {
        if current_utf16 >= utf16_col {
            return byte_offset;
        }
        current_utf16 += ch.len_utf16() as u32;
    }
    line.len()
}

/// Convert a byte offset within a line to a 0-based UTF-16 code unit offset.
/// Clamps to the line's UTF-16 length if `byte_offset` exceeds `line.len()`.
pub fn byte_offset_to_utf16_col(line: &str, byte_offset: usize) -> u32 {
    let mut current_utf16: u32 = 0;
    for (offset, ch) in line.char_indices() {
        if offset >= byte_offset {
            return current_utf16;
        }
        current_utf16 += ch.len_utf16() as u32;
    }
    current_utf16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_roundtrip() {
        let line = "let x = 42;";
        for col in 0..=line.len() as u32 {
            let byte_offset = utf16_col_to_byte_offset(line, col);
            let roundtrip_col = byte_offset_to_utf16_col(line, byte_offset);
            assert_eq!(col, roundtrip_col);
        }
    }

    #[test]
    fn test_emoji_roundtrip() {
        // Crab emoji 🦀 is 4 bytes in UTF-8, 2 code units in UTF-16.
        let line = "🦀 fn run() {}";
        // col 0: before emoji -> byte 0
        assert_eq!(utf16_col_to_byte_offset(line, 0), 0);
        assert_eq!(byte_offset_to_utf16_col(line, 0), 0);

        // col 2: after emoji, at space -> byte 4
        let byte_offset = utf16_col_to_byte_offset(line, 2);
        assert_eq!(byte_offset, 4);
        assert_eq!(byte_offset_to_utf16_col(line, byte_offset), 2);

        // col 5: after "🦀 fn"
        let byte_offset = utf16_col_to_byte_offset(line, 5);
        assert_eq!(byte_offset, 7);
        assert_eq!(byte_offset_to_utf16_col(line, byte_offset), 5);
    }

    #[test]
    fn test_cjk_roundtrip() {
        // CJK characters: 中 (3 bytes, 1 code unit), 文 (3 bytes, 1 code unit)
        let line = "中文代码";
        for (expected_byte, col) in [(0, 0), (3, 1), (6, 2), (9, 3), (12, 4)] {
            let byte_offset = utf16_col_to_byte_offset(line, col);
            assert_eq!(byte_offset, expected_byte);
            let roundtrip_col = byte_offset_to_utf16_col(line, byte_offset);
            assert_eq!(col, roundtrip_col);
        }
    }
}
