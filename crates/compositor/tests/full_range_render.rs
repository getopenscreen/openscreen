//! #1531 : une vidéo en plage pleine passe par le vrai shader D3D11 (`sample_yuv`) sans dériver.
//!
//! Frame NV12 synthétique et unie, étiquetée pleine : (128, 128, 128) doit sortir gris neutre
//! à 128. Une chroma ramenée en limitée hors du centre (128 → 128,44) teintait ce gris.
//! Sans adaptateur matériel, le test se saute.

// Windows seulement : le chemin D3D11 de ce harnais n'existe que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::scene::Scene;

mod common;
use common::{gpu, Nv12Frame};

const OUT: (u32, u32) = (320, 180);

#[test]
fn full_range_grey_stays_neutral_grey() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, OUT.0, OUT.1).expect("compositor");
    let screen = Nv12Frame::new(&gpu, (64, 64), |_, _| 128, |_, _| [128, 128]).full_range();
    let scene = Scene::from_json(
        r##"{"clips":[{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}],
            "layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},
            "effects":{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0},
            "background":{"kind":"color","color":"#000000"},
            "zoomRegions":[],"annotations":[],
            "cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"none"},
            "cropByClip":[null],
            "output":{"width":320,"height":180,"fps":30}}"##,
    )
    .expect("scène valide");
    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    comp.set_live_params(live);
    comp.set_has_webcam(false);
    comp.set_scene(Some(scene));
    comp.clear_cursor();
    let mut cfg = Cfg::c8();
    cfg.bg_blur = 0.0;
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.cursor = false;
    cfg.mblur_n = 1;
    cfg.shadow = false;
    let (w, _, rgba) = unsafe {
        comp.compose_frame(screen.as_ptr(), screen.as_ptr(), 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback")
    };
    let i = (((OUT.1 / 2) * w + OUT.0 / 2) * 4) as usize;
    let [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
    println!("centre : ({r}, {g}, {b})");
    assert!(r == g && g == b, "gris teinté : ({r}, {g}, {b})");
    assert!(r.abs_diff(128) <= 1, "gris {r} au lieu de 128");
}
