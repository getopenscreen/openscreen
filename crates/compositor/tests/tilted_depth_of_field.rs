//! La profondeur de champ du mode 8 floute le coin LOINTAIN d'un écran incliné et laisse le
//! coin proche, où tombe le focus, intact à l'octet.
//!
//! Rend de vraies frames par le compositeur D3D11, sur une source quelconque (de préférence du
//! texte : c'est là qu'un plafond de flou trop haut se voit). Le fond est magenta, une couleur
//! qu'aucune source réaliste ne produit, pour isoler le plan au pixel près.
//!
//! ```powershell
//! $env:OPENSCREEN_DOF_SOURCE = "...\text.mp4"      # obligatoire, sinon le test se saute
//! $env:OPENSCREEN_DOF_OUT = "...\renders"          # facultatif : PPM par cas
//! $env:OPENSCREEN_DOF_BENCH = "1"                  # facultatif : A/B de coût, matériel et WARP
//! cargo test -p openscreen-compositor --test tilted_depth_of_field -- --nocapture
//! ```
//!
//! Le pendant « réglage coupé = rendu d'avant à l'octet » est `tilted_depth_slot_inert.rs`, qui
//! compare à une référence produite sans l'effet.

// Windows seulement : le readback et le décodage D3D11VA de ce harnais n'existent que là.
#![cfg(windows)]

use std::time::Instant;

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config;
use openscreen_compositor::d3d::{Backend, Gpu};
use openscreen_compositor::frame_geometry::live_params_from_scene;
use openscreen_compositor::live::Player;
use openscreen_compositor::scene::Scene;

/// En plein palier du zoom : la région couvre 0..6 s.
const AT_SEC: f64 = 3.0;

fn scene_json(source: &str, rotation: &str, dof: bool, focus: [f32; 2], w: u32, h: u32) -> String {
    let s = source.replace('\\', "/");
    let [fx, fy] = focus;
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"","sourceStartSec":0,"sourceEndSec":6,"webcamOffsetSec":0,"hasAudio":false}}],
        "layout": {{"preset":"no-webcam","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                    "screenRect":{{"x":0.05,"y":0.05,"width":0.9,"height":0.9}}}},
        "effects": {{"padding":0.1,"blur":false,"shadow":0.0,"roundnessFrac":0.0,"motionBlur":0.0,"depthOfField":{dof}}},
        "background": {{"kind":"color","color":"#ff00ff"}},
        "zoomRegions": [{{"id":"z","startSec":0,"endSec":6,"scale":1.0,"focusX":{fx},"focusY":{fy},"focusMode":"manual","rotation":{rotation}}}],
        "annotations": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":{w},"height":{h},"fps":null}}
    }}"##
    )
}

fn compositor(gpu: &Gpu, source: &str, rotation: &str, dof: bool, focus: [f32; 2], w: u32, h: u32) -> Compositor {
    let comp = Compositor::new_sized(gpu, w, h).expect("compositor");
    let scene = Scene::from_json(&scene_json(source, rotation, dof, focus, w, h)).expect("scene valide");
    comp.set_live_params(live_params_from_scene(&scene));
    comp.set_scene(Some(scene));
    comp.clear_cursor();
    comp
}

fn cfg() -> config::Cfg {
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.shadow = false;
    cfg
}

fn render(gpu: &Gpu, source: &str, rotation: &str, dof: bool, focus: [f32; 2], w: u32, h: u32) -> Vec<u8> {
    let comp = compositor(gpu, source, rotation, dof, focus, w, h);
    unsafe {
        let mut player = Player::open(source, "", gpu).expect("ouvrir la source");
        player.present_frame(&comp, &cfg(), AT_SEC).expect("composer la frame");
        comp.readback_resized(w, h).expect("readback")
    }
}

fn write_ppm(dir: &Option<std::path::PathBuf>, name: &str, rgba: &[u8], w: u32, h: u32) {
    let Some(dir) = dir else { return };
    std::fs::create_dir_all(dir).expect("creer le dossier de sortie");
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(dir.join(format!("{name}.ppm")), out).expect("ecrire le ppm");
}

/// Pixel du plan (pas le fond magenta). Seuil large : le feather des bords ne compte pas.
fn on_plane(p: &[u8]) -> bool {
    !(p[0] > 200 && p[1] < 60 && p[2] > 200)
}

