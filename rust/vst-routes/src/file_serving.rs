use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

pub const HARD_LIMIT: u64 = 50 * 1024 * 1024;
pub const BINARY_LIMIT: u64 = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FileServingError {
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("File too large (>50MB)")]
    TooLarge,
    #[error("Binary file (>1MB) — preview unavailable")]
    BinaryTooLarge,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Unprocessable(String),
}

#[derive(Debug)]
pub enum FileResponse {
    Text { etag: String, content: String },
    Image { mime: String, content: Vec<u8> },
}

/// Compute ETag header string: `"\"hex\""`
pub fn compute_etag(content: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    let hex = format!("{:016x}", hasher.finish());
    format!("\"{hex}\"")
}

pub async fn read_file_response(abs_path: &Path) -> Result<FileResponse, FileServingError> {
    let meta = tokio::fs::metadata(abs_path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileServingError::NotFound(abs_path.to_string_lossy().to_string())
        } else {
            FileServingError::Io(e)
        }
    })?;

    if meta.len() > HARD_LIMIT {
        return Err(FileServingError::TooLarge);
    }

    let buf = tokio::fs::read(abs_path).await?;

    let ext = abs_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let image_mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    };

    if let Some(mime) = image_mime {
        return Ok(FileResponse::Image {
            mime: mime.to_string(),
            content: buf,
        });
    }

    // Binary detection: check null byte in first 8KB
    let sample_len = buf.len().min(8192);
    let is_binary = buf[..sample_len].contains(&0);
    if is_binary && meta.len() > BINARY_LIMIT {
        return Err(FileServingError::BinaryTooLarge);
    }

    let etag = compute_etag(&buf);
    let text = String::from_utf8_lossy(&buf).to_string();

    Ok(FileResponse::Text {
        etag,
        content: text,
    })
}
