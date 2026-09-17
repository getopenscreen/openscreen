//! La caméra réelle de `follow-cursor` (l'orbite) rendue par le vrai compositeur D3D11.
//!
//! Deux tests sans variable d'environnement, sur une frame NV12 SYNTHÉTIQUE (une grille, donc une
//! géométrie connue au texel près ; sans adaptateur matériel, ils se sautent : « test saute ») :
//!
//! - le warp projectif du mode 8 pose chaque ligne de la grille là où la caméra la projette
//!   (`TiltedQuad::point_px`), là où le warp bilinéaire des angles fixes la manquerait ;
//! - le roulis est nul au pixel près : la verticale qui passe par l'axe de la caméra reste
//!   verticale à l'image, les autres convergent comme la projection le dit.
//!
//! Et, opt-in, une vidéo de 8 s à 30 i/s sur une vraie source décodée (une interface), avec un
//! pointeur qui visite la gauche, la droite, le haut et le bas et clique, au zoom 1 puis 1,8,
//! flèche 3D, cadre, ombre et profondeur de champ ; plus la planche gauche / droite / haut / bas
//! aux deux zooms et la trace de la caméra.
//!
//! ```powershell
//! $env:OPENSCREEN_FOLLOW_VIDEO_SOURCE = "...\screen.mp4"   # 1920×1080, 10 s au moins
//! $env:OPENSCREEN_FOLLOW_VIDEO_OUT = "...\orbit"          # frames\NNN.png, sheet-*.png, trace
//! cargo test -p openscreen-compositor --test follow_camera_render -- --nocapture
//! ffmpeg -framerate 30 -i orbit\frames\%03d.png -c:v h264_mf -b:v 12M -pix_fmt nv12 orbit.mp4
//! ```

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::ffi::AVFrame;
use openscreen_compositor::frame_geometry::{live_params_from_scene, plan_frame, FrameGeometryInput};
use openscreen_compositor::scene::Scene;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_WRITE_DISCARD, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DYNAMIC,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

const SRC: (u32, u32) = (640, 360);
/// Pas de la grille, en texels : des lignes sombres de 2 texels sur fond clair.
const GRID: u32 = 32;
/// En plein palier de la région (0..10 s), le cadreur posé.
const T: f32 = 3.0;

fn gpu() -> Option<Gpu> {
    match Gpu::create(false) {
        Ok(g) => Some(g),
        Err(e) => {
            eprintln!("pas de device D3D11 matériel ({e:#}) — test saute");
            None
        }
    }
}

/// Une frame NV12 synthétique présentée comme une frame D3D11VA (cf. `cursor_model_render.rs`) :
/// une grille sombre sur fond clair, chroma neutre.
struct GridFrame {
    frame: Box<AVFrame>,
    _tex: ID3D11Texture2D,
}

impl GridFrame {
    fn new(gpu: &Gpu) -> GridFrame {
        let (w, h) = SRC;
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
            for row in 0..h {
                for col in 0..w {
                    let line = col % GRID < 2 || row % GRID < 2;
                    *dst.add(row as usize * pitch + col as usize) = if line { 30 } else { 220 };
                }
            }
            for row in 0..(h / 2) as usize {
                for col in 0..w as usize {
                    *dst.add((h as usize + row) * pitch + col) = 128;
                }
            }
            gpu.context.Unmap(&tex, 0);
            let mut frame: Box<AVFrame> = Box::new(std::mem::zeroed());
            frame.data[0] = tex.as_raw() as *mut u8;
            frame.data[1] = std::ptr::null_mut();
            frame.width = w as i32;
            frame.height = h as i32;
            GridFrame { frame, _tex: tex }
        }
    }

    fn as_ptr(&self) -> *const AVFrame {
        &*self.frame as *const AVFrame
    }
}

