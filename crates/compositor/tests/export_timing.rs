//! Frame-timing regression net for the export paths.
//!
//! The bug class this exists to catch is silent: an exporter that advances its
//! decoder by one SOURCE frame per OUTPUT frame emits the right number of
//! frames while covering only `out_fps / source_fps` of the recording. Frame
//! count alone therefore proves nothing — the content has to be checked.
//!
//! So the fixture is a 4 s / 60 fps clip whose colour changes every second
//! (red → green → blue → white). A correct export spans all four colours; a
//! mis-advanced one stays red for its whole length.
//!
//! Needs a native GPU backend and the generated media, so it is opt-in: set
//! OPENSCREEN_TEST_MEDIA to a directory holding `screen_colors.mp4` and
//! `webcam_gray.mp4`. Gap/origin tests also need the derived fixtures below.
//! Without OPENSCREEN_TEST_MEDIA every test here skips.
//!
//! Regenerate the media with the vendored ffmpeg:
//!   for c in red green blue white; do ffmpeg -f lavfi \
//!     -i "color=c=$c:size=640x360:duration=1:rate=60" -c:v libopenh264 \
//!     -g 60 -pix_fmt yuv420p seg_$c.mp4; done
//!   ffmpeg -f concat -safe 0 -i concat.txt -c copy screen_colors.mp4
//!   ffmpeg -f lavfi -i "color=c=gray:size=320x240:duration=4:rate=60" \
//!     -c:v libopenh264 -g 60 -pix_fmt yuv420p webcam_gray.mp4
//!   ffmpeg -i screen_colors.mp4 -vf "select='lt(t,1)+gte(t,3)'" \
//!     -fps_mode vfr -c:v libopenh264 -g 60 -pix_fmt yuv420p video_gap.mp4
//!   ffmpeg -i screen_colors.mp4 -c copy -output_ts_offset 1 offset_start.mp4
//!   ffmpeg -i video_gap.mp4 -c copy -output_ts_offset 1 offset_gap.mp4
//! The gap fixture must retain timestamps: video frames stop at 0.983 s and
//! resume at 3.000 s. An equivalent H.264 encoder is sufficient if libopenh264
//! is unavailable.

// Pas sur Linux : `pipeline::probe_frame_count` n'existe que dans
// `pipeline_windows` et `pipeline_macos`. Les fichiers de `tests/` sont compiles
// sur TOUTE plateforme, donc sans cette porte ce fichier casse la compilation du
// crate sous Linux — ce que personne ne voyait faute de job Rust Linux en CI (il
// en existe un depuis, d'ou la decouverte). Meme motif que `compose_linux.rs` et
// `warp_device_cannot_decode.rs`, en negatif : ici c'est Linux qu'on exclut, pas
// les autres qu'on cible, pour ne pas retirer ce fichier du job macOS qui le
// compile aujourd'hui.
#![cfg(not(target_os = "linux"))]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::export_control::{ExportCancelled, ExportControl};
use openscreen_compositor::gif_export::{self, GifExportParams};
use openscreen_compositor::pipeline::{self, ClipSource, ExportCodec, ExportParams};
use std::path::PathBuf;

const SOURCE_SEC: f64 = 4.0;

/// Isolate generated outputs from fixtures and remove them during unwinding.
struct TestOutputDir(PathBuf);

impl TestOutputDir {
    /// Create a fresh directory without reusing or deleting an existing path.
    fn new(label: &str) -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("openscreen-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).expect("isolated test output directory");
        Self(path)
    }
}

impl Drop for TestOutputDir {
    /// Report cleanup errors without causing a second panic during unwinding.
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!("Could not clean test output directory: {error}");
        }
    }
}

/// Failed export assertions must not leave files in a caller's fixture directory.
#[test]
fn test_output_directory_is_removed_during_unwinding() {
    let outputs = TestOutputDir::new("cleanup-unwind");
    let path = outputs.0.clone();
    std::fs::write(path.join("partial.mp4"), b"incomplete export").expect("seed output");
    let result = std::panic::catch_unwind(move || {
        let _outputs = outputs;
        panic!("simulate a failed export assertion");
    });
    assert!(result.is_err());
    assert!(
        !path.exists(),
        "failed tests must remove their output directory"
    );
}

