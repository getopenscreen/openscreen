//! Les cadres d'appareil modelés (`effects.frame`, mode 17) rendus par le vrai compositeur
//! D3D11 : portable, téléphone et moniteur, à plat, sous un angle fixe et sous la caméra en
//! orbite, dans les deux thèmes et sur quatre formats de clip.
//!
//! La source est une frame NV12 SYNTHÉTIQUE, comme `cursor_model_render.rs` : rien à décoder,
//! donc le test tourne sur toute machine qui a un GPU, sans variable d'environnement. Sans
//! adaptateur matériel, il se saute (« test saute »).
//!
//! ```powershell
//! cargo test -p openscreen-compositor --test device_frame_render -- --nocapture
//! $env:OPENSCREEN_DEVICE_OUT = "...\renders"    # planches à regarder
//! $env:OPENSCREEN_DEVICE_BENCH = "1"            # coût d'une frame 1080p, cadre allumé/éteint
//! $env:OPENSCREEN_DEVICE_CLIP = "...\clip"      # 6 s de PNG pour un MP4 (portable en orbite)
//! ```

#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::ffi::AVFrame;
use openscreen_compositor::frame_geometry::{live_params_from_scene, plan_frame, FrameGeometry, FrameGeometryInput};
use openscreen_compositor::regions::TiltedQuad;
use openscreen_compositor::scene::Scene;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_WRITE_DISCARD, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DYNAMIC,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

const W: u32 = 1280;
const H: u32 = 720;
const SRC: (u32, u32) = (640, 360);
/// Instant rendu : en plein palier de la région de zoom.
const T: f32 = 2.0;

/// Les trois appareils modelés. Aucun n'est réservé à une forme de clip : c'est le cadre qui
/// s'adapte au métrage (cf. `SHAPES`).
const DEVICES: [&str; 3] = ["laptop", "phone", "monitor"];

/// Les formats de sortie passes en revue : paysage, portrait, et deux ratios inhabituels. Le
/// cadre s'adapte au METRAGE, donc chacun doit tenir dans chacun — un telephone autour d'un clip
/// paysage est un telephone couche, pas un telephone etire, et rien n'est jamais recadre pour
/// faire tenir un appareil.
const SHAPES: [(&str, (u32, u32), (u32, u32)); 4] = [
    ("16:9", (1280, 720), (640, 360)),
    ("9:16", (720, 1280), (360, 640)),
    ("4:3", (960, 720), (480, 360)),
    ("21:9", (1260, 540), (630, 270)),
];

fn gpu() -> Option<Gpu> {
    match Gpu::create(false) {
        Ok(g) => Some(g),
        Err(e) => {
            eprintln!("pas de device D3D11 matériel ({e:#}) — test saute");
            None
        }
    }
}

/// Deux teintes de contenu : un pixel identique sur les deux est de l'appareil ou du fond, un
/// pixel qui change est le métrage.
#[derive(Clone, Copy)]
enum Tint {
    Blue,
    Orange,
}

/// Une frame NV12 synthétique, striée pour que le métrage se distingue d'un aplat.
struct FakeFrame {
    frame: Box<AVFrame>,
    _tex: ID3D11Texture2D,
}

impl FakeFrame {
    fn new(gpu: &Gpu, (w, h): (u32, u32), tint: Tint) -> FakeFrame {
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
                    *dst.add(row * pitch + col) = if bar { 90 } else { 170 };
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

/// Une scène d'un seul écran : `frame` = la valeur du réglage (`""` = clé absente).
fn scene_json(frame: &str, rotation: &str, shadow: f32, cursor: &str, out: (u32, u32)) -> String {
    scene_json_themed(frame, "light", rotation, shadow, cursor, out)
}

/// `scene_json` avec le theme du cadre : clair (argent) ou sombre (graphite), pour TOUS les
/// cadres. Omis a « light », comme l'app l'omet.
fn scene_json_themed(
    frame: &str,
    theme: &str,
    rotation: &str,
    shadow: f32,
    cursor: &str,
    out: (u32, u32),
) -> String {
    let theme = if theme == "light" { String::new() } else { format!(r#","frameTheme":"{theme}""#) };
    let frame =
        if frame.is_empty() { String::new() } else { format!(r#","frame":"{frame}"{theme}"#) };
    let (ow, oh) = out;
    format!(
        r##"{{"clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                       "screenRect":{{"x":0.08,"y":0.08,"width":0.84,"height":0.84}}}},
            "effects":{{"padding":0.25,"blur":false,"shadow":{shadow},"roundnessFrac":0.02,"motionBlur":0{frame}}},
            "background":{{"kind":"gradient","angleDeg":135,"stops":["#5b6ee1","#e8a0bf"]}},
            "zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":10,"scale":1,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":{rotation}}}],
            "annotations":[],
            "cursor":{cursor},
            "cropByClip":[null],
            "output":{{"width":{ow},"height":{oh},"fps":30}}}}"##
    )
}

const NO_CURSOR: &str = r#"{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}"#;

fn cfg() -> Cfg {
    let mut cfg = Cfg::c8();
    cfg.bg_blur = false;
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.cursor = false;
    cfg.mblur_n = 1;
    cfg.shadow = true;
    cfg
}

fn render(comp: &Compositor, screen: &FakeFrame, json: &str, track: Option<&CursorTrack>, t: f32) -> Vec<u8> {
    let scene = Scene::from_json(json).expect("scène valide");
    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    comp.set_live_params(live);
    comp.set_has_webcam(false);
    comp.set_scene(Some(scene));
    let mut cfg = cfg();
    match track {
        Some(tr) => {
            cfg.cursor = true;
            comp.set_cursor(tr.clone());
            comp.set_cursor_time(Some(t));
        }
        None => comp.clear_cursor(),
    }
    comp.set_timeline_time(Some(t));
    unsafe {
        comp.compose_frame(screen.as_ptr(), screen.as_ptr(), 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback").2
    }
}

/// Le quadrilatère de l'écran RÉELLEMENT dessiné, en px de sortie — c'est l'ouverture que
/// l'appareil laisse au métrage —, et les marges de son CORPS, en fractions de ce quad. Même
/// chemin que les backends (`plan_frame` + `screen_tilt`).
fn aperture(json: &str, out: (u32, u32)) -> ([(f32, f32); 4], [f32; 4]) {
    let g = plan(json, out, SRC);
    let render_px = [out.0 as f32, out.1 as f32];
    let s = g.s_dst;
    let s_px = [s[2] * render_px[0], s[3] * render_px[1]];
    let center = [(s[0] + s[2] * 0.5) * render_px[0], (s[1] + s[3] * 0.5) * render_px[1]];
    let margins = g.window_frame.map(|f| f.margins).unwrap_or([0.0; 4]);
    let corners = match g.screen_tilt(s_px) {
        Some(q) => std::array::from_fn(|i| {
            let (fx, fy) = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)][i];
            let (x, y) = q.point_px(fx, fy);
            (center[0] + x, center[1] + y)
        }),
        None => std::array::from_fn(|i| {
            let (fx, fy) = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)][i];
            ((s[0] + s[2] * fx) * render_px[0], (s[1] + s[3] * fy) * render_px[1])
        }),
    };
    (corners, margins)
}

/// Le plan de la scène, par le même chemin que les backends.
fn plan(json: &str, out: (u32, u32), src: (u32, u32)) -> FrameGeometry {
    let scene = Scene::from_json(json).expect("scène valide");
    let cfg = cfg();
    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    let src = [src.0 as f32, src.1 as f32];
    plan_frame(&FrameGeometryInput {
        render_px: [out.0 as f32, out.1 as f32],
        screen_tex_px: src,
        screen_visible_px: src,
        webcam_visible_px: src,
        u_max: 1.0,
        v_max: 1.0,
        frame: 0.0,
        cfg: &cfg,
        live,
        scene: Some(&scene),
        cursor: None,
        timeline_t_override: Some(T),
        programme_time: None,
    })
}

/// Le métrage et le corps du cadre dans le repère du rect DROIT du métrage (px, origine au coin
/// haut-gauche), et le passage vers l'image rendue par le warp que le plan utilise VRAIMENT
/// (`TiltedQuad::point_px` : projectif sous un appareil ou la caméra, bilinéaire sinon) : un point
/// pris sur le métrage ou dans la lunette tombe au bon pixel, à plat comme incliné.
struct Geo {
    s_px: [f32; 2],
    /// Rayon des coins du métrage (et de l'ouverture), px.
    radius: f32,
    /// Corps : marges gauche, haut, droite, bas, et rayons extérieurs (coins hauts, bas), px.
    body: [f32; 4],
    body_radius: [f32; 2],
    tilt: Option<TiltedQuad>,
    center: [f32; 2],
    origin: [f32; 2],
}

impl Geo {
    fn new(json: &str, out: (u32, u32), src: (u32, u32)) -> Geo {
        let g = plan(json, out, src);
        let (rw, rh) = (out.0 as f32, out.1 as f32);
        let s_px = [g.s_dst[2] * rw, g.s_dst[3] * rh];
        let center = [(g.s_dst[0] + g.s_dst[2] * 0.5) * rw, (g.s_dst[1] + g.s_dst[3] * 0.5) * rh];
        let origin = [g.s_dst[0] * rw, g.s_dst[1] * rh];
        let (body, body_radius) = match g.window_frame {
            Some(f) => {
                let m = f.margins;
                ([m[0] * s_px[0], m[1] * s_px[1], m[2] * s_px[0], m[3] * s_px[1]], f.radius)
            }
            None => ([0.0; 4], [g.s_radius; 2]),
        };
        Geo { s_px, radius: g.s_radius, body, body_radius, tilt: g.screen_tilt(s_px), center, origin }
    }

    fn to_out(&self, p: [f32; 2]) -> (f32, f32) {
        match &self.tilt {
            Some(q) => {
                let (x, y) = q.point_px(p[0] / self.s_px[0], p[1] / self.s_px[1]);
                (self.center[0] + x, self.center[1] + y)
            }
            None => (self.origin[0] + p[0], self.origin[1] + p[1]),
        }
    }

    /// Distance signée au contour du métrage (rect arrondi de `radius`), <0 dedans.
    fn footage_sd(&self, p: [f32; 2]) -> f32 {
        let h = [self.s_px[0] * 0.5, self.s_px[1] * 0.5];
        sd_rr([p[0] - h[0], p[1] - h[1]], h, self.radius)
    }

