//! Le curseur en volume (`cursor.volume`) : des flancs le long de la normale du plan et une
//! ombre de contact, sur écran droit comme incliné — sans toucher à sa face avant.
//!
//! Rend de vraies frames par le compositeur D3D11, avec le sprite `arrow` livré
//! (`public/cursors/default`) et une piste curseur synthétique immobile sur le pavé rouge de la
//! source de `privacy_blur_under_zoom.rs` (mêmes réglages ffmpeg).
//!
//! ```powershell
//! $env:OPENSCREEN_CURSOR_VOLUME_SOURCE = "...\secret.mp4"
//! $env:OPENSCREEN_CURSOR_VOLUME_OUT = "...\renders"   # facultatif : un PPM par cas
//! cargo test -p openscreen-compositor --test cursor_volume_render -- --nocapture
//! ```

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::cursor::CursorTrack;
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

fn scene_json(source: &str, arrow: &str, volume: f32, rotation: &str) -> String {
    let s = source.replace('\\', "/");
    let a = arrow.replace('\\', "/");
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#d8d8d8"}},
        "zoomRegions": [{{"id":"z","startSec":0,"endSec":6,"scale":1.5,"focusX":0.6,"focusY":0.6,"focusMode":"manual","rotation":{rotation}}}],
        "annotations": [],
        "speedRegions": [],
        "cursor": {{"show":true,"size":3,"smoothing":0,"motionBlur":0,"clickBounce":0,"volume":{volume},"clipToBounds":false,"theme":"default",
                    "cursorSprites": {{"arrow": {{"path":"{a}","hotspotX":0.119,"hotspotY":0.0874}}}}}},
        "cropByClip": [null],
        "output": {{"width":{W},"height":{H},"fps":null}}
    }}"##
    )
}

fn render(
    gpu: &Gpu,
    source: &str,
    track: &str,
    arrow: &str,
    volume: f32,
    rotation: &str,
) -> Vec<u8> {
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(gpu, W, H).expect("compositor");
    let scene =
        Scene::from_json(&scene_json(source, arrow, volume, rotation)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    comp.set_cursor(CursorTrack::load(track, 0.0, 6.0).expect("piste curseur"));
    unsafe {
        let mut player = Player::open(source, "", gpu).expect("ouvrir la source");
        player
            .present_frame(&comp, &cfg, AT_SEC)
            .expect("composer la frame");
        comp.readback_resized(W, H).expect("readback")
    }
}

fn luma(p: &[u8]) -> u32 {
    (p[0] as u32 * 2126 + p[1] as u32 * 7152 + p[2] as u32 * 722) / 10000
}

#[test]
fn the_cursor_volume_adds_sides_and_keeps_the_front_face() {
    let Ok(source) = std::env::var("OPENSCREEN_CURSOR_VOLUME_SOURCE") else {
        println!("SKIP: definir OPENSCREEN_CURSOR_VOLUME_SOURCE (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_CURSOR_VOLUME_OUT")
        .ok()
        .map(std::path::PathBuf::from);
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).expect("creer le dossier de sortie");
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let arrow = root.join("public/cursors/default/arrow.png");
    let arrow = arrow.to_str().expect("chemin utf-8");
    // Piste immobile au coin haut-gauche du pavé rouge : les flancs sombres s'y lisent.
    let track = std::env::temp_dir().join("openscreen-cursor-volume-track.json");
    std::fs::write(
        &track,
        r#"{"samples":[{"timeMs":0,"cx":0.58,"cy":0.58},{"timeMs":6000,"cx":0.58,"cy":0.58}]}"#,
    )
    .expect("ecrire la piste");
    let track = track.to_str().expect("chemin utf-8");
    let gpu = Gpu::create(false).expect("device d3d11");

    for (name, rotation) in [("flat", "null"), ("iso", r#""iso""#), ("left", r#""left""#)] {
        let flat = render(&gpu, &source, track, arrow, 0.0, rotation);
        let deep = render(&gpu, &source, track, arrow, 1.0, rotation);
        if let Some(dir) = &out_dir {
            write_ppm(&dir.join(format!("{name}-volume0.ppm")), &flat, W, H).expect("ppm");
            write_ppm(&dir.join(format!("{name}-volume1.ppm")), &deep, W, H).expect("ppm");
        }
        let changed = flat
            .chunks_exact(4)
            .zip(deep.chunks_exact(4))
            .filter(|(a, b)| a != b)
            .count();
        // Écart franc (> 30 en luma, dans un sens ou l'autre) : les flancs gris du liseré blanc
        // ressortent PLUS clairs que le rouge, l'ombre plus sombre.
        let marked = flat
            .chunks_exact(4)
            .zip(deep.chunks_exact(4))
            .filter(|(a, b)| luma(a).abs_diff(luma(b)) > 30)
            .count();
        // Face avant : les pixels blancs du sprite à volume 0 restent blancs. Le passage du mode 7
        // au mode 13 (quad identité) ne doit rien déplacer, et les flancs passent DERRIÈRE.
        let (mut white, mut kept) = (0usize, 0usize);
        for (a, b) in flat.chunks_exact(4).zip(deep.chunks_exact(4)) {
            if a[0] > 235 && a[1] > 235 && a[2] > 235 {
                white += 1;
                kept += usize::from(b[0] > 225 && b[1] > 225 && b[2] > 225);
            }
        }
        println!(
            "{name:<5} pixels changes {changed:>6}  marques {marked:>5}  face avant {kept}/{white}"
        );
        assert!(
            white > 200,
            "{name}: le sprite n'est pas visible ({white} px blancs)"
        );
        assert!(
            marked > 150,
            "{name}: le volume ne se voit pas ({changed} changes, {marked} marques)"
        );
        assert!(
            kept * 100 >= white * 97,
            "{name}: la face avant a bougé ({kept}/{white})"
        );
    }
}