/// Per-frame local colour tables, in order, from a GIF89a file.
///
/// Enough of the format to walk block-to-block: extensions are skipped by
/// their sub-block chain, image descriptors yield their local table and then
/// their LZW data is skipped the same way. No LZW decode — the palette alone
/// says which colours a frame is made of, which is all the timing assertions
/// need.
fn gif_frame_palettes(bytes: &[u8]) -> Vec<Vec<[u8; 3]>> {
    fn table_len(packed: u8) -> usize {
        if packed & 0x80 == 0 {
            0
        } else {
            3 * (1usize << ((packed & 0x07) + 1))
        }
    }
    /// Skips a `len,data…,0` sub-block chain, returning the position after it.
    fn skip_sub_blocks(bytes: &[u8], mut p: usize) -> usize {
        while p < bytes.len() && bytes[p] != 0 {
            p += 1 + bytes[p] as usize;
        }
        p + 1
    }

    let mut palettes = Vec::new();
    let mut p = 6; // "GIF89a"
    let packed = bytes[p + 4];
    p += 7 + table_len(packed); // logical screen descriptor + global table

    while p < bytes.len() {
        match bytes[p] {
            0x21 => p = skip_sub_blocks(bytes, p + 2), // extension: 0x21, label, chain
            0x2C => {
                let packed = bytes[p + 9];
                let start = p + 10;
                let len = table_len(packed);
                palettes.push(
                    bytes[start..start + len]
                        .chunks_exact(3)
                        .map(|c| [c[0], c[1], c[2]])
                        .collect(),
                );
                p = skip_sub_blocks(bytes, start + len + 1); // +1 = LZW min code size
            }
            _ => break, // 0x3B trailer, or done
        }
    }
    palettes
}

/// Mean `R - B` across a palette. The fixture's first second is pure red
/// (large positive) and its last is white (≈ 0), so this single number
/// separates "covered the timeline" from "stuck on frame 0".
fn redness(palette: &[[u8; 3]]) -> f64 {
    if palette.is_empty() {
        return 0.0;
    }
    palette
        .iter()
        .map(|c| c[0] as f64 - c[2] as f64)
        .sum::<f64>()
        / palette.len() as f64
}

fn media_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var("OPENSCREEN_TEST_MEDIA").ok()?);
    dir.join("screen_colors.mp4").exists().then_some(dir)
}

/// One clip covering the whole fixture.
fn whole_clip(dir: &PathBuf) -> ClipSource {
    ClipSource {
        screen: dir.join("screen_colors.mp4").to_string_lossy().into_owned(),
        webcam: dir.join("webcam_gray.mp4").to_string_lossy().into_owned(),
        source_start_sec: 0.0,
        source_end_sec: SOURCE_SEC,
        webcam_offset_sec: 0.0,
        has_audio: false,
    }
}

/// MP4 at 30 fps over a 4 s source must emit 120 frames — i.e. the walk is
/// driven by OUTPUT time, not by "one source frame per output frame" (which
/// would still emit 120 frames but cover only 2 s of the recording; the GIF
/// test below is the one that catches the coverage half).
#[test]
fn mp4_export_frame_count_follows_output_fps() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let gpu = Gpu::create(false).expect("gpu");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    let comp = Compositor::new_sized(&gpu, params.width, params.height).expect("compositor");
    let out = dir.join("out_timing.mp4");
    let stats = pipeline::run_composited_multi(
        &[whole_clip(&dir)],
        &out.to_string_lossy(),
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |_| {},
    )
    .expect("mp4 export");

    assert_eq!(
        stats.frames, 120,
        "4 s of source at 30 fps out must be 120 frames, got {}",
        stats.frames
    );
    let probed = pipeline::probe_frame_count(&out.to_string_lossy()).expect("probe");
    assert_eq!(probed, 120, "muxed file disagrees with the reported count");
}