    /// Distance signée au contour extérieur du corps, <0 dedans.
    fn body_sd(&self, p: [f32; 2]) -> f32 {
        let [l, t, r, b] = self.body;
        let h = [(self.s_px[0] + l + r) * 0.5, (self.s_px[1] + t + b) * 0.5];
        let c = [-l + h[0], -t + h[1]];
        let r = if p[1] < c[1] { self.body_radius[0] } else { self.body_radius[1] };
        sd_rr([p[0] - c[0], p[1] - c[1]], h, r)
    }

    /// Les sondes de couture : un point du bord du métrage, sa normale sortante, et jusqu'où
    /// marcher dehors sans quitter le corps du cadre (px). Le milieu des quatre bords et le
    /// sommet de l'arc des quatre coins — sauf les coins HAUTS de la fenêtre, carrés et à ras de
    /// la barre, dont le bord haut est déjà sondé.
    fn seam_probes(&self, window: bool) -> Vec<([f32; 2], [f32; 2], f32)> {
        let [w, h] = self.s_px;
        let [l, t, r, b] = self.body;
        // Jusqu'à un pixel et demi du bord EXTÉRIEUR du cadre : au-delà, c'est son propre
        // antialiasing sur le fond, pas une couture.
        let reach = |m: f32| (m - 1.5).min(6.0);
        let mut v = vec![
            ([w * 0.5, 0.0], [0.0, -1.0], reach(t)),
            ([w * 0.5, h], [0.0, 1.0], reach(b)),
            ([0.0, h * 0.5], [-1.0, 0.0], reach(l)),
            ([w, h * 0.5], [1.0, 0.0], reach(r)),
        ];
        let k = self.radius * (1.0 - std::f32::consts::FRAC_1_SQRT_2);
        let n = std::f32::consts::FRAC_1_SQRT_2;
        for (c, s, m) in [
            ([0.0, 0.0], [-1.0, -1.0], l.min(t)),
            ([w, 0.0], [1.0, -1.0], r.min(t)),
            ([w, h], [1.0, 1.0], r.min(b)),
            ([0.0, h], [-1.0, 1.0], l.min(b)),
        ] {
            if window && s[1] < 0.0 {
                continue;
            }
            v.push(([c[0] - s[0] * k, c[1] - s[1] * k], [s[0] * n, s[1] * n], reach(m)));
        }
        v
    }
}

/// `sd_round_rect` des shaders, <0 dedans.
fn sd_rr(p: [f32; 2], h: [f32; 2], r: f32) -> f32 {
    let r = r.min(h[0].min(h[1])).max(0.0);
    let q = [p[0].abs() - h[0] + r, p[1].abs() - h[1] + r];
    q[0].max(0.0).hypot(q[1].max(0.0)) + q[0].max(q[1]).min(0.0) - r
}

/// Un fond uni VERT, loin du métrage (lavande) comme des lunettes (neutres) : un pixel vert dans
/// une couture ou dans un coin de lunette, c'est le fond d'écran qui passe.
fn on_green(json: &str) -> String {
    json.replace(
        r##"{"kind":"gradient","angleDeg":135,"stops":["#5b6ee1","#e8a0bf"]}"##,
        r##"{"kind":"color","color":"#10c040"}"##,
    )
}

fn greenish(p: [u8; 3]) -> bool {
    p[1] as i32 - p[0].max(p[2]) as i32 > 30
}

/// Roundness au maximum : au-delà de la moitié du petit côté, le rayon est borné
/// (`screen_corner_radius_px`), donc 1 est le bout du slider et au-delà.
const MAX_ROUND: f32 = 1.0;

fn with_roundness(json: &str, r: f32) -> String {
    json.replace(r#""roundnessFrac":0.02"#, &format!(r#""roundnessFrac":{r}"#))
}

/// Le métrage dans un rect PLUS PETIT que celui des planches, pour que le cadre tienne entier
/// dans l'image (pied du moniteur compris) : `(x, y, w, h)` en fractions de la sortie.
fn with_rect(json: &str, r: (f32, f32, f32, f32)) -> String {
    json.replace(
        r#""screenRect":{"x":0.08,"y":0.08,"width":0.84,"height":0.84}"#,
        &format!(r#""screenRect":{{"x":{},"y":{},"width":{},"height":{}}}"#, r.0, r.1, r.2, r.3),
    )
}

/// Un clip paysage et un clip PORTRAIT dans le même projet 16:9 (1280×720) : le portrait est un
/// rect étroit au ratio 9:16 exact.
const CLIPS: [(&str, (f32, f32, f32, f32), (u32, u32)); 2] = [
    ("landscape", (0.2, 0.14, 0.6, 0.6), (640, 360)),
    ("portrait", (0.3734375, 0.1, 0.253125, 0.8), (360, 640)),
];

/// Le point du quad aux fractions (fx, fy), prolongé au-delà de 0..1 par l'homographie de ses
/// coins — donc aussi juste dans la lunette, qui vit hors de l'écran.
fn quad_at(q: &[(f32, f32); 4], fx: f32, fy: f32) -> (f32, f32) {
    // Homographie du carré unité sur le quad (forme de Heckbert), comme `regions::square_to_quad`.
    let (x0, y0) = q[0];
    let (dx1, dy1) = (q[1].0 - q[2].0, q[1].1 - q[2].1);
    let (dx2, dy2) = (q[3].0 - q[2].0, q[3].1 - q[2].1);
    let (sx, sy) = (q[0].0 - q[1].0 + q[2].0 - q[3].0, q[0].1 - q[1].1 + q[2].1 - q[3].1);
    let den = dx1 * dy2 - dx2 * dy1;
    let (g, h) = if den.abs() < 1e-9 {
        (0.0, 0.0)
    } else {
        ((sx * dy2 - dx2 * sy) / den, (dx1 * sy - sx * dy1) / den)
    };
    let a = q[1].0 - q[0].0 + g * q[1].0;
    let b = q[3].0 - q[0].0 + h * q[3].0;
    let d = q[1].1 - q[0].1 + g * q[1].1;
    let e = q[3].1 - q[0].1 + h * q[3].1;
    let w = g * fx + h * fy + 1.0;
    ((a * fx + b * fy + x0) / w, (d * fx + e * fy + y0) / w)
}

fn px(rgba: &[u8], out: (u32, u32), x: f32, y: f32) -> Option<[u8; 3]> {
    let (xi, yi) = (x.round() as i32, y.round() as i32);
    if xi < 0 || yi < 0 || xi >= out.0 as i32 || yi >= out.1 as i32 {
        return None;
    }
    let i = ((yi * out.0 as i32 + xi) * 4) as usize;
    Some([rgba[i], rgba[i + 1], rgba[i + 2]])
}

fn neutral(p: [u8; 3]) -> bool {
    p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]) < 40
}

fn differing(a: &[u8], b: &[u8], tol: u8) -> usize {
    a.chunks_exact(4)
        .zip(b.chunks_exact(4))
        .filter(|(p, q)| p.iter().zip(q.iter()).take(3).any(|(x, y)| x.abs_diff(*y) > tol))
        .count()
}

fn out_dir(var: &str) -> Option<String> {
    let dir = std::env::var(var).ok()?;
    std::fs::create_dir_all(&dir).expect("dossier de sortie");
    Some(dir)
}

fn save(dir: &str, name: &str, rgba: &[u8], out: (u32, u32)) {
    image::RgbaImage::from_raw(out.0, out.1, rgba.to_vec())
        .expect("dimensions du readback")
        .save(format!("{dir}/{name}.png"))
        .unwrap_or_else(|e| panic!("écriture {name} : {e}"));
}

/// Chaque appareil se dessine AUTOUR du metrage sans jamais le recouvrir, QUELLE QUE SOIT la
/// forme du clip : dans l'ouverture, le pixel change avec la teinte de la source (c'est le
/// metrage que le mode 8 y dessine) ; dans la lunette, il n'en depend pas et il est neutre
/// (c'est l'appareil, pas le fond d'ecran colore).
///
/// Les quatre formats couvrent ce que le produit demande : un telephone autour d'un clip paysage
/// est un telephone couche, un portable autour d'un clip portrait reste un portable, et deux
/// ratios inhabituels (4:3, 21:9) disent que rien ne degenere.
#[test]
fn each_device_draws_around_untouched_footage() {
    let Some(gpu) = gpu() else { return };
    for (shape, out, src) in SHAPES {
        let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
        let blue = FakeFrame::new(&gpu, src, Tint::Blue);
        let orange = FakeFrame::new(&gpu, src, Tint::Orange);
        for &device in &DEVICES {
            for rotation in ["null", r#""iso""#, r#""follow-cursor""#] {
                let json = scene_json(device, rotation, 0.0, NO_CURSOR, out);
                let a = render(&comp, &blue, &json, None, T);
                let b = render(&comp, &orange, &json, None, T);
                let (q, margins) = aperture(&json, out);

                // Dans l'ouverture, bien a l'interieur du bord : du metrage, partout.
                for i in 1..=9 {
                    for j in 1..=9 {
                        let (x, y) = quad_at(&q, i as f32 / 10.0, j as f32 / 10.0);
                        let (Some(pa), Some(pb)) = (px(&a, out, x, y), px(&b, out, x, y)) else {
                            panic!("{shape} {device} {rotation} : l'ouverture sort de l'image");
                        };
                        assert_ne!(
                            pa, pb,
                            "{shape} {device} {rotation} : ({x:.0},{y:.0}) n'est pas du metrage"
                        );
                    }
                }

                // Juste DEHORS, au milieu de la lunette : l'appareil, et lui seul.
                let [ml, mt, mr, mb] = margins.map(|v| v * 0.5);
                let mut bezel = 0;
                for k in 1..=9 {
                    let s = k as f32 / 10.0;
                    for ((fx, fy), (ex, ey)) in [(s, -mt), (s, 1.0 + mb), (-ml, s), (1.0 + mr, s)]
                        .into_iter()
                        .zip([(s, 0.0), (s, 1.0), (0.0, s), (1.0, s)])
                    {
                        let (x, y) = quad_at(&q, fx, fy);
                        // Une lunette vue par la tranche peut mesurer moins d'un pixel.
                        let (bx, by) = quad_at(&q, ex, ey);
                        if (x - bx).hypot(y - by) < 2.5 {
                            continue;
                        }
                        let (Some(pa), Some(pb)) = (px(&a, out, x, y), px(&b, out, x, y)) else {
                            continue;
                        };
                        assert_eq!(
                            pa, pb,
                            "{shape} {device} {rotation} : du metrage deborde en ({x:.0},{y:.0})"
                        );
                        assert!(
                            neutral(pa),
                            "{shape} {device} {rotation} : ({x:.0},{y:.0}) = {pa:?}, pas l'appareil"
                        );
                        bezel += 1;
                    }
                }
                assert!(bezel >= 18, "{shape} {device} {rotation} : {bezel} points de lunette");

                // Et l'appareil se voit.
                let bare =
                    render(&comp, &blue, &scene_json("none", rotation, 0.0, NO_CURSOR, out), None, T);
                let seen = differing(&a, &bare, 8);
                println!("{shape:<5} {device:<8} {rotation:<16} {seen:>7} px changent");
                // Une lunette fine autour d'un grand metrage : un anneau de 1 a 2 % de la largeur.
                assert!(
                    seen > (out.0 * out.1) as usize / 80,
                    "{shape} {device} {rotation} : cadre invisible"
                );
            }
        }
    }
}

/// Les deux themes donnent deux objets differents, et le metrage ne bouge pas d'un pixel entre
/// les deux : le theme peint la coque, il ne touche pas a l'image.
#[test]
fn the_frame_theme_repaints_the_body_and_nothing_else() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    for &device in &["window", "laptop", "phone", "monitor"] {
        for rotation in ["null", r#""iso""#] {
            let light =
                render(&comp, &screen, &scene_json_themed(device, "light", rotation, 0.0, NO_CURSOR, (W, H)), None, T);
            let dark =
                render(&comp, &screen, &scene_json_themed(device, "dark", rotation, 0.0, NO_CURSOR, (W, H)), None, T);
            let seen = differing(&light, &dark, 8);
            println!("{device:<8} {rotation:<8} clair/sombre {seen:>7} px");
            assert!(seen > (W * H) as usize / 200, "{device} {rotation} : les deux themes se confondent");
            // Le metrage : identique au bit pres dans l'ouverture.
            let (q, _) = aperture(&scene_json(device, rotation, 0.0, NO_CURSOR, (W, H)), (W, H));
            for i in 1..=9 {
                for j in 1..=9 {
                    let (x, y) = quad_at(&q, i as f32 / 10.0, j as f32 / 10.0);
                    let (Some(pa), Some(pb)) = (px(&light, (W, H), x, y), px(&dark, (W, H), x, y))
                    else {
                        continue;
                    };
                    assert_eq!(pa, pb, "{device} {rotation} : le theme a touche le metrage");
                }
            }
        }
    }
}

