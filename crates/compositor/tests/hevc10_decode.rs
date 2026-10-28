//! Une vidéo HEVC Main 10 (iPhone, #1390) se rend avec ses couleurs, pas en bandes.
//!
//! VideoToolbox sort un `CVPixelBuffer` P010 (16 bits par échantillon) pour un flux 10 bits.
//! Lu comme du NV12 8 bits, chaque échantillon devient deux texels : l'image se couvre de
//! bandes jaunes et vertes. La mire est coupée en deux, rouge à gauche, bleu à droite ;
//! chaque moitié doit garder sa couleur.
//!
//! La CI ne le joue pas : il faut le GPU et un encodeur HEVC 10 bits.
//!
//! ```sh
//! ffmpeg -f lavfi -i "color=c=red:size=640x360:rate=30:duration=1,drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill" \
//!   -vf format=p010le -c:v hevc_videotoolbox -profile:v main10 -tag:v hvc1 split10.mov
//! OPENSCREEN_HEVC10_SOURCE=$PWD/split10.mov cargo test -p openscreen-compositor --test hevc10_decode
//! ```
#![cfg(target_os = "macos")]

use openscreen_compositor::compositor::{live_params_from_scene, Compositor};
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::ClipSource;
use openscreen_compositor::scene::Scene;
use openscreen_compositor::timeline_walk::{render_frames, RenderedFrame};

fn scene_json(source: &str) -> String {
    let source = serde_json::to_string(source).expect("chemin JSON");
    format!(
        r##"{{
        "clips": [{{"screenPath":{source},"webcamPath":"","sourceStartSec":0,"sourceEndSec":1,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":640,"height":360,"fps":null}}
        }}"##
    )
}

/// La frame 10 de `source`, rendue seule sur un fond uni, sans effet.
fn render_frame_10(source: &str) -> RenderedFrame {
    let source = source.replace('\\', "/");
    let gpu = Gpu::create_auto(false).expect("device");
    let clips = [ClipSource {
        screen: source.clone(),
        webcam: String::new(),
        source_start_sec: 0.0,
        source_end_sec: 1.0,
        webcam_offset_sec: 0.0,
        has_audio: false,
    }];
    let mut cfg = config::all().pop().expect("C8");
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.mblur_n = 1;
    cfg.bg_blur = 0.0;
    cfg.cursor = false;
    let scene = Scene::from_json(&scene_json(&source)).expect("scène");
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositeur");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    let mut frames =
        unsafe { render_frames(&clips, &gpu, &comp, &cfg, 30, &[10]) }.expect("render_frames");
    frames.swap_remove(0)
}

/// Chaque moitié de la mire garde `left` / `right`, à `tol` près par canal.
fn assert_halves(frame: &RenderedFrame, left: [u8; 3], right: [u8; 3], tol: u8) {
    let px = |x: u32, y: u32| {
        let i = ((y * frame.width + x) * 4) as usize;
        [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]]
    };
    let (w, h) = (frame.width, frame.height);
    for (x, want) in [(w / 4, left), (3 * w / 4, right)] {
        for y in [h / 4, h / 2, 3 * h / 4] {
            let got = px(x, y);
            let close = got.iter().zip(want).all(|(&g, w)| g.abs_diff(w) <= tol);
            assert!(close, "({x},{y}) : {got:?}, attendu ≈ {want:?}");
        }
    }
}

#[test]
fn a_10_bit_hevc_frame_keeps_its_colours() {
    let Some(source) = std::env::var_os("OPENSCREEN_HEVC10_SOURCE") else {
        eprintln!("OPENSCREEN_HEVC10_SOURCE absent — test sauté");
        return;
    };
    let frame = render_frame_10(&source.to_string_lossy());
    assert_halves(&frame, [255, 0, 0], [0, 0, 255], 40);
}

/// Une frame pleine plage (`420f`, `xf20`) n'est pas relue comme limitée : sans le
/// correctif, le gris sombre tombe à ~19 et le gris clair monte à ~242.
///
/// ```sh
/// ffmpeg -f lavfi -i "color=c=0x202020:size=640x360:rate=30:duration=1,drawbox=x=320:y=0:w=320:h=360:color=0xe0e0e0:t=fill" ///   -vf scale=out_range=full,format=p010le -color_range pc -c:v hevc_videotoolbox -profile:v main10 -tag:v hvc1 grey10full.mov
/// OPENSCREEN_FULL_RANGE_SOURCE=$PWD/grey10full.mov cargo test -p openscreen-compositor --test hevc10_decode
/// ```
#[test]
fn a_full_range_frame_keeps_its_levels() {
    let Some(source) = std::env::var_os("OPENSCREEN_FULL_RANGE_SOURCE") else {
        eprintln!("OPENSCREEN_FULL_RANGE_SOURCE absent — test sauté");
        return;
    };
    let frame = render_frame_10(&source.to_string_lossy());
    assert_halves(&frame, [0x20; 3], [0xe0; 3], 6);
}
