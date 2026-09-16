//! Un masque de confidentialité (annotation « flou », style mosaïque) doit couvrir le même
//! contenu à l'écran pendant un zoom, droit ou incliné en 3D, qu'au repos.
//!
//! Le masque était ancré sur la boîte écran SANS zoom (`s_ann`) alors que la vidéo grossit dans
//! la boîte zoomée (`s_dst`) et, sous un préset 3D, passe par le warp du mode 8 : ce qu'il
//! cachait sortait de dessous, dans la preview comme dans l'export.
//!
//! Rend de vraies frames par le compositeur D3D11. Piloté par l'environnement, comme
//! `output_geometry_golden.rs` : il faut une source dont un pavé rouge occupe les fractions
//! 0.55..0.70 sur les deux axes, sur fond gris.
//!
//! ```powershell
//! ffmpeg -f lavfi -i "color=c=0x303030:s=1920x1080:r=30:d=6,drawbox=x=1056:y=594:w=288:h=162:color=red:t=fill" -c:v h264_mf -b:v 4M -pix_fmt nv12 secret.mp4
//! $env:OPENSCREEN_PRIVACY_SECRET = "...\secret.mp4"
//! cargo test -p openscreen-compositor --test privacy_blur_under_zoom -- --nocapture
//! ```
//!
//! `OPENSCREEN_PRIVACY_OUT` (facultatif) reçoit un PPM par cas, pour l'inspection à l'œil.

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

/// Pixels encore franchement rouges. La mosaïque teintée en blanc mêle la couleur à moitié avec
/// le blanc, donc un rouge couvert ressort rose (vert et bleu vers 127) et ne compte plus.
fn red_pixels(rgba: &[u8]) -> usize {
    rgba.chunks_exact(4).filter(|p| p[0] > 150 && p[1] < 80 && p[2] < 80).count()
}

fn write_ppm(path: &std::path::Path, rgba: &[u8], w: u32, h: u32) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out)
}

/// `zoom` : `None` = pas de région, sinon (échelle, focus x, focus y, rotation JSON).
fn scene_json(secret: &str, masked: bool, zoom: Option<(f32, f32, f32, &str)>) -> String {
    let s = secret.replace('\\', "/");
    let zoom_regions = match zoom {
        None => String::new(),
        Some((scale, fx, fy, rotation)) => format!(
            r#"{{"id":"z","startSec":0,"endSec":6,"scale":{scale},"focusX":{fx},"focusY":{fy},"focusMode":"manual","rotation":{rotation}}}"#
        ),
    };
    let annotations = if masked {
        r#"{"id":"secret","startSec":0,"endSec":6,"kind":"blur","x":0.55,"y":0.55,"w":0.15,"h":0.15,"zIndex":0,
            "blur":{"style":"mosaic","shape":"rectangle","color":"white","intensity":12,"blockSize":12}}"#
    } else {
        ""
    };
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0,"motionBlur":0.0}},
        "background": {{"kind":"color","color":"#303030"}},
        "zoomRegions": [{zoom_regions}],
        "annotations": [{annotations}],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":{W},"height":{H},"fps":null}}
    }}"##
    )
}

fn render(gpu: &Gpu, secret: &str, masked: bool, zoom: Option<(f32, f32, f32, &str)>) -> Vec<u8> {
    let mut cfg = config::all().pop().expect("au moins une config");
    // Plannings de la fixture coupés : seul le contrat de scène pilote le zoom.
    cfg.zoom = false;
    cfg.layout_anim = false;
    let comp = Compositor::new_sized(gpu, W, H).expect("compositor");
    let scene = Scene::from_json(&scene_json(secret, masked, zoom)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    comp.clear_cursor();
    unsafe {
        let mut player = Player::open(secret, "", gpu).expect("ouvrir la source");
        player.present_frame(&comp, &cfg, AT_SEC).expect("composer la frame");
        comp.readback_resized(W, H).expect("readback")
    }
}

#[test]
fn a_privacy_mask_keeps_covering_its_content_under_zoom_and_tilt() {
    let Ok(secret) = std::env::var("OPENSCREEN_PRIVACY_SECRET") else {
        println!("SKIP: definir OPENSCREEN_PRIVACY_SECRET (voir l'en-tete du fichier).");
        return;
    };
    let out_dir = std::env::var("OPENSCREEN_PRIVACY_OUT").ok().map(std::path::PathBuf::from);
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).expect("creer le dossier de sortie");
    }
    let gpu = Gpu::create(false).expect("device d3d11");

    let cases: [(&str, Option<(f32, f32, f32, &str)>); 5] = [
        ("repos", None),
        ("zoom-centre", Some((2.0, 0.5, 0.5, "null"))),
        ("zoom-coin", Some((2.0, 0.75, 0.75, "null"))),
        ("zoom-iso", Some((2.0, 0.5, 0.5, r#""iso""#))),
        ("zoom-left", Some((2.0, 0.6, 0.6, r#""left""#))),
    ];

    let mut leaks = Vec::new();
    for (name, zoom) in cases {
        let clear = red_pixels(&render(&gpu, &secret, false, zoom));
        let rgba = render(&gpu, &secret, true, zoom);
        let exposed = red_pixels(&rgba);
        if let Some(dir) = &out_dir {
            write_ppm(&dir.join(format!("{name}.ppm")), &rgba, W, H).expect("ecrire le ppm");
        }
        println!("{name:<12} rouge sans masque {clear:>6}  rouge avec masque {exposed:>6}");
        // Garde : sans masque, le secret doit être bien visible, sinon le cas ne prouve rien.
        assert!(clear > 2_000, "{name}: le pave rouge n'est pas visible ({clear} px)");
        // Quelques pixels de bord tolérés : le sous-échantillonnage 4:2:0 étale la chrominance
        // d'un demi-pixel source au-delà du pavé.
        if exposed > clear / 200 {
            leaks.push(format!("{name}: {exposed} px rouges visibles sur {clear}"));
        }
    }
    assert!(leaks.is_empty(), "le masque laisse voir le secret :\n{}", leaks.join("\n"));
}