/// A camera that ended before its requested offset must fail the whole export,
/// even after a good clip. Otherwise an empty or incomplete MP4 replaces the destination.
#[test]
fn mp4_export_rejects_an_unreadable_camera_without_publishing() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join("unreadable_camera_export");
    std::fs::create_dir_all(&out_dir).expect("output dir");
    let camera = out_dir.join("camera.webm");
    openscreen_compositor::remux::remux_to_seekable_matroska(
        &dir.join("webcam_gray.mp4").to_string_lossy(),
        &camera.to_string_lossy(),
    )
    .expect("camera with no stream duration, like a browser recording");
    let gpu = Gpu::create(false).expect("gpu");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    for unknown_duration in [false, true] {
        for after_valid_clip in [false, true] {
            let mut bad = whole_clip(&dir);
            if unknown_duration {
                bad.webcam = camera.to_string_lossy().into_owned();
            }
            bad.webcam_offset_sec = -(SOURCE_SEC + 1.0);
            let mut clips = Vec::new();
            if after_valid_clip {
                clips.push(whole_clip(&dir));
            }
            clips.push(bad);
            let out = out_dir.join("out.mp4");
            std::fs::write(&out, b"previous export").expect("seed destination");
            let error = pipeline::run_composited_multi(
                &clips,
                &out.to_string_lossy(),
                &gpu,
                &comp,
                &Cfg::c8(),
                &params,
                &mut |_| {},
            )
            .err()
            .expect("an unreadable camera must not silently drop a clip");
            let message = format!("{error:#}");
            assert!(
                message.contains("camera"),
                "missing camera diagnosis: {message}"
            );
            assert!(
                message.contains(&format!("clip {}", clips.len())),
                "missing clip number: {message}"
            );
            assert_eq!(std::fs::read(&out).unwrap(), b"previous export");
            assert_eq!(
                std::fs::read_dir(&out_dir).unwrap().count(),
                2,
                "partial output left behind"
            );
        }
    }
    std::fs::remove_dir_all(out_dir).expect("remove test outputs");
}

/// An entirely out-of-range timeline cannot publish an empty replacement.
#[test]
fn mp4_export_rejects_a_timeline_that_produces_no_frames() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let gpu = Gpu::create(false).expect("gpu");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    let mut clip = whole_clip(&dir);
    clip.webcam.clear();
    clip.source_start_sec = SOURCE_SEC + 1.0;
    clip.source_end_sec = SOURCE_SEC + 2.0;
    let out = dir.join("no_frames.mp4");
    std::fs::write(&out, b"previous export").expect("seed destination");
    let error = pipeline::run_composited_multi(
        &[clip],
        &out.to_string_lossy(),
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |_| {},
    )
    .err()
    .expect("zero video frames must not be a successful export");
    assert!(
        format!("{error:#}").contains("No video frames"),
        "unexpected error: {error:#}"
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"previous export");
    std::fs::remove_file(out).expect("remove test output");
}

/// Entering a clip just past its last frame is normal when audio outlasts video.
/// Exercise screen-only, real-camera and unknown-duration camera sources, including
/// frame inspection, which shares the export walk.
#[test]
fn mp4_export_accepts_tail_clips_and_frame_inspection() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join("tail_clip_export");
    std::fs::create_dir_all(&out_dir).expect("output dir");
    let camera = out_dir.join("camera.mkv");
    openscreen_compositor::remux::remux_to_seekable_matroska(
        &dir.join("webcam_gray.mp4").to_string_lossy(),
        &camera.to_string_lossy(),
    )
    .expect("unknown-duration camera");
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    for source in 0..5 {
        let mut tail = whole_clip(&dir);
        if source == 0 || source == 4 {
            tail.webcam.clear();
        } else if source == 2 {
            tail.webcam = camera.to_string_lossy().into_owned();
        }
        // Last video pts is 4 - 1/60; the declared stream end is 4 seconds.
        tail.source_start_sec = if source >= 3 {
            SOURCE_SEC + 0.25
        } else {
            SOURCE_SEC - 0.01
        };
        tail.source_end_sec = tail.source_start_sec + 0.01;
        let expected_tail_frames = if source >= 3 { 0 } else { 1 };
        let clips = [whole_clip(&dir), tail];
        let frames = unsafe {
            openscreen_compositor::timeline_walk::render_frames(
                &clips,
                &gpu,
                &comp,
                &Cfg::c8(),
                30,
                &[120],
            )
        }
        .expect("inspect tail frame");
        assert_eq!(
            frames.len(),
            expected_tail_frames,
            "source {source}: tail inspection"
        );
        if let Some(frame) = frames.first() {
            assert_eq!(frame.index, 120);
        }
        let out = out_dir.join("out.mp4");
        let stats = pipeline::run_composited_multi(
            &clips,
            &out.to_string_lossy(),
            &gpu,
            &comp,
            &Cfg::c8(),
            &params,
            &mut |_| {},
        )
        .expect("tail must not fail the complete export");
        assert_eq!(
            stats.frames,
            120 + expected_tail_frames as u64,
            "source {source}: tail export"
        );
        std::fs::remove_file(out).expect("remove output");
    }
    std::fs::remove_dir_all(out_dir).expect("remove test outputs");
}

