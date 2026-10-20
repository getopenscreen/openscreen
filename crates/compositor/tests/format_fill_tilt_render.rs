//! Le remplissage du format sous la caméra en orbite, rendu par le vrai compositeur D3D11.
//!
//! Un enregistrement 4:3 remplit une sortie 16:9 (`screenCover` + `screenFollow`), zoom ×2 en
//! orbite, pointeur garé en bas à droite : la caméra tourne à fond. La carte doit pencher ENTIÈRE,
//! ses quatre coins arrondis. De v2.0.0 à v2.1.0, le plan de l'enregistrement entier penchait
//! dans le rect droit du slot, qui le rognait : des coins coupés à plat, par une arête alignée sur
//! les axes, alors que la carte tenait dans la sortie.
//!
//! Frame NV12 synthétique et unie, fond noir, sans ombre : le métrage est clair, tout le reste
//! noir. Sans adaptateur matériel, le test se saute.

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::frame_geometry::{live_params_from_scene, plan_frame, FrameGeometryInput};
use openscreen_compositor::scene::Scene;

mod common;
use common::{gpu, Nv12Frame};

const SRC: (u32, u32) = (640, 480);
const OUT: (u32, u32) = (1280, 720);
/// En plein palier de la région (0..10 s), le cadreur posé.
const T: f32 = 3.0;

fn scene() -> Scene {
    Scene::from_json(
        r##"{"clips":[{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}],
            "layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                      "screenRect":{"x":0.1,"y":0.1,"width":0.8,"height":0.8},"screenCover":true,"screenFollow":true},
            "effects":{"padding":0.2,"blur":false,"shadow":0,"roundnessFrac":0.04,"motionBlur":0,"depthOfField":false},
            "background":{"kind":"color","color":"#000000"},
            "zoomRegions":[{"clipIndex":0,"startSec":0,"endSec":10,"scale":2.0,"focusX":0.5,"focusY":0.5,"focusMode":"auto","rotation":"orbit"}],
            "annotations":[],
            "cursor":{"show":true,"size":0.05,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"none"},
            "cropByClip":[null],
            "output":{"width":1280,"height":720,"fps":30}}"##,
    )
    .expect("scène valide")
}

/// Pointeur garé en (x, y), échantillonné à 60 Hz sur 10 s, écrit dans un sidecar temporaire.
fn parked(x: f32, y: f32) -> CursorTrack {
    let body: Vec<String> =
        (0..=600).map(|i| format!(r#"{{"timeMs":{},"cx":{x},"cy":{y}}}"#, (i as f32 * 1000.0 / 60.0).round())).collect();
    let path = std::env::temp_dir().join(format!("os_fill_tilt_{}.json", std::process::id()));
    std::fs::write(&path, format!(r#"{{"samples":[{}]}}"#, body.join(","))).expect("sidecar");
    let track = CursorTrack::load(path.to_str().unwrap(), 0.0, 10.0).expect("piste curseur");
    let _ = std::fs::remove_file(&path);
    track
}

fn cfg() -> Cfg {
    let mut cfg = Cfg::c8();
    cfg.bg_blur = 0.0;
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.cursor = true;
    cfg.mblur_n = 1;
    cfg.shadow = false;
    cfg
}

/// Hors de la sortie, rien n'est dessiné : noir, comme le fond.
fn luma(rgba: &[u8], x: f32, y: f32) -> f32 {
    let (x, y) = (x.round() as i32, y.round() as i32);
    if !(0..OUT.0 as i32).contains(&x) || !(0..OUT.1 as i32).contains(&y) {
        return 0.0;
    }
    let i = ((y * OUT.0 as i32 + x) * 4) as usize;
    0.2126 * rgba[i] as f32 + 0.7152 * rgba[i + 1] as f32 + 0.0722 * rgba[i + 2] as f32
}

/// Chaque coin de la carte inclinée est arrondi : sur la bissectrice, à 0,15 rayon du sommet
/// projeté, le fond (l'arrondi l'a retiré) ; à 1,3 rayon, le métrage. Un coin coupé par le rect
/// du slot laissait du noir là où la carte devait être, ou la poussait hors de la sortie.
#[test]
fn every_corner_of_a_filled_card_stays_rounded_under_the_orbit() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, OUT.0, OUT.1).expect("compositor");
    let screen = Nv12Frame::new(&gpu, SRC, |_, _| 220, |_, _| [128, 128]);
    let scene = scene();
    let track = parked(0.9, 0.9);

    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    comp.set_live_params(live);
    comp.set_has_webcam(false);
    comp.set_scene(Some(scene.clone()));
    comp.set_cursor(track.clone());
    comp.set_cursor_time(Some(T));
    comp.set_timeline_time(Some(T));
    let cfg = cfg();
    let (w, h, rgba) = unsafe {
        comp.compose_frame(screen.as_ptr(), screen.as_ptr(), 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback")
    };
    assert_eq!((w, h), OUT);
    if let Ok(dir) = std::env::var("OPENSCREEN_FILL_TILT_OUT") {
        image::RgbaImage::from_raw(w, h, rgba.clone()).unwrap().save(format!("{dir}/fill-orbit.png")).unwrap();
    }

    let render_px = [w as f32, h as f32];
    let src = [SRC.0 as f32, SRC.1 as f32];
    let g = plan_frame(&FrameGeometryInput {
        render_px,
        screen_tex_px: src,
        screen_visible_px: src,
        webcam_visible_px: src,
        u_max: 1.0,
        v_max: 1.0,
        frame: 0.0,
        cfg: &cfg,
        live,
        scene: Some(&scene),
        cursor: Some(&track),
        timeline_t_override: Some(T),
        programme_time: None,
    });
    let camera = g.camera.expect("la caméra réelle doit être posée");
    assert!(camera.orbit[0] > 0.8, "garde : la caméra doit tourner à fond, orbite {:?}", camera.orbit);
    let s_px = [g.s_dst[2] * render_px[0], g.s_dst[3] * render_px[1]];
    let quad = g.screen_tilt(s_px).expect("quad de la caméra");
    let center = [(g.s_dst[0] + g.s_dst[2] * 0.5) * render_px[0], (g.s_dst[1] + g.s_dst[3] * 0.5) * render_px[1]];
    let r = g.s_radius * quad.scale;
    assert!(r > 20.0, "garde : rayon {r} px, trop petit pour se mesurer");

    let corners = quad.corners.map(|(x, y)| [center[0] + x, center[1] + y]);
    let mid = [corners.iter().map(|c| c[0]).sum::<f32>() / 4.0, corners.iter().map(|c| c[1]).sum::<f32>() / 4.0];
    for (name, c) in ["haut-gauche", "haut-droit", "bas-droit", "bas-gauche"].iter().zip(corners) {
        let (dx, dy) = (mid[0] - c[0], mid[1] - c[1]);
        let n = dx.hypot(dy);
        let at = |k: f32| luma(&rgba, c[0] + dx / n * k * r, c[1] + dy / n * k * r);
        let (rounded, inside) = (at(0.15), at(1.3));
        println!("coin {name} ({:.0}, {:.0}) : arrondi {rounded:.0}, dedans {inside:.0}", c[0], c[1]);
        assert!(rounded < 40.0, "coin {name} : pas arrondi (luma {rounded:.0} au sommet)");
        assert!(inside > 150.0, "coin {name} : la carte est coupée (luma {inside:.0} à 1,3 rayon)");
    }
}
