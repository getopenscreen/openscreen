//! Proof harness for #1654 (not part of the PR). Copied into crates/compositor/tests/ of a base and
//! a head worktree. Env:
//!   PROOF_SOURCE  mp4 with `<file>.cursor.json` beside it
//!   PROOF_OUT     output folder
//!   PROOF_SCENE   light | heavy | anim (anim parses on head only: `animate`)
//!   PROOF_MODE    frames (export walk, hashes + PNGs) | export (timed MP4s) | preview
//!   PROOF_RUNS    timed runs for export / preview playback
use std::io::Write;
use std::time::Instant;

use openscreen_compositor::compositor::{live_params_from_scene, Compositor};
use openscreen_compositor::config;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::live::Player;
use openscreen_compositor::pipeline::{self, ClipSource};
use openscreen_compositor::scene::Scene;
use openscreen_compositor::timeline_walk::render_frames;

const FPS: i32 = 30;
const W: u32 = 1920;
const H: u32 = 1080;
const PW: u32 = 960;
const PH: u32 = 540;
const DUR: f64 = 12.0;

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

// The animated effect: the screen becomes a flat grey whose level is the keyframed `g`.
// Region starts at source 2 s. Track: 0.1 at 0 s, linear to 0.9 at 4 s, hold, 0.3 at 6 s.
const ANIM_FX: &str = r#"[{"clipIndex":0,"startSec":2.0,"endSec":10.0,"target":"image","contract":1,
 "code":"fn effect(uv: vec2<f32>) -> vec4<f32> { return vec4<f32>(params.g, params.g, params.g, 1.0); }",
 "params":[{"name":"g","type":"number"}],"values":{"g":0.5},
 "animate":{"g":[{"atSec":0,"value":0.1},{"atSec":4,"value":0.9,"hold":true},{"atSec":6,"value":0.3}]}}]"#;

// A static effect present on base too, for the heavy identity run.
const STATIC_FX: &str = r#"[{"clipIndex":0,"startSec":7.0,"endSec":11.0,"target":"image","contract":1,
 "code":"fn effect(uv: vec2<f32>) -> vec4<f32> { let c = frame(uv); return vec4<f32>(c.rgb * (0.6 + 0.4 * sin(ctx.time * 3.0)) * params.gain, 1.0); }",
 "params":[{"name":"gain","type":"number"}],"values":{"gain":0.8}}]"#;