/// Piste curseur écrite dans un sidecar temporaire, échantillonnée à 60 Hz sur `[0, dur]`.
fn track(name: &str, dur: f32, at: &dyn Fn(f32) -> (f32, f32), clicks: &[f32]) -> CursorTrack {
    let body: Vec<String> = (0..=(dur * 60.0) as u32)
        .map(|i| {
            let t = i as f32 / 60.0;
            let (x, y) = at(t);
            let click = clicks.iter().any(|c| (c - t).abs() < 1e-3);
            let kind = if click { r#","interactionType":"click""# } else { "" };
            format!(r#"{{"timeMs":{},"cx":{x},"cy":{y}{kind}}}"#, (t * 1000.0).round())
        })
        .collect();
    let path = std::env::temp_dir().join(format!("os_follow_{name}_{}.json", std::process::id()));
    std::fs::write(&path, format!(r#"{{"samples":[{}]}}"#, body.join(","))).expect("sidecar");
    let track = CursorTrack::load(path.to_str().unwrap(), 0.0, dur as f64).expect("piste curseur");
    let _ = std::fs::remove_file(&path);
    track
}

fn grid_scene_dof(scale: f32, dof: bool) -> Scene {
    Scene::from_json(&format!(
        r##"{{"clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                       "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
            "effects":{{"padding":0.2,"blur":false,"shadow":0,"roundnessFrac":0.0,"motionBlur":0,"depthOfField":{dof}}},
            "background":{{"kind":"color","color":"#000000"}},
            "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":10,"scale":{scale},"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":"follow-cursor"}}],
            "annotations":[],
            "cursor":{{"show":true,"size":0.05,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"none"}},
            "cropByClip":[null],
            "output":{{"width":1280,"height":720,"fps":30}}}}"##
    ))
    .expect("scène valide")
}

/// La grille nette : la profondeur de champ (allumée par défaut) floute le côté lointain, et un
/// trait flou ne se mesure plus au pixel.
fn grid_scene(scale: f32) -> Scene {
    grid_scene_dof(scale, false)
}

fn cfg() -> Cfg {
    let mut cfg = Cfg::c8();
    cfg.bg_blur = false;
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.cursor = true;
    cfg.mblur_n = 1;
    cfg.shadow = false;
    cfg
}

/// La frame, et le quad que la géométrie partagée prévoit pour elle (centre compris).
fn render(
    comp: &Compositor,
    screen: &GridFrame,
    scene: &Scene,
    track: &CursorTrack,
) -> (Vec<u8>, openscreen_compositor::regions::TiltedQuad, [f32; 2]) {
    let mut live = live_params_from_scene(scene);
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
    assert_eq!((w, h), (1280, 720));
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
        scene: Some(scene),
        cursor: Some(track),
        timeline_t_override: Some(T),
        programme_time: None,
    });
    assert!(g.camera.is_some(), "la caméra réelle doit être posée");
    let s_px = [g.s_dst[2] * render_px[0], g.s_dst[3] * render_px[1]];
    let center = [(g.s_dst[0] + g.s_dst[2] * 0.5) * render_px[0], (g.s_dst[1] + g.s_dst[3] * 0.5) * render_px[1]];
    (rgba, g.screen_tilt(s_px).expect("quad de la caméra"), center)
}

fn luma(rgba: &[u8], x: i32, y: i32) -> f32 {
    let i = ((y * 1280 + x) * 4) as usize;
    0.2126 * rgba[i] as f32 + 0.7152 * rgba[i + 1] as f32 + 0.0722 * rgba[i + 2] as f32
}

/// Le centre (sous-pixel) de la ligne sombre la plus proche de `x0` sur la rangée `y`, cherchée
/// à ±`reach` px : barycentre de l'assombrissement. `None` sans ligne.
fn line_center(rgba: &[u8], x0: f32, y: i32, reach: i32) -> Option<f32> {
    let (mut sum, mut wsum) = (0.0f32, 0.0f32);
    for dx in -reach..=reach {
        let x = x0.round() as i32 + dx;
        if !(0..1280).contains(&x) || !(0..720).contains(&y) {
            return None;
        }
        let w = (200.0 - luma(rgba, x, y)).max(0.0);
        (sum, wsum) = (sum + w * (x as f32 + 0.5), wsum + w);
    }
    (wsum > 200.0).then(|| sum / wsum)
}

