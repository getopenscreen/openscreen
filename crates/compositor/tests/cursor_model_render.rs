//! Le curseur modélisé (`cursor.model3d`, mode 15) rendu par le vrai compositeur D3D11 : chaque
//! état du thème par défaut, extrudé depuis son sprite.
//!
//! La source est une frame NV12 SYNTHÉTIQUE (une texture remplie ici, présentée comme une frame
//! D3D11VA) : rien à décoder, donc le test tourne sur toute machine qui a un GPU, sans variable
//! d'environnement. Sans adaptateur matériel, il se saute (« test saute »).
//!
//! ```powershell
//! $env:OPENSCREEN_CURSOR3D_OUT = "...\renders"   # facultatif : un PNG par cas, et la planche
//! cargo test -p openscreen-compositor --test cursor_model_render -- --nocapture
//! # coût d'une frame 1080p, curseur 3D allumé contre éteint (opt-in) :
//! $env:OPENSCREEN_CURSOR3D_BENCH = "1"
//! cargo test -p openscreen-compositor --release --test cursor_model_render bench -- --nocapture
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

const SRC: (u32, u32) = (640, 360);
/// Instant rendu : en plein palier de la région de zoom (0..10 s).
const T: f32 = 2.0;
/// Creux de `regions::tap` : un clic à `T - CONTACT_S` montre le modèle posé à `T`.
const CONTACT_S: f32 = 0.0495;

/// Les seize états du thème par défaut et leurs hotspots (`DEFAULT_CURSOR_SPRITES`,
/// `src/lib/cursor/cursorThemes.ts`).
const STATES: [(&str, [f32; 2]); 16] = [
    ("arrow", [0.119, 0.0874]),
    ("text", [0.4375, 0.5333]),
    ("pointer", [0.3893, 0.0032]),
    ("crosshair", [0.4667, 0.4667]),
    ("open-hand", [0.4375, 0.1781]),
    ("closed-hand", [0.3889, 0.451]),
    ("resize-ew", [0.4881, 0.4706]),
    ("resize-ns", [0.5, 0.5]),
    ("resize-nesw", [0.5, 0.5]),
    ("resize-nwse", [0.5, 0.5]),
    ("move", [0.4444, 0.4444]),
    ("not-allowed", [0.5, 0.5]),
    ("wait", [0.5, 0.5]),
    ("app-starting", [0.05, 0.0537]),
    ("help", [0.0515, 0.0572]),
    ("up-arrow", [0.5, 0.069]),
];

/// Les états que les tests de rendu passent en revue : pointeurs, centrés, entre deux.
const TESTED: [&str; 6] = ["arrow", "pointer", "text", "open-hand", "resize-ew", "not-allowed"];

/// Les états dont le hotspot est au centre : ni tangage ni lacet.
fn is_centred(key: &str) -> bool {
    matches!(key, "text" | "resize-ew" | "not-allowed")
}

fn gpu() -> Option<Gpu> {
    match Gpu::create(false) {
        Ok(g) => Some(g),
        Err(e) => {
            eprintln!("pas de device D3D11 matériel ({e:#}) — test saute");
            None
        }
    }
}

/// Deux teintes de contenu : un pixel identique sur les deux est du modèle opaque, un pixel qui
/// change est le contenu, son ombre ou une frange antialiasée.
#[derive(Clone, Copy)]
enum Tint {
    Blue,
    Orange,
}

/// Une frame NV12 synthétique : `data[0]` = la texture, `data[1]` = tranche 0, comme une frame
/// D3D11VA (le seul contrat que `Compositor::nv12_srvs` lit). Une teinte moyenne striée de barres
/// plus sombres : rien d'aussi clair ni d'aussi sombre que le curseur, et surtout rien de NEUTRE,
/// si bien qu'un pixel gris est le curseur et un pixel teinté assombri, son ombre.
struct FakeFrame {
    frame: Box<AVFrame>,
    _tex: ID3D11Texture2D,
}

impl FakeFrame {
    fn new(gpu: &Gpu, tint: Tint) -> FakeFrame {
        let (w, h) = SRC;
        let (u, v) = match tint {
            Tint::Blue => (150, 120),
            Tint::Orange => (100, 170),
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
            for row in 0..h as usize {
                for col in 0..w as usize {
                    let bar = row % 24 >= 8 && row % 24 < 12 && (col / 40) % 3 != 2;
                    *dst.add(row * pitch + col) = if bar { 90 } else { 150 };
                }
            }
            for row in 0..(h / 2) as usize {
                for col in 0..w as usize {
                    let uv = (h as usize + row) * pitch + col;
                    *dst.add(uv) = if col % 2 == 0 { u } else { v };
                }
            }
            gpu.context.Unmap(&tex, 0);
            let mut frame: Box<AVFrame> = Box::new(std::mem::zeroed());
            frame.data[0] = tex.as_raw() as *mut u8;
            frame.data[1] = std::ptr::null_mut();
            frame.width = w as i32;
            frame.height = h as i32;
            FakeFrame { frame, _tex: tex }
        }
    }

