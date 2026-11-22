//! #1651 proof: cost of the per-render-loop break rebuild (live.rs) and of the re-smoothing.
use std::time::Instant;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::scene::Scene;

fn scene(n: usize, path: &str) -> Scene {
    let clips: Vec<String> = (0..n).map(|i| format!(r#"{{"screenPath":"{path}","webcamPath":"","sourceStartSec":{},"sourceEndSec":{},"webcamOffsetSec":0,"hasAudio":false}}"#, i as f64 * 0.5, i as f64 * 0.5 + 0.4)).collect();
    let crop = vec!["null"; n].join(",");
    Scene::from_json(&format!(r##"{{"clips":[{}],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0.1,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#000000"}},"zoomRegions":[],"cursor":{{"show":true,"size":1,"smoothing":0.5,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[{crop}],"output":{{"width":1920,"height":1080,"fps":30}}}}"##, clips.join(","))).unwrap()
}

#[test]
fn proof_bench() {
    let Ok(src) = std::env::var("PROOF_SOURCE") else { return };
    let path = src.replace('\\', "/");
    for n in [1usize, 2, 20, 200] {
        let s = scene(n, &path);
        let last: Vec<f32> = s.cursor_break_for_clip(n - 1).into_iter().collect();
        let iters = 1_000_000;
        let t = Instant::now();
        let mut changed = 0;
        for _ in 0..iters {
            let b: Vec<f32> = std::hint::black_box(&s).cursor_break_for_clip(std::hint::black_box(n - 1)).into_iter().collect();
            if b != last { changed += 1; }
        }
        let ns = t.elapsed().as_nanos() as f64 / iters as f64;
        eprintln!("clips={n}: breaks rebuild + compare = {ns:.1} ns/iteration (changed {changed})");
    }
    for f in [src.clone(), std::env::var("PROOF_LONG").unwrap_or(src.clone())] {
        let raw = CursorTrack::load(&format!("{f}.cursor.json"), 0.0, 24.0 * 3600.0).unwrap();
        let breaks: Vec<f32> = (0..200).map(|i| i as f32 * 0.3).collect();
        for (label, b) in [("smoothed", vec![]), ("2 breaks", vec![1.0, 18.5]), ("200 breaks", breaks)] {
            let t = Instant::now();
            for _ in 0..20 { std::hint::black_box(raw.smoothed_with_breaks(0.5, &b)); }
            eprintln!("{f}: {label}: {:.2} ms per re-smooth", t.elapsed().as_secs_f64() * 1000.0 / 20.0);
        }
    }
}