fn bilinear(c: &[(f32, f32); 4], u: f32, v: f32) -> (f32, f32) {
    let top = (c[0].0 + (c[1].0 - c[0].0) * u, c[0].1 + (c[1].1 - c[0].1) * u);
    let bottom = (c[3].0 + (c[2].0 - c[3].0) * u, c[3].1 + (c[2].1 - c[3].1) * u);
    (top.0 + (bottom.0 - top.0) * v, top.1 + (bottom.1 - top.1) * v)
}

/// Les lignes verticales de la grille tombent là où la caméra les projette, à un pixel près,
/// partout dans le cadre ; le warp bilinéaire les poserait à plusieurs pixels de là.
#[test]
fn the_projective_warp_lands_every_line_where_the_camera_projects_it() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = GridFrame::new(&gpu);
    // Pointeur en haut à droite : caméra tournée à fond, le cas le plus projectif.
    let tr = track("corner", 10.0, &|_| (0.93, 0.08), &[]);
    let (rgba, quad, center) = render(&comp, &screen, &grid_scene(2.2), &tr);
    if let Ok(dir) = std::env::var("OPENSCREEN_FOLLOW_VIDEO_OUT") {
        image::RgbaImage::from_raw(1280, 720, rgba.clone()).unwrap().save(format!("{dir}/grid-corner.png")).unwrap();
    }
    let (mut worst, mut worst_bilinear, mut n) = (0.0f32, 0.0f32, 0);
    // `SRC.0 / GRID` exclu : ce serait le bord droit de l'écran, pas une ligne de la grille.
    for k in 0..SRC.0 / GRID {
        let u = (k * GRID) as f32 / SRC.0 as f32 + 1.0 / SRC.0 as f32;
        for j in 0..SRC.1 / GRID {
            // Au milieu d'une cellule, loin des lignes horizontales.
            let v = ((j * GRID) as f32 + GRID as f32 * 0.5 + 1.0) / SRC.1 as f32;
            let p = quad.point_px(u, v);
            let (x, y) = (center[0] + p.0, center[1] + p.1);
            if !(40.0..1240.0).contains(&x) || !(40.0..680.0).contains(&y) {
                continue;
            }
            let Some(found) = line_center(&rgba, x, y.floor() as i32, 8) else { continue };
            // La ligne penche de moins de 5° : mesurée sur la rangée de `y`, à moins d'un demi-px
            // de lui, elle ne se décale que de quelques centièmes.
            let err = (found - (center[0] + p.0)).abs();
            worst = worst.max(err);
            let b = bilinear(&quad.corners, u, v);
            worst_bilinear = worst_bilinear.max((center[0] + b.0 - (center[0] + p.0)).abs());
            n += 1;
        }
    }
    println!("{n} points de grille : écart au rendu {worst:.2} px (le bilinéaire en serait à {worst_bilinear:.1} px)");
    assert!(n > 50, "trop peu de points visibles : {n}");
    assert!(worst <= 0.25, "le rendu s'écarte de la projection de {worst:.2} px");
    assert!(worst_bilinear > 5.0, "{worst_bilinear}");
}