    fn as_ptr(&self) -> *const AVFrame {
        &*self.frame as *const AVFrame
    }
}

/// Les seize sprites livrés, au format `cursorSprites` de la scène.
fn sprites_json() -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/cursors/default")
        .to_string_lossy()
        .replace('\\', "/");
    let entries: Vec<String> = STATES
        .iter()
        .map(|(key, [hx, hy])| format!(r#""{key}":{{"path":"{dir}/{key}.png","hotspotX":{hx},"hotspotY":{hy}}}"#))
        .collect();
    format!("{{{}}}", entries.join(","))
}

/// `model3d` : `None` = clé absente (payload d'avant le réglage).
fn scene_json(rotation: &str, model3d: Option<bool>, theme: &str, motion_blur: f32, size: f32) -> String {
    let model3d = model3d.map(|m| format!(r#","model3d":{m}"#)).unwrap_or_default();
    let sprites = sprites_json();
    format!(
        r##"{{"clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                       "screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}}}},
            "effects":{{"padding":0.2,"blur":false,"shadow":0,"roundnessFrac":0.03,"motionBlur":0}},
            "background":{{"kind":"gradient","angleDeg":135,"stops":["#5b6ee1","#e8a0bf"]}},
            "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":10,"scale":1,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":{rotation}}}],
            "annotations":[],
            "cursor":{{"show":true,"size":{size},"smoothing":0,"motionBlur":{motion_blur},"clickBounce":2.5{model3d},"clipToBounds":false,"theme":"{theme}",
                       "cursorSprites":{sprites}}},
            "cropByClip":[null],
            "output":{{"width":1280,"height":720,"fps":30}}}}"##
    )
}

/// La même scène, curseur masqué : la référence « sans curseur ».
fn hidden_json(rotation: &str) -> String {
    scene_json(rotation, Some(true), "default", 0.0, 3.0).replace(r#""show":true"#, r#""show":false"#)
}

/// Piste curseur écrite dans un sidecar temporaire : `(t, x, y, clic)`, dans l'état `kind`
/// (`None` = pas de clé, la flèche).
fn track_as(name: &str, kind: Option<&str>, samples: &[(f32, f32, f32, bool)]) -> CursorTrack {
    let kind = kind.map(|k| format!(r#","cursorType":"{k}""#)).unwrap_or_default();
    let body: Vec<String> = samples
        .iter()
        .map(|&(t, x, y, click)| {
            let click = if click { r#","interactionType":"click""# } else { "" };
            format!(r#"{{"timeMs":{},"cx":{x},"cy":{y}{click}{kind}}}"#, t * 1000.0)
        })
        .collect();
    let path = std::env::temp_dir().join(format!("os_cursor_model_{name}.json"));
    std::fs::write(&path, format!(r#"{{"samples":[{}]}}"#, body.join(","))).expect("sidecar");
    CursorTrack::load(path.to_str().unwrap(), 0.0, 10.0).expect("piste curseur")
}

fn track(name: &str, samples: &[(f32, f32, f32, bool)]) -> CursorTrack {
    track_as(name, None, samples)
}

/// Une piste immobile en (0.45, 0.45) dans l'état `kind`, avec ou sans clic au creux du contact
/// à `T`.
fn resting_as(name: &str, kind: Option<&str>, click: bool) -> CursorTrack {
    resting_at(name, kind, click, 0.45)
}

/// `resting_as`, en (`at`, `at`) : 0,5 est le centre de l'écran, sur l'axe de la caméra.
fn resting_at(name: &str, kind: Option<&str>, click: bool, at: f32) -> CursorTrack {
    let mut s = vec![(0.0, at, at, false), (T - CONTACT_S - 0.2, at, at, false)];
    if click {
        s.push((T - CONTACT_S, at, at, true));
    }
    s.push((9.0, at, at, false));
    track_as(name, kind, &s)
}

fn resting(name: &str, click: bool) -> CursorTrack {
    resting_as(name, None, click)
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

/// Ce que la frame dit du curseur : le pixel du contenu qu'il vise et son unité en px.
#[derive(Clone, Copy)]
struct Probe {
    tip: [f32; 2],
    unit: f32,
}

fn render(comp: &Compositor, screen: &FakeFrame, json: &str, track: &CursorTrack) -> (Vec<u8>, Probe) {
    let (rgba, probe) = render_any(comp, screen, json, track);
    (rgba, probe.expect("un curseur à dessiner"))
}

/// `render`, sans exiger de curseur (scène au curseur masqué).
fn render_any(
    comp: &Compositor,
    screen: &FakeFrame,
    json: &str,
    track: &CursorTrack,
) -> (Vec<u8>, Option<Probe>) {
    let scene = Scene::from_json(json).expect("scène valide");
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
        cursor: Some(track),
        timeline_t_override: Some(T),
        programme_time: None,
    });
    let Some(plan) = plan_cursor(
        &g,
        &CursorPlanInput {
            render_px,
            u_max: 1.0,
            v_max: 1.0,
            cfg: &cfg,
            live,
            scene: Some(&scene),
            track,
            t: T,
        },
    ) else {
        return (rgba, None);
    };
    let (tip, scale) = match plan.placement {
        CursorPlacement::Tilted { plane_pt, quad, center_px, .. } => {
            let (x, y) = quad.point_px(plane_pt[0], plane_pt[1]);
            ([center_px[0] + x, center_px[1] + y], quad.scale)
        }
        CursorPlacement::Upright { center } => ([center[0] * render_px[0], center[1] * render_px[1]], 1.0),
    };
    (rgba, Some(Probe { tip, unit: plan.size_px * scale }))
}

fn px(rgba: &[u8], x: i32, y: i32) -> [u8; 4] {
    let i = ((y * 1280 + x) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

fn luma(p: [u8; 4]) -> f32 {
    0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32
}

fn is_neutral(p: [u8; 4]) -> bool {
    p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]) < 12
}

fn is_white(p: [u8; 4]) -> bool {
    p[0] > 200 && p[1] > 200 && p[2] > 200
}

fn is_black(p: [u8; 4]) -> bool {
    p[0] < 45 && p[1] < 45 && p[2] < 45
}

/// Ce qui distingue une frame avec flèche de la même sans : les pixels de la flèche (neutres,
/// quand le contenu est bleu) et ceux d'ombre (le bleu du contenu, assombri), avec leurs
/// centroïdes et la distance de l'ombre la plus proche de la pointe.
struct Split {
    body: usize,
    white: usize,
    black: usize,
    shadow: usize,
    body_c: [f32; 2],
    shadow_c: [f32; 2],
    /// Distance (px) du pixel d'ombre le plus proche de l'apex de la silhouette.
    shadow_near_apex: f32,
}

fn split(with: &[u8], without: &[u8], apex: [f32; 2]) -> Split {
    let mut s = Split {
        body: 0,
        white: 0,
        black: 0,
        shadow: 0,
        body_c: [0.0; 2],
        shadow_c: [0.0; 2],
        shadow_near_apex: f32::MAX,
    };
    let body = |x: i32, y: i32| {
        (0..1280).contains(&x)
            && (0..720).contains(&y)
            && px(with, x, y) != px(without, x, y)
            && is_neutral(px(with, x, y))
    };
    for y in 0..720 {
        for x in 0..1280 {
            let (a, b) = (px(with, x, y), px(without, x, y));
            if a == b {
                continue;
            }
            // La frange antialiasée de la silhouette mêle la flèche au contenu : ni corps ni
            // ombre, on l'écarte (deux pixels autour du corps).
            let fringe = (-2..=2).any(|dy| (-2..=2).any(|dx| body(x + dx, y + dy)));
            if is_neutral(a) {
                s.body += 1;
                s.white += is_white(a) as usize;
                s.black += is_black(a) as usize;
                s.body_c[0] += x as f32;
                s.body_c[1] += y as f32;
            } else if !fringe && luma(a) < luma(b) - 6.0 {
                s.shadow += 1;
                s.shadow_c[0] += x as f32;
                s.shadow_c[1] += y as f32;
                let d = (x as f32 - apex[0]).hypot(y as f32 - apex[1]);
                s.shadow_near_apex = s.shadow_near_apex.min(d);
            }
        }
    }
    for (c, n) in [(&mut s.body_c, s.body), (&mut s.shadow_c, s.shadow)] {
        *c = [c[0] / n.max(1) as f32, c[1] / n.max(1) as f32];
    }
    s
}

/// Les pixels OPAQUES du curseur : identiques sur les deux teintes de contenu, différents du
/// contenu nu.
fn opaque_mask(on_blue: &[u8], on_orange: &[u8], bare_blue: &[u8]) -> Vec<bool> {
    (0..1280 * 720)
        .map(|i| {
            let (a, b, c) = (&on_blue[i * 4..i * 4 + 3], &on_orange[i * 4..i * 4 + 3], &bare_blue[i * 4..i * 4 + 3]);
            a == b && a != c
        })
        .collect()
}

fn iou(a: &[bool], b: &[bool]) -> f32 {
    let inter = a.iter().zip(b).filter(|(x, y)| **x && **y).count();
    let union = a.iter().zip(b).filter(|(x, y)| **x || **y).count();
    inter as f32 / union.max(1) as f32
}

/// Part des pixels de `a` qui ont un pixel de `b` à `r` px au plus (norme max) : l'accord de deux
/// silhouettes à la perspective près.
fn within(a: &[bool], b: &[bool], r: i32) -> f32 {
    let near = |i: usize| {
        let (x, y) = ((i % 1280) as i32, (i / 1280) as i32);
        (-r..=r).any(|dy| {
            (-r..=r).any(|dx| {
                let (x, y) = (x + dx, y + dy);
                (0..1280).contains(&x) && (0..720).contains(&y) && b[(y * 1280 + x) as usize]
            })
        })
    };
    let hits: Vec<usize> = (0..a.len()).filter(|&i| a[i]).collect();
    hits.iter().filter(|&&i| near(i)).count() as f32 / hits.len().max(1) as f32
}

/// Parts des pixels sombres, clairs et rouges parmi ceux du masque qui tombent dans l'une des
/// trois classes : les demi-teintes du chanfrein n'y comptent pas.
fn palette(rgba: &[u8], mask: &[bool]) -> [f32; 3] {
    let mut c = [0usize; 3];
    for (i, _) in mask.iter().enumerate().filter(|(_, m)| **m) {
        let p = [rgba[i * 4] as i32, rgba[i * 4 + 1] as i32, rgba[i * 4 + 2] as i32];
        c[0] += (p.iter().max().unwrap() < &70) as usize;
        c[1] += (p.iter().min().unwrap() > &150) as usize;
        c[2] += (p[0] > p[1] + 60 && p[0] > p[2] + 60) as usize;
    }
    let n = c.iter().sum::<usize>().max(1) as f32;
    c.map(|k| k as f32 / n)
}

fn out_dir() -> Option<String> {
    let dir = std::env::var("OPENSCREEN_CURSOR3D_OUT").ok()?;
    std::fs::create_dir_all(&dir).expect("dossier de sortie");
    Some(dir)
}

fn save(name: &str, rgba: &[u8]) {
    let Some(dir) = out_dir() else { return };
    let path = format!("{dir}/{name}.png");
    image::RgbaImage::from_raw(1280, 720, rgba.to_vec())
        .expect("dimensions du readback")
        .save(&path)
        .unwrap_or_else(|e| panic!("écriture {path} : {e}"));
    println!("écrit {path}");
}

#[test]
fn the_modelled_arrow_stands_on_the_screen_and_casts_its_shadow() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    let still = resting("still", false);
    let clicked = resting("clicked", true);

    for (name, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
        let bare = render_any(&comp, &screen, &hidden_json(rotation), &still).0;
        let (hover, p) = render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 3.0), &still);
        let (touch, q) =
            render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 3.0), &clicked);
        save(&format!("{name}-hover"), &hover);
        save(&format!("{name}-touch"), &touch);
        // L'apex de la silhouette : le filet blanc dépasse le hotspot vers le haut-gauche.
        let apex = |p: &Probe| [p.tip[0] - 0.03 * p.unit, p.tip[1] - 0.07 * p.unit];
        let (a, b) = (split(&hover, &bare, apex(&p)), split(&touch, &bare, apex(&q)));
        println!(
            "{name} : unité {:.1} px, pointe {:?} | en l'air : corps {} (blanc {}, noir {}), ombre {} \
             à {:.1} px de l'apex, centroïdes {:?} / {:?} | posée : ombre à {:.1} px, centroïdes {:?} / {:?}",
            p.unit, p.tip, a.body, a.white, a.black, a.shadow, a.shadow_near_apex, a.body_c, a.shadow_c,
            b.shadow_near_apex, b.body_c, b.shadow_c
        );

        // La pointe : le hotspot est la pointe de l'incrustation noire. Juste sous elle, dans le
        // corps, c'est noir ; juste au-dessus-gauche, le filet blanc ; loin au-dessus-gauche, le
        // contenu, intact (l'ombre part vers le bas-droite).
        let u = p.unit;
        let at = |dx: f32, dy: f32| px(&hover, (p.tip[0] + dx * u) as i32, (p.tip[1] + dy * u) as i32);
        assert!(is_black(at(0.07, 0.3)), "{name}: pas d'incrustation noire sous la pointe : {:?}", at(0.07, 0.3));
        assert!(is_white(at(-0.035, -0.02)) || is_white(at(-0.04, 0.05)), "{name}: pas de filet blanc à la pointe");
        let far = [(p.tip[0] - 0.3 * u) as i32, (p.tip[1] - 0.3 * u) as i32];
        assert_eq!(px(&hover, far[0], far[1]), px(&bare, far[0], far[1]), "{name}: le haut-gauche a bougé");

        // Corps blanc ET noir, de la taille d'une flèche : 0,35 u² de silhouette dans le PNG.
        let area = 0.35 * u * u;
        assert!(a.white as f32 > 0.15 * area && a.black as f32 > 0.25 * area, "{name}: matières absentes");
        assert!((a.body as f32) < 1.5 * area && (a.body as f32) > 0.7 * area, "{name}: taille {} pour {area}", a.body);

        // L'ombre : présente, du côté opposé à la lumière (bas-droite de la flèche).
        assert!(a.shadow as f32 > 0.1 * area, "{name}: pas d'ombre en l'air ({})", a.shadow);
        assert!(
            a.shadow_c[0] > a.body_c[0] && a.shadow_c[1] > a.body_c[1],
            "{name}: l'ombre n'est pas en bas à droite ({:?} / {:?})",
            a.shadow_c,
            a.body_c
        );
        // Posée, l'ombre rejoint la pointe et se resserre sous la flèche.
        assert!(b.shadow_near_apex < 0.1 * u, "{name}: posée, l'ombre est à {:.1} px de l'apex", b.shadow_near_apex);
        assert!(a.shadow_near_apex > 0.2 * u, "{name}: en l'air, l'ombre touche l'apex ({:.1} px)", a.shadow_near_apex);
        let gap = |s: &Split| (s.shadow_c[0] - s.body_c[0]).hypot(s.shadow_c[1] - s.body_c[1]);
        // (La queue, relevée par la pression, garde son ombre au loin : le centroïde ne se
        // rapproche que d'une fraction de la hauteur.)
        assert!(gap(&b) < gap(&a) - 0.1 * u, "{name}: l'ombre ne se rapproche pas au contact ({} / {})", gap(&b), gap(&a));
        // La pointe ne bouge pas quand la flèche descend (elle est sur le rayon de vue).
        assert!((p.tip[0] - q.tip[0]).abs() < 0.01 && (p.tip[1] - q.tip[1]).abs() < 0.01);
    }
}

/// Chaque état garde son art et sa silhouette : posé au centre de l'écran (sur l'axe de la
/// caméra, donc vu de face), le modèle couvre ce que couvre le sprite plat, avec ses couleurs, et
/// il porte une ombre en l'air.
#[test]
fn every_state_keeps_its_art_and_its_footprint() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let (blue, orange) = (FakeFrame::new(&gpu, Tint::Blue), FakeFrame::new(&gpu, Tint::Orange));
    const SIZE: f32 = 5.0;
    let bare = render_any(&comp, &blue, &hidden_json("null"), &resting("bare", false)).0;
    let mut failures = Vec::new();
    for key in TESTED {
        let still = resting_at(&format!("art-still-{key}"), Some(key), false, 0.5);
        let clicked = resting_at(&format!("art-clicked-{key}"), Some(key), true, 0.5);
        let (on3d, flat) =
            (scene_json("null", Some(true), "default", 0.0, SIZE), scene_json("null", Some(false), "default", 0.0, SIZE));
        let (touch, p) = render(&comp, &blue, &on3d, &clicked);
        let touch_b = render(&comp, &orange, &on3d, &clicked).0;
        let (hover, _) = render(&comp, &blue, &on3d, &still);
        let sprite = render(&comp, &blue, &flat, &still).0;
        let sprite_b = render(&comp, &orange, &flat, &still).0;
        save(&format!("art-{key}-touch"), &touch);
        save(&format!("art-{key}-sprite"), &sprite);

        let m3d = opaque_mask(&touch, &touch_b, &bare);
        let m2d = opaque_mask(&sprite, &sprite_b, &bare);
        let overlap = iou(&m3d, &m2d);
        let (near3d, near2d) = (within(&m3d, &m2d, 2), within(&m2d, &m3d, 2));
        let (pal3d, pal2d) = (palette(&touch, &m3d), palette(&sprite, &m2d));
        let area = m2d.iter().filter(|m| **m).count() as f32;
        // L'ombre en l'air : ce qui a changé, n'est pas du modèle, et s'est assombri.
        let shadow = (0..1280 * 720)
            .filter(|&i| {
                let (a, b) = (&hover[i * 4..i * 4 + 4], &bare[i * 4..i * 4 + 4]);
                a != b
                    && !is_neutral([a[0], a[1], a[2], 255])
                    && luma([a[0], a[1], a[2], 255]) < luma([b[0], b[1], b[2], 255]) - 6.0
            })
            .count() as f32;
        println!(
            "{key} : unité {:.1} px, IoU {overlap:.3}, à 2 px près {near3d:.3} / {near2d:.3}, sprite {area} px, \
             palette 3D {pal3d:?} / sprite {pal2d:?}, ombre {shadow} px",
            p.unit
        );
        // De face et à plat, un curseur centré est son sprite, à la perspective près : le dessus
        // est à une épaisseur du plan, donc agrandi de ~3 % (1 à 2 px, ce qui suffit à baisser
        // l'IoU d'un trait fin comme le I ; à 2 px près, les silhouettes coïncident). Un pointeur est basculé de 28°
        // (tangage de la pression) : raccourci, et le flanc de sa queue relevée se voit, de la
        // couleur de son bord.
        let (min_iou, min_near, palette_tol) =
            if is_centred(key) { (0.75, 0.98, 0.07) } else { (0.6, 0.9, 0.2) };
        if overlap <= min_iou || near3d < min_near || near2d < min_near {
            failures.push(format!("{key}: la silhouette s'écarte du sprite (IoU {overlap}, {near3d} / {near2d})"));
        }
        for (c, (a, b)) in ["sombre", "clair", "rouge"].iter().zip(pal3d.iter().zip(pal2d.iter())) {
            if (a - b).abs() >= palette_tol {
                failures.push(format!("{key}: part {c} {a} contre {b} dans le sprite"));
            }
        }
        if shadow <= 0.3 * area {
            failures.push(format!("{key}: pas d'ombre en l'air ({shadow} px)"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Incliné et à plat, le modèle n'a pas la même silhouette : le plan l'emporte avec lui.
#[test]
fn the_tilt_turns_every_state_with_the_screen() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    for key in TESTED {
        let still = resting_as(&format!("tilt-{key}"), Some(key), false);
        let mask = |rotation: &str| -> (Vec<bool>, Probe) {
            let (rgba, p) = render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 3.0), &still);
            // Silhouette relative au hotspot, sur une fenêtre de ±1,1 unité.
            let r = (1.1 * p.unit) as i32;
            let mut m = Vec::new();
            for dy in -r..r {
                for dx in -r..r {
                    let (x, y) = (p.tip[0] as i32 + dx, p.tip[1] as i32 + dy);
                    m.push((0..1280).contains(&x) && (0..720).contains(&y) && is_neutral(px(&rgba, x, y)));
                }
            }
            (m, p)
        };
        let (flat, pf) = mask("null");
        let (iso, pi) = mask(r#""iso""#);
        let n = flat.len().min(iso.len());
        let differ = (0..n).filter(|&k| flat[k] != iso[k]).count();
        println!("{key} : {differ} px diffèrent (unités {:.1} / {:.1})", pf.unit, pi.unit);
        assert!(differ as f32 > 0.05 * pf.unit * pf.unit, "{key}: le modèle ne suit pas l'inclinaison ({differ})");
    }
}

/// Réglage éteint : la frame est celle du sprite plat, quelle que soit la façon de le dire (clé
/// absente, `false`, ou allumé sur un autre thème), et quel que soit l'état.
#[test]
fn without_the_model_the_cursor_renders_the_flat_sprite() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    let still = resting("flat-sprite", false);
    let clicked = resting("flat-sprite-clicked", true);
    let text = resting_as("flat-sprite-text", Some("text"), false);
    for rotation in ["null", r#""iso""#] {
        let absent = render(&comp, &screen, &scene_json(rotation, None, "default", 0.0, 3.0), &still).0;
        let off = render(&comp, &screen, &scene_json(rotation, Some(false), "default", 0.0, 3.0), &still).0;
        let other = render(&comp, &screen, &scene_json(rotation, Some(true), "other", 0.0, 3.0), &still).0;
        let on = render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 3.0), &still).0;
        let off_click = render(&comp, &screen, &scene_json(rotation, Some(false), "default", 0.0, 3.0), &clicked).0;
        if let Ok(dir) = std::env::var("OPENSCREEN_CURSOR3D_FLAT_REF") {
            // Comparaison à des frames rendues par un commit de base : le même test, lancé
            // là-bas, écrit les références ; lancé ici, il les relit. La frame plate, et celle du
            // modèle au repos (sans clic), et le sprite plat au creux d'un clic.
            let preset = if rotation == "null" { "flat" } else { "iso" };
            for (kind, frame) in [("flat", &absent), ("model", &on), ("flat-click", &off_click)] {
                let name = format!("{dir}/{kind}-{preset}.rgba");
                match std::fs::read(&name) {
                    Ok(before) => assert!(&before == frame, "{rotation}: la frame {kind} diffère de la référence"),
                    Err(_) => std::fs::write(&name, frame).expect("écriture de la référence"),
                }
            }
        }
        assert!(absent == off, "{rotation}: model3d=false a changé la frame");
        assert!(absent == other, "{rotation}: un thème sans modèle a changé la frame");
        assert!(absent != on, "{rotation}: le réglage allumé ne change rien");
        let text_off = render(&comp, &screen, &scene_json(rotation, Some(false), "default", 0.0, 3.0), &text).0;
        let text_other = render(&comp, &screen, &scene_json(rotation, Some(true), "other", 0.0, 3.0), &text).0;
        let text_on = render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 3.0), &text).0;
        assert!(text_off == text_other, "{rotation}: le I d'un autre thème n'est plus plat");
        assert!(text_off != text_on, "{rotation}: le I du thème par défaut reste plat");
        assert!(text_off != off, "{rotation}: l'état n'a pas changé le sprite");
    }
}

