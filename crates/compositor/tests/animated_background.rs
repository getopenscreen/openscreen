//! Un fond dégradé animé (mode 5, `fx.w`) est une fonction pure du temps programme :
//! immobile, il ne dépend pas de l'instant ; animé, chaque mouvement donne une image propre à
//! chacun des trois instants fixes, et différente du dégradé immobile.
//!
//! Rend de vraies frames par le compositeur D3D11. Piloté par l'environnement, comme
//! `privacy_blur_under_zoom.rs`, dont il réutilise la source (n'importe quel MP4 d'au moins
//! 6 s convient) :
//!
//! ```powershell
//! $env:OPENSCREEN_PRIVACY_SECRET = "...\secret.mp4"
//! cargo test -p openscreen-compositor --test animated_background -- --nocapture
//! ```
//!
//! `OPENSCREEN_BACKGROUND_OUT` (facultatif) reçoit un PPM par cas, pour l'inspection à l'œil.
//! Les empreintes imprimées sont celles de CE GPU : le rendu « none » se compare à celui du
//! shader d'avant le fond animé en relançant le test sur l'ancien `shaders.hlsl`.

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

const W: u32 = 960;
const H: u32 = 540;
/// Trois clips de 6 s du même fichier : le clip `k` lu à 3 s source tombe à `6k + 3` s de
/// programme. La frame vidéo est la même, seul le temps programme change.
const PROGRAMME_TIMES: [f32; 3] = [3.0, 9.0, 15.0];

fn write_ppm(path: &std::path::Path, rgba: &[u8], w: u32, h: u32) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out)
}

/// `motion` : fragment JSON inséré tel quel dans le fond (`""` = clé absente).
fn scene_json(source: &str, motion: &str) -> String {
    let s = source.replace('\\', "/");
    let clip = format!(
        r#"{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}"#
    );
    format!(
        r##"{{
        "clips": [{clip},{clip},{clip}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":1.0,"blur":false,"shadow":0.0,"roundnessFrac":0.02,"motionBlur":0.0}},
        "background": {{"kind":"gradient","angleDeg":135,"stops":["#2b3a67","#b8577f"]{motion}}},
        "zoomRegions": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null, null, null],
        "output": {{"width":{W},"height":{H},"fps":30}}
    }}"##
    )
}

fn render(gpu: &Gpu, source: &str, motion: &str, clip: usize) -> Vec<u8> {
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(gpu, W, H).expect("compositor");
    let scene = Scene::from_json(&scene_json(source, motion)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene.clone()));
    comp.clear_cursor();
    unsafe {
        let mut player = Player::open(source, "", gpu).expect("ouvrir la source");
        player.set_programme_clock(Some(&scene), clip);
        player.present_frame(&comp, &cfg, 3.0).expect("composer la frame");
        let t = player.programme_time().expect("horloge programme");
        assert!((t - PROGRAMME_TIMES[clip]).abs() < 0.05, "temps programme {t} pour le clip {clip}");
        comp.readback_resized(W, H).expect("readback")
    }
}

fn hash(rgba: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    rgba.hash(&mut h);
    h.finish()
}

#[test]
fn each_motion_is_a_distinct_pure_function_of_programme_time() {
    let Ok(source) = std::env::var("OPENSCREEN_PRIVACY_SECRET") else {
        println!("SKIP: definir OPENSCREEN_PRIVACY_SECRET (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_BACKGROUND_OUT").ok().map(std::path::PathBuf::from);
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).expect("creer le dossier de sortie");
    }
    let gpu = Gpu::create(false).expect("device d3d11");
    let shoot = |name: &str, motion: &str, clip: usize| {
        let rgba = render(&gpu, &source, motion, clip);
        if let Some(dir) = &out_dir {
            let file = format!("{name}-t{:02}.ppm", PROGRAMME_TIMES[clip] as u32);
            write_ppm(&dir.join(file), &rgba, W, H).expect("ecrire le ppm");
        }
        let h = hash(&rgba);
        println!("{name:<8} t={:>4}  {h:016x}", PROGRAMME_TIMES[clip]);
        h
    };

    // Immobile : clé absente, "none" et une valeur inconnue rendent la même image, à tout instant.
    let still = shoot("absent", "", 0);
    for clip in 0..3 {
        assert_eq!(shoot("none", r#","motion":"none""#, clip), still, "none au clip {clip}");
    }
    assert_eq!(shoot("unknown", r#","motion":"plasma""#, 2), still);

    for name in ["drift", "aurora", "waves"] {
        let motion = format!(r#","motion":"{name}""#);
        let hashes: Vec<u64> = (0..3).map(|clip| shoot(name, &motion, clip)).collect();
        for (k, h) in hashes.iter().enumerate() {
            assert_ne!(*h, still, "{name} a t={} rend le degrade immobile", PROGRAMME_TIMES[k]);
        }
        assert!(
            hashes[0] != hashes[1] && hashes[1] != hashes[2] && hashes[0] != hashes[2],
            "{name} : deux instants rendent la meme image ({hashes:x?})"
        );
        // Fonction pure : le même instant recomposé par un autre compositeur donne le même octet.
        assert_eq!(shoot(name, &motion, 1), hashes[1], "{name} n'est pas reproductible");
    }
}
