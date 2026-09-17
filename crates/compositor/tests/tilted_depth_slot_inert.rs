//! La profondeur de champ éteinte ne change pas un octet du rendu.
//!
//! `TiltedQuad::depth_mb` remplit le `mb` du mode 8. Réglage « Depth of field » coupé, `k` vaut 0
//! et une frame inclinée doit sortir identique, octet pour octet, à celle d'avant ce slot. Même
//! chose, réglage ALLUMÉ, pour une frame sans rotation : le mode 8 n'y est pas dessiné et la
//! pyramide n'est pas remplie. La seule façon de le montrer est de comparer à un rendu de
//! référence produit SANS le slot (la clé `depthOfField` y est ignorée) :
//!
//! ```powershell
//! # 1) sur le code d'avant (sources de src/ de la base), écrire la référence
//! $env:OPENSCREEN_PRIVACY_SECRET = "...\secret.mp4"
//! $env:OPENSCREEN_DEPTH_OUT = "...\reference"
//! cargo test -p openscreen-compositor --test tilted_depth_slot_inert -- --nocapture
//! # 2) sur le code d'après, comparer
//! $env:OPENSCREEN_DEPTH_OUT = "...\after"
//! $env:OPENSCREEN_DEPTH_REFERENCE = "...\reference"
//! cargo test -p openscreen-compositor --test tilted_depth_slot_inert -- --nocapture
//! ```
//!
//! Même source que `privacy_blur_under_zoom.rs` (pavé rouge sur fond gris). Sans
//! `OPENSCREEN_PRIVACY_SECRET`, le test se saute.

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

const W: u32 = 960;
const H: u32 = 540;
/// En plein palier du zoom : la région couvre 0..6 s.
const AT_SEC: f64 = 3.0;

fn scene_json(secret: &str, fx: f32, fy: f32, rotation: &str, dof: bool) -> String {
    let s = secret.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.35,"roundnessFrac":0.03,"motionBlur":0.0,"depthOfField":{dof}}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [{{"id":"z","startSec":0,"endSec":6,"scale":1.6,"focusX":{fx},"focusY":{fy},"focusMode":"manual","rotation":"{rotation}"}}],
        "annotations": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [{{"x":0.1,"y":0.05,"width":0.85,"height":0.9}}],
        "output": {{"width":{W},"height":{H},"fps":null}}
    }}"##
    )
}

fn render(gpu: &Gpu, secret: &str, fx: f32, fy: f32, rotation: &str, dof: bool) -> Vec<u8> {
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(gpu, W, H).expect("compositor");
    let scene = Scene::from_json(&scene_json(secret, fx, fy, rotation, dof)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    comp.clear_cursor();
    unsafe {
        let mut player = Player::open(secret, "", gpu).expect("ouvrir la source");
        player.present_frame(&comp, &cfg, AT_SEC).expect("composer la frame");
        comp.readback_resized(W, H).expect("readback")
    }
}

fn write_ppm(path: &std::path::Path, rgba: &[u8]) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{W} {H}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out)
}

#[test]
fn a_tilted_frame_is_unchanged_by_the_depth_slot() {
    let Ok(secret) = std::env::var("OPENSCREEN_PRIVACY_SECRET") else {
        println!("SKIP: definir OPENSCREEN_PRIVACY_SECRET (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_DEPTH_OUT").ok().map(std::path::PathBuf::from);
    let reference = std::env::var("OPENSCREEN_DEPTH_REFERENCE").ok().map(std::path::PathBuf::from);
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).expect("creer le dossier de sortie");
    }
    let gpu = Gpu::create(false).expect("device d3d11");

    // Focus décentrés : un `z_focus` nul (focus au centre) ne prouverait rien sur le 3e champ.
    // Les trois présets inclinés réglage coupé ; la frame droite réglage allumé.
    let cases = [
        ("iso", 0.8, 0.3, false),
        ("left", 0.2, 0.7, false),
        ("right", 0.9, 0.9, false),
        ("none", 0.8, 0.3, true),
    ];
    let mut diffs = Vec::new();
    for (rotation, fx, fy, dof) in cases {
        let rgba = render(&gpu, &secret, fx, fy, rotation, dof);
        // Garde : la frame montre bien l'écran, pas un fond uni.
        let red = rgba.chunks_exact(4).filter(|p| p[0] > 150 && p[1] < 80 && p[2] < 80).count();
        assert!(red > 1_000, "{rotation}: pave rouge absent ({red} px)");
        if let Some(dir) = &out_dir {
            std::fs::write(dir.join(format!("{rotation}.rgba")), &rgba).expect("ecrire le brut");
            write_ppm(&dir.join(format!("{rotation}.ppm")), &rgba).expect("ecrire le ppm");
        }
        match &reference {
            None => println!("{rotation:<6} rendu, {red} px rouges (pas de reference)"),
            Some(dir) => {
                let want = std::fs::read(dir.join(format!("{rotation}.rgba"))).expect("lire la reference");
                let differing = rgba.iter().zip(&want).filter(|(a, b)| a != b).count();
                println!("{rotation:<6} {differing} octets differents de la reference");
                if want.len() != rgba.len() || differing != 0 {
                    diffs.push(format!("{rotation}: {differing} octets differents"));
                }
            }
        }
    }
    assert!(diffs.is_empty(), "la profondeur de champ eteinte a change le rendu :\n{}", diffs.join("\n"));
}