/// Le lacet : en mouvement vers la droite, la flèche tourne sa pointe vers la droite ; un
/// curseur centré, lui, ne tourne pas.
#[test]
fn a_moving_pointer_turns_towards_its_motion_and_a_centred_cursor_does_not() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    let json = scene_json(r#""iso""#, Some(true), "default", 0.0, 3.0);
    // En T, la piste mobile passe en x = 0,2 + 0,6 × T / (T + 1) = 0,6 : la piste immobile y est.
    let moving_as = |key: Option<&str>| {
        track_as(&format!("moving-{}", key.unwrap_or("arrow")), key, &[(0.0, 0.2, 0.45, false), (T + 1.0, 0.8, 0.45, false)])
    };
    let still_as =
        |key: Option<&str>| track_as(&format!("still-yaw-{}", key.unwrap_or("arrow")), key, &[(0.0, 0.6, 0.45, false), (9.0, 0.6, 0.45, false)]);

    let (rgba, p) = render(&comp, &screen, &json, &moving_as(None));
    save("iso-moving", &rgba);
    // Au repos la queue descend à droite de la pointe ; tournée vers la droite, elle part vers
    // la gauche : l'extrémité de la queue (bas du corps) est donc moins à droite qu'au repos.
    let (rest, r) = render(&comp, &screen, &json, &still_as(None));
    let tail_x = |rgba: &[u8], p: &Probe| {
        let y = (p.tip[1] + 0.8 * p.unit) as i32;
        let xs: Vec<i32> = (0..1280).filter(|&x| is_neutral(px(rgba, x, y))).collect();
        xs.iter().sum::<i32>() as f32 / xs.len().max(1) as f32 - p.tip[0]
    };
    let (moving_x, rest_x) = (tail_x(&rgba, &p), tail_x(&rest, &r));
    println!("queue : {moving_x:.1} px en mouvement, {rest_x:.1} px au repos");
    assert!(moving_x < rest_x - 0.05 * p.unit, "la flèche ne tourne pas vers son mouvement");

    // Le redimensionnement horizontal, même mouvement : même silhouette qu'immobile. Sur un écran
    // à plat, que le mouvement du curseur n'incline pas : les deux pistes s'y croisent au pixel.
    let flat = scene_json("null", Some(true), "default", 0.0, 3.0);
    let silhouette = |rgba: &[u8]| -> Vec<bool> { (0..1280 * 720).map(|i| is_neutral(px(rgba, i % 1280, i / 1280))).collect() };
    let pair = |key: Option<&str>| {
        let (moved, pm) = render(&comp, &screen, &flat, &moving_as(key));
        let (held, ph) = render(&comp, &screen, &flat, &still_as(key));
        assert!((pm.tip[0] - ph.tip[0]).abs() < 0.01, "les deux pistes ne se croisent pas en T : {:?} / {:?}", pm.tip, ph.tip);
        iou(&silhouette(&moved), &silhouette(&held))
    };
    let (same, arrow_same) = (pair(Some("resize-ew")), pair(None));
    println!("silhouettes mobile/immobile : redimensionnement {same:.3}, flèche {arrow_same:.3}");
    assert!(same > 0.97, "le redimensionnement tourne avec son mouvement ({same})");
    assert!(arrow_same < same - 0.05, "la flèche devrait, elle, tourner ({arrow_same})");
}

