//! Le flou de mouvement de l'écran CADRÉ incliné (mode 18, `FrameGeometry::screen_trail`) rendu
//! par le vrai compositeur D3D11, sur une source NV12 synthétique : rien à décoder, donc le test
//! tourne sur toute machine qui a un GPU. Sans adaptateur matériel, il se saute (« test saute »).
//!
//! ```powershell
//! cargo test -p openscreen-compositor --test screen_trail_render -- --nocapture
//! $env:OPENSCREEN_TRAIL_OUT = "...\renders"    # facultatif : les rendus comparés, en PNG
//! ```

#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::scene::Scene;

mod common;
use common::{gpu, Nv12Frame};

const W: u32 = 1280;
const H: u32 = 720;
const SRC: (u32, u32) = (640, 360);
/// Les rampes du zoom de `scene_json` (2 à 6 s) : l'entrée finit à 2 s, la sortie part de 6 s.
const RAMPS: [f32; 8] = [1.3, 1.5, 1.7, 1.9, 6.1, 6.3, 6.5, 6.7];

/// Une frame NV12 synthétique : `yuv(colonne, rangée)` donne Y, Cb, Cr (BT.709 limité), la
/// chroma étant prise au coin haut-gauche de chaque bloc 2×2.
fn source(gpu: &Gpu, yuv: impl Fn(u32, u32) -> [u8; 3]) -> Nv12Frame {
    Nv12Frame::new(
        gpu,
        SRC,
        |col, row| yuv(col, row)[0],
        |bx, by| {
            let [_, u, v] = yuv(2 * bx, 2 * by);
            [u, v]
        },
    )
}

/// Un seul écran dans `rect` (fractions de la sortie `out`), zoomé ×`scale` sous `iso` de 2 à 6 s.
/// Fond uni, sans ombre ni padding : hors de l'écran et de sa traînée, le pixel est le fond.
fn scene_json(rect: [f32; 4], out: (u32, u32), scale: f32, roundness: f32, blur: f32, dof: bool) -> String {
    let [x, y, w, h] = rect;
    let (ow, oh) = out;
    format!(
        r##"{{"clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                       "screenRect":{{"x":{x},"y":{y},"width":{w},"height":{h}}}}},
            "effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":{roundness},"motionBlur":{blur},"depthOfField":{dof}}},
            "background":{{"kind":"color","color":"#6070a0"}},
            "zoomRegions":[{{"clipIndex":0,"startSec":2,"endSec":6,"scale":{scale},"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":"iso"}}],
            "annotations":[],
            "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
            "cropByClip":[null],
            "output":{{"width":{ow},"height":{oh},"fps":30}}}}"##
    )
}

fn render(comp: &Compositor, src: &Nv12Frame, json: &str, t: f32) -> Vec<u8> {
    let scene = Scene::from_json(json).expect("scène valide");
    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    comp.set_live_params(live);
    comp.set_has_webcam(false);
    comp.set_scene(Some(scene));
    comp.clear_cursor();
    comp.set_timeline_time(Some(t));
    let mut cfg = Cfg::c8();
    cfg.bg_blur = 0.0;
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.cursor = false;
    cfg.mblur_n = 1;
    cfg.shadow = false;
    unsafe {
        comp.compose_frame(src.as_ptr(), src.as_ptr(), 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback").2
    }
}

fn save(name: &str, rgba: &[u8], (w, h): (u32, u32)) {
    let Ok(dir) = std::env::var("OPENSCREEN_TRAIL_OUT") else { return };
    std::fs::create_dir_all(&dir).expect("dossier de sortie");
    image::RgbaImage::from_raw(w, h, rgba.to_vec())
        .expect("dimensions du readback")
        .save(format!("{dir}/{name}.png"))
        .unwrap_or_else(|e| panic!("écriture {name} : {e}"));
}

/// Un tap du mode 18 dont le warp inverse n'a PAS de solution (au-delà du pli du warp bilinéaire
/// d'`iso`) est écarté. Il valait l'origine du plan, que le warp direct renvoyait sur le coin
/// haut-gauche de l'écran courant : loin de l'écran, le fond prenait la couleur de ce coin, et
/// un repère masqué par l'arrondi y reparaissait. Petit écran centré (15 % de la sortie), zoom
/// ×1,6 : le coin bas-gauche de la sortie tombe au-delà du pli pendant les rampes. Là, et partout
/// loin de l'écran, le rendu flouté doit rester le fond, au bit près.
#[test]
fn unsolvable_trail_taps_leave_the_background_alone() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    // Métrage rouge, repère vert dans son coin haut-gauche (sous l'arrondi de l'écran).
    let src = source(&gpu, |col, row| if col < 48 && row < 48 { [173, 42, 26] } else { [63, 102, 240] });
    let json = |blur| scene_json([0.425, 0.425, 0.15, 0.15], (W, H), 1.6, 0.02, blur, false);
    let far = |x: u32, y: u32| x < W / 4 || x >= W * 3 / 4 || y < H / 4 || y >= H * 3 / 4;
    let mut leaks = 0;
    for t in RAMPS {
        let sharp = render(&comp, &src, &json(0.0), t);
        let blurred = render(&comp, &src, &json(1.0), t);
        let n = (0..W * H)
            .filter(|&i| far(i % W, i / W))
            .filter(|&i| sharp[i as usize * 4..][..3] != blurred[i as usize * 4..][..3])
            .count();
        println!("t={t} : {n} px du fond changent avec le flou");
        if n > 0 {
            save(&format!("leak-{t}-sharp"), &sharp, (W, H));
            save(&format!("leak-{t}-blurred"), &blurred, (W, H));
        }
        leaks += n;
    }
    assert_eq!(leaks, 0, "le flou de mouvement a peint loin de l'écran");
}