/// L'appareil suit le plan : incliné ou vu par la caméra en orbite, il n'est plus là où il était
/// à plat, et il reste à l'intérieur de l'image. À plat et curseur éteint, deux rendus successifs
/// sont identiques à l'octet — une fonction pure de `t`.
#[test]
fn the_device_follows_the_tilt_and_the_orbit_camera() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    for &device in &["laptop", "window"] {
        let flat = render(&comp, &screen, &scene_json(device, "null", 0.0, NO_CURSOR, (W, H)), None, T);
        assert!(
            flat == render(&comp, &screen, &scene_json(device, "null", 0.0, NO_CURSOR, (W, H)), None, T),
            "{device} : le rendu à plat n'est pas stable"
        );
        for rotation in [r#""iso""#, r#""left""#, r#""follow-cursor""#] {
            let tilted = render(&comp, &screen, &scene_json(device, rotation, 0.0, NO_CURSOR, (W, H)), None, T);
            let moved = differing(&flat, &tilted, 8);
            println!("{device:<8} {rotation:<16} {moved:>7} px bougent");
            assert!(moved > (W * H) as usize / 20, "{device} {rotation} : l'appareil n'a pas suivi");
            // (Le cadre peut sortir de l'image : le métrage garde sa taille et le cadre pousse
            // vers l'extérieur, la sortie le coupe. `the_footage_box_is_the_same_under_every_frame`.)
        }
    }
}

/// Le cadre porte l'ombre, pas l'écran : avec l'ombre allumée, le fond s'assombrit AUTOUR de
/// l'appareil, y compris sous le socle du portable, qui descend plus bas que l'écran.
#[test]
fn the_frame_casts_the_contact_shadow() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    for &device in &DEVICES {
        let on = render(&comp, &screen, &scene_json(device, "null", 0.7, NO_CURSOR, (W, H)), None, T);
        let off = render(&comp, &screen, &scene_json(device, "null", 0.0, NO_CURSOR, (W, H)), None, T);
        let mut darker = 0usize;
        let mut lowest = 0u32;
        for y in 0..H {
            for x in 0..W {
                let i = ((y * W + x) * 4) as usize;
                let (a, b) = (&on[i..i + 3], &off[i..i + 3]);
                if a.iter().zip(b.iter()).all(|(p, q)| *p < *q) && b.iter().any(|c| *c > 60) {
                    darker += 1;
                    lowest = lowest.max(y);
                }
            }
        }
        let bottom = aperture(&scene_json(device, "null", 0.0, NO_CURSOR, (W, H)), (W, H))
            .0
            .iter()
            .fold(0.0f32, |m, &(_, y)| m.max(y));
        println!("{device:<8} ombre {darker:>7} px, jusqu'à y={lowest} (écran jusqu'à {bottom:.0})");
        assert!(darker > (W * H) as usize / 200, "{device} : pas d'ombre ({darker} px)");
        assert!(lowest as f32 > bottom, "{device} : l'ombre s'arrête au-dessus du bas de l'écran");
    }
}

/// AUCUNE couture ne laisse passer le fond d'écran entre le métrage et son cadre : le long de
/// chaque bord et à travers chaque coin, du dedans du métrage jusqu'au corps du cadre, pas un
/// pixel n'est du fond. Fond VERT, loin du métrage comme des lunettes : la moindre frange s'y
/// voit. Roundness 0 et maximal, à plat, angle fixe et caméra en orbite, 1080p et 4K — le
/// recouvrement se compte en pixels (`DEV_OVERLAP_PX`), il doit tenir à toutes les tailles.
#[test]
fn no_seam_lets_the_wallpaper_through() {
    let Some(gpu) = gpu() else { return };
    for (res, out) in [("1080p", (1920u32, 1080u32)), ("4K", (3840, 2160))] {
        let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
        let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
        for frame in ["window", "laptop", "phone", "monitor"] {
            for roundness in [0.0f32, MAX_ROUND] {
                for rotation in ["null", r#""iso""#, r#""follow-cursor""#] {
                    let json = on_green(&with_roundness(&scene_json(frame, rotation, 0.6, NO_CURSOR, out), roundness));
                    let rgba = render(&comp, &screen, &json, None, T);
                    let g = Geo::new(&json, out, SRC);
                    let (mut seen, mut leaks) = (0usize, Vec::new());
                    for (p, n, reach) in g.seam_probes(frame == "window") {
                        let mut d = -2.5f32;
                        while d <= reach {
                            let (x, y) = g.to_out([p[0] + n[0] * d, p[1] + n[1] * d]);
                            if let Some(c) = px(&rgba, out, x, y) {
                                seen += 1;
                                if greenish(c) {
                                    leaks.push((x.round(), y.round(), c));
                                }
                            }
                            d += 0.5;
                        }
                    }
                    let case = format!("{res} {frame} r{roundness} {rotation}");
                    println!("{case:<40} {seen:>4} px sondés, {} verts", leaks.len());
                    assert!(seen > 30, "{case} : trop peu de sondes ({seen})");
                    assert!(leaks.is_empty(), "{case} : le fond passe en {:?}", &leaks[..leaks.len().min(6)]);
                }
            }
        }
    }
}

/// Au Roundness MAXIMAL, la région du coin entre l'arc du métrage et le coin carré n'est JAMAIS du
/// métrage (il changerait avec la teinte de la source), et là où elle est dans le corps du cadre,
/// jamais du fond (vert) : de la lunette, pixel par pixel. C'est là que le métrage non borné et
/// l'ouverture bornée traçaient deux coins différents. Le corps est concentrique au métrage : loin
/// de l'arc, le coin carré lui-même est hors du corps — du fond, voulu.
#[test]
fn the_bezel_fills_the_corners_at_maximum_roundness() {
    let Some(gpu) = gpu() else { return };
    let out = (1920u32, 1080u32);
    let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
    let blue = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let orange = FakeFrame::new(&gpu, SRC, Tint::Orange);
    for frame in ["window", "laptop", "phone", "monitor"] {
        for rotation in ["null", r#""iso""#, r#""follow-cursor""#] {
            let json = on_green(&with_roundness(&scene_json(frame, rotation, 0.0, NO_CURSOR, out), MAX_ROUND));
            let (a, b) = (render(&comp, &blue, &json, None, T), render(&comp, &orange, &json, None, T));
            let g = Geo::new(&json, out, SRC);
            let [w, h] = g.s_px;
            // Coins : origine et sens vers l'intérieur. La fenêtre n'a que ses coins BAS arrondis.
            let corners: &[([f32; 2], [f32; 2])] = if frame == "window" {
                &[([w, h], [-1.0, -1.0]), ([0.0, h], [1.0, -1.0])]
            } else {
                &[([0.0, 0.0], [1.0, 1.0]), ([w, 0.0], [-1.0, 1.0]), ([w, h], [-1.0, -1.0]), ([0.0, h], [1.0, -1.0])]
            };
            let (mut n, mut inside, mut bad) = (0usize, 0usize, Vec::new());
            // Le carré du coin, de son sommet jusqu'au rayon : dehors l'arc, dedans le corps.
            for &(c, s) in corners {
                let mut u = 0.75f32;
                while u < g.radius {
                    let mut v = 0.75f32;
                    while v < g.radius {
                        let p = [c[0] + s[0] * u, c[1] + s[1] * v];
                        // Hors de l'arc : jamais de metrage. Et dans le corps : jamais de fond.
                        // (3,5 px du plan : un angle fixe raccourcit le côté lointain, et la frange
                        // d'antialiasing du métrage fait 1,5 px d'IMAGE.)
                        if g.footage_sd(p) > 3.5 {
                            let (x, y) = g.to_out(p);
                            if let (Some(pa), Some(pb)) = (px(&a, out, x, y), px(&b, out, x, y)) {
                                let in_body = g.body_sd(p) < -2.0;
                                n += 1;
                                inside += in_body as usize;
                                if pa != pb || (in_body && greenish(pa)) {
                                    bad.push((x.round(), y.round(), pa, pb));
                                }
                            }
                        }
                        v += 1.5;
                    }
                    u += 1.5;
                }
            }
            println!("{frame:<8} {rotation:<16} {n:>6} px de coin dont {inside:>6} dans le corps, {} faux", bad.len());
            // Sous un petit rayon, le coin carré n'est qu'à quelques pixels de l'arc, en deçà de la
            // frange sondée : on ne compte la région que quand le rayon en laisse une.
            if g.radius * (std::f32::consts::SQRT_2 - 1.0) > 8.0 {
                // La fenêtre ne se sonde qu'à ses deux coins BAS (les hauts sont sa barre), sous un
                // rayon plus petit que celui du téléphone : une région bien moindre à compter.
                let min_n = if frame == "window" { 40 } else { 200 };
                assert!(n > min_n, "{frame} {rotation} : région de coin vide ({n})");
                // La fenetre n'a qu'un filet d'un pixel entre son arc et celui du metrage.
                assert!(frame == "window" || inside > 200, "{frame} {rotation} : lunette de coin vide ({inside})");
            }
            assert!(bad.is_empty(), "{frame} {rotation} : métrage ou fond dans le coin en {:?}", &bad[..bad.len().min(6)]);
        }
    }
}

