#![allow(dead_code)]

#[cfg(windows)]
mod nv12;
#[cfg(windows)]
pub use nv12::{gpu, Nv12Frame};

/// PPM P6 — pas de dépendance à encoder, et ça s'ouvre dans n'importe quel
/// visionneur. Permet l'inspection à l'œil en plus de la comparaison de hash.
pub fn write_ppm(path: &std::path::Path, rgba: &[u8], w: u32, h: u32) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out)
}
