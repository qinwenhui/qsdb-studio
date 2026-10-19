//! 背景图读取：本地图片 → data URL（前端直接用作 CSS background）。
//!
//! 不引图片/编码依赖：只做扩展名 → MIME 与 base64。图片只在启动/选择时读一次，
//! 大图上限 16 MiB（明确的"过大"错误，不静默截断）。

use std::path::Path;

use crate::error::{Result, StudioError};

/// 允许的背景图最大字节数。
pub const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

/// 读一张本地图片，返回 `data:<mime>;base64,…`。
pub fn read_image_data_url(path: &Path) -> Result<String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| StudioError::storage(format!("读取图片 {} 失败: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(StudioError::usage(format!(
            "{} 不是文件（背景图只接受 png/jpg/jpeg/webp/gif/bmp）",
            path.display()
        )));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(StudioError::usage(format!(
            "图片 {} 为 {} MiB，超过背景图上限 {} MiB",
            path.display(),
            meta.len() / (1024 * 1024),
            MAX_IMAGE_BYTES / (1024 * 1024)
        )));
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        other => {
            return Err(StudioError::usage(format!(
                "不支持的背景图格式 {other:?}（png/jpg/jpeg/webp/gif/bmp）"
            )));
        }
    };
    let bytes = std::fs::read(path)
        .map_err(|e| StudioError::storage(format!("读取图片 {} 失败: {e}", path.display())))?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// 标准 base64（带 padding）。
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0x00, 0xab, 0xff]), "AKv/");
    }

    #[test]
    fn reads_png_as_data_url() {
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path().join("wall.png");
        std::fs::write(&p, [0x89, b'P', b'N', b'G']).unwrap();
        let url = read_image_data_url(&p).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(url.ends_with("iVBORw=="));
    }

    #[test]
    fn rejects_unsupported_and_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path().join("x.txt");
        std::fs::write(&p, b"hello").unwrap();
        let e = read_image_data_url(&p).unwrap_err();
        assert!(e.message.contains("不支持的背景图格式"));

        let e = read_image_data_url(&tmp.path().join("nope.png")).unwrap_err();
        assert_eq!(e.kind, "storage");
    }
}
