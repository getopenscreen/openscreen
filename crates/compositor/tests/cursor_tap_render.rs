//! Le contact du curseur modélisé et l'impact du clic (mode 16), rendus par le vrai compositeur
//! D3D11 sur une frame NV12 SYNTHÉTIQUE : une maquette d'interface dont les cibles portent une
//! pastille rouge au pixel exact du clic. Sans adaptateur matériel, les tests se sautent
//! (« test saute »).
//!
//! - au contact, la pointe couvre la pastille, même sous un fort lissage (la piste lissée traîne
//!   loin derrière la souris), à plat, sous un angle fixe et sous la caméra réelle ;
//! - l'anneau de l'impact est centré sur la pastille.
//!
//! Et, en opt-in, une vidéo de 4 s à 30 i/s (la flèche puis la main qui cliquent, à plat et en
//! `iso`, côte à côte) et une planche des images autour du contact :
//!
//! ```powershell
//! $env:OPENSCREEN_CURSOR_TAP_OUT = "...\cursor-tap"
//! cargo test -p openscreen-compositor --test cursor_tap_render -- --nocapture
//! ```

#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::ffi::AVFrame;
use openscreen_compositor::frame_geometry::{
    live_params_from_scene, plan_cursor, plan_frame, CursorPlacement, CursorPlanInput,
    FrameGeometryInput,
};
use openscreen_compositor::scene::Scene;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_WRITE_DISCARD, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DYNAMIC,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

const SRC: (u32, u32) = (1280, 720);
const OUT: (u32, u32) = (1280, 720);
/// Les deux cibles (repère normalisé de l'écran) et l'instant de leur clic : la flèche clique la
/// première, la main (état `pointer`) la seconde. Chacune tombe au centre d'un bloc de chroma
/// NV12 (texels impairs) : la pastille est alors symétrique autour d'elle, chroma comprise.
const TARGETS: [([f32; 2], f32); 2] =
    [([385.0 / 1280.0, 259.0 / 720.0], 1.0), ([897.0 / 1280.0, 447.0 / 720.0], 2.4)];
/// Au creux du contact (`regions::tap`).
const CONTACT_S: f32 = 0.0495;

fn gpu() -> Option<Gpu> {
    match Gpu::create(false) {
        Ok(g) => Some(g),
        Err(e) => {
            eprintln!("pas de device D3D11 matériel ({e:#}) — test saute");
            None
        }
    }
}

/// Une maquette d'interface en NV12 (barre de titre, carte, lignes de texte, deux boutons), avec
/// une pastille rouge de 5 texels de rayon au centre exact de chaque cible. Présentée comme une
/// frame D3D11VA (cf. `cursor_model_render.rs`). La luma est évaluée au centre de chaque texel, la
/// chroma au centre de chaque bloc 2×2.
struct MockFrame {
    frame: Box<AVFrame>,
    _tex: ID3D11Texture2D,
}