/// Une ligne verticale de la grille, mesurée au pixel : `x = a + b·(y − cy)`, relative au point
/// principal. La prévision vient de la projection (`TiltedQuad::point_px`), la mesure du rendu.
fn measure_line(rgba: &[u8], quad: &openscreen_compositor::regions::TiltedQuad, center: [f32; 2], u: f32) -> Option<((f32, f32), (f32, f32))> {
    let (p0, p1) = (quad.point_px(u, 0.0), quad.point_px(u, 1.0));
    let predicted = |y: f32| p0.0 + (p1.0 - p0.0) * (y - p0.1) / (p1.1 - p0.1);
    let pts: Vec<(f32, f32)> = (60..660)
        .step_by(4)
        .filter_map(|y| {
            let dy = y as f32 + 0.5 - center[1];
            let x = center[0] + predicted(dy);
            // Hors des croisements de lignes horizontales, qui tirent le barycentre.
            (luma(rgba, (x + 14.0) as i32, y) > 150.0).then_some(())?;
            line_center(rgba, x, y, 10).map(|found| (dy, found - center[0]))
        })
        .collect();
    if pts.len() < 60 {
        return None;
    }
    let fit = |pts: &[(f32, f32)]| {
        let n = pts.len() as f32;
        let (my, mx) = (pts.iter().map(|p| p.0).sum::<f32>() / n, pts.iter().map(|p| p.1).sum::<f32>() / n);
        let b = pts.iter().map(|p| (p.0 - my) * (p.1 - mx)).sum::<f32>()
            / pts.iter().map(|p| (p.0 - my).powi(2)).sum::<f32>();
        (mx - b * my, b)
    };
    let want: Vec<(f32, f32)> = pts.iter().map(|&(y, _)| (y, predicted(y))).collect();
    Some((fit(&pts), fit(&want)))
}

/// Roulis nul au pixel près. Sous l'élévation de l'orbite, les verticales convergent vers un
/// point de fuite À LA VERTICALE du point principal : la pente d'une ligne verticale de la grille
/// est proportionnelle à sa distance à l'axe, et nulle SUR l'axe. On mesure les deux lignes qui
/// l'encadrent, on interpole leur pente à l'axe : elle doit être nulle, où que soit le pointeur.
/// Chaque pente mesurée tombe aussi sur la projection.
#[test]
fn the_vertical_through_the_view_axis_stays_vertical() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = GridFrame::new(&gpu);
    for (name, at, scale) in [
        ("tl", (0.1, 0.1), 1.8),
        ("br", (0.9, 0.92), 1.8),
        ("r", (0.9, 0.5), 1.0),
        ("t", (0.5, 0.05), 1.0),
        ("b", (0.3, 0.95), 2.2),
    ] {
        let tr = track(name, 10.0, &|_| at, &[]);
        let (rgba, quad, center) = render(&comp, &screen, &grid_scene(scale), &tr);
        let x_at_axis = |k: u32| quad.point_px((k * GRID + 1) as f32 / SRC.0 as f32, 0.5).0;
        let right = (0..=SRC.0 / GRID).find(|&k| x_at_axis(k) > 0.0).expect("une ligne à droite de l'axe");
        let lines: Vec<_> = [right - 1, right]
            .iter()
            .map(|&k| measure_line(&rgba, &quad, center, (k * GRID + 1) as f32 / SRC.0 as f32))
            .collect();
        let [Some(((a1, b1), (_, w1))), Some(((a2, b2), (_, w2)))] = lines[..] else {
            panic!("{name}: lignes introuvables autour de l'axe");
        };
        let axis = b1 + (b2 - b1) * (0.0 - a1) / (a2 - a1);
        let deg = |b: f32| b.atan().to_degrees();
        println!(
            "{name}: lignes à {a1:.0} et {a2:.0} px de l'axe, pentes {:.3}° et {:.3}° (projection {:.3}° et {:.3}°), à l'axe {:.3}°",
            deg(b1), deg(b2), deg(w1), deg(w2), deg(axis)
        );
        assert!(deg(axis).abs() < 0.1, "{name}: la verticale de l'axe penche de {:.3}°", deg(axis));
        assert!((deg(b1) - deg(w1)).abs() < 0.1 && (deg(b2) - deg(w2)).abs() < 0.1, "{name}");
    }
}