/// Coin du plan extrême dans la direction `(dx, dy)`, rentré de `inset` vers le centroïde :
/// une fenêtre posée là est entièrement sur le plan, loin du feather.
fn corner_window(rgba: &[u8], w: u32, h: u32, dir: (i64, i64), inset: f64) -> (u32, u32) {
    let (mut best, mut at) = (i64::MIN, (0i64, 0i64));
    let (mut sx, mut sy, mut n) = (0f64, 0f64, 0f64);
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let i = ((y * w as i64 + x) * 4) as usize;
            if !on_plane(&rgba[i..i + 4]) {
                continue;
            }
            sx += x as f64;
            sy += y as f64;
            n += 1.0;
            let score = x * dir.0 + y * dir.1;
            if score > best {
                best = score;
                at = (x, y);
            }
        }
    }
    let (cx, cy) = (sx / n, sy / n);
    let x = at.0 as f64 + (cx - at.0 as f64) * inset;
    let y = at.1 as f64 + (cy - at.1 as f64) * inset;
    (x as u32, y as u32)
}

/// Netteté d'une fenêtre `r`×`r` centrée en `c` : moyenne des écarts absolus entre voisins
/// (luma approchée par le vert). Le texte net en a beaucoup, le texte flou peu.
fn sharpness(rgba: &[u8], w: u32, c: (u32, u32), r: u32) -> f64 {
    let g = |x: u32, y: u32| rgba[((y * w + x) * 4 + 1) as usize] as f64;
    let (mut acc, mut n) = (0.0, 0.0);
    for y in c.1 - r / 2..c.1 + r / 2 {
        for x in c.0 - r / 2..c.0 + r / 2 {
            acc += (g(x + 1, y) - g(x, y)).abs() + (g(x, y + 1) - g(x, y)).abs();
            n += 1.0;
        }
    }
    acc / n
}

fn window_bytes(rgba: &[u8], w: u32, c: (u32, u32), r: u32) -> Vec<u8> {
    let mut out = Vec::new();
    for y in c.1 - r / 2..c.1 + r / 2 {
        let i = ((y * w + c.0 - r / 2) * 4) as usize;
        out.extend_from_slice(&rgba[i..i + (r * 4) as usize]);
    }
    out
}

#[test]
fn the_far_corner_of_a_tilted_screen_is_defocused_and_the_near_one_is_not() {
    let Ok(source) = std::env::var("OPENSCREEN_DOF_SOURCE") else {
        println!("SKIP: definir OPENSCREEN_DOF_SOURCE (voir l'en-tete du fichier).");
        return;
    };
    let out = std::env::var("OPENSCREEN_DOF_OUT").ok().map(std::path::PathBuf::from);
    let gpu = Gpu::create(false).expect("device d3d11");
    let (w, h) = (1920u32, 1080u32);
    let rot = r#""iso""#;

    // Focus sur le coin PROCHE (haut-droit d'iso) : le lointain (bas-gauche) en est au plus loin.
    let near_focus = [0.94, 0.06];
    let on = render(&gpu, &source, rot, true, near_focus, w, h);
    let off = render(&gpu, &source, rot, false, near_focus, w, h);
    write_ppm(&out, "iso-dof-on", &on, w, h);
    write_ppm(&out, "iso-dof-off", &off, w, h);

    let r = 48;
    let near = corner_window(&off, w, h, (1, -1), 0.12);
    let far = corner_window(&off, w, h, (-1, 1), 0.12);
    let (near_on, near_off) = (sharpness(&on, w, near, r), sharpness(&off, w, near, r));
    let (far_on, far_off) = (sharpness(&on, w, far, r), sharpness(&off, w, far, r));
    println!("iso : proche {near:?} nettete {near_off:.2} -> {near_on:.2}");
    println!("iso : lointain {far:?} nettete {far_off:.2} -> {far_on:.2}");
    // Garde : les deux fenêtres voient du contenu, pas un aplat.
    assert!(near_off > 2.0 && far_off > 2.0, "fenetres sans detail ({near_off}, {far_off})");
    // Le coin proche, au focus, reste l'échantillon net d'avant : pas un octet ne bouge.
    assert_eq!(window_bytes(&on, w, near, r), window_bytes(&off, w, near, r), "coin proche modifie");
    // Le coin lointain perd nettement de son détail, et plus que le proche : l'ordre des deux
    // est ce qu'un signe de profondeur inversé casserait.
    assert!(far_on < far_off * 0.7, "coin lointain pas floute : {far_off} -> {far_on}");
    assert!(far_on / far_off < near_on / near_off, "le lointain n'est pas le plus flou");

    // Focus au centre : les deux coins sont à la même distance du plan net, ni l'un ni l'autre
    // n'est épargné — la preuve que c'est bien le focus qui décide, pas la position.
    let centre = render(&gpu, &source, rot, true, [0.5, 0.5], w, h);
    write_ppm(&out, "iso-dof-on-centre-focus", &centre, w, h);
    let near_c = sharpness(&centre, w, near, r);
    println!("iso focus centre : proche {near_off:.2} -> {near_c:.2}");
    assert!(near_c < near_off * 0.9, "focus au centre : le coin proche devrait se flouter aussi");

    // À plat, l'effet n'existe pas : allumé ou non, la frame est la même à l'octet.
    let flat_on = render(&gpu, &source, "null", true, near_focus, w, h);
    let flat_off = render(&gpu, &source, "null", false, near_focus, w, h);
    assert!(flat_on == flat_off, "rotation nulle : la profondeur de champ a change la frame");
}

