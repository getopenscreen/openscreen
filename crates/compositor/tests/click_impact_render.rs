//! Sous un préset 3D avec « Click impact », un clic fait basculer le plan du côté cliqué puis le
//! laisse revenir (`regions::click_impact`). Rend de vraies frames par le compositeur D3D11.
//!
//! Même harnais que `tilt_parallax_render.rs`, mêmes variables d'environnement : une source
//! 1920×1080 de 6 s, de préférence quadrillée. La piste curseur (immobile, un clic) est écrite
//! par le test lui-même, au format du sidecar `.cursor.json`.
//!
//! ```powershell
//! ffmpeg -f lavfi -i "color=c=0x707070:s=1920x1080:r=30:d=6,drawgrid=w=96:h=96:t=3:c=white" -c:v h264_mf -b:v 6M -pix_fmt nv12 grid.mp4
//! $env:OPENSCREEN_TILT_SOURCE = "...\grid.mp4"
//! cargo test -p openscreen-compositor --test click_impact_render -- --nocapture
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
const CLICK_S: f64 = 2.0;

/// Pointeur immobile près du bord droit, à mi-hauteur ; un clic à `CLICK_S`.
fn write_sidecar(path: &std::path::Path) {
    let samples: Vec<String> = (0..=180)
        .map(|i| {
            let ms = (i as f64 * 1000.0 / 30.0).round();
            let click = if (ms - CLICK_S * 1000.0).abs() < 1.0 { r#","interactionType":"click""# } else { "" };
            format!(r#"{{"timeMs":{ms},"cx":0.9,"cy":0.5{click}}}"#)
        })
        .collect();
    std::fs::write(path, format!(r#"{{"samples":[{}]}}"#, samples.join(","))).expect("sidecar");
}

fn scene_json(source: &str, click_impact: bool) -> String {
    let s = source.replace('\\', "/");
    let flag = if click_impact { r#","clickImpact":true"# } else { "" };
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.15,"y":0.15,"width":0.7,"height":0.7}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.5,"roundnessFrac":0.02,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#2060d0"}},
        "zoomRegions": [{{"id":"z","startSec":0,"endSec":6,"scale":1.15,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":"iso"{flag}}}],
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

/// Pixels dont l'appartenance au plan diffère entre deux frames : la silhouette a bougé. Pas
/// d'égalité au pixel : deux frames de la source ne sont pas identiques après l'encodeur.
fn silhouette_diff(a: &[u8], b: &[u8]) -> usize {
    (0..H)
        .flat_map(|y| (0..W).map(move |x| (x, y)))
        .filter(|&(x, y)| is_plane(a, x, y) != is_plane(b, x, y))
        .count()
}

/// Hauteur du plan sur une colonne : le bord qui recule rétrécit.
fn plane_height_at(rgba: &[u8], x: u32) -> u32 {
    (0..H).filter(|&y| is_plane(rgba, x, y)).count() as u32
}

/// Bord droit et bord gauche du plan sur la rangée du milieu.
fn left_and_right_edges(rgba: &[u8]) -> (u32, u32) {
    let left = (0..W).find(|&x| is_plane(rgba, x, H / 2)).unwrap_or(0);
    let right = (0..W).rev().find(|&x| is_plane(rgba, x, H / 2)).unwrap_or(0);
    (left, right)
}

#[test]
fn a_click_presses_the_clicked_side_of_the_tilted_plane() {
    let Ok(source) = std::env::var("OPENSCREEN_TILT_SOURCE") else {
        println!("SKIP: definir OPENSCREEN_TILT_SOURCE (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_TILT_OUT").ok().map(std::path::PathBuf::from);
    let sidecar_dir = out_dir.clone().unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&sidecar_dir).expect("creer le dossier de sortie");
    let sidecar = sidecar_dir.join(format!("click-impact-{}.cursor.json", std::process::id()));
    write_sidecar(&sidecar);
    let track = CursorTrack::load(sidecar.to_str().expect("chemin utf-8"), 0.0, 6.0).expect("piste");
    let _ = std::fs::remove_file(&sidecar);

    let gpu = Gpu::create(false).expect("device d3d11");
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    comp.set_cursor(track.smoothed(0.0));

    let render = |click_impact: bool, t: f64| -> Vec<u8> {
        let scene = Scene::from_json(&scene_json(&source, click_impact)).expect("scene valide");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_scene(Some(scene));
        unsafe {
            let mut player = Player::open(&source, "", &gpu).expect("ouvrir la source");
            player.present_frame(&comp, &cfg, t).expect("composer la frame");
            comp.readback_resized(W, H).expect("readback")
        }
    };

    let instants = [
        ("rest-before", CLICK_S - 0.5),
        ("contact", CLICK_S + 0.0495),
        ("rebound", CLICK_S + 0.165),
        ("rest-after", CLICK_S + 1.0),
    ];
    let probe = |rgba: &[u8]| {
        let (l, r) = left_and_right_edges(rgba);
        // Colonnes fixes, à l'intérieur du plan à tous les instants (bords mesurés : ~430 et
        // ~1660) : on compare la même tranche du plan d'une frame à l'autre.
        (l, r, plane_height_at(rgba, 1600), plane_height_at(rgba, 480))
    };
    let mut frames = Vec::new();
    for (name, t) in instants {
        let rgba = render(true, t);
        if let Some(dir) = &out_dir {
            write_ppm(&dir.join(format!("click-{name}.ppm")), &rgba);
        }
        let (l, r, hr, hl) = probe(&rgba);
        println!("{name:<12} t={t:<6} bords {l:>4}..{r:>4}  hauteur droite {hr:>4}  gauche {hl:>4}");
        frames.push((rgba, (l, r, hr, hl)));
    }
    let off = render(false, CLICK_S + 0.0495);
    if let Some(dir) = &out_dir {
        write_ppm(&dir.join("click-off-at-contact.ppm"), &off);
    }

    let rest = frames[0].1;
    let contact = frames[1].1;
    let (unchanged, settled, pressed) = (
        silhouette_diff(&off, &frames[0].0),
        silhouette_diff(&frames[3].0, &frames[0].0),
        silhouette_diff(&frames[1].0, &frames[0].0),
    );
    println!("silhouette : option éteinte {unchanged} px, repos/repos {settled} px, contact {pressed} px");
    // Option éteinte : le clic ne change rien. Au repos après l'impact : la pose du préset.
    assert_eq!(unchanged, 0, "sans l'option, le clic ne doit rien changer");
    assert_eq!(settled, 0, "le plan n'est pas revenu à sa pose");
    assert!(pressed > 1_000, "{pressed} px : le contact ne se voit pas");
    // Au contact, le bord droit (cliqué) recule : il se rapproche du centre et rétrécit, le
    // bord gauche avance et grandit.
    assert!(contact.1 < rest.1, "bord droit {} au repos {}", contact.1, rest.1);
    assert!(contact.2 < rest.2, "hauteur droite {} au repos {}", contact.2, rest.2);
    assert!(contact.3 > rest.3, "hauteur gauche {} au repos {}", contact.3, rest.3);
}