/// Unknown stream duration must not turn last-frame recovery into an unbounded
/// hold. A real gap still fails, and the screen stand-in must not blame a camera.
#[test]
fn mp4_export_bounds_tail_recovery_and_reports_the_correct_source() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join("bounded_tail_export");
    std::fs::create_dir_all(&out_dir).expect("output dir");
    let source = out_dir.join("source.mkv");
    openscreen_compositor::remux::remux_to_seekable_matroska(
        &dir.join("screen_colors.mp4").to_string_lossy(),
        &source.to_string_lossy(),
    )
    .expect("unknown-duration source");
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    for has_camera in [false, true] {
        for gap in [0.25, 0.6] {
            let mut clip = whole_clip(&dir);
            if has_camera {
                clip.webcam = source.to_string_lossy().into_owned();
                clip.webcam_offset_sec = -(SOURCE_SEC + gap);
                clip.source_end_sec = 0.1;
            } else {
                clip.screen = source.to_string_lossy().into_owned();
                clip.webcam.clear();
                clip.source_start_sec = SOURCE_SEC + gap;
                clip.source_end_sec = clip.source_start_sec + 0.1;
            }
            let out = out_dir.join("out.mp4");
            std::fs::write(&out, b"previous export").expect("seed output");
            let result = pipeline::run_composited_multi(
                &[clip],
                &out.to_string_lossy(),
                &gpu,
                &comp,
                &Cfg::c8(),
                &params,
                &mut |_| {},
            );
            if gap < 0.5 {
                assert_eq!(result.expect("normal tail hold").frames, 3);
            } else {
                let message = format!("{:#}", result.err().expect("real gap must fail"));
                assert!(
                    message.contains(if has_camera { "camera" } else { "screen" }),
                    "{message}"
                );
                if !has_camera {
                    assert!(!message.contains("camera"), "{message}");
                }
                assert_eq!(std::fs::read(&out).unwrap(), b"previous export");
            }
            std::fs::remove_file(out).expect("remove output");
            assert_eq!(
                std::fs::read_dir(&out_dir).unwrap().count(),
                1,
                "partial output left behind"
            );
        }
    }
    std::fs::remove_dir_all(out_dir).expect("remove test outputs");
}

/// A seek inside a multi-second hole must not show a frame from the future.
/// Exercise both source roles and preservation after an earlier valid clip.
#[test]
fn mp4_export_rejects_a_start_inside_a_multisecond_video_gap() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let outputs = TestOutputDir::new("future-frame-gap");
    let out_dir = &outputs.0;
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    for timestamp_offset in [0.0, 1.0] {
        let gap = dir.join(if timestamp_offset == 0.0 {
            "video_gap.mp4"
        } else {
            "offset_gap.mp4"
        });
        assert!(
            gap.exists(),
            "generate gap fixtures using the fixture header recipe"
        );
        for camera_gap in [false, true] {
            for after_valid_clip in [false, true] {
                let mut bad = whole_clip(&dir);
                if camera_gap {
                    bad.webcam = gap.to_string_lossy().into_owned();
                } else {
                    bad.screen = gap.to_string_lossy().into_owned();
                }
                bad.source_start_sec = 1.5 + timestamp_offset;
                bad.source_end_sec = 3.5 + timestamp_offset;
                let mut clips = Vec::new();
                if after_valid_clip {
                    clips.push(whole_clip(&dir));
                }
                clips.push(bad);
                let out = out_dir.join("out.mp4");
                std::fs::write(&out, b"previous export").expect("seed destination");
                let result = pipeline::run_composited_multi(
                    &clips,
                    &out.to_string_lossy(),
                    &gpu,
                    &comp,
                    &Cfg::c8(),
                    &params,
                    &mut |_| {},
                );
                let error = result
                    .err()
                    .expect("a future frame cannot stand in for a missing start");
                let message = format!("{error:#}");
                assert!(
                    message.contains(if camera_gap { "camera" } else { "screen" }),
                    "{message}"
                );
                assert!(
                    message.contains(&format!("clip {}", clips.len())),
                    "{message}"
                );
                assert_eq!(std::fs::read(&out).unwrap(), b"previous export");
                assert_eq!(std::fs::read_dir(out_dir).unwrap().count(), 1);
                std::fs::remove_file(out).expect("remove destination");
            }
        }
    }
}