/// Le chemin du pointeur de la vidéo, en fractions de l'image source (une interface : menu à
/// gauche, cartes, boutons à droite). Zoom 1 : gauche, droite, haut, bas ; puis zoom 1,8 : un
/// bouton à droite, le menu en haut à gauche, un bouton en bas à droite. Chaque trajet dure 0,5 s
/// et finit à l'heure du point ; un clic tombe 0,2 s après chaque arrivée.
const TOUR: [(f32, f32, f32); 9] = [
    (0.0, 0.55, 0.45),
    (1.4, 0.10, 0.44),
    (2.4, 0.90, 0.40),
    (3.3, 0.64, 0.04),
    (4.2, 0.45, 0.93),
    (5.3, 0.82, 0.70),
    (6.4, 0.10, 0.20),
    (7.4, 0.80, 0.885),
    (9.0, 0.80, 0.885),
];

fn tour(t: f32) -> (f32, f32) {
    let i = TOUR.iter().rposition(|w| w.0 <= t).unwrap_or(0).min(TOUR.len() - 2);
    let (a, b) = (TOUR[i], TOUR[i + 1]);
    let e = ((t - (b.0 - 0.5)) / 0.5).clamp(0.0, 1.0);
    let s = e * e * (3.0 - 2.0 * e);
    let wobble = 0.003 * (t * 5.0).sin();
    (a.1 + (b.1 - a.1) * s + wobble, a.2 + (b.2 - a.2) * s)
}

/// La scène de la vidéo et de la planche : interface, cadre sombre, ombre, profondeur de champ,
/// flèche 3D, impact du clic.
fn orbit_scene(source: &str, regions: &str, (w, h): (u32, u32)) -> Scene {
    let arrow = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/cursors/default/arrow.png")
        .to_string_lossy()
        .replace('\\', "/");
    let src = source.replace('\\', "/");
    Scene::from_json(&format!(
        r##"{{"clips":[{{"screenPath":"{src}","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                       "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
            "effects":{{"padding":0.2,"blur":false,"shadow":0.6,"roundnessFrac":0.015,"motionBlur":0,"depthOfField":true,"frame":"window-dark"}},
            "background":{{"kind":"gradient","angleDeg":135,"stops":["#3b4fd1","#c86fa6"]}},
            "zoomRegions":[{regions}],
            "annotations":[],
            "cursor":{{"show":true,"size":2.2,"smoothing":0,"motionBlur":0,"clickBounce":2.5,"model3d":true,"clipToBounds":false,"theme":"default",
                       "cursorSprites":{{"arrow":{{"path":"{arrow}","hotspotX":0.119,"hotspotY":0.0874}}}}}},
            "cropByClip":[null],
            "output":{{"width":{w},"height":{h},"fps":30}}}}"##
    ))
    .expect("scène valide")
}

fn orbit_region(start: f32, end: f32, scale: f32) -> String {
    format!(
        r#"{{"clipIndex":0,"startSec":{start},"endSec":{end},"scale":{scale},"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":"follow-cursor","clickImpact":true}}"#
    )
}

fn video_cfg() -> Cfg {
    let mut cfg = openscreen_compositor::config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.shadow = true;
    cfg.cursor = true;
    cfg
}