/// Distance (px) de chaque pixel au masque, par chanfrein (1, √2) en deux passes : elle
/// SURESTIME l'euclidienne d'au plus 8 %, donc une borne vérifiée sur elle vaut a fortiori.
fn distance_to(mask: &[bool], w: usize, h: usize) -> Vec<f32> {
    let s2 = std::f32::consts::SQRT_2;
    let mut d: Vec<f32> = mask.iter().map(|&m| if m { 0.0 } else { 1e9 }).collect();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut v = d[i];
            if x > 0 {
                v = v.min(d[i - 1] + 1.0);
            }
            if y > 0 {
                v = v.min(d[i - w] + 1.0);
                if x > 0 {
                    v = v.min(d[i - w - 1] + s2);
                }
                if x + 1 < w {
                    v = v.min(d[i - w + 1] + s2);
                }
            }
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            let mut v = d[i];
            if x + 1 < w {
                v = v.min(d[i + 1] + 1.0);
            }
            if y + 1 < h {
                v = v.min(d[i + w] + 1.0);
                if x + 1 < w {
                    v = v.min(d[i + w + 1] + s2);
                }
                if x > 0 {
                    v = v.min(d[i + w - 1] + s2);
                }
            }
            d[i] = v;
        }
    }
    d
}

/// L'ombre d'un appareil a la forme de sa SILHOUETTE 3D, socle et pied compris : aucun pixel
/// assombri à plus de décalage + pénombre de la silhouette (l'ancien quad plat pendait sous le
/// portable comme une dalle grise), et une ombre bien présente juste sous le socle et le pied.
/// Clair et sombre, à plat, angle fixe et orbite.
#[test]
fn the_device_shadow_follows_the_silhouette() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let blue = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let orange = FakeFrame::new(&gpu, SRC, Tint::Orange);
    let rect = CLIPS[0].1;
    // SCREEN_SHADOW_SPREAD_FRAC (40 px réglés contre un cadre 1080), en px de CETTE sortie.
    let spread = 40.0 / 1080.0 * W.min(H) as f32;
    for frame in ["laptop", "monitor", "phone"] {
        for theme in ["light", "dark"] {
            for rotation in ["null", r#""iso""#, r#""follow-cursor""#] {
                let json = |shadow: f32, f: &str| {
                    with_rect(&scene_json_themed(f, theme, rotation, shadow, NO_CURSOR, (W, H)), rect)
                };
                let on = render(&comp, &blue, &json(1.0, frame), None, T);
                let off = render(&comp, &blue, &json(0.0, frame), None, T);
                let off_o = render(&comp, &orange, &json(0.0, frame), None, T);
                let bare = render(&comp, &blue, &json(0.0, "none"), None, T);
                let (w, h) = (W as usize, H as usize);
                let differs = |a: &[u8], b: &[u8], i: usize, tol: u8| {
                    (0..3).any(|k| a[i * 4 + k].abs_diff(b[i * 4 + k]) > tol)
                };
                // La silhouette : l'appareil (ce qui change avec le cadre) et le métrage (ce qui
                // change avec la teinte de la source).
                let sil: Vec<bool> =
                    (0..w * h).map(|i| differs(&off, &bare, i, 6) || differs(&off, &off_o, i, 6)).collect();
                let dist = distance_to(&sil, w, h);
                let g = plan(&json(1.0, frame), (W, H), SRC);
                let off_px = g.screen_shadow_offset();
                let reach = (off_px[0].hypot(off_px[1]) + spread) * 1.09 + 2.0;
                let (mut shade, mut worst) = (0usize, 0.0f32);
                for i in 0..w * h {
                    let darker = (0..3).all(|k| on[i * 4 + k] <= off[i * 4 + k])
                        && (0..3).any(|k| off[i * 4 + k] - on[i * 4 + k] > 2);
                    if darker && !sil[i] {
                        shade += 1;
                        worst = worst.max(dist[i]);
                    }
                }
                // Juste sous la silhouette, dans la colonne du milieu : de l'ombre.
                let x = w / 2;
                let low = (0..h).rev().find(|&y| sil[y * w + x]).expect("silhouette");
                let under = (low + 2..(low + 8).min(h)).any(|y| {
                    let i = y * w + x;
                    (0..3).any(|k| off[i * 4 + k].saturating_sub(on[i * 4 + k]) > 4)
                });
                let case = format!("{frame} {theme} {rotation}");
                println!("{case:<28} ombre {shade:>7} px, au plus à {worst:.1} px (borne {reach:.1})");
                assert!(shade > (w * h) / 200, "{case} : pas d'ombre");
                assert!(worst <= reach, "{case} : ombre à {worst} px de la silhouette (borne {reach})");
                assert!(under || low + 3 >= h, "{case} : pas d'ombre sous la silhouette (y = {low})");
            }
        }
    }
}