/// A non-zero first video timestamp is a valid stream origin, not an interior gap.
#[test]
fn mp4_export_accepts_a_nonzero_first_video_timestamp() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let offset = dir.join("offset_start.mp4");
    assert!(
        offset.exists(),
        "generate offset_start.mp4 using the fixture header recipe"
    );
    let outputs = TestOutputDir::new("offset-start");
    let out_dir = &outputs.0;
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    #[cfg(target_os = "macos")]
    {
        let mut decoder =
            pipeline::Decoder::open_for_export(&offset.to_string_lossy(), &gpu).expect("decoder");
        unsafe {
            assert!(!decoder.seek_to(0.0).expect("first frame").is_null());
            assert!(
                (decoder.cur_time_sec() - 1.0).abs() < 0.01,
                "fixture must have a non-zero first timestamp"
            );
        }
    }
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    for camera_offset in [false, true] {
        let mut clip = whole_clip(&dir);
        if camera_offset {
            clip.webcam = offset.to_string_lossy().into_owned();
        } else {
            clip.screen = offset.to_string_lossy().into_owned();
        }
        let out = out_dir.join("out.mp4");
        let frames = pipeline::run_composited_multi(
            &[clip],
            &out.to_string_lossy(),
            &gpu,
            &comp,
            &Cfg::c8(),
            &params,
            &mut |_| {},
        )
        .expect("a non-zero stream origin must export");
        assert_eq!(frames.frames, 120);
        assert!(pipeline::probe_frame_count(&out.to_string_lossy()).expect("decode output") > 0);
        std::fs::remove_file(out).expect("remove export");
    }
}

/// The macOS frame probe must count decoded video rather than require MP4
/// frame-count metadata; Matroska recordings commonly omit that metadata.
#[cfg(target_os = "macos")]
#[test]
fn frame_probe_counts_video_without_declared_frame_count() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let outputs = TestOutputDir::new("frame-probe");
    let source = outputs.0.join("video.mkv");
    openscreen_compositor::remux::remux_to_seekable_matroska(
        &dir.join("screen_colors.mp4").to_string_lossy(),
        &source.to_string_lossy(),
    )
    .expect("remux synthetic video without a declared frame count");
    assert_eq!(
        pipeline::probe_frame_count(&source.to_string_lossy()).expect("decode Matroska"),
        240
    );
    assert_eq!(
        pipeline::probe_frame_count(&dir.join("screen_colors.mp4").to_string_lossy())
            .expect("decode MP4"),
        240
    );
    std::fs::remove_file(source).expect("remove remux");
}

/// Inspecting a completed selection must not prepare an unrelated later clip,
/// while a selection that reaches the bad camera must still report its error.
#[test]
fn frame_inspection_stops_before_an_unrequested_unreadable_clip() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    let mut bad = whole_clip(&dir);
    bad.webcam_offset_sec = -(SOURCE_SEC + 1.0);
    let clips = [whole_clip(&dir), bad];
    let frames = unsafe {
        openscreen_compositor::timeline_walk::render_frames(
            &clips,
            &gpu,
            &comp,
            &Cfg::c8(),
            30,
            &[119],
        )
    }
    .expect("the last frame of the valid clip must not inspect the next camera");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].index, 119);
    let empty = unsafe {
        openscreen_compositor::timeline_walk::render_frames(
            &clips[1..],
            &gpu,
            &comp,
            &Cfg::c8(),
            30,
            &[],
        )
    }
    .expect("an empty selection must not prepare any clip");
    assert!(empty.is_empty());
    let error = unsafe {
        openscreen_compositor::timeline_walk::render_frames(
            &clips,
            &gpu,
            &comp,
            &Cfg::c8(),
            30,
            &[120],
        )
    }
    .err()
    .expect("a requested unreadable clip must still fail");
    let message = format!("{error:#}");
    assert!(
        message.contains("clip 2") && message.contains("camera"),
        "{message}"
    );
}

