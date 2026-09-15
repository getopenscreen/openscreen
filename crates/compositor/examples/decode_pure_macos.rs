//! Diagnostic : décodage H.264/HEVC PUR (avcodec_receive_frame, thread_count=0),
//! sans la conversion NV12/CVPixelBuffer de `mac_frames::CpuFrames` — pour séparer
//! le coût du décodeur logiciel de celui de la présentation dans decode_bench_macos.
//! Le chemin VT y est câblé explicitement (`get_format` + vérification du format de
//! la première frame) : un comptage de frames logiciel étiqueté VideoToolbox serait
//! pire qu'une erreur.
//!
//! Utilisation : `cargo run --release --example decode_pure_macos -- <fichier> [frames] [software|videotoolbox]`

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
	use std::ffi::CString;
	use std::ptr;

	use openscreen_compositor::ffi;

	let path = std::env::args().nth(1).unwrap_or_else(|| {
		eprintln!("usage: decode_pure_macos <fichier> [frames=1200] [software|videotoolbox]");
		std::process::exit(2);
	});
	let frames: u64 = std::env::args()
		.nth(2)
		.and_then(|s| s.parse().ok())
		.unwrap_or(1200);
	let mode = std::env::args().nth(3).unwrap_or_else(|| "software".into());
	if !matches!(mode.as_str(), "software" | "videotoolbox") {
		anyhow::bail!("mode {mode} invalide (software|videotoolbox)");
	}

	unsafe extern "C" fn get_videotoolbox_format(
		_ctx: *mut ffi::AVCodecContext,
		pix_fmts: *const ffi::AVPixelFormat::Type,
	) -> ffi::AVPixelFormat::Type {
		if pix_fmts.is_null() {
			return ffi::AVPixelFormat::AV_PIX_FMT_NONE;
		}
		let mut p = pix_fmts;
		while *p != ffi::AVPixelFormat::AV_PIX_FMT_NONE {
			if *p == ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX {
				return *p;
			}
			p = p.add(1);
		}
		ffi::AVPixelFormat::AV_PIX_FMT_NONE
	}

	unsafe {
		let mut fmt: *mut ffi::AVFormatContext = ptr::null_mut();
		let cpath = CString::new(path)?;
		ffi::averr(
			ffi::avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null(), ptr::null_mut()),
			"open",
		)?;
		ffi::averr(ffi::avformat_find_stream_info(fmt, ptr::null_mut()), "find_stream_info")?;
		let vidx = ffi::av_find_best_stream(
			fmt,
			ffi::AVMediaType::AVMEDIA_TYPE_VIDEO,
			-1,
			-1,
			ptr::null_mut(),
			0,
		);
		if vidx < 0 {
			anyhow::bail!("pas de flux vidéo");
		}
		let codecpar = (*ffi::sn_fmt_stream(fmt, vidx)).codecpar;

		let dec = ffi::avcodec_find_decoder((*codecpar).codec_id);
		let dctx = ffi::avcodec_alloc_context3(dec);
		ffi::averr(ffi::avcodec_parameters_to_context(dctx, codecpar), "params_to_ctx")?;

		let mut hwdev: *mut ffi::AVBufferRef = ptr::null_mut();
		if mode == "videotoolbox" {
			ffi::averr(
				ffi::av_hwdevice_ctx_create(
					&mut hwdev,
					ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
					ptr::null(),
					ptr::null_mut(),
					0,
				),
				"hwdevice",
			)?;
			(*dctx).hw_device_ctx = ffi::av_buffer_ref(hwdev);
			// Sans `get_format`, libavcodec choisit son format natif : `hw_device_ctx`
			// seul ne garantit pas AV_PIX_FMT_VIDEOTOOLBOX. La boucle ci-dessous refuse
			// en plus toute première frame qui n'aurait pas ce format.
			(*dctx).get_format = Some(get_videotoolbox_format);
		} else {
			(*dctx).thread_count = 0;
		}
		ffi::averr(ffi::avcodec_open2(dctx, dec, ptr::null_mut()), "open2")?;

		let pkt = ffi::av_packet_alloc();
		let frame = ffi::av_frame_alloc();
		let mut sent_eof = false;
		let mut n: u64 = 0;
		let t0 = std::time::Instant::now();
		while n < frames {
			let r = ffi::avcodec_receive_frame(dctx, frame);
			if r == 0 {
				// En VT, compter une frame système serait étiqueter « VideoToolbox » un
				// décodage logiciel (retombée silencieuse du hwaccel).
				if mode == "videotoolbox"
					&& (*frame).format != ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32
				{
					anyhow::bail!(
						"frame reçue en format {}, pas VIDEOTOOLBOX — le chemin demandé n'a pas pris",
						(*frame).format
					);
				}
				n += 1;
				continue;
			}
			if r == ffi::AVERROR_EOF {
				break;
			}
			if r != ffi::AVERROR_EAGAIN {
				ffi::averr(r, "receive_frame")?;
			}
			if sent_eof {
				ffi::avcodec_send_packet(dctx, ptr::null_mut());
				continue;
			}
			let rr = ffi::av_read_frame(fmt, pkt);
			if rr == ffi::AVERROR_EOF {
				ffi::avcodec_send_packet(dctx, ptr::null_mut());
				sent_eof = true;
			} else {
				ffi::averr(rr, "read_frame")?;
				if (*pkt).stream_index == vidx {
					ffi::averr(ffi::avcodec_send_packet(dctx, pkt), "send_packet")?;
				}
				ffi::av_packet_unref(pkt);
			}
		}
		if n < frames {
			anyhow::bail!("source finie après {n} frames ; {frames} demandées — mesure incomplète");
		}
		let dt = t0.elapsed().as_secs_f64();
		eprintln!(
			"codec={} profil={} format={} mode={mode}",
			(*codecpar).codec_id,
			(*dctx).profile,
			(*codecpar).format
		);
		println!("{n} frames en {dt:.3} s — {:.0} fps (pur, sans present)", n as f64 / dt);
	}
	Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
	eprintln!("macOS only");
}
