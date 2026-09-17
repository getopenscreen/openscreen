//! Le cadre de fenêtre (`effects.frame`) rendu par le vrai compositeur D3D11 : droit et incliné,
//! clair et sombre, plus le témoin sans cadre.
//!
//! Piloté par l'environnement, comme `privacy_blur_under_zoom.rs` : il faut une source vidéo
//! quelconque (celle de ce test-là convient).
//!
//! ```powershell
//! $env:OPENSCREEN_FRAME_SOURCE = "...\secret.mp4"
//! $env:OPENSCREEN_FRAME_OUT = "...\renders"   # facultatif : un PPM par cas
//! cargo test -p openscreen-compositor --test window_frame_render -- --nocapture
//! ```

#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

const W: u32 = 1280;
const H: u32 = 720;
const AT_SEC: f64 = 3.0;

fn write_ppm(path: &std::path::Path, rgba: &[u8], w: u32, h: u32) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out)
}

/// `frame` : `None` = clé absente du JSON (payload d'avant le cadre), sinon sa valeur.
fn scene_json(source: &str, frame: Option<&str>, rotation: &str) -> String {
    let s = source.replace('\\', "/");
    let frame = frame.map(|f| format!(r#","frame":"{f}""#)).unwrap_or_default();
    // Zoom 1 : la région ne sert qu'à porter le préset 3D, sans grossir la boîte.
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
        "effects": {{"padding":0.5,"blur":false,"shadow":0.6,"roundnessFrac":0.03,"motionBlur":0.0{frame}}},
        "background": {{"kind":"gradient","angleDeg":135,"stops":["#5b6ee1","#e8a0bf"]}},
        "zoomRegions": [{{"id":"z","startSec":0,"endSec":6,"scale":1.0,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":{rotation}}}],
        "annotations": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":{W},"height":{H},"fps":null}}
    }}"##
    )
}

fn render(gpu: &Gpu, source: &str, frame: Option<&str>, rotation: &str) -> Vec<u8> {
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(gpu, W, H).expect("compositor");
    let scene = Scene::from_json(&scene_json(source, frame, rotation)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    comp.clear_cursor();
    unsafe {
        let mut player = Player::open(source, "", gpu).expect("ouvrir la source");
        player.present_frame(&comp, &cfg, AT_SEC).expect("composer la frame");
        comp.readback_resized(W, H).expect("readback")
    }
}

/// Pixels qui diffèrent de plus de `tol` sur un canal.
fn differing(a: &[u8], b: &[u8], tol: u8) -> usize {
    a.chunks_exact(4)
        .zip(b.chunks_exact(4))
        .filter(|(p, q)| p.iter().zip(q.iter()).take(3).any(|(x, y)| x.abs_diff(*y) > tol))
        .count()
}

#[test]
fn the_window_frame_renders_flat_and_tilted_in_both_themes() {
    let Ok(source) = std::env::var("OPENSCREEN_FRAME_SOURCE") else {
        println!("SKIP: definir OPENSCREEN_FRAME_SOURCE (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_FRAME_OUT").ok().map(std::path::PathBuf::from);
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).expect("creer le dossier de sortie");
    }
    let gpu = Gpu::create(false).expect("device d3d11");

    let mut renders = Vec::new();
    for (tilt_name, rotation) in [("flat", "null"), ("iso", r#""iso""#), ("left", r#""left""#)] {
        for (frame_name, frame) in
            [("absent", None), ("none", Some("none")), ("light", Some("window-light")), ("dark", Some("window-dark"))]
        {
            let rgba = render(&gpu, &source, frame, rotation);
            if let Some(dir) = &out_dir {
                write_ppm(&dir.join(format!("{tilt_name}-{frame_name}.ppm")), &rgba, W, H)
                    .expect("ecrire le ppm");
            }
            renders.push(((tilt_name, frame_name), rgba));
        }
    }
    let get = |t: &str, f: &str| &renders.iter().find(|((a, b), _)| *a == t && *b == f).unwrap().1;

    for tilt in ["flat", "iso", "left"] {
        // `"none"` et la clé absente : le même rendu, à l'octet. Les deux se lisent
        // `SceneFrame::None`, donc ce n'est qu'un garde-fou de désérialisation : la preuve que le
        // chemin sans cadre n'a pas bougé est `no_frame_leaves_the_geometry_untouched`.
        assert!(get(tilt, "none") == get(tilt, "absent"), "{tilt}: frame none != payload sans cadre");
        // Le cadre se voit, et ses deux thèmes aussi.
        let light = differing(get(tilt, "none"), get(tilt, "light"), 8);
        let dark = differing(get(tilt, "none"), get(tilt, "dark"), 8);
        let themes = differing(get(tilt, "light"), get(tilt, "dark"), 8);
        println!("{tilt:<5} clair {light:>7}  sombre {dark:>7}  clair/sombre {themes:>7}");
        let area = (W * H) as usize;
        assert!(light > area / 50, "{tilt}: le cadre clair ne se voit pas ({light} px)");
        assert!(dark > area / 50, "{tilt}: le cadre sombre ne se voit pas ({dark} px)");
        assert!(themes > area / 200, "{tilt}: clair et sombre se confondent ({themes} px)");
    }
}