fn scene_json(source: &str, kind: &str) -> String {
    let heavy = kind == "heavy";
    let effects = if heavy {
        r#"{"padding":0.12,"blur":true,"shadow":0.6,"roundnessFrac":0.03,"motionBlur":0.35}"#
    } else {
        r#"{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}"#
    };
    let zooms = if heavy {
        r#"[{"id":"z","clipIndex":0,"startSec":1,"endSec":4,"scale":1.8,"focusX":0.5,"focusY":0.5,"focusMode":"auto"},{"id":"z2","clipIndex":0,"startSec":7,"endSec":10,"scale":1.6,"focusX":0.4,"focusY":0.5,"focusMode":"manual"}]"#
    } else {
        "[]"
    };
    let fx = match kind {
        "heavy" => STATIC_FX,
        "anim" => ANIM_FX,
        _ => "[]",
    };
    let cmb = if heavy { 0.5 } else { 0.0 };
    format!(
        r##"{{"clips":[{{"screenPath":"{source}","webcamPath":"","sourceStartSec":0,"sourceEndSec":{DUR},"webcamOffsetSec":0,"hasAudio":false}}],
        "layout":{{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects":{effects},
        "background":{{"kind":"gradient","angleDeg":45,"stops":["#ff3b6b","#3b6bff"]}},
        "zoomRegions":{zooms},
        "cursor":{{"show":true,"size":1.5,"smoothing":0.5,"motionBlur":{cmb},"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip":[null],
        "shaderEffects":{fx},
        "output":{{"width":{W},"height":{H},"fps":{FPS}}}}}"##
    )
}

fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn export_cfg(scene: &Scene) -> config::Cfg {
    // `export_cfg_and_scene` in compositor-view-napi.
    let mut cfg = config::all().pop().unwrap();
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.mblur_n = 1;
    cfg.bg_blur = scene.effects.blur;
    cfg.cursor = scene.cursor.show;
    cfg
}

fn save(path: std::path::PathBuf, w: u32, h: u32, rgba: Vec<u8>) {
    image::RgbaImage::from_raw(w, h, rgba).unwrap().save(path).unwrap();
}

#[test]
fn proof_1654() {
    let Ok(source) = std::env::var("PROOF_SOURCE") else { return };
    let source = source.replace('\\', "/");
    let out = std::path::PathBuf::from(env("PROOF_OUT", "proof-out"));
    std::fs::create_dir_all(&out).unwrap();
    let kind = env("PROOF_SCENE", "light");
    let mode = env("PROOF_MODE", "frames");
    let runs: usize = env("PROOF_RUNS", "3").parse().unwrap();
    let json = scene_json(&source, &kind);
    let clips = vec![ClipSource { screen: source.clone(), webcam: String::new(), source_start_sec: 0.0, source_end_sec: DUR, webcam_offset_sec: 0.0, has_audio: false }];
    let gpu = Gpu::create_auto(false).expect("device");
    let scene = Scene::from_json(&json).expect("scene");
    let cfg = export_cfg(&scene);
    let make_comp = |w, h| {
        let scene = Scene::from_json(&json).unwrap();
        let comp = Compositor::new_sized(&gpu, w, h).unwrap();
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_scene(Some(scene));
        comp
    };
    let frames_total = (DUR * FPS as f64) as u64;

    match mode.as_str() {
        "export" => {
            let mut log = std::fs::File::create(out.join("export_times.txt")).unwrap();
            for i in 0..runs {
                let comp = make_comp(W, H);
                let params = pipeline::ExportParams { width: W, height: H, ..Default::default() };
                let path = out.join(format!("export{i}.mp4"));
                let s = pipeline::run_composited_multi(&clips, path.to_str().unwrap(), &gpu, &comp, &cfg, &params, &mut |_| {}).expect("export");
                writeln!(log, "{i} frames={} wall_s={:.4} fps={:.2}", s.frames, s.wall_s, s.fps).unwrap();
                eprintln!("export {i}: {} frames {:.3}s", s.frames, s.wall_s);
                if i > 0 {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        "frames" => {
            let comp = make_comp(W, H);
            let all: Vec<u64> = (0..frames_total + 10).collect();
            let frames = unsafe { render_frames(&clips, &gpu, &comp, &cfg, FPS, &all) }.expect("render");
            let mut hashes = std::fs::File::create(out.join("hashes.txt")).unwrap();
            for f in frames {
                writeln!(hashes, "{} {:016x}", f.index, fnv(&f.rgba)).unwrap();
                if f.index % 45 == 0 {
                    save(out.join(format!("f{:04}.png", f.index)), f.width, f.height, f.rgba);
                }
            }
        }
        "preview" => unsafe {
            // Preview path: the live view's Player into a compositor at the preview's size, the
            // scene and cursor the live view sets, readback_direct as the live loop publishes.
            let mut pcfg = cfg.clone();
            pcfg.mblur_n = (1.0 + scene.effects.motion_blur.clamp(0.0, 1.0) * 15.0).round() as u32;
            let comp = make_comp(PW, PH);
            let raw = CursorTrack::load(&format!("{source}.cursor.json"), 0.0, 24.0 * 3600.0).unwrap();
            comp.set_cursor(raw.smoothed(scene.cursor.smoothing));
            let mut player = Player::open(&source, "", &gpu).expect("player");
            player.set_programme_clock(Some(&scene), 0);
            // Instants on exact source frames (60 fps) that are also export frames (30 fps).
            let instants: Vec<u64> = vec![15, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
            let export_comp = make_comp(W, H);
            let exported = render_frames(&clips, &gpu, &export_comp, &cfg, FPS, &instants).expect("render");
            let mut log = std::fs::File::create(out.join("preview_vs_export.txt")).unwrap();
            for ef in exported {
                let t = ef.index as f64 / FPS as f64;
                assert!(player.present_frame(&comp, &pcfg, t).expect("seek"));
                let (w, h, prev) = comp.readback_direct().expect("readback");
                let exp = image::RgbaImage::from_raw(ef.width, ef.height, ef.rgba).unwrap();
                let small = image::imageops::resize(&exp, w, h, image::imageops::FilterType::Triangle);
                let (mut sum, mut max, mut over16) = (0u64, 0u8, 0u64);
                for (a, b) in prev.chunks(4).zip(small.as_raw().chunks(4)) {
                    for c in 0..3 {
                        let d = a[c].abs_diff(b[c]);
                        sum += d as u64;
                        max = max.max(d);
                        if d > 16 {
                            over16 += 1;
                        }
                    }
                }
                let mean = sum as f64 / (w as f64 * h as f64 * 3.0);
                // The centre pixel (inside the screen image): the animated grey level.
                let ci = ((h / 2 * w + w / 2) * 4) as usize;
                let (pc, ec) = (prev[ci], small.as_raw()[ci]);
                let line = format!(
                    "t={t:.3}s preview {w}x{h} pts={:.4} mean_abs_diff={mean:.3} max={max} channels_over16={:.4}% centre preview={pc} export={ec}",
                    player.screen_time_sec(),
                    over16 as f64 * 100.0 / (w as f64 * h as f64 * 3.0)
                );
                eprintln!("{line}");
                writeln!(log, "{line}").unwrap();
                let mut pair = image::RgbaImage::new(w * 2, h);
                image::imageops::replace(&mut pair, &image::RgbaImage::from_raw(w, h, prev).unwrap(), 0, 0);
                image::imageops::replace(&mut pair, &small, w as i64, 0);
                pair.save(out.join(format!("pair_{:04}.png", ef.index))).unwrap();
            }
            // Playback throughput of the preview path: the live loop's 60 Hz clock, step + readback.
            let mut tl = std::fs::File::create(out.join("preview_playback.txt")).unwrap();
            for r in 0..runs {
                assert!(player.present_frame(&comp, &pcfg, 0.0).expect("seek"));
                let mut target = 0.0;
                let mut composed = 0u32;
                let mut per: Vec<f64> = Vec::new();
                let t0 = Instant::now();
                while target < DUR - 0.5 {
                    target += 1.0 / 60.0;
                    let s = Instant::now();
                    if player.step(&comp, &pcfg, target).expect("step") {
                        let _ = comp.readback_direct().expect("readback");
                        composed += 1;
                        per.push(s.elapsed().as_secs_f64() * 1000.0);
                    }
                }
                let wall = t0.elapsed().as_secs_f64();
                per.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let p = |q: f64| per[((per.len() - 1) as f64 * q) as usize];
                let line = format!(
                    "run {r}: {composed} frames in {wall:.3}s unthrottled = {:.1} fps capacity; per frame p50={:.3}ms p95={:.3}ms p99={:.3}ms",
                    composed as f64 / wall,
                    p(0.5),
                    p(0.95),
                    p(0.99)
                );
                eprintln!("{line}");
                writeln!(tl, "{line}").unwrap();
            }
        },
        m => panic!("unknown mode {m}"),
    }
}