/// Hors de la sortie, le mode 18 relit le métrage lui-même : il doit le relire comme le mode 8
/// l'a dessiné, profondeur de champ comprise. Même écran physique, zoomé ×2 sous `iso`, sur la
/// sortie et au centre d'une sortie deux fois plus grande, où rien ne sort du cadre : aux bords
/// de la sortie, les deux rendus coïncident. Le repli lisait le métrage NET : sur ces rayures de
/// 2 px, des pixels du bord s'écartaient de la référence, grise de profondeur de champ, jusqu'à
/// 89 niveaux (écart moyen 3,6). Seul écart admis, épars : la référence relit un rendu déjà
/// échantillonné au pixel, le repli le métrage lui-même.
#[test]
fn off_canvas_trail_taps_keep_the_depth_of_field() {
    let Some(gpu) = gpu() else { return };
    // Rayures noires et blanches de 2 px : la profondeur de champ les grise.
    let src = source(&gpu, |col, _| [if col / 2 % 2 == 0 { 16 } else { 235 }, 128, 128]);
    let normal = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let padded = Compositor::new_sized(&gpu, 2 * W, 2 * H).expect("compositor");
    // La même boîte en px, centrée sur une sortie deux fois plus grande (le rayon se mesure sur
    // la boîte, il ne change pas).
    let json = |k: f32, dof| {
        let r = [0.5 - 0.4 / k, 0.5 - 0.4 / k, 0.8 / k, 0.8 / k];
        let out = ((W as f32 * k) as u32, (H as f32 * k) as u32);
        scene_json(r, out, 2.0, 0.02, 1.0, dof)
    };
    // Les bords gauche et droit de la sortie, à mi-hauteur : le plan zoomé y déborde, et les taps
    // de la rampe d'entrée tombent hors de la sortie.
    let edges: Vec<(u32, u32)> = (H / 4..H * 3 / 4)
        .flat_map(|y| (0..24).chain(W - 24..W).map(move |x| (x, y)))
        .collect();
    let at = |rgba: &[u8], w: u32, (x, y): (u32, u32)| rgba[((y * w + x) * 4) as usize];
    // Le cœur de la rampe d'entrée : assez de mouvement pour que les taps sortent du cadre.
    for t in [1.5, 1.7] {
        let a = render(&normal, &src, &json(1.0, true), t);
        let b = render(&padded, &src, &json(2.0, true), t);
        let net = render(&normal, &src, &json(1.0, false), t);
        let crop = |(x, y): (u32, u32)| (x + W / 2, y + H / 2);
        let diffs: Vec<u8> = edges.iter().map(|&p| at(&a, W, p).abs_diff(at(&b, 2 * W, crop(p)))).collect();
        let mean = diffs.iter().map(|&d| d as f32).sum::<f32>() / diffs.len() as f32;
        let max = diffs.iter().copied().max().unwrap_or(0);
        // Garde : la profondeur de champ change bien ces pixels, sinon il n'y a rien à comparer.
        let dof = edges.iter().map(|&p| at(&a, W, p).abs_diff(at(&net, W, p))).max().unwrap_or(0);
        // Et la pyramide est bien liée : elle grise les rayures sans les assombrir (non liée, le
        // shader y lirait du noir, sur les deux sorties à la fois).
        let level = |rgba: &[u8]| edges.iter().map(|&p| at(rgba, W, p) as f32).sum::<f32>() / edges.len() as f32;
        let (lit, flat) = (level(&a), level(&net));
        println!("t={t} : bord de la sortie, écart moyen {mean:.2}, max {max} (profondeur de champ : {dof}, niveau {lit:.1} / {flat:.1})");
        save(&format!("dof-{t}-normal"), &a, (W, H));
        save(&format!("dof-{t}-padded"), &b, (2 * W, 2 * H));
        assert!(dof > 60, "t={t} : la profondeur de champ n'agit pas au bord, le test ne prouve rien");
        assert!((lit - flat).abs() < 4.0, "t={t} : la profondeur de champ assombrit le bord ({lit:.1} / {flat:.1})");
        assert!(mean < 1.0 && max <= 16, "t={t} : le bord perd la profondeur de champ ({mean:.2}, {max})");
    }
}
