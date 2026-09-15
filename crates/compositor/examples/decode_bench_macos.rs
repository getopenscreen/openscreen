//! Bench décodage seul (macOS) : déroule `pipeline_macos::Decoder` sur N frames et
//! imprime le débit. C'est le même décodeur que la marche d'export (`next()` inclut
//! la conversion NV12/CVPixelBuffer du chemin logiciel), piloté par la même variable
//! `OPENSCREEN_MAC_DECODE=software|videotoolbox` que l'arbitrage de production.
//!
//! Utilisation : `cargo run --release --example decode_bench_macos -- <fichier> [frames]`

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
	let path = std::env::args().nth(1).unwrap_or_else(|| {
		eprintln!("usage: decode_bench_macos <fichier> [frames=1200]");
		std::process::exit(2);
	});
	let frames: u64 = std::env::args()
		.nth(2)
		.and_then(|s| s.parse().ok())
		.unwrap_or(1200);
	// Un mode mal orthographié serait ignoré par l'arbitrage de production (qui garde
	// son défaut) : le bench mesurerait l'autre chemin en croyant mesurer celui demandé.
	let forced = std::env::var("OPENSCREEN_MAC_DECODE").ok();
	match forced.as_deref() {
		None | Some("software") | Some("videotoolbox") => {}
		Some(other) => anyhow::bail!("OPENSCREEN_MAC_DECODE={other} invalide (software|videotoolbox)"),
	}

	let gpu = openscreen_compositor::d3d_macos::Gpu::create(false)?;
	unsafe {
		let mut dec = openscreen_compositor::pipeline_macos::Decoder::open_for_export(&path, &gpu)?;
		// `open_with` retombe silencieusement sur logiciel si `av_hwdevice_ctx_create`
		// échoue : refuser plutôt que chronométrer un autre chemin que celui demandé.
		if forced.as_deref() == Some("videotoolbox") && !dec.uses_videotoolbox() {
			anyhow::bail!(
				"OPENSCREEN_MAC_DECODE=videotoolbox demandé, mais VideoToolbox n'a pas pris (retombe logiciel)"
			);
		}
		let t0 = std::time::Instant::now();
		let mut n: u64 = 0;
		// Boucle sur le fichier jusqu'à N frames décodées : une source plus courte que la
		// cible ne doit pas raccourcir la mesure. Le rewind (seek 0 + flush) reste dans le
		// chronomètre, c'est négligeable devant le décodage.
		let mut pass_frames: u64 = 0;
		while n < frames {
			let f = dec.next()?;
			if f.is_null() {
				// Une passe complète sans aucune frame décodable rewinderait indéfiniment.
				if pass_frames == 0 {
					anyhow::bail!("source sans aucune frame décodable");
				}
				pass_frames = 0;
				dec.rewind()?;
				continue;
			}
			n += 1;
			pass_frames += 1;
		}
		let dt = t0.elapsed().as_secs_f64();
		println!("{n} frames en {dt:.3} s — {:.0} fps", n as f64 / dt);
	}
	Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
	eprintln!("macOS only");
}