/// Planches a regarder (opt-in, `OPENSCREEN_DEVICE_OUT`) : chaque appareil a plat et sous `iso`,
/// dans les deux themes, plus un gros plan de la charniere du portable pour juger le chanfrein.
#[test]
fn contact_sheets() {
    let Some(dir) = out_dir("OPENSCREEN_DEVICE_OUT") else {
        eprintln!("OPENSCREEN_DEVICE_OUT absent - saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let all: [&str; 4] = ["window", "laptop", "phone", "monitor"];
    // Une planche par theme : quatre cadres x (plat, iso).
    for theme in ["light", "dark"] {
        let mut sheet = image::RgbaImage::new(W * 2, H * 4);
        for (row, &device) in all.iter().enumerate() {
            for (col, (name, rotation)) in [("flat", "null"), ("iso", r#""iso""#)].iter().enumerate()
            {
                let json = scene_json_themed(device, theme, rotation, 0.6, NO_CURSOR, (W, H));
                let rgba = render(&comp, &screen, &json, None, T);
                save(&dir, &format!("{device}-{name}-{theme}"), &rgba, (W, H));
                let img = image::RgbaImage::from_raw(W, H, rgba).expect("readback");
                image::imageops::overlay(&mut sheet, &img, (col as u32 * W) as i64, (row as u32 * H) as i64);
            }
        }
        sheet.save(format!("{dir}/devices-{theme}.png")).expect("planche");
    }
    // Le telephone dans les deux orientations de clip : debout et couche.
    for (name, out, src) in [("portrait", (720u32, 1280u32), (360u32, 640u32)), ("landscape", (W, H), SRC)] {
        let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
        let f = FakeFrame::new(&gpu, src, Tint::Blue);
        for (label, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
            let rgba = render(&comp, &f, &scene_json("phone", rotation, 0.6, NO_CURSOR, out), None, T);
            save(&dir, &format!("phone-{name}-{label}"), &rgba, out);
        }
    }
    // Ratios inhabituels : rien ne degenere.
    for (shape, out, src) in SHAPES {
        let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
        let f = FakeFrame::new(&gpu, src, Tint::Blue);
        for &device in &["laptop", "monitor"] {
            let rgba = render(&comp, &f, &scene_json(device, "null", 0.6, NO_CURSOR, out), None, T);
            save(&dir, &format!("shape-{}-{device}", shape.replace(':', "x")), &rgba, out);
        }
    }
    // Gros plan : les coins HAUTS du chrome de fenetre, au rayon maximal. C'est la qu'ils etaient
    // faux (cadre arrondi, metrage carre) et que l'arrondi mordait la premiere pastille.
    for roundness in ["0.02", "0.09"] {
        let json = scene_json("window", "null", 0.6, NO_CURSOR, (W, H))
            .replace(r#""roundnessFrac":0.02"#, &format!(r#""roundnessFrac":{roundness}"#));
        let rgba = render(&comp, &screen, &json, None, T);
        let img = image::RgbaImage::from_raw(W, H, rgba).expect("readback");
        let crop = image::imageops::crop_imm(&img, 120, 30, 420, 150).to_image();
        let zoom = image::imageops::resize(&crop, 420 * 3, 150 * 3, image::imageops::FilterType::Nearest);
        zoom.save(format!("{dir}/window-top-corner-r{}.png", roundness.replace('.', "")))
            .expect("gros plan");
    }
    // Gros plan : la charniere et l'arete du portable, agrandies cinq fois au plus proche pour
    // que le micro-chanfrein et son filet de lumiere se jugent au pixel.
    let rgba = render(&comp, &screen, &scene_json("laptop", r#""iso""#, 0.6, NO_CURSOR, (W, H)), None, T);
    let img = image::RgbaImage::from_raw(W, H, rgba).expect("readback");
    let crop = image::imageops::crop_imm(&img, W / 2 - 120, H / 2 - 20, 240, 150).to_image();
    let zoom = image::imageops::resize(&crop, 240 * 5, 150 * 5, image::imageops::FilterType::Nearest);
    zoom.save(format!("{dir}/laptop-hinge-closeup.png")).expect("gros plan");
    println!("planches ecrites dans {dir}");
}

/// Un carré de `2r` px centré sur `p`, agrandi `k` fois au plus proche.
fn closeup(rgba: &[u8], out: (u32, u32), p: (f32, f32), r: u32, k: u32) -> image::RgbaImage {
    let img = image::RgbaImage::from_raw(out.0, out.1, rgba.to_vec()).expect("readback");
    let x0 = (p.0.round() as i64 - r as i64).clamp(0, (out.0 - 2 * r) as i64) as u32;
    let y0 = (p.1.round() as i64 - r as i64).clamp(0, (out.1 - 2 * r) as i64) as u32;
    let crop = image::imageops::crop_imm(&img, x0, y0, 2 * r, 2 * r).to_image();
    image::imageops::resize(&crop, 2 * r * k, 2 * r * k, image::imageops::FilterType::Nearest)
}

/// Des images côte à côte, séparées d'un filet blanc.
fn strip(imgs: &[image::RgbaImage]) -> image::RgbaImage {
    let h = imgs.iter().map(|i| i.height()).max().unwrap_or(1);
    let w = imgs.iter().map(|i| i.width() + 6).sum::<u32>();
    let mut s = image::RgbaImage::from_pixel(w, h, image::Rgba([255, 255, 255, 255]));
    let mut x = 0i64;
    for i in imgs {
        image::imageops::overlay(&mut s, i, x, 0);
        x += i.width() as i64 + 6;
    }
    s
}

fn save_in(dir: &str, sub: &str, name: &str, img: &image::RgbaImage) {
    let d = format!("{dir}/{sub}");
    std::fs::create_dir_all(&d).expect("dossier");
    img.save(format!("{d}/{name}.png")).unwrap_or_else(|e| panic!("écriture {name} : {e}"));
}

/// Les rendus de la passe 3 (opt-in, `OPENSCREEN_DEVICE_V3`) : chaque cadre autour d'un clip
/// paysage et d'un clip portrait, à plat et sous `iso`, dans les deux thèmes ; les gros plans de
/// coins (portable, fenêtre) à Roundness 0, par défaut et maximal ; les coutures sur fond vert ;
/// les ombres (plat, iso, orbite) ; et les vues de face à comparer aux références produit.
#[test]
fn v3_renders() {
    let Some(dir) = out_dir("OPENSCREEN_DEVICE_V3") else {
        eprintln!("OPENSCREEN_DEVICE_V3 absent - saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let all: [&str; 4] = ["window", "laptop", "phone", "monitor"];
    let cams = [("flat", "null"), ("iso", r#""iso""#)];
    let img = |rgba: Vec<u8>| image::RgbaImage::from_raw(W, H, rgba).expect("readback");

    // 1. Paysage et portrait, plat et iso, clair et sombre : une image par cas, une planche par
    // clip et par thème.
    for (clip, rect, src) in CLIPS {
        let f = FakeFrame::new(&gpu, src, Tint::Blue);
        for theme in ["light", "dark"] {
            let mut sheet = image::RgbaImage::new(W * 2, H * 4);
            for (row, &frame) in all.iter().enumerate() {
                for (col, (cam, rotation)) in cams.iter().enumerate() {
                    let json = with_rect(&scene_json_themed(frame, theme, rotation, 0.6, NO_CURSOR, (W, H)), rect);
                    let i = img(render(&comp, &f, &json, None, T));
                    save_in(&dir, "clips", &format!("{frame}-{clip}-{cam}-{theme}"), &i);
                    image::imageops::overlay(&mut sheet, &i, (col as u32 * W) as i64, (row as u32 * H) as i64);
                }
            }
            save_in(&dir, "clips", &format!("sheet-{clip}-{theme}"), &sheet);
        }
    }

    // 2. Gros plans de coins : les quatre coins de l'écran du portable et de la fenêtre, pris au
    // sommet de l'arc du métrage.
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let arc_points = |g: &Geo| {
        let [w, h] = g.s_px;
        let k = g.radius * (1.0 - std::f32::consts::FRAC_1_SQRT_2);
        [[k, k], [w - k, k], [w - k, h - k], [k, h - k]].map(|p| g.to_out(p))
    };
    for (label, roundness) in [("r0", 0.0f32), ("r002", 0.02), ("rmax", MAX_ROUND)] {
        for frame in ["laptop", "window", "phone", "monitor"] {
            for (cam, rotation) in cams {
                let json =
                    with_roundness(&with_rect(&scene_json(frame, rotation, 0.6, NO_CURSOR, (W, H)), CLIPS[0].1), roundness);
                let rgba = render(&comp, &screen, &json, None, T);
                let g = Geo::new(&json, (W, H), SRC);
                let crops: Vec<_> = arc_points(&g).iter().map(|&p| closeup(&rgba, (W, H), p, 30, 5)).collect();
                save_in(&dir, "closeups", &format!("{frame}-corners-{label}-{cam}"), &strip(&crops));
            }
        }
    }

    // 3. Coutures sur fond VERT : les quatre coins (sommet de l'arc) et le milieu du bord bas,
    // Roundness 0 et maximal, à plat et iso.
    for frame in all {
        for (label, roundness) in [("r0", 0.0f32), ("rmax", MAX_ROUND)] {
            for (cam, rotation) in cams {
                let json = on_green(&with_roundness(&scene_json(frame, rotation, 0.6, NO_CURSOR, (W, H)), roundness));
                let rgba = render(&comp, &screen, &json, None, T);
                let g = Geo::new(&json, (W, H), SRC);
                let mut pts = arc_points(&g).to_vec();
                pts.push(g.to_out([g.s_px[0] * 0.5, g.s_px[1]]));
                let crops: Vec<_> = pts.iter().map(|&p| closeup(&rgba, (W, H), p, 16, 8)).collect();
                save_in(&dir, "seams", &format!("{frame}-{label}-{cam}"), &strip(&crops));
            }
        }
    }

    // 4. Ombres : chaque cadre, clair et sombre, à plat, iso et en orbite, ombre au maximum.
    for frame in all {
        for theme in ["light", "dark"] {
            let mut row = Vec::new();
            for (cam, rotation) in [("flat", "null"), ("iso", r#""iso""#), ("orbit", r#""follow-cursor""#)] {
                let json = with_rect(&scene_json_themed(frame, theme, rotation, 1.0, NO_CURSOR, (W, H)), CLIPS[0].1);
                let i = img(render(&comp, &screen, &json, None, T));
                save_in(&dir, "shadows", &format!("{frame}-{cam}-{theme}"), &i);
                row.push(image::imageops::resize(&i, W / 2, H / 2, image::imageops::FilterType::Triangle));
            }
            save_in(&dir, "shadows", &format!("strip-{frame}-{theme}"), &strip(&row));
        }
    }

    // 5. Références produit : portable, moniteur et téléphone DE FACE, en 1080p, clair et sombre.
    let big = Compositor::new_sized(&gpu, 1920, 1080).expect("compositor");
    for frame in ["laptop", "monitor", "phone"] {
        for theme in ["light", "dark"] {
            let json = with_rect(&scene_json_themed(frame, theme, "null", 0.6, NO_CURSOR, (1920, 1080)), CLIPS[0].1);
            let rgba = render(&big, &screen, &json, None, T);
            let i = image::RgbaImage::from_raw(1920, 1080, rgba).expect("readback");
            save_in(&dir, "reference-match", &format!("{frame}-front-{theme}"), &i);
        }
    }
    println!("rendus v3 écrits dans {dir}");
}

/// 6 s de portable sous la caméra en orbite, curseur modélisé allumé (opt-in,
/// `OPENSCREEN_DEVICE_CLIP`) : un PNG par frame, à assembler en MP4 par ffmpeg.
#[test]
fn orbit_clip_frames() {
    let Some(dir) = out_dir("OPENSCREEN_DEVICE_CLIP") else {
        eprintln!("OPENSCREEN_DEVICE_CLIP absent — saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    // Le pointeur fait le tour de l'écran : l'œil de la caméra le suit sur son orbite.
    let mut samples = Vec::new();
    for k in 0..=120 {
        let t = k as f32 / 20.0;
        let a = std::f32::consts::TAU * t / 6.0;
        samples.push(format!(
            r#"{{"timeMs":{},"cx":{},"cy":{}}}"#,
            t * 1000.0,
            0.5 + 0.34 * a.cos(),
            0.5 + 0.30 * a.sin()
        ));
    }
    let path = std::env::temp_dir().join("os_device_orbit.json");
    std::fs::write(&path, format!(r#"{{"samples":[{}]}}"#, samples.join(","))).expect("sidecar");
    let track = CursorTrack::load(path.to_str().unwrap(), 0.0, 10.0).expect("piste curseur");
    let cursor = format!(
        r#"{{"show":true,"size":4,"smoothing":0.2,"motionBlur":0,"clickBounce":2.5,"model3d":true,"clipToBounds":false,"theme":"default","cursorSprites":{{"arrow":{{"path":"{}/arrow.png","hotspotX":0.119,"hotspotY":0.0874}}}}}}"#,
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/cursors/default")
            .to_string_lossy()
            .replace('\\', "/")
    );
    let json = scene_json("laptop", r#""follow-cursor""#, 0.6, &cursor, (W, H));
    for k in 0..180 {
        let t = k as f32 / 30.0;
        let rgba = render(&comp, &screen, &json, Some(&track), t);
        save(&dir, &format!("f{k:04}"), &rgba, (W, H));
    }
    println!("180 frames écrites dans {dir}");
}

// ============ Épaisseur des bordures, ratios, plan proche ============

/// Le pixel en (x, y), interpolé entre ses quatre voisins : une mesure au dixième de pixel.
fn bilinear(rgba: &[u8], out: (u32, u32), x: f32, y: f32) -> Option<[f32; 3]> {
    let (x, y) = (x - 0.5, y - 0.5);
    let (x0, y0) = (x.floor(), y.floor());
    if x0 < 0.0 || y0 < 0.0 || x0 + 1.0 >= out.0 as f32 || y0 + 1.0 >= out.1 as f32 {
        return None;
    }
    let (fx, fy) = (x - x0, y - y0);
    let at = |i: f32, j: f32| {
        let k = ((j as u32 * out.0 + i as u32) * 4) as usize;
        [rgba[k] as f32, rgba[k + 1] as f32, rgba[k + 2] as f32]
    };
    let (a, b, c, d) = (at(x0, y0), at(x0 + 1.0, y0), at(x0, y0 + 1.0), at(x0 + 1.0, y0 + 1.0));
    Some(std::array::from_fn(|k| {
        (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy
    }))
}

/// Ce qu'un rayon du plan traverse, du métrage vers le dehors : la distance (px du plan) où le
/// métrage finit, où le verre noir de la lunette finit (le liseré commence), et où le fond d'écran
/// commence. Chacune au passage de mi-hauteur, interpolée entre deux échantillons.
#[derive(Clone, Copy, Debug, Default)]
struct Crossings {
    footage: f32,
    glass: Option<f32>,
    wallpaper: Option<f32>,
}

/// Le vert du fond de `on_green`, en marge vert − max(rouge, bleu).
const GREEN_MARGIN: f32 = 128.0;

/// Marche le rayon `p0 + n·t` (px du plan, `n` unitaire), `p0` bien dans le métrage, sur les deux
/// rendus `a` (teinte bleue) et `b` (orange) : le métrage est ce qui change entre les deux.
fn crossings(g: &Geo, a: &[u8], b: &[u8], out: (u32, u32), p0: [f32; 2], n: [f32; 2], len: f32, dark: bool) -> Option<Crossings> {
    let sample = |t: f32| {
        let (x, y) = g.to_out([p0[0] + n[0] * t, p0[1] + n[1] * t]);
        Some((bilinear(a, out, x, y)?, bilinear(b, out, x, y)?))
    };
    let diff = |pa: [f32; 3], pb: [f32; 3]| (0..3).map(|k| (pa[k] - pb[k]).abs()).sum::<f32>();
    let (a0, b0) = sample(0.0)?;
    let full = diff(a0, b0);
    assert!(full > 60.0, "sonde hors du métrage ({full})");
    // Verre : noir (~10) ; liseré : argent (~180) ou graphite (~55).
    let glass_thr = if dark { 30.0 } else { 80.0 };
    let (step, mut t) = (0.1f32, 0.0f32);
    let mut prev = (1.0f32, 0.0f32, 0.0f32);
    let mut c = Crossings::default();
    let mut found_footage = false;
    while t <= len {
        let Some((pa, pb)) = sample(t) else { break };
        let foot = diff(pa, pb) / full;
        let lum = (pa[0] + pa[1] + pa[2]) / 3.0;
        let green = ((pa[1] - pa[0].max(pa[2])) / GREEN_MARGIN).clamp(0.0, 1.0);
        let cross = |v0: f32, v1: f32, thr: f32| t - step + (thr - v0) / (v1 - v0) * step;
        if !found_footage {
            if foot < 0.5 {
                c.footage = cross(prev.0, foot, 0.5);
                found_footage = true;
            }
        } else {
            if c.glass.is_none() && c.wallpaper.is_none() && lum > glass_thr && prev.1 <= glass_thr {
                c.glass = Some(cross(prev.1, lum, glass_thr));
            }
            if c.wallpaper.is_none() && green > 0.5 {
                c.wallpaper = Some(cross(prev.2, green, 0.5));
                break;
            }
        }
        prev = (foot, lum, green);
        t += step;
    }
    found_footage.then_some(c)
}

/// Une mesure de bordure en px du PLAN : (l'anneau jusqu'au fond, le verre jusqu'au liseré).
type Border = (Option<f32>, Option<f32>);

/// La bordure qu'un rayon du plan traverse, du métrage vers le dehors, en px du PLAN (la boîte
/// droite) : la géométrie du cadre, qu'on veut concentrique. À plat, ce sont des px de sortie ; sous
/// un angle fixe, la perspective raccourcit x, y et la diagonale différemment, et seule la mesure
/// dans le plan compare un coin à ses bords.
fn border(g: &Geo, a: &[u8], b: &[u8], out: (u32, u32), p0: [f32; 2], n: [f32; 2], len: f32, dark: bool) -> Border {
    let Some(c) = crossings(g, a, b, out, p0, n, len, dark) else { return (None, None) };
    (c.wallpaper.map(|t| t - c.footage), c.glass.map(|t| t - c.footage))
}

/// Un coin du cadre mesuré sur l'image : le long de sa diagonale à 45°, depuis le centre de l'arc
/// du métrage, et à travers les deux bords qui s'y rejoignent, juste après l'arc du corps — à la
/// même échelle de projection que le coin.
struct CornerProbe {
    diag: Border,
    side: Border,
    end: Border,
    /// Px de sortie par px du plan, le long de la diagonale, au coin : 1 à plat. La tolérance d'un
    /// pixel de SORTIE vaut `1 / scale` px du plan.
    scale: f32,
}

/// Les quatre coins : haut-gauche, haut-droit, bas-droit, bas-gauche.
fn measure_corners(g: &Geo, a: &[u8], b: &[u8], out: (u32, u32), dark: bool) -> [CornerProbe; 4] {
    let [w, h] = g.s_px;
    let r = g.radius;
    let widest = g.body.iter().fold(0.0f32, |m, v| m.max(*v));
    let reach = 4.0 * widest + 30.0;
    // Assez loin du coin pour que le bord soit droit : au-delà de l'arc extérieur du corps.
    let along = r + widest + 12.0;
    let k = std::f32::consts::FRAC_1_SQRT_2;
    [([0.0, 0.0], [-1.0f32, -1.0f32]), ([w, 0.0], [1.0, -1.0]), ([w, h], [1.0, 1.0]), ([0.0, h], [-1.0, 1.0])].map(
        |(c, s)| {
            let centre = [c[0] - s[0] * (r + 12.0 * k), c[1] - s[1] * (r + 12.0 * k)];
            let apex = [c[0] - s[0] * r * (1.0 - k), c[1] - s[1] * r * (1.0 - k)];
            let (p, q) = (g.to_out(apex), g.to_out([apex[0] + s[0] * k, apex[1] + s[1] * k]));
            CornerProbe {
                scale: (q.0 - p.0).hypot(q.1 - p.1),
                diag: border(g, a, b, out, centre, [s[0] * k, s[1] * k], reach + r, dark),
                // Le bord vertical (gauche ou droit), puis le bord horizontal (haut ou bas).
                side: border(g, a, b, out, [c[0] - s[0] * 12.0, c[1] - s[1] * along], [s[0], 0.0], reach, dark),
                end: border(g, a, b, out, [c[0] - s[0] * along, c[1] - s[1] * 12.0], [0.0, s[1]], reach, dark),
            }
        },
    )
}

/// Le Roundness que l'app envoie à sa valeur par défaut (40 px de slider) dans une sortie 1080p.
const DEFAULT_ROUND: f32 = 40.0 / 1080.0;

/// La bordure de la fenêtre et du téléphone garde son épaisseur TOUT AUTOUR de chaque coin, à
/// toutes les valeurs de Roundness : mesurée le long de la diagonale à 45° de chaque coin, elle
/// vaut, au pixel près, celle des deux bords qui s'y rejoignent. Les deux contours sont
/// concentriques (`concentric_radius`). Le portable et le moniteur n'y sont pas soumis : leur
/// coque garde ses rayons et seul l'intérieur de la lunette suit le slider
/// (`only_the_inside_of_the_laptop_and_screen_bezel_follows_roundness`).
///
/// Les épaisseurs se mesurent dans le PLAN (la géométrie du cadre) : sous un angle fixe, la
/// perspective raccourcit x, y et la diagonale différemment. L'écart toléré, lui, est d'un pixel
/// de SORTIE, converti au coin par l'échelle locale de la projection.
///
/// Fenêtre, téléphone ; Roundness 0, par défaut et maximal ; à plat et sous
/// `iso` ; clair et sombre. À plat, l'anneau entier jusqu'au fond d'écran ; sous `iso`, où les
/// flancs de l'appareil se voient, le verre de la lunette jusqu'à son liseré. Les coins HAUTS de
/// la fenêtre sont sous la barre de titre, carrés par construction : on n'y mesure rien.
#[test]
fn the_border_keeps_its_thickness_around_every_corner() {
    let Some(gpu) = gpu() else { return };
    let out = (1920u32, 1080u32);
    let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
    let blue = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let orange = FakeFrame::new(&gpu, SRC, Tint::Orange);
    let (mut worst, mut failures) = (0.0f32, Vec::new());
    for frame in ["window", "phone"] {
        for (rlabel, roundness) in [("r0", 0.0f32), ("rdef", DEFAULT_ROUND), ("rmax", MAX_ROUND)] {
            for (cam, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
                for theme in ["light", "dark"] {
                    let dark = theme == "dark";
                    let json = on_green(&with_roundness(
                        &scene_json_themed(frame, theme, rotation, 0.0, NO_CURSOR, out),
                        roundness,
                    ));
                    let (a, b) = (render(&comp, &blue, &json, None, T), render(&comp, &orange, &json, None, T));
                    let g = Geo::new(&json, out, SRC);
                    let probes = measure_corners(&g, &a, &b, out, dark);
                    let case = format!("{frame} {rlabel} {cam} {theme}");
                    // Deux mesures. Le VERRE de la lunette, du métrage à son liseré, pour les
                    // appareils — à plat comme sous iso, où les flancs se voient. L'ANNEAU entier,
                    // du métrage au fond d'écran, à plat — sauf au bas du portable, où la tranche du
                    // socle prolonge le corps. La fenêtre n'a que son anneau : un filet.
                    let device = frame != "window";
                    for (what, pick) in [("verre", 1usize), ("anneau", 0usize)] {
                        if (what == "verre" && !device) || (what == "anneau" && device && cam != "flat") {
                            continue;
                        }
                        let get = |v: Border| if pick == 0 { v.0 } else { v.1 };
                        let mut line = String::new();
                        for (k, p) in probes.iter().enumerate() {
                            // Les coins hauts de la fenêtre sont sa barre de titre ; le bas du
                            // portable, à l'anneau, sa charnière et son socle.
                            if (frame == "window" && k < 2) || (frame == "laptop" && what == "anneau" && k >= 2) {
                                line.push_str("        -          ");
                                continue;
                            }
                            let (Some(dg), Some(e0), Some(e1)) = (get(p.diag), get(p.side), get(p.end)) else {
                                panic!("{case} {what}: coin {k} non mesuré");
                            };
                            let want = 0.5 * (e0 + e1);
                            line.push_str(&format!(" {dg:5.1}/{e0:5.1}/{e1:5.1}  "));
                            // L'écart, en px de SORTIE : c'est un pixel à l'image qu'on s'accorde.
                            let off = (dg - want).abs() * p.scale;
                            worst = worst.max(off);
                            if off > 1.0 {
                                failures.push(format!(
                                    "{case} {what}: coin {k} {dg:.2} px au lieu de {want:.2} px (bords {e0:.2} / {e1:.2})"
                                ));
                            }
                        }
                        println!("{case:<26} {what:<6} diag/côté/bout HG HD BD BG :{line}");
                    }
                }
            }
        }
    }
    println!("écart maximal diagonale / bords : {worst:.2} px de sortie");
    assert!(failures.is_empty(), "{} coins hors tolérance :\n{}", failures.len(), failures.join("\n"));
}

/// Portable et écran : le slider Roundness n'arrondit QUE l'intérieur de la lunette. Entre
/// Roundness 0 et maximal, la silhouette de l'appareil sur le fond (vert, sans ombre) est la même
/// au pixel près, alors que les coins de l'écran, eux, changent visiblement.
#[test]
fn only_the_inside_of_the_laptop_and_screen_bezel_follows_roundness() {
    let Some(gpu) = gpu() else { return };
    let out = (1920u32, 1080u32);
    let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
    let blue = FakeFrame::new(&gpu, SRC, Tint::Blue);
    for frame in ["laptop", "monitor"] {
        let at = |r: f32| {
            let json = on_green(&with_roundness(&scene_json(frame, "null", 0.0, NO_CURSOR, out), r));
            render(&comp, &blue, &json, None, T)
        };
        let (square, round) = (at(0.0), at(MAX_ROUND));
        let wall = |rgba: &[u8]| -> Vec<bool> { rgba.chunks_exact(4).map(|p| greenish([p[0], p[1], p[2]])).collect() };
        let (ws, wr) = (wall(&square), wall(&round));
        let silhouette = ws.iter().zip(&wr).filter(|(a, b)| a != b).count();
        let inside = differing(&square, &round, 24);
        println!("{frame:<8} silhouette {silhouette} px différents, intérieur {inside} px différents");
        assert!(silhouette <= 4, "{frame} : la coque a bougé avec Roundness ({silhouette} px)");
        assert!(inside > 400, "{frame} : les coins de l'écran ne suivent pas Roundness ({inside} px)");
    }
}

/// Un métrage de ratio `ar` contenu dans 80 % d'une sortie 16:9, comme l'app le contient dans la
/// zone paddée : la même sortie, un autre clip.
fn contained_rect(ar: f32) -> (f32, f32, f32, f32) {
    let (w, h) = if ar >= 16.0 / 9.0 { (0.8, 0.8 * 16.0 / 9.0 / ar) } else { (0.8 * ar * 9.0 / 16.0, 0.8) };
    (0.5 - w * 0.5, 0.5 - h * 0.5, w, h)
}

const RATIOS: [(&str, f32); 5] =
    [("16x9", 16.0 / 9.0), ("9x16", 9.0 / 16.0), ("1x1", 1.0), ("4x3", 4.0 / 3.0), ("21x9", 21.0 / 9.0)];

/// Le même cadre sur un clip 16:9, 9:16, 1:1, 4:3 et 21:9, dans la MÊME sortie : les mêmes
/// bordures en px sur les quatre côtés, le même rayon de coin — seule l'ouverture change de
/// forme. Mesuré sur l'image. Les bordures étaient en largeurs de la boîte : autour d'un clip
/// portrait, la lunette tombait au tiers de celle d'un clip paysage.
#[test]
fn a_frame_looks_the_same_on_every_clip_ratio() {
    let Some(gpu) = gpu() else { return };
    let out = (1920u32, 1080u32);
    let comp = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
    let (w0, h0) = (1280u32, 720u32);
    for frame in ["window", "laptop", "phone", "monitor"] {
        let mut first: Option<([f32; 4], f32, f32)> = None;
        for (label, ar) in RATIOS {
            // La source a le ratio du clip : rien n'est recadré, rien n'est étiré.
            let src = if ar >= 1.0 { (w0, (w0 as f32 / ar).round() as u32) } else { ((h0 as f32 * ar).round() as u32, h0) };
            let src = (src.0 & !1, src.1 & !1);
            let blue = FakeFrame::new(&gpu, src, Tint::Blue);
            let orange = FakeFrame::new(&gpu, src, Tint::Orange);
            let json = on_green(&with_roundness(
                &with_rect(&scene_json(frame, "null", 0.0, NO_CURSOR, out), contained_rect(ar)),
                DEFAULT_ROUND,
            ));
            let (a, b) = (render(&comp, &blue, &json, None, T), render(&comp, &orange, &json, None, T));
            let g = Geo::new(&json, out, src);
            let p = measure_corners(&g, &a, &b, out, false);
            // Les quatre bords (gauche, haut, droite, bas), mesurés près des coins haut-gauche et
            // bas-droit : l'anneau de la fenêtre, le verre des appareils — sous eux, l'anneau
            // traverserait le socle du portable ou le pied du moniteur.
            let m = |v: Border| if frame == "window" { v.0 } else { v.1 };
            let edges = [p[0].side, p[0].end, p[2].side, p[2].end].map(|e| m(e).expect("bord mesuré"));
            // Le rayon extérieur du coin haut-droit : depuis le centre de l'arc du métrage, l'arc
            // du corps est à R — concentriques — soit le rayon du métrage plus la bordure mesurée.
            let outer = g.radius + m(p[1].diag).expect("coin mesuré");
            let now = (edges, outer, g.radius);
            println!(
                "{frame:<8} {label:<5} bords {:5.1?} px, métrage r = {:5.1} px, extérieur R = {outer:5.1} px",
                edges, g.radius
            );
            match first {
                None => first = Some(now),
                Some((e0, o0, r0)) => {
                    for k in 0..4 {
                        assert!((edges[k] - e0[k]).abs() <= 1.0, "{frame} {label}: bord {k} {} px au lieu de {} px", edges[k], e0[k]);
                    }
                    assert!((outer - o0).abs() <= 1.0, "{frame} {label}: rayon extérieur {outer} px au lieu de {o0} px");
                    assert!((g.radius - r0).abs() <= 0.01, "{frame} {label}: rayon du métrage {} au lieu de {r0}", g.radius);
                }
            }
        }
    }
}

/// Une piste curseur garée en (x, y) de l'image pendant dix secondes.
fn parked_track(name: &str, x: f32, y: f32) -> CursorTrack {
    let samples: Vec<String> = (0..=100).map(|k| format!(r#"{{"timeMs":{},"cx":{x},"cy":{y}}}"#, k * 100)).collect();
    let path = std::env::temp_dir().join(format!("os_device_parked_{name}.json"));
    std::fs::write(&path, format!(r#"{{"samples":[{}]}}"#, samples.join(","))).expect("sidecar");
    CursorTrack::load(path.to_str().unwrap(), 0.0, 10.0).expect("piste curseur")
}

/// Le curseur affiché (la caméra en orbite le suit), minuscule : il ne masque aucune sonde.
const SHOWN_CURSOR: &str = r#"{"show":true,"size":0.2,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default","cursorSprites":{}}"#;

/// La caméra en orbite qui zoome de `zoom` : la région de zoom de `scene_json`, sous
/// `follow-cursor`, à l'échelle voulue.
fn orbit_json(frame: &str, zoom: f32, out: (u32, u32)) -> String {
    scene_json(frame, r#""follow-cursor""#, 0.6, SHOWN_CURSOR, out).replace(r#""scale":1,"#, &format!(r#""scale":{zoom},"#))
}

/// Le socle du portable ne couvre JAMAIS le métrage que le zoom montre : au plus fort zoom et aux
/// angles extrêmes de l'orbite, toute la région de mise au point — le centre de l'image, où la
/// caméra vise — est du métrage, pixel par pixel.
///
/// C'est ce qui cassait : zoomée sur le bas de l'image, la caméra en orbite visait sous le centre,
/// l'œil du relief plongeait sous l'écran, et la face inférieure du socle couvrait tout le métrage,
/// son bord avant énorme au premier plan. Au zoom 1, le pointeur en bas : l'ouverture entière.
#[test]
fn the_laptop_deck_never_covers_the_zoom_focus() {
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let blue = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let orange = FakeFrame::new(&gpu, SRC, Tint::Orange);
    let pointers = [
        ("bas", (0.5f32, 0.98f32)),
        ("bas-gauche", (0.02, 0.98)),
        ("bas-droite", (0.98, 0.98)),
        ("haut-gauche", (0.02, 0.02)),
        ("haut-droite", (0.98, 0.02)),
    ];
    for (name, (x, y)) in pointers {
        let track = parked_track(name, x, y);
        for zoom in [1.0f32, 2.2, 3.5, 5.0] {
            let json = orbit_json("laptop", zoom, (W, H));
            let a = render(&comp, &blue, &json, Some(&track), T);
            let b = render(&comp, &orange, &json, Some(&track), T);
            let (mut n, mut covered) = (0usize, Vec::new());
            if zoom > 1.0 {
                // La région de mise au point : le centre de l'image, 60 % de chaque côté.
                for j in 0..40 {
                    for i in 0..40 {
                        let (px_x, px_y) = (W as f32 * (0.2 + 0.6 * i as f32 / 39.0), H as f32 * (0.2 + 0.6 * j as f32 / 39.0));
                        let (Some(pa), Some(pb)) = (px(&a, (W, H), px_x, px_y), px(&b, (W, H), px_x, px_y)) else { continue };
                        n += 1;
                        if pa == pb {
                            covered.push((px_x.round(), px_y.round(), pa));
                        }
                    }
                }
            } else {
                // Au zoom 1 : l'ouverture entière, de 5 % à 95 % de chaque côté.
                let (q, _) = aperture_tracked(&json, (W, H), &track);
                for j in 1..=19 {
                    for i in 1..=19 {
                        let (px_x, px_y) = quad_at(&q, i as f32 / 20.0, j as f32 / 20.0);
                        let (Some(pa), Some(pb)) = (px(&a, (W, H), px_x, px_y), px(&b, (W, H), px_x, px_y)) else { continue };
                        n += 1;
                        if pa == pb {
                            covered.push((px_x.round(), px_y.round(), pa));
                        }
                    }
                }
            }
            println!("{name:<12} zoom {zoom:<4} {n:>5} px sondés, {} couverts", covered.len());
            assert!(n > 300, "{name} z{zoom}: trop peu de sondes ({n})");
            assert!(covered.is_empty(), "{name} z{zoom}: le socle couvre le métrage en {:?}", &covered[..covered.len().min(6)]);
        }
    }
}

/// `aperture` sous une piste curseur : la caméra en orbite dépend du pointeur.
fn aperture_tracked(json: &str, out: (u32, u32), track: &CursorTrack) -> ([(f32, f32); 4], [f32; 4]) {
    let scene = Scene::from_json(json).expect("scène valide");
    let cfg = cfg();
    let mut live = live_params_from_scene(&scene);
    live.has_webcam = false;
    let src = [SRC.0 as f32, SRC.1 as f32];
    let g = plan_frame(&FrameGeometryInput {
        render_px: [out.0 as f32, out.1 as f32],
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
    let render_px = [out.0 as f32, out.1 as f32];
    let s = g.s_dst;
    let s_px = [s[2] * render_px[0], s[3] * render_px[1]];
    let center = [(s[0] + s[2] * 0.5) * render_px[0], (s[1] + s[3] * 0.5) * render_px[1]];
    let q = g.screen_tilt(s_px).expect("caméra en orbite");
    let corners = std::array::from_fn(|i| {
        let (fx, fy) = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)][i];
        let (x, y) = q.point_px(fx, fy);
        (center[0] + x, center[1] + y)
    });
    (corners, g.window_frame.map(|f| f.margins).unwrap_or([0.0; 4]))
}

/// Les rendus de la passe 4 (opt-in, `OPENSCREEN_DEVICE_V4`) :
/// - `corners/` : les quatre coins de chaque cadre au Roundness maximal, clair et sombre, agrandis ;
/// - `ratios/` : chaque cadre sur un clip 16:9, 9:16, 1:1, 4:3 et 21:9, dans la même sortie ;
/// - `roundness/` : chaque cadre × slider 0, 50 et 100 % × clips 16:9, 9:16, 4:3 et 21:9.
///
/// Le plan proche a son propre rendu, `v4_near_clip`.
#[test]
fn v4_renders() {
    let Some(dir) = out_dir("OPENSCREEN_DEVICE_V4") else {
        eprintln!("OPENSCREEN_DEVICE_V4 absent - saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let all: [&str; 4] = ["window", "laptop", "phone", "monitor"];
    let out = (1920u32, 1080u32);
    let big = Compositor::new_sized(&gpu, out.0, out.1).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let img = |rgba: Vec<u8>, o: (u32, u32)| image::RgbaImage::from_raw(o.0, o.1, rgba).expect("readback");

    // 1. Coins, au Roundness maximal : les quatre coins, 40 px de côté agrandis six fois, clair et
    // sombre, à plat et sous iso. En haut de la fenêtre, la barre de titre entière : le coin du
    // cadre au-dessus, le coin carré du métrage dessous.
    for frame in all {
        for theme in ["light", "dark"] {
            for (cam, rotation) in [("flat", "null"), ("iso", r#""iso""#)] {
                let json = with_roundness(&scene_json_themed(frame, theme, rotation, 0.6, NO_CURSOR, out), MAX_ROUND);
                let rgba = render(&big, &screen, &json, None, T);
                let g = Geo::new(&json, out, SRC);
                let [w, h] = g.s_px;
                let k = g.radius * (1.0 - std::f32::consts::FRAC_1_SQRT_2);
                let top = if frame == "window" { -0.4 * g.body[1] } else { k };
                let pts: Vec<[f32; 2]> = vec![[k, top], [w - k, top], [w - k, h - k], [k, h - k]];
                let crops: Vec<_> = pts.iter().map(|&p| closeup(&rgba, out, g.to_out(p), 40, 6)).collect();
                save_in(&dir, "corners", &format!("{frame}-rmax-{cam}-{theme}"), &strip(&crops));
            }
        }
    }

    // 2. Ratios : le même cadre autour de cinq clips, dans la même sortie 1080p.
    for theme in ["light", "dark"] {
        let mut sheet = image::RgbaImage::from_pixel(out.0 / 2 * 5 + 24, out.1 / 2 * 4 + 18, image::Rgba([255, 255, 255, 255]));
        for (row, &frame) in all.iter().enumerate() {
            for (col, (label, ar)) in RATIOS.iter().enumerate() {
                let src = if *ar >= 1.0 { (1280u32, (1280.0 / ar).round() as u32 & !1) } else { ((720.0 * ar).round() as u32 & !1, 720u32) };
                let f = FakeFrame::new(&gpu, src, Tint::Blue);
                let json = with_rect(&scene_json_themed(frame, theme, "null", 0.6, NO_CURSOR, out), contained_rect(*ar));
                let json = with_roundness(&json, DEFAULT_ROUND);
                let i = img(render(&big, &f, &json, None, T), out);
                save_in(&dir, "ratios", &format!("{frame}-{label}-{theme}"), &i);
                let small = image::imageops::resize(&i, out.0 / 2, out.1 / 2, image::imageops::FilterType::Triangle);
                image::imageops::overlay(&mut sheet, &small, (col as u32 * (out.0 / 2 + 6)) as i64, (row as u32 * (out.1 / 2 + 6)) as i64);
            }
        }
        save_in(&dir, "ratios", &format!("sheet-{theme}"), &sheet);
    }

    // 3. La course de Roundness de chaque cadre : 0, 50 et 100 % du slider, sur quatre clips.
    let ratios4 = [RATIOS[0], RATIOS[1], RATIOS[3], RATIOS[4]];
    for frame in all {
        let mut sheet = image::RgbaImage::from_pixel(out.0 / 2 * 4 + 18, out.1 / 2 * 3 + 12, image::Rgba([255, 255, 255, 255]));
        for (row, pct) in [0.0f32, 0.5, 1.0].into_iter().enumerate() {
            for (col, (label, ar)) in ratios4.iter().enumerate() {
                let src = if *ar >= 1.0 { (1280u32, (1280.0 / ar).round() as u32 & !1) } else { ((720.0 * ar).round() as u32 & !1, 720u32) };
                let f = FakeFrame::new(&gpu, src, Tint::Blue);
                let json = with_rect(&scene_json(frame, "null", 0.6, NO_CURSOR, out), contained_rect(*ar));
                let json = with_roundness(&json, pct * 64.0 / 1080.0);
                let i = img(render(&big, &f, &json, None, T), out);
                save_in(&dir, "roundness", &format!("{frame}-{}-{label}", (pct * 100.0) as u32), &i);
                let small = image::imageops::resize(&i, out.0 / 2, out.1 / 2, image::imageops::FilterType::Triangle);
                image::imageops::overlay(&mut sheet, &small, (col as u32 * (out.0 / 2 + 6)) as i64, (row as u32 * (out.1 / 2 + 6)) as i64);
            }
        }
        save_in(&dir, "roundness", &format!("sheet-{frame}"), &sheet);
    }

    println!("rendus v4 écrits dans {dir}");
}

/// Le plan proche, en images (opt-in, `OPENSCREEN_DEVICE_V4`, dans `near-clip/`) : le portable
/// sous la caméra en orbite, pointeur au bas de l'écran — là où le socle couvrait le métrage —,
/// zoom avant de 1 à 3,5 puis retour, 6 s à 30 images/s (à assembler en MP4), et une planche de
/// douze instants. Le métrage est plus petit que la sortie : l'appareil y tient entier au repos.
#[test]
fn v4_near_clip() {
    let Some(dir) = out_dir("OPENSCREEN_DEVICE_V4") else {
        eprintln!("OPENSCREEN_DEVICE_V4 absent - saute");
        return;
    };
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, W, H).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let track = parked_track("near", 0.5, 0.97);
    let json = with_rect(&scene_json("laptop", r#""follow-cursor""#, 0.6, SHOWN_CURSOR, (W, H)), CLIPS[0].1)
        .replace(
            r#""zoomRegions":[{"clipIndex":0,"startSec":0,"endSec":10,"scale":1,"#,
            r#""zoomRegions":[{"clipIndex":0,"startSec":1.2,"endSec":4.4,"scale":3.5,"#,
        );
    std::fs::create_dir_all(format!("{dir}/near-clip/frames")).expect("dossier");
    let mut sheet = Vec::new();
    for k in 0..180 {
        let t = k as f32 / 30.0;
        let rgba = render(&comp, &screen, &json, Some(&track), t);
        save(&format!("{dir}/near-clip/frames"), &format!("f{k:04}"), &rgba, (W, H));
        if k % 15 == 0 {
            let i = image::RgbaImage::from_raw(W, H, rgba).expect("readback");
            sheet.push(image::imageops::resize(&i, W / 4, H / 4, image::imageops::FilterType::Triangle));
        }
    }
    let (w4, h4) = (W / 4 + 6, H / 4 + 6);
    let mut grid = image::RgbaImage::from_pixel(w4 * 6, h4 * 2, image::Rgba([255, 255, 255, 255]));
    for (k, i) in sheet.iter().enumerate() {
        image::imageops::overlay(&mut grid, i, ((k % 6) as u32 * w4) as i64, ((k / 6) as u32 * h4) as i64);
    }
    save_in(&dir, "near-clip", "sheet", &grid);
    println!("180 images écrites dans {dir}/near-clip/frames");
}

/// Coût d'une frame 1080p, cadre d'appareil allumé contre éteint (opt-in, à lancer en release).
/// Le readback synchronise chaque frame et pèse autant des deux côtés ; on alterne les deux
/// réglages et on garde le meilleur de cinq passes.
#[test]
fn bench_the_device_frame_at_1080p() {
    if std::env::var("OPENSCREEN_DEVICE_BENCH").is_err() {
        eprintln!("OPENSCREEN_DEVICE_BENCH absent — saute");
        return;
    }
    let Some(gpu) = gpu() else { return };
    let comp = Compositor::new_sized(&gpu, 1920, 1080).expect("compositor");
    let screen = FakeFrame::new(&gpu, SRC, Tint::Blue);
    let time = |json: &str| {
        let scene = Scene::from_json(json).expect("scène");
        let mut live = live_params_from_scene(&scene);
        live.has_webcam = false;
        comp.set_live_params(live);
        comp.set_has_webcam(false);
        comp.set_scene(Some(scene));
        comp.clear_cursor();
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
    for rotation in ["null", r#""iso""#, r#""follow-cursor""#] {
        for &device in &DEVICES {
            let (off, on) = (
                scene_json("none", rotation, 0.6, NO_CURSOR, (1920, 1080)),
                scene_json(device, rotation, 0.6, NO_CURSOR, (1920, 1080)),
            );
            time(&off);
            time(&on);
            let (mut a, mut b) = (f64::MAX, f64::MAX);
            for _ in 0..5 {
                a = a.min(time(&off));
                b = b.min(time(&on));
            }
            println!("{rotation:<16} {device:<8} éteint {a:6.3} ms  allumé {b:6.3} ms  (+{:.3})", b - a);
        }
    }
}
