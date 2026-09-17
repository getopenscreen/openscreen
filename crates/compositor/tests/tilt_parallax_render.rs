//! Sous un préset 3D, le plan penche vers le geste du curseur puis revient à la pose du préset
//! au repos (`regions::dynamic_tilt`). Rend de vraies frames par le compositeur D3D11.
//!
//! Piloté par l'environnement, comme `privacy_blur_under_zoom.rs` : il faut une source
//! 1920×1080 de 6 s, de préférence quadrillée pour que l'inclinaison se lise à l'œil. La piste
//! curseur est écrite par le test lui-même (même format que le sidecar `.cursor.json`).
//!
//! ```powershell
//! ffmpeg -f lavfi -i "color=c=0x707070:s=1920x1080:r=30:d=6,drawgrid=w=96:h=96:t=3:c=white" -c:v h264_mf -b:v 6M -pix_fmt nv12 grid.mp4
//! $env:OPENSCREEN_TILT_SOURCE = "...\grid.mp4"
//! cargo test -p openscreen-compositor --test tilt_parallax_render -- --nocapture
//! ```
//!
//! `OPENSCREEN_TILT_OUT` (facultatif) reçoit un PPM par instant, pour l'inspection à l'œil.

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

const W: u32 = 1920;
const H: u32 = 1080;

/// Au repos jusqu'à 1,6 s ; vers la droite de 1,6 à 2,2 s ; repos ; vers le bas de 2,7 à 3,3 s ;
/// repos jusqu'au bout.
fn cursor_at(t: f32) -> (f32, f32) {
    let ramp = |a: f32, b: f32| ((t - a) / (b - a)).clamp(0.0, 1.0);
    (0.3 + 0.4 * ramp(1.6, 2.2), 0.4 + 0.35 * ramp(2.7, 3.3))
}

fn write_sidecar(path: &std::path::Path) {
    let samples: Vec<String> = (0..=180)
        .map(|i| {
            let t = i as f32 / 30.0;
            let (cx, cy) = cursor_at(t);
            format!(r#"{{"timeMs":{},"cx":{cx},"cy":{cy}}}"#, (t * 1000.0).round())
        })
        .collect();
    std::fs::write(path, format!(r#"{{"samples":[{}]}}"#, samples.join(","))).expect("sidecar");
}

fn scene_json(source: &str) -> String {
    let s = source.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.15,"y":0.15,"width":0.7,"height":0.7}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.5,"roundnessFrac":0.02,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#2060d0"}},
        "zoomRegions": [{{"id":"z","startSec":0,"endSec":6,"scale":1.15,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":"iso"}}],
        "annotations": [],
        "speedRegions": [],
        "cursor": {{"show":true,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":{W},"height":{H},"fps":null}}
    }}"##
    )
}

fn write_ppm(path: &std::path::Path, rgba: &[u8]) {
    let mut out = format!("P6\n{W} {H}\n255\n").into_bytes();
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out).expect("ecrire le ppm");
}

/// Un pixel du plan : tout ce qui n'est pas le fond bleu (ombre comprise, qui reste bleue).
fn is_plane(rgba: &[u8], x: u32, y: u32) -> bool {
    let p = &rgba[((y * W + x) * 4) as usize..];
    !(p[2] as i32 > p[0] as i32 + 60)
}

/// Pixels dont l'appartenance au plan diffère entre deux frames : la silhouette a bougé.
fn silhouette_diff(a: &[u8], b: &[u8]) -> usize {
    (0..H)
        .flat_map(|y| (0..W).map(move |x| (x, y)))
        .filter(|&(x, y)| is_plane(a, x, y) != is_plane(b, x, y))
        .count()
}

/// Bord droit du plan sur la rangée du milieu, bord bas sur la colonne du milieu.
fn right_and_bottom_edges(rgba: &[u8]) -> (u32, u32) {
    let right = (0..W).rev().find(|&x| is_plane(rgba, x, H / 2)).unwrap_or(0);
    let bottom = (0..H).rev().find(|&y| is_plane(rgba, W / 2, y)).unwrap_or(0);
    (right, bottom)
}

#[test]
fn the_tilted_plane_leans_into_the_cursor_gesture() {
    let Ok(source) = std::env::var("OPENSCREEN_TILT_SOURCE") else {
        println!("SKIP: definir OPENSCREEN_TILT_SOURCE (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_TILT_OUT").ok().map(std::path::PathBuf::from);
    let sidecar_dir = out_dir.clone().unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&sidecar_dir).expect("creer le dossier de sortie");
    let sidecar = sidecar_dir.join(format!("tilt-parallax-{}.cursor.json", std::process::id()));
    write_sidecar(&sidecar);
    let track = CursorTrack::load(sidecar.to_str().expect("chemin utf-8"), 0.0, 6.0).expect("piste");

    let gpu = Gpu::create(false).expect("device d3d11");
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let scene = Scene::from_json(&scene_json(&source)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    comp.set_cursor(track.smoothed(0.0));

    let mut edges = Vec::new();
    let mut frames = Vec::new();
    let instants = [("rest-before", 1.2), ("moving-right", 2.0), ("moving-down", 3.1), ("rest-after", 5.0)];
    for (name, t) in instants {
        let rgba = unsafe {
            let mut player = Player::open(&source, "", &gpu).expect("ouvrir la source");
            player.present_frame(&comp, &cfg, t).expect("composer la frame");
            comp.readback_resized(W, H).expect("readback")
        };
        if let Some(dir) = &out_dir {
            write_ppm(&dir.join(format!("{name}.ppm")), &rgba);
        }
        let e = right_and_bottom_edges(&rgba);
        println!("{name:<13} t={t:<4} bord droit {:>4}  bord bas {:>4}", e.0, e.1);
        edges.push(e);
        frames.push(rgba);
    }
    let _ = std::fs::remove_file(&sidecar);
    let [rest, right, down, rest_after] = [edges[0], edges[1], edges[2], edges[3]];

    let settled = silhouette_diff(&frames[0], &frames[3]);
    let leaned_right = silhouette_diff(&frames[0], &frames[1]);
    let leaned_down = silhouette_diff(&frames[0], &frames[2]);
    println!("silhouette : repos/repos {settled} px, droite {leaned_right} px, bas {leaned_down} px");

    // Au repos, le plan reprend la pose du préset (le curseur, lui, a bougé, mais il reste
    // DANS le plan : il ne change pas la silhouette).
    assert!(settled < 50, "{settled} px de silhouette changés entre deux repos");
    let still = rest.0.abs_diff(rest_after.0) <= 1 && rest.1.abs_diff(rest_after.1) <= 1;
    assert!(still, "{rest:?} {rest_after:?}");
    // En mouvement, tout le contour bouge.
    assert!(leaned_right > 1_000 && leaned_down > 1_000, "{leaned_right} / {leaned_down}");
    // Vers la droite : le bord droit recule, donc se rapproche du centre.
    assert!(right.0 < rest.0, "bord droit {} au repos {}", right.0, rest.0);
    // Vers le bas : le bord bas recule.
    assert!(down.1 < rest.1, "bord bas {} au repos {}", down.1, rest.1);
}