/// The staged decode check must accept short exports in both supported MP4 codecs.
#[cfg(target_os = "macos")]
#[test]
fn mp4_export_validation_accepts_h264_and_hevc() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join(format!("validated_codecs-{}", std::process::id()));
    std::fs::create_dir_all(&out_dir).expect("output dir");
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    for codec in [ExportCodec::H264, ExportCodec::H265] {
        let params = ExportParams {
            width: 640, height: 360, fps: Some(30), codec, bit_rate: None,
        };
        let mut clip = whole_clip(&dir);
        clip.source_end_sec = 0.2;
        let out = out_dir.join("out.mp4");
        std::fs::write(&out, b"previous export").expect("seed destination");
        let stats = pipeline::run_composited_multi(
            &[clip], &out.to_string_lossy(), &gpu, &comp, &Cfg::c8(), &params, &mut |_| {},
        ).expect("valid encoded video must pass validation");
        assert_eq!(stats.frames, 6);
        assert_ne!(std::fs::read(&out).unwrap(), b"previous export");
        std::fs::remove_file(out).expect("remove output");
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 0);
    }
    std::fs::remove_dir(out_dir).expect("remove output dir");
}

/// VideoToolbox can mux one tail sample with zero duration and mark it discard.
/// A positive composed-frame count must not let that file replace a good export.
#[cfg(target_os = "macos")]
#[test]
fn mp4_export_rejects_an_undecodable_single_tail_frame_without_publishing() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join(format!("undecodable_single_tail-{}", std::process::id()));
    std::fs::create_dir_all(&out_dir).expect("output dir");
    let out = out_dir.join("out.mp4");
    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositor");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    let mut tail = whole_clip(&dir);
    tail.webcam.clear();
    tail.source_start_sec = SOURCE_SEC - 0.01;
    for existing_destination in [false, true] {
        if existing_destination {
            std::fs::write(&out, b"previous export").expect("seed destination");
        }
        let result = pipeline::run_composited_multi(
            &[ClipSource {
                screen: tail.screen.clone(),
                webcam: String::new(),
                source_start_sec: tail.source_start_sec,
                source_end_sec: tail.source_end_sec,
                webcam_offset_sec: 0.0,
                has_audio: false,
            }],
            &out.to_string_lossy(),
            &gpu,
            &comp,
            &Cfg::c8(),
            &params,
            &mut |_| {},
        );
        let error = result
            .err()
            .expect("undecodable output must not be published");
        assert!(
            format!("{error:#}").contains("validating exported video"),
            "{error:#}"
        );
        if existing_destination {
            assert_eq!(std::fs::read(&out).unwrap(), b"previous export");
            std::fs::remove_file(&out).expect("remove destination");
        } else {
            assert!(!out.exists());
        }
        assert_eq!(
            std::fs::read_dir(&out_dir).unwrap().count(),
            0,
            "partial output left behind"
        );
    }
    std::fs::remove_dir(out_dir).expect("remove output dir");
}