/// Coût mesuré, A/B entrelacé : la même frame décodée, recomposée par deux compositeurs qui ne
/// diffèrent que par le réglage. Le readback synchronise le GPU à chaque tour ; il est payé des
/// deux côtés, donc l'écart est celui de l'effet.
///
/// Trois formes, parce que la pyramide suit la texture SOURCE et non le rendu :
/// - export : rendu à la taille de sortie, `readback_resized` (ce que fait l'export) ;
/// - preview : rendu à la taille du panneau (1280×720 ici, cf. `preview_render_size`), lu par
///   `readback_direct` comme la boucle live — la pyramide y reste pleine taille, donc son coût
///   pèse relativement plus ;
/// - 4K : source et sortie 3840×2160, si `OPENSCREEN_DOF_SOURCE_4K` est posée.
#[test]
fn depth_of_field_cost_a_b() {
    let (Ok(source), Ok(_)) = (std::env::var("OPENSCREEN_DOF_SOURCE"), std::env::var("OPENSCREEN_DOF_BENCH")) else {
        println!("SKIP: definir OPENSCREEN_DOF_SOURCE et OPENSCREEN_DOF_BENCH.");
        return;
    };
    let source_4k = std::env::var("OPENSCREEN_DOF_SOURCE_4K").ok();
    let mut cases = vec![
        (Backend::Hardware, source.clone(), (1920u32, 1080u32), false, 300usize),
        (Backend::Hardware, source.clone(), (1280, 720), true, 300),
        (Backend::Cpu, source.clone(), (1920, 1080), false, 20),
        (Backend::Cpu, source.clone(), (1280, 720), true, 20),
    ];
    if let Some(s4) = source_4k {
        cases.insert(2, (Backend::Hardware, s4, (3840, 2160), false, 150));
    }
    for (backend, source, (w, h), preview, rounds) in cases {
        let Ok(gpu) = Gpu::create_backend(backend, false) else {
            println!("{backend:?} indisponible, saute");
            continue;
        };
        let focus = [0.92, 0.08];
        let on = compositor(&gpu, &source, r#""iso""#, true, focus, w, h);
        let off = compositor(&gpu, &source, r#""iso""#, false, focus, w, h);
        let cfg = cfg();
        let read = |comp: &Compositor| unsafe {
            if preview {
                comp.readback_direct().expect("readback").2
            } else {
                comp.readback_resized(w, h).expect("readback")
            }
        };
        let (mut t_on, mut t_off) = (0f64, 0f64);
        unsafe {
            let mut player = Player::open(&source, "", &gpu).expect("ouvrir la source");
            player.present_frame(&on, &cfg, AT_SEC).expect("composer la frame");
            // Chauffe : allocation de la pyramide, caches du pilote.
            for comp in [&on, &off, &on, &off] {
                player.recompose(comp, &cfg).expect("recomposer");
                read(comp);
            }
            for i in 0..rounds {
                // Ordre alterné : aucun des deux ne profite toujours d'être second.
                let pair = if i % 2 == 0 { [(&on, true), (&off, false)] } else { [(&off, false), (&on, true)] };
                for (comp, is_on) in pair {
                    let t0 = Instant::now();
                    player.recompose(comp, &cfg).expect("recomposer");
                    read(comp);
                    let dt = t0.elapsed().as_secs_f64() * 1e3;
                    if is_on { t_on += dt } else { t_off += dt }
                }
            }
        }
        let (a, b) = (t_on / rounds as f64, t_off / rounds as f64);
        let shape = if preview { "preview (readback_direct)" } else { "export (readback_resized)" };
        println!(
            "{backend:?} {w}x{h} {shape}, iso, {rounds} tours : DoF on {a:.2} ms/frame, off {b:.2} ms/frame, surcout {:.2} ms/frame",
            a - b
        );
    }
}
