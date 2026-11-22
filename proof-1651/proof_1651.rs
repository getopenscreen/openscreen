//! Proof harness for #1651 (not part of the PR). Copied into tests/ of a base and a head worktree.
//! Env: PROOF_SOURCE (mp4 with .cursor.json beside it), PROOF_OUT (dir), PROOF_SCENE (single|cut),
//! PROOF_SMOOTH (cursor smoothing), PROOF_HEAVY (1 = heavy effects), PROOF_EXPORTS (timed runs).
use std::io::Write;

use openscreen_compositor::compositor::{live_params_from_scene, Compositor};
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::{self, ClipSource};
use openscreen_compositor::scene::Scene;
use openscreen_compositor::timeline_walk::render_frames;

const FPS: i32 = 30;
const W: u32 = 1920;
const H: u32 = 1080;

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn windows(scene: &str) -> Vec<(f64, f64)> {
    match scene {
        "single" => vec![(0.0, 32.0)],
        _ => vec![(1.0, 7.5), (18.5, 30.0)],
    }
}

fn scene_json(source: &str, wins: &[(f64, f64)], smooth: f32, heavy: bool) -> String {
    let clips: Vec<String> = wins
        .iter()
        .map(|(s, e)| format!(r#"{{"screenPath":"{source}","webcamPath":"","sourceStartSec":{s},"sourceEndSec":{e},"webcamOffsetSec":0,"hasAudio":false}}"#))
        .collect();
    let (effects, zooms, cmb) = if heavy {
        (
            r#"{"padding":0.12,"blur":true,"shadow":0.6,"roundnessFrac":0.03,"motionBlur":0.35}"#,
            r#"[{"id":"z","clipIndex":0,"startSec":2,"endSec":5,"scale":1.8,"focusX":0.5,"focusY":0.5,"focusMode":"FOCUS"},{"id":"z2","clipIndex":1,"startSec":20,"endSec":26,"scale":1.6,"focusX":0.4,"focusY":0.5,"focusMode":"FOCUS"}]"#,
            0.5,
        )
    } else {
        (r#"{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}"#, "[]", 0.0)
    };
    let crop = vec!["null"; wins.len()].join(",");
    let zooms = zooms.replace("FOCUS", &env("PROOF_FOCUS", "auto"));
    format!(
        r##"{{"clips":[{clips}],
        "layout":{{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects":{effects},
        "background":{{"kind":"gradient","angleDeg":45,"stops":["#ff3b6b","#3b6bff"]}},
        "zoomRegions":{zooms},
        "cursor":{{"show":true,"size":1.5,"smoothing":{smooth},"motionBlur":{cmb},"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip":[{crop}],
        "output":{{"width":{W},"height":{H},"fps":{FPS}}}}}"##,
        clips = clips.join(",")
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

#[test]
fn proof_1651() {
    let Ok(source) = std::env::var("PROOF_SOURCE") else { return };
    let source = source.replace('\\', "/");
    let out = std::path::PathBuf::from(env("PROOF_OUT", "proof-out"));
    std::fs::create_dir_all(&out).unwrap();
    let scene_name = env("PROOF_SCENE", "cut");
    let smooth: f32 = env("PROOF_SMOOTH", "0.5").parse().unwrap();
    let heavy = env("PROOF_HEAVY", "0") == "1";
    let exports: usize = env("PROOF_EXPORTS", "0").parse().unwrap();
    let wins = windows(&scene_name);
    let json = scene_json(&source, &wins, smooth, heavy);
    let clips: Vec<ClipSource> = wins
        .iter()
        .map(|&(s, e)| ClipSource { screen: source.clone(), webcam: String::new(), source_start_sec: s, source_end_sec: e, webcam_offset_sec: 0.0, has_audio: false })
        .collect();
    let gpu = Gpu::create_auto(false).expect("device");
    let mut cfg = config::all().pop().unwrap();
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.mblur_n = 1;
    let scene = Scene::from_json(&json).expect("scene");
    cfg.bg_blur = scene.effects.blur;
    cfg.cursor = true;
    let make_comp = || {
        let scene = Scene::from_json(&json).unwrap();
        let comp = Compositor::new_sized(&gpu, W, H).unwrap();
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_scene(Some(scene));
        comp
    };

    if exports > 0 {
        let mut log = std::fs::File::create(out.join("export_times.txt")).unwrap();
        for i in 0..exports {
            let comp = make_comp();
            let params = pipeline::ExportParams { width: W, height: H, ..Default::default() };
            let path = out.join(format!("export{i}.mp4"));
            let s = pipeline::run_composited_multi(&clips, path.to_str().unwrap(), &gpu, &comp, &cfg, &params, &mut |_| {}).expect("export");
            writeln!(log, "{i} frames={} wall_s={:.4} fps={:.2}", s.frames, s.wall_s, s.fps).unwrap();
            eprintln!("export {i}: {} frames {:.3}s", s.frames, s.wall_s);
            if i > 0 {
                let _ = std::fs::remove_file(&path);
            }
        }
        return;
    }

    // Frames to keep as PNG: the first 20 output frames of every window, then every 30th.
    let mut starts = vec![0u64];
    let mut acc = 0.0;
    for (s, e) in &wins {
        acc += e - s;
        starts.push((acc * FPS as f64).round() as u64);
    }
    let comp = make_comp();
    let all: Vec<u64> = (0..((acc * FPS as f64) as u64 + 10)).collect();
    let frames = unsafe { render_frames(&clips, &gpu, &comp, &cfg, FPS, &all) }.expect("render");
    let mut hashes = std::fs::File::create(out.join("hashes.txt")).unwrap();
    for f in frames {
        writeln!(hashes, "{} {:016x}", f.index, fnv(&f.rgba)).unwrap();
        let keep = f.index % 30 == 0 || starts.iter().any(|&s| f.index >= s && f.index < s + 20) || starts.iter().any(|&s| s > 0 && f.index + 3 >= s && f.index < s);
        if keep {
            image::RgbaImage::from_raw(f.width, f.height, f.rgba).unwrap().save(out.join(format!("f{:04}.png", f.index))).unwrap();
        }
    }
    eprintln!("window starts (output frames): {starts:?}");
}