/// Cancelling an MP4 mid-render stops the walk at the next frame, reports `ExportCancelled`,
/// and publishes nothing: the destination keeps what it held and no partial is left beside
/// it. On Windows that last check also proves the muxer closed its file, since an open
/// handle makes the partial undeletable.
#[test]
fn mp4_export_cancelled_mid_render_publishes_nothing() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join("cancelled_export");
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir(&out_dir).expect("output dir");
    let out = out_dir.join("out.mp4");
    std::fs::write(&out, b"previous export").expect("seed the destination");

    let gpu = Gpu::create(false).expect("gpu");
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
        bit_rate: None,
    };
    let comp = Compositor::new_sized(&gpu, params.width, params.height).expect("compositor");
    let control = ExportControl::default();
    let mut reported = 0;
    let error = pipeline::run_composited_multi_cancellable(
        &[whole_clip(&dir)],
        &out.to_string_lossy(),
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |frames| {
            reported = frames;
            if frames == 10 {
                control.cancel();
            }
        },
        &control,
    )
    .err()
    .expect("a cancelled export must not succeed");

    assert!(error.is::<ExportCancelled>(), "expected a cancellation, got: {error:#}");
    assert_eq!(reported, 10, "the walk went on to frame {reported} after the cancel");
    assert_eq!(std::fs::read(&out).expect("destination"), b"previous export");
    let left: Vec<_> = std::fs::read_dir(&out_dir)
        .expect("output dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(left, vec![std::ffi::OsString::from("out.mp4")], "a partial export was left behind");
    let _ = std::fs::remove_dir_all(&out_dir);
}

/// Same for a GIF, whose frames are encoded on a worker pool: the cancel must reach the
/// export thread, release the workers rather than wait on them, and publish nothing.
#[test]
fn gif_export_cancelled_mid_render_publishes_nothing() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out_dir = dir.join("cancelled_gif");
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir(&out_dir).expect("output dir");
    let out = out_dir.join("out.gif");
    std::fs::write(&out, b"previous export").expect("seed the destination");

    let gpu = Gpu::create(false).expect("gpu");
    let comp = Compositor::new_sized(&gpu, 320, 180).expect("compositor");
    let params = GifExportParams {
        width: Some(320),
        height: Some(180),
        fps: Some(12),
        loop_count: None,
        dither: true,
    };
    let control = ExportControl::default();
    let error = gif_export::export_gif_cancellable(
        &[whole_clip(&dir)],
        &out,
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |frames| {
            if frames == 10 {
                control.cancel();
            }
        },
        &control,
    )
    .err()
    .expect("a cancelled export must not succeed");

    assert!(error.is::<ExportCancelled>(), "expected a cancellation, got: {error:#}");
    assert_eq!(std::fs::read(&out).expect("destination"), b"previous export");
    let left: Vec<_> = std::fs::read_dir(&out_dir)
        .expect("output dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(left, vec![std::ffi::OsString::from("out.gif")], "a partial export was left behind");
    let _ = std::fs::remove_dir_all(&out_dir);
}

/// The GIF must cover the WHOLE timeline, not just its first
/// `out_fps / source_fps` slice.
///
/// This is the assertion frame count cannot make: an exporter that advances one
/// source frame per output frame still writes 48 frames for a 4 s / 12 fps
/// request — it just takes them all from the first 0.8 s, so every frame is red
/// and the GIF plays 5x slow. Comparing the first and last frame palettes
/// catches exactly that.
#[test]
fn gif_export_spans_the_whole_timeline() {
    let Some(dir) = media_dir() else {
        eprintln!("skipped: set OPENSCREEN_TEST_MEDIA");
        return;
    };
    let out = dir.join("out_timing.gif");
    let params = GifExportParams {
        width: Some(320),
        height: Some(180),
        fps: Some(12),
        loop_count: None,
        dither: false,
    };
    let gpu = Gpu::create(false).expect("gpu");
    // Same contract as the MP4 path: the caller sizes the compositor to the output.
    let comp = Compositor::new_sized(&gpu, 320, 180).expect("compositor");
    let stats = gif_export::export_gif(
        &[whole_clip(&dir)],
        &out,
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |_| {},
    )
    .expect("gif export");

    assert_eq!(
        stats.frames, 48,
        "4 s at 12 fps must be 48 frames, got {}",
        stats.frames
    );

    let bytes = std::fs::read(&out).expect("read gif");
    let palettes = gif_frame_palettes(&bytes);
    assert_eq!(palettes.len(), 48, "GIF carries {} frames", palettes.len());

    let first = redness(&palettes[0]);
    let last = redness(&palettes[palettes.len() - 1]);
    assert!(
        first > 40.0,
        "first frame should be red-dominated (redness {first:.1})"
    );
    assert!(
        last < first - 40.0,
        "last frame still looks like the first — the export never advanced past \
         the opening red second (first {first:.1}, last {last:.1})"
    );
}