impl MockFrame {
    fn new(gpu: &Gpu) -> MockFrame {
        let (w, h) = SRC;
        // (Y, Cb, Cr) de chaque pixel, en BT.709 limité.
        let pixel = |fx: f32, fy: f32| -> (u8, u8, u8) {
            let (x, y) = (fx as u32, fy as u32);
            for ([tx, ty], _) in TARGETS {
                let (cx, cy) = (tx * w as f32, ty * h as f32);
                if (fx - cx).hypot(fy - cy) <= 5.0 {
                    return (63, 102, 240); // rouge
                }
            }
            let button = |c: [f32; 2], hw: f32, hh: f32| {
                let (dx, dy) = ((fx - c[0] * w as f32).abs(), (fy - c[1] * h as f32).abs());
                (dx - hw + 10.0).max(0.0).hypot((dy - hh + 10.0).max(0.0)) <= 10.0
            };
            if button(TARGETS[0].0, 130.0, 70.0) {
                return (92, 180, 110); // bouton bleu
            }
            if button(TARGETS[1].0, 90.0, 26.0) {
                return (150, 100, 90); // bouton vert
            }
            if y < 56 {
                return (48, 132, 126); // barre de titre sombre
            }
            if x < 220 {
                let item = (y - 56) % 44;
                return if (14..22).contains(&item) && (24..150).contains(&x) { (150, 128, 128) } else { (222, 129, 127) };
            }
            let card = x > 250 && x < 1240 && y > 90 && y < 690;
            if card && (x == 251 || x == 1239 || y == 91 || y == 689) {
                return (200, 128, 128);
            }
            // Lignes de « texte » dans la carte, à l'écart des boutons.
            let line = (y % 36) >= 14 && (y % 36) < 20 && x > 280 && x < 1200 && (x / 97) % 5 != 4;
            if card && line {
                return (135, 128, 128);
            }
            (if card { 245 } else { 232 }, 128, 128)
        };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DYNAMIC,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
            MiscFlags: 0,
        };
        unsafe {
            let mut tex: Option<ID3D11Texture2D> = None;
            gpu.device.CreateTexture2D(&desc, None, Some(&mut tex)).expect("texture NV12");
            let tex = tex.expect("texture NV12");
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context.Map(&tex, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut m)).expect("Map");
            let pitch = m.RowPitch as usize;
            let dst = m.pData as *mut u8;
            for y in 0..h {
                for x in 0..w {
                    *dst.add(y as usize * pitch + x as usize) = pixel(x as f32 + 0.5, y as f32 + 0.5).0;
                }
            }
            for y in 0..h / 2 {
                for x in 0..w / 2 {
                    let (_, cb, cr) = pixel(2.0 * x as f32 + 1.0, 2.0 * y as f32 + 1.0);
                    let uv = (h as usize + y as usize) * pitch + 2 * x as usize;
                    *dst.add(uv) = cb;
                    *dst.add(uv + 1) = cr;
                }
            }
            gpu.context.Unmap(&tex, 0);
            let mut frame: Box<AVFrame> = Box::new(std::mem::zeroed());
            frame.data[0] = tex.as_raw() as *mut u8;
            frame.data[1] = std::ptr::null_mut();
            frame.width = w as i32;
            frame.height = h as i32;
            MockFrame { frame, _tex: tex }
        }
    }

    fn as_ptr(&self) -> *const AVFrame {
        &*self.frame as *const AVFrame
    }
}

/// `rotation` : valeur JSON du préset ; `hide` : le curseur masqué par la région (la caméra le
/// suit toujours), pour lire la pastille sans lui.
fn scene_json(rotation: &str, hide: bool, click_bounce: f32) -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/cursors/default")
        .to_string_lossy()
        .replace('\\', "/");
    format!(
        r##"{{"clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                       "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
            "effects":{{"padding":0.2,"blur":false,"shadow":0.5,"roundnessFrac":0.03,"motionBlur":0}},
            "background":{{"kind":"gradient","angleDeg":135,"stops":["#5b6ee1","#e8a0bf"]}},
            "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":10,"scale":1,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":{rotation},"hideCursor":{hide}}}],
            "annotations":[],
            "cursor":{{"show":true,"size":4,"smoothing":0.5,"motionBlur":0.5,"clickBounce":{click_bounce},"model3d":true,"clipToBounds":false,"theme":"default",
                       "cursorSprites":{{"arrow":{{"path":"{dir}/arrow.png","hotspotX":0.119,"hotspotY":0.0874}},
                                        "pointer":{{"path":"{dir}/pointer.png","hotspotX":0.3893,"hotspotY":0.0032}}}}}},
            "cropByClip":[null],
            "output":{{"width":1280,"height":720,"fps":30}}}}"##
    )
}