/// Opt-in : les frames d'une vidéo de 8 s à 30 i/s, zoom 1 puis zoom 1,8, et la planche
/// gauche / droite / haut / bas aux deux zooms. Cf. l'en-tête du fichier.
#[test]
fn an_orbit_camera_video() {
    let (Ok(source), Ok(out)) = (
        std::env::var("OPENSCREEN_FOLLOW_VIDEO_SOURCE"),
        std::env::var("OPENSCREEN_FOLLOW_VIDEO_OUT"),
    ) else {
        println!("SKIP: definir OPENSCREEN_FOLLOW_VIDEO_SOURCE et OPENSCREEN_FOLLOW_VIDEO_OUT.");
        return;
    };
    let size = (1920u32, 1080u32);
    let (w, h) = size;
    let frames = format!("{out}/frames");
    std::fs::create_dir_all(&frames).expect("dossier de sortie");
    let gpu = Gpu::create(false).expect("device d3d11");
    let cfg = video_cfg();
    let comp = Compositor::new_sized(&gpu, w, h).expect("compositor");
    let mut player = unsafe { openscreen_compositor::live::Player::open(&source, "", &gpu) }.expect("source");
    let mut present = |scene: &Scene, pointer: &CursorTrack, t: f32| -> Vec<u8> {
        let live = live_params_from_scene(scene);
        comp.set_live_params(live);
        comp.set_scene(Some(scene.clone()));
        comp.set_cursor(pointer.clone());
        unsafe {
            player.present_frame(&comp, &cfg, t as f64).expect("composer la frame");
            comp.readback_resized(w, h).expect("readback")
        }
    };

    // La planche : pointeur posé à gauche, à droite, en haut, en bas, au zoom 1 puis 1,8.
    for (zoom, tag) in [(1.0f32, "z1"), (1.8, "z18")] {
        let scene = orbit_scene(&source, &orbit_region(0.0, 10.0, zoom), size);
        for (side, at) in [("left", (0.06, 0.5)), ("right", (0.94, 0.5)), ("top", (0.5, 0.05)), ("bottom", (0.5, 0.95))] {
            let pointer = track(&format!("sheet_{tag}_{side}"), 10.0, &|_| at, &[]);
            let rgba = present(&scene, &pointer, 3.0);
            image::save_buffer(format!("{out}/sheet-{tag}-{side}.png"), &rgba, w, h, image::ColorType::Rgba8).expect("png");
        }
    }

    // La vidéo : une région au zoom 1, chaînée à une région au zoom 1,8.
    let regions = format!("{},{}", orbit_region(0.8, 4.6, 1.0), orbit_region(5.1, 8.5, 1.8));
    let scene = orbit_scene(&source, &regions, size);
    let clicks: Vec<f32> = TOUR[1..8].iter().map(|w| w.0 + 0.2).collect();
    let pointer = track("video", 10.0, &tour, &clicks).smoothed(0.0);
    let live = live_params_from_scene(&scene);
    // La trace de la caméra, frame par frame, par la géométrie partagée : de quoi juger la douceur
    // du mouvement sans regarder la vidéo.
    let mut trace = String::from("t,poids,zoom,orbite_x,orbite_y,visee_x,visee_y,azimut,elevation,recul,centre_x,centre_y\n");
    for i in 0..240u32 {
        let t = i as f32 / 30.0;
        let rgba = present(&scene, &pointer, t);
        image::save_buffer(format!("{frames}/{i:03}.png"), &rgba, w, h, image::ColorType::Rgba8).expect("png");
        let g = plan_frame(&FrameGeometryInput {
            render_px: [w as f32, h as f32],
            screen_tex_px: [1920.0, 1080.0],
            screen_visible_px: [1920.0, 1080.0],
            webcam_visible_px: [1920.0, 1080.0],
            u_max: 1.0,
            v_max: 1.0,
            frame: i as f32,
            cfg: &cfg,
            live,
            scene: Some(&scene),
            cursor: Some(&pointer),
            timeline_t_override: Some(t),
            programme_time: None,
        });
        let s_px = [g.s_dst[2] * w as f32, g.s_dst[3] * h as f32];
        let pose = g.camera.unwrap_or(openscreen_compositor::camera::CameraPose { weight: 0.0, ..openscreen_compositor::camera::CameraPose::REST });
        let [az, el] = openscreen_compositor::camera::View::new(s_px, pose).angles_deg();
        let offset = g.screen_tilt(s_px).map(|q| q.offset).unwrap_or([0.0; 2]);
        trace += &format!(
            "{t:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{az:.3},{el:.3},{:.3},{:.2},{:.2}\n",
            pose.weight, pose.zoom, pose.orbit[0], pose.orbit[1], pose.aim[0], pose.aim[1], pose.press, offset[0], offset[1]
        );
    }
    std::fs::write(format!("{out}/camera-trace.csv"), trace).expect("trace");
    println!("240 frames et 8 planches dans {out}");
}