/// La traînée de flou de mouvement : des copies du modèle, pas un sprite plat.
#[test]
fn the_motion_blur_trail_draws_modelled_copies() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    let moving = track("trail", &[(0.0, 0.2, 0.45, false), (T + 1.0, 0.8, 0.45, false)]);
    let (rgba, _) = render(&comp, &screen, &scene_json("null", Some(true), "default", 1.0, 3.0), &moving);
    let (flat, _) = render(&comp, &screen, &scene_json("null", Some(false), "default", 1.0, 3.0), &moving);
    save("flat-trail", &rgba);
    assert!(rgba != flat, "la traînée 3D est celle du sprite plat");
}

/// Planches à regarder (opt-in, `OPENSCREEN_CURSOR3D_OUT`) : les seize états en l'air sur un
/// écran à plat, chacun à côté de son sprite plat ; la flèche, la main et le I posés sur un écran
/// incliné ; et les grandes flèches (taille 8) qui servent à la comparaison avec le modèle
/// analytique d'avant.
#[test]
fn contact_sheets() {
    let Some(dir) = out_dir() else {
        eprintln!("OPENSCREEN_CURSOR3D_OUT absent — saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1280, 720).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    const CELL: u32 = 300;
    let crop = |rgba: &[u8], p: Probe| {
        let img = image::RgbaImage::from_raw(1280, 720, rgba.to_vec()).expect("readback");
        let (x, y) = ((p.tip[0] - 0.7 * p.unit).max(0.0) as u32, (p.tip[1] - 0.7 * p.unit).max(0.0) as u32);
        image::imageops::crop_imm(&img, x, y, CELL, CELL).to_image()
    };

    let mut sheet = image::RgbaImage::new(8 * CELL, 4 * CELL);
    for (i, (key, _)) in STATES.iter().enumerate() {
        let still = resting_as(&format!("sheet-{key}"), Some(key), false);
        let (flat, p) = render(&comp, &screen, &scene_json("null", Some(false), "default", 0.0, 5.0), &still);
        let (hover, q) = render(&comp, &screen, &scene_json("null", Some(true), "default", 0.0, 5.0), &still);
        let (col, row) = ((i % 4) as u32 * 2, (i / 4) as u32);
        image::imageops::overlay(&mut sheet, &crop(&flat, p), (col * CELL) as i64, (row * CELL) as i64);
        image::imageops::overlay(&mut sheet, &crop(&hover, q), ((col + 1) * CELL) as i64, (row * CELL) as i64);
    }
    sheet.save(format!("{dir}/states-hover-flat.png")).expect("planche");

    let mut tilted = image::RgbaImage::new(3 * CELL, 2 * CELL);
    for (i, key) in ["arrow", "pointer", "text"].iter().enumerate() {
        let clicked = resting_as(&format!("sheet-touch-{key}"), Some(key), true);
        for (row, rotation) in ["null", r#""iso""#].iter().enumerate() {
            let (touch, p) = render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 5.0), &clicked);
            image::imageops::overlay(&mut tilted, &crop(&touch, p), i as i64 * CELL as i64, row as i64 * CELL as i64);
        }
    }
    tilted.save(format!("{dir}/states-touch-flat-and-iso.png")).expect("planche");

    let (still, clicked) = (resting("big-still", false), resting("big-clicked", true));
    for (name, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
        for (case, tr) in [("hover", &still), ("touch", &clicked)] {
            let (rgba, _) = render(&comp, &screen, &scene_json(rotation, Some(true), "default", 0.0, 8.0), tr);
            save(&format!("big-{name}-{case}"), &rgba);
        }
    }
}