/// Le geste : repos, arc jusqu'à la première cible (arrivée 80 ms avant le clic), tenue 120 ms,
/// arc jusqu'à la seconde, qui se survole en main, puis départ. 60 Hz, clics compris, lissé à
/// 0,5 comme le ferait l'application.
fn gesture(name: &str) -> CursorTrack {
    let ([ax, ay], t1) = TARGETS[0];
    let ([bx, by], t2) = TARGETS[1];
    let ease = |u: f32| {
        let u = u.clamp(0.0, 1.0);
        u * u * (3.0 - 2.0 * u)
    };
    let arc = |p: [f32; 2], q: [f32; 2], u: f32, bow: f32| {
        let e = ease(u);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let s = (std::f32::consts::PI * e).sin() * bow;
        (p[0] + dx * e - dy * s, p[1] + dy * e + dx * s)
    };
    let pos = |t: f32| -> (f32, f32) {
        let start = [0.12, 0.8];
        let end = [0.9, 0.3];
        if t < t1 - 0.08 {
            arc(start, [ax, ay], (t - 0.1) / (t1 - 0.18), 0.15)
        } else if t < t1 + 0.12 {
            (ax, ay)
        } else if t < t2 - 0.1 {
            arc([ax, ay], [bx, by], (t - t1 - 0.12) / (t2 - t1 - 0.22), -0.2)
        } else if t < t2 + 0.15 {
            (bx, by)
        } else {
            arc([bx, by], end, (t - t2 - 0.15) / 0.9, 0.1)
        }
    };
    let clicks = [t1, t2];
    let body: Vec<String> = (0..=300)
        .map(|i| {
            let t = i as f32 / 60.0;
            let (x, y) = pos(t);
            let click = if clicks.iter().any(|c| (c - t).abs() < 1e-3) { r#","interactionType":"click""# } else { "" };
            let kind = if t > (t1 + t2) * 0.5 { "pointer" } else { "arrow" };
            format!(r#"{{"timeMs":{},"cx":{x},"cy":{y}{click},"cursorType":"{kind}"}}"#, (t * 1000.0).round())
        })
        .collect();
    let path = std::env::temp_dir().join(format!("os_cursor_tap_{name}.json"));
    std::fs::write(&path, format!(r#"{{"samples":[{}]}}"#, body.join(","))).expect("sidecar");
    CursorTrack::load(path.to_str().unwrap(), 0.0, 10.0).expect("piste curseur").smoothed(0.5)
}

fn cfg() -> Cfg {
    let mut cfg = Cfg::c8();
    cfg.bg_blur = false;
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.cursor = true;
    cfg.mblur_n = 1;
    cfg.shadow = true;
    cfg
}

/// La frame à `t`, et le pixel du contenu où le plan pose le curseur (la pointe), s'il y en a un.
fn render(comp: &Compositor, screen: &MockFrame, json: &str, track: &CursorTrack, t: f32) -> (Vec<u8>, Option<[f32; 2]>) {
    let scene = Scene::from_json(json).expect("scène valide");
    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    comp.set_live_params(live);
    comp.set_has_webcam(false);
    comp.set_scene(Some(scene.clone()));
    comp.set_cursor(track.clone());
    comp.set_cursor_time(Some(t));
    comp.set_timeline_time(Some(t));
    let cfg = cfg();
    let (w, h, rgba) = unsafe {
        comp.compose_frame(screen.as_ptr(), screen.as_ptr(), t * 30.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback")
    };
    assert_eq!((w, h), OUT);
    let render_px = [w as f32, h as f32];
    let src = [SRC.0 as f32, SRC.1 as f32];
    let g = plan_frame(&FrameGeometryInput {
        render_px,
        screen_tex_px: src,
        screen_visible_px: src,
        webcam_visible_px: src,
        u_max: 1.0,
        v_max: 1.0,
        frame: t * 30.0,
        cfg: &cfg,
        live,
        scene: Some(&scene),
        cursor: Some(track),
        timeline_t_override: Some(t),
        programme_time: None,
    });
    let input = CursorPlanInput { render_px, u_max: 1.0, v_max: 1.0, cfg: &cfg, live, scene: Some(&scene), track, t };
    let tip = plan_cursor(&g, &input).map(|plan| match plan.placement {
        CursorPlacement::Tilted { plane_pt, quad, center_px, .. } => {
            let (x, y) = quad.point_px(plane_pt[0], plane_pt[1]);
            [center_px[0] + x, center_px[1] + y]
        }
        CursorPlacement::Upright { center } => [center[0] * render_px[0], center[1] * render_px[1]],
    });
    (rgba, tip)
}

fn px(rgba: &[u8], x: i32, y: i32) -> [i32; 3] {
    let i = ((y * OUT.0 as i32 + x) * 4) as usize;
    [rgba[i] as i32, rgba[i + 1] as i32, rgba[i + 2] as i32]
}

fn is_red(p: [i32; 3]) -> bool {
    p[0] > p[1] + 60 && p[0] > p[2] + 60
}

/// Centre (px) de la pastille rouge la plus proche de `near`, lu dans l'image.
fn marker(rgba: &[u8], near: [f32; 2]) -> [f32; 2] {
    let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
    for y in (near[1] as i32 - 40).max(0)..(near[1] as i32 + 40).min(OUT.1 as i32) {
        for x in (near[0] as i32 - 40).max(0)..(near[0] as i32 + 40).min(OUT.0 as i32) {
            if is_red(px(rgba, x, y)) {
                sx += x as f32 + 0.5;
                sy += y as f32 + 0.5;
                n += 1.0;
            }
        }
    }
    assert!(n > 10.0, "pas de pastille près de {near:?}");
    [sx / n, sy / n]
}

/// Au contact, la pointe couvre la pastille : le pixel du clic n'est plus rouge, et le plan pose
/// la pointe sur le centre mesuré de la pastille à 0,5 px près. À plat, en `iso` et sous la
/// caméra réelle, avec une piste lissée à 0,5 qui passe à des dizaines de px de la cible.
#[test]
fn the_tip_lands_on_the_marked_click_target() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, OUT.0, OUT.1).expect("compositor");
    let screen = MockFrame::new(&gpu);
    let track = gesture("contact");
    for (name, rotation) in [("flat", "null"), ("iso", r#""iso""#), ("follow", r#""follow-cursor""#)] {
        for (target, tc) in TARGETS {
            let t = tc + CONTACT_S;
            // La pastille, lue sans curseur au même instant (la caméra suit la même piste).
            let (bare, hidden) = render(&comp, &screen, &scene_json(rotation, true, 2.5), &track, t);
            assert!(hidden.is_none(), "{name}: la région devait masquer le curseur");
            let (touch, tip) = render(&comp, &screen, &scene_json(rotation, false, 2.5), &track, t);
            let tip = tip.expect("curseur au contact");
            let m = marker(&bare, tip);
            let off = (tip[0] - m[0]).hypot(tip[1] - m[1]);
            // Où serait la pointe sur la piste lissée : l'écart que la convergence rattrape, en
            // largeurs d'écran (~1000 px ici).
            let lag = track.at(t).map(|(x, y)| (x - target[0]).hypot(y - target[1])).unwrap() * 1000.0;
            println!("{name} cible {target:?} : pointe à {off:.3} px de la pastille (piste lissée à ~{lag:.0} px)");
            assert!(off < 0.5, "{name} {target:?}: pointe à {off} px de la pastille");
            assert!(lag > 5.0, "{name}: le lissage devrait traîner, sinon le test ne prouve rien");
            // Juste sous le point cliqué, la pointe (l'incrustation noire de la flèche, le trait du
            // doigt, dont le hotspot est le haut) couvre la pastille ; sans la convergence, la
            // pointe serait à des dizaines de px.
            let (x, y) = (m[0] as i32, (m[1] + 2.0) as i32);
            assert!(!is_red(px(&touch, x, y)), "{name} {target:?}: la pastille reste visible sous la pointe");
        }
    }
}

/// L'anneau de l'impact est centré sur la pastille : à plat, il passe à la même distance au-dessus
/// et à gauche d'elle (le curseur couvre le bas et la droite ; les deux côtés sont sur le même
/// bouton), et il n'existe pas sans clic.
#[test]
fn the_impact_ring_is_centred_on_the_click() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, OUT.0, OUT.1).expect("compositor");
    let screen = MockFrame::new(&gpu);
    let track = gesture("ring");
    let (_, tc) = TARGETS[0];
    let t = tc + 0.16;
    let (bare, _) = render(&comp, &screen, &scene_json("null", true, 2.5), &track, t);
    let (ring, tip) = render(&comp, &screen, &scene_json("null", false, 2.5), &track, t);
    let (quiet, _) = render(&comp, &screen, &scene_json("null", false, 0.0), &track, t);
    let m = marker(&bare, tip.expect("curseur"));
    // Le profil de l'écart dû à l'impact le long d'une demi-droite partant du clic.
    let peak = |dx: i32, dy: i32| -> (i32, i32) {
        (4..45)
            .map(|r| {
                let (x, y) = (m[0] as i32 + dx * r, m[1] as i32 + dy * r);
                let (a, b) = (px(&ring, x, y), px(&quiet, x, y));
                ((0..3).map(|c| (a[c] - b[c]).abs()).sum::<i32>(), r)
            })
            .max()
            .unwrap()
    };
    let (up, left) = (peak(0, -1), peak(-1, 0));
    println!("anneau : haut {up:?}, gauche {left:?} (gain, rayon px)");
    assert!(up.0 > 60 && left.0 > 60, "anneau absent : {up:?} {left:?}");
    assert!((up.1 - left.1).abs() <= 1, "anneau décentré : {up:?} {left:?}");
    let (late, _) = render(&comp, &screen, &scene_json("null", false, 2.5), &track, tc + 0.5);
    let (late_quiet, _) = render(&comp, &screen, &scene_json("null", false, 0.0), &track, tc + 0.5);
    assert!(late == late_quiet, "l'anneau survit à sa fenêtre");
}

/// Vidéo et planche à regarder (opt-in, `OPENSCREEN_CURSOR_TAP_OUT`).
#[test]
fn cursor_tap_video() {
    let Ok(dir) = std::env::var("OPENSCREEN_CURSOR_TAP_OUT") else {
        eprintln!("OPENSCREEN_CURSOR_TAP_OUT absent — saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, OUT.0, OUT.1).expect("compositor");
    let screen = MockFrame::new(&gpu);
    let track = gesture("video");
    let frames = format!("{dir}/frames");
    std::fs::create_dir_all(&frames).expect("dossier des frames");
    let presets = [("flat", "null"), ("iso", r#""iso""#)];
    let img = |rgba: Vec<u8>| image::RgbaImage::from_raw(OUT.0, OUT.1, rgba).expect("readback");
    for k in 0..120 {
        let t = k as f32 / 30.0;
        let mut both = image::RgbaImage::new(2 * OUT.0, OUT.1);
        for (i, (_, rotation)) in presets.iter().enumerate() {
            let (rgba, _) = render(&comp, &screen, &scene_json(rotation, false, 2.5), &track, t);
            image::imageops::overlay(&mut both, &img(rgba), (i as u32 * OUT.0) as i64, 0);
        }
        both.save(format!("{frames}/{k:03}.png")).expect("frame");
    }
    // La planche : autour de chaque clic, sept instants, agrandis ×2 autour de la pointe.
    const CELL: u32 = 200;
    let offsets = [-0.2, -0.067, 0.033, 0.067, 0.133, 0.233, 0.4];
    let mut sheet = image::RgbaImage::new(offsets.len() as u32 * 2 * CELL, 4 * 2 * CELL);
    for (row, ((name, rotation), (_, tc))) in presets.iter().flat_map(|p| TARGETS.iter().map(move |t| (p, t))).enumerate() {
        let (_, center) = render(&comp, &screen, &scene_json(rotation, false, 2.5), &track, tc + CONTACT_S);
        let center = center.expect("curseur");
        for (col, dt) in offsets.iter().enumerate() {
            let (rgba, _) = render(&comp, &screen, &scene_json(rotation, false, 2.5), &track, tc + dt);
            let (x, y) = ((center[0] - CELL as f32 * 0.5) as u32, (center[1] - CELL as f32 * 0.5) as u32);
            let crop = image::imageops::crop_imm(&img(rgba), x, y, CELL, CELL).to_image();
            let big = image::imageops::resize(&crop, 2 * CELL, 2 * CELL, image::imageops::FilterType::Nearest);
            image::imageops::overlay(&mut sheet, &big, (col as u32 * 2 * CELL) as i64, (row as u32 * 2 * CELL) as i64);
        }
        println!("planche, ligne {row} : {name}, clic à {tc} s, colonnes {offsets:?} s");
    }
    sheet.save(format!("{dir}/contact-sheet.png")).expect("planche");
    let ffmpeg = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/bin/ffmpeg.exe");
    let status = std::process::Command::new(ffmpeg)
        .args(["-y", "-loglevel", "error", "-framerate", "30", "-i"])
        .arg(format!("{frames}/%03d.png"))
        .args(["-c:v", "h264_mf", "-b:v", "16M", "-pix_fmt", "nv12"])
        .arg(format!("{dir}/cursor-tap.mp4"))
        .status();
    println!("ffmpeg : {status:?} -> {dir}/cursor-tap.mp4");
}
