//! Une frame rendue seule (`timeline_walk::render_frames`, ce que getFrames montre sans export)
//! est celle de l'export, au pixel près. La marche est la même ; seules les frames sautées
//! diffèrent, et `catch_up` rattrape les décodeurs sans changer la frame source montrée. Comparé
//! ici à la marche complète, où toutes les frames sont demandées et aucune n'est sautée.
//!
//! La scène met deux coupes du même fichier, une région 2× dans la seconde, un effet shader qui
//! lit le temps programme, et le curseur de la prise s'il a sa piste à côté.
//!
//! La sortie est à 24 i/s : sur une source à 30 i/s, ses instants tombent entre deux frames
//! source, là où un rattrapage qui viserait la cible au lieu de la précéder montrerait la frame
//! suivante. Encore faut-il que deux frames voisines diffèrent : une prise d'écran immobile ne
//! prouve rien, d'où une mire dont chaque frame change.
//!
//! La CI ne le joue pas : il faut un device (lavapipe convient) et la vidéo, d'au moins 20 s.
//!
//! ```powershell
//! ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -t 25 -c:v libopenh264 -g 60 counter30.mp4
//! $env:OPENSCREEN_RENDER_SOURCE = "...\counter30.mp4"
//! cargo test -p openscreen-compositor --test render_frames_match_export -- --nocapture
//! ```

use openscreen_compositor::compositor::{live_params_from_scene, Compositor};
use openscreen_compositor::config;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::ClipSource;
use openscreen_compositor::scene::Scene;
use openscreen_compositor::timeline_walk::{render_frames, RenderedFrame};

const FPS: i32 = 24;
const CLIPS: [(f64, f64); 2] = [(1.0, 4.0), (6.0, 20.0)];

fn scene_json(source: &str) -> String {
    let clips: Vec<String> = CLIPS
        .iter()
        .map(|(start, end)| {
            format!(
                r#"{{"screenPath":"{source}","webcamPath":"","sourceStartSec":{start},"sourceEndSec":{end},"webcamOffsetSec":0,"hasAudio":false}}"#
            )
        })
        .collect();
    format!(
        r##"{{
        "clips": [{clips}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [],
        "speedRegions": [{{"clipIndex":1,"startSec":8,"endSec":10,"speed":2}}],
        "cursor": {{"show":true,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null, null],
        "output": {{"width":640,"height":360,"fps":null}},
        "shaderEffects": [{{
            "clipIndex": 1, "startSec": 6.0, "endSec": 20.0, "target": "image", "contract": 1,
            "code": "fn effect(uv: vec2<f32>) -> vec4<f32> {{ let c = frame(uv); return vec4<f32>(c.rgb * (0.6 + 0.4 * sin(ctx.time * 3.0)), 1.0); }}",
            "params": [], "values": {{}}
        }}]
        }}"##,
        clips = clips.join(",")
    )
}

#[test]
fn a_frame_rendered_alone_is_the_frame_of_the_full_walk() {
    let Some(source) = std::env::var_os("OPENSCREEN_RENDER_SOURCE") else {
        eprintln!("OPENSCREEN_RENDER_SOURCE absent — test sauté");
        return;
    };
    let source = source.to_string_lossy().replace('\\', "/");
    let gpu = Gpu::create_auto(false).expect("device");
    let clips: Vec<ClipSource> = CLIPS
        .iter()
        .map(|&(start, end)| ClipSource {
            screen: source.clone(),
            webcam: String::new(),
            source_start_sec: start,
            source_end_sec: end,
            webcam_offset_sec: 0.0,
            has_audio: false,
        })
        .collect();
    // La config de l'export (`export_cfg_and_scene` dans l'addon).
    let mut cfg = config::all().pop().expect("C8");
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.mblur_n = 1;
    cfg.bg_blur = 0.0;
    cfg.cursor = true;
    let render = |wanted: &[u64]| -> Vec<RenderedFrame> {
        let scene = Scene::from_json(&scene_json(&source)).expect("scène");
        let comp = Compositor::new_sized(&gpu, 640, 360).expect("compositeur");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_scene(Some(scene));
        unsafe { render_frames(&clips, &gpu, &comp, &cfg, FPS, wanted) }.expect("render_frames")
    };

    let all: Vec<u64> = (0..2_000).collect();
    let dense = render(&all);
    let total = dense.len() as u64;
    eprintln!("marche complète : {total} frames");
    // 3 s, puis 2 s + 1 s (2×) + 10 s : 16 s de sortie.
    assert_eq!(total, 16 * FPS as u64, "la marche complète ne couvre pas la timeline");
    assert!(dense.iter().enumerate().all(|(i, f)| f.index == i as u64));

    // Des sauts de plus de `CATCH_UP_DECODE_SEC`, dans les deux clips, dont un dans la région 2×.
    let sparse_at = [2, 70, 130, 140, 260, total - 1, total + 50];
    let sparse = render(&sparse_at);
    assert_eq!(
        sparse.iter().map(|f| f.index).collect::<Vec<_>>(),
        &sparse_at[..6],
        "une frame demandée manque, ou une au-delà de la timeline a été rendue"
    );
    for frame in &sparse {
        let reference = &dense[frame.index as usize];
        let differing = frame.rgba.iter().zip(&reference.rgba).filter(|(a, b)| a != b).count();
        assert_eq!(differing, 0, "frame {} : {differing} octets diffèrent de la marche complète", frame.index);
    }
}