/// Coût d'une frame 1080p, curseur 3D allumé contre éteint (opt-in, à lancer en release). Le
/// readback synchronise chaque frame (sans lui on ne mesurerait que la mise en file) et pèse
/// autant des deux côtés : on alterne les deux réglages et on garde le meilleur de cinq passes.
/// `OPENSCREEN_CURSOR3D_BENCH=warp` mesure le backend logiciel (WARP) au lieu du GPU.
#[test]
fn bench_the_modelled_cursor_at_1080p() {
    let Ok(which) = std::env::var("OPENSCREEN_CURSOR3D_BENCH") else {
        eprintln!("OPENSCREEN_CURSOR3D_BENCH absent — saute");
        return;
    };
    let gpu = if which == "warp" {
        Gpu::create_backend(openscreen_compositor::d3d::Backend::Cpu, false).expect("WARP")
    } else {
        let Some(gpu) = gpu() else { return };
        gpu
    };
    let comp = Compositor::new_sized(&gpu, 1920, 1080).expect("compositor");
    let screen = FakeFrame::new(&gpu, Tint::Blue);
    let still = resting("bench", false);
    let text = resting_as("bench-text", Some("text"), false);
    // Un geste rapide : la traînée prend ses 16 copies.
    let fast = track("bench-fast", &[(0.0, 0.2, 0.45, false), (T - 0.15, 0.2, 0.45, false), (T + 0.15, 0.8, 0.45, false), (9.0, 0.8, 0.45, false)]);
    let time = |json: &str, track: &CursorTrack| {
        let scene = Scene::from_json(json).expect("scène");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(false);
        comp.set_scene(Some(scene));
        comp.set_cursor(track.clone());
        comp.set_cursor_time(Some(T));
        comp.set_timeline_time(Some(T));
        let cfg = cfg();
        let t0 = std::time::Instant::now();
        for _ in 0..100 {
            unsafe {
                comp.compose_frame(screen.as_ptr(), screen.as_ptr(), 0.0, &cfg).expect("compose");
                comp.readback_direct().expect("readback");
            }
        }
        t0.elapsed().as_secs_f64() * 10.0
    };
    for rotation in ["null", r#""iso""#] {
        for (label, blur, size, tr) in [
            ("taille 3, net", 0.0, 3.0, &still),
            ("taille 10, net", 0.0, 10.0, &still),
            ("taille 10, I", 0.0, 10.0, &text),
            ("taille 10, traînée 16", 1.0, 10.0, &fast),
        ] {
            let (off_json, on_json) = (
                scene_json(rotation, Some(false), "default", blur, size),
                scene_json(rotation, Some(true), "default", blur, size),
            );
            time(&off_json, tr);
            time(&on_json, tr);
            let (mut off, mut on) = (f64::MAX, f64::MAX);
            for _ in 0..5 {
                off = off.min(time(&off_json, tr));
                on = on.min(time(&on_json, tr));
            }
            println!("{which} 1080p {rotation} {label} : sprite {off:.2} ms, curseur 3D {on:.2} ms ({:+.2} ms)", on - off);
        }
    }
}
