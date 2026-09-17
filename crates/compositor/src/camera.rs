//! Caméra 3D réelle, en orbite, pour `follow-cursor`.
//!
//! L'ÉCRAN NE BOUGE PAS. L'œil tourne autour de lui sur une sphère : l'azimut suit la position
//! horizontale du pointeur (à droite, on voit l'écran par la droite et son côté droit vient vers
//! nous), l'élévation sa position verticale (en haut, la caméra monte et plonge sur le haut de
//! l'écran), autour d'une petite élévation de repos. L'œil regarde toujours son point visé, haut du
//! monde fixe (le `lookAt` classique) : le roulis est donc nul PAR CONSTRUCTION. L'axe horizontal
//! de l'image reste horizontal dans le monde, et une verticale qui passe par le point visé reste
//! verticale à l'image. Ce qui penche encore, c'est la perspective, et elle seule.
//!
//! Pourquoi une orbite et pas un pivot sur place : depuis un œil fixe, tourner la caméra n'est
//! presque qu'un pan à plat, l'angle sous lequel on voit l'écran change à peine. L'orientation ne
//! se lit que si l'œil se DÉPLACE autour de l'écran.
//!
//! Repère du monde : celui de l'écran, en px de sa boîte (`s_dst`, zoom compris), origine au
//! centre de l'écran, x à droite, y vers le bas, z vers l'œil ; l'écran est le plan z = 0.
//!
//! Le rendu passe par `TiltedQuad`, que les modes 8, 10, 12, 13, 14 et 15 savent déjà dessiner : la
//! rotation de la caméra y est une rotation X (tangage) puis Y (lacet) du plan, exactement celle de
//! `regions::rotate_point`, plus une translation de l'image du centre de l'écran (`offset`) et un
//! warp projectif (`projective`). Cette convention décrit n'importe quel œil sans roulis : l'orbite
//! n'ajoute rien aux shaders.

use crate::regions::{CameraFrame, TiltedQuad};

/// Distance de l'œil au point visé, en `min(w, h)` de la boîte au zoom 1 : l'objectif des angles
/// fixes (`regions::PERSPECTIVE_FACTOR`), ~35° de champ sur le petit côté. Assez court pour que la
/// perspective se lise : c'est elle qui montre l'orientation.
pub const DISTANCE: f32 = crate::regions::PERSPECTIVE_FACTOR;
/// Azimut (degrés) quand le pointeur touche le bord droit de l'image (+), ou gauche (−).
pub const AZIMUTH_DEG: f32 = 22.0;
/// Élévation (degrés) : au repos, puis le débattement, pointeur au bord haut (+) ou bas (−). Le
/// repos regarde un peu d'en haut : les bords verticaux convergent, l'écran ne se tient jamais
/// parfaitement droit au milieu de son orbite.
pub const ELEVATION_DEG: [f32; 2] = [4.0, 12.0];
/// Part du zoom prise en travelling plutôt qu'en focale : la distance est divisée par
/// `zoom^DOLLY`. Un zoom purement optique (0) aplatit d'autant la perspective de la vue ; en
/// s'approchant, la caméra garde assez de fuite pour que l'orbite se lise encore au zoom. Plus
/// (0,75), la vue zoomée tourne au grand-angle et tout le texte penche.
const DOLLY: f32 = 0.5;
/// Zoom à partir duquel le cadrage « écran entier » (containment de l'enveloppe, centrage) a
/// cédé la place au cadrage « point visé au centre ». Entre 1 et lui, fondu linéaire.
const FULL_VIEW_ZOOM: f32 = 2.0;
/// Recul de l'œil au contact d'un clic, en fraction de sa distance (impact du clic).
pub const PRESS: f32 = 0.04;
/// Marge du containment : l'enveloppe n'est échantillonnée qu'en 3×3, et le centrage déplace un
/// peu le pire cas entre ces points (mesuré : 0,3 % au plus).
const FIT_MARGIN: f32 = 0.995;

/// Ce que la caméra reçoit d'une frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraPose {
    /// Poids de la caméra (0..1) : la force de la région de zoom. À 0, la caméra regarde l'écran
    /// de face et la projection est l'identité.
    pub weight: f32,
    /// Point visé dans l'écran (0..1 depuis son coin haut-gauche), déjà pondéré.
    pub aim: [f32; 2],
    /// Le pointeur lissé dans l'écran (0..1), déjà pondéré : il place l'œil sur l'orbite.
    pub orbit: [f32; 2],
    /// Zoom courant (≥ 1) : l'œil s'approche de `zoom^DOLLY`, la focale fait le reste.
    pub zoom: f32,
    /// Impact des clics (somme de `regions::tap`, −1 au contact), déjà passé par ses portes :
    /// l'œil recule de `PRESS` au contact. 0 sans impact.
    pub press: f32,
}

impl CameraPose {
    /// La caméra au repos, pointeur au centre : ce que rend une région sans piste.
    pub const REST: CameraPose =
        CameraPose { weight: 1.0, aim: [0.5; 2], orbit: [0.5; 2], zoom: 1.0, press: 0.0 };
}

/// Une caméra posée : œil, orientation et focale, dans le repère du monde.
#[derive(Clone, Copy, Debug)]
pub struct View {
    eye: [f32; 3],
    /// Lacet et tangage (rad) : positif = vers la droite, vers le haut.
    yaw: f32,
    pitch: f32,
    /// Focale en px de sortie.
    focal: f32,
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Direction de visée pour un lacet et un tangage.
fn forward(yaw: f32, pitch: f32) -> [f32; 3] {
    [yaw.sin() * pitch.cos(), -pitch.sin(), -yaw.cos() * pitch.cos()]
}

/// Azimut et élévation (rad) d'un pointeur en `orbit` (0..1, déjà pondéré), au poids `w`.
fn orbit_angles(orbit: [f32; 2], w: f32) -> [f32; 2] {
    let [rest, swing] = ELEVATION_DEG;
    [
        (AZIMUTH_DEG * (2.0 * orbit[0] - 1.0)).to_radians(),
        (rest * w + swing * (1.0 - 2.0 * orbit[1])).to_radians(),
    ]
}

/// L'œil à `dist` du point `target` de l'écran, dans la direction (azimut, élévation), qui le
/// regarde.
fn orbit_view(target: [f32; 2], dist: f32, [az, el]: [f32; 2], focal: f32) -> View {
    let eye = [
        target[0] + dist * az.sin() * el.cos(),
        target[1] - dist * el.sin(),
        dist * az.cos() * el.cos(),
    ];
    View { eye, yaw: -az, pitch: -el, focal }
}

/// Boîte englobante `[x0, x1, y0, y1]` de l'écran `unit` (petit côté 1) vu à `DISTANCE` de
/// `target`, focale `DISTANCE` : en unités du petit côté, relative au point principal.
fn unit_bbox(unit: [f32; 2], angles: [f32; 2], target: [f32; 2]) -> [f32; 4] {
    let v = orbit_view(target, DISTANCE, angles, DISTANCE);
    let mut b = [f32::MAX, f32::MIN, f32::MAX, f32::MIN];
    for [x, y] in corners(unit[0], unit[1]) {
        let [px, py] = v.project([x, y, 0.0]).unwrap_or([x, y]);
        b = [b[0].min(px), b[1].max(px), b[2].min(py), b[3].max(py)];
    }
    b
}

/// Le point à viser pour que l'écran vu sous `angles` soit CENTRÉ dans sa boîte, en unités du
/// petit côté. Vu de biais, le côté proche grandit et le lointain rétrécit : viser le centre de
/// l'écran le décentrerait, et le containment paierait ce décalage (0,77 au lieu de 0,83 en
/// 16:9). Quatre passes : 0,2 px d'écart à 1080p.
fn centring(unit: [f32; 2], angles: [f32; 2]) -> [f32; 2] {
    let mut l = [0.0f32; 2];
    for _ in 0..4 {
        let b = unit_bbox(unit, angles, l);
        l = [l[0] + 0.5 * (b[0] + b[1]), l[1] + 0.5 * (b[2] + b[3])];
    }
    l
}

/// Le containment d'une région : le facteur qui fait tenir l'écran centré dans sa boîte depuis
/// TOUTE l'enveloppe de l'orbite au poids `w`. Il ne dépend ni du pointeur ni du temps, donc
/// l'écran ne respire pas pendant que la caméra tourne.
fn envelope_fit(unit: [f32; 2], w: f32) -> f32 {
    let mut fit = 1.0f32;
    for ox in [0.0, 0.5, 1.0] {
        for oy in [0.0, 0.5, 1.0] {
            let orbit = [0.5 + (ox - 0.5) * w, 0.5 + (oy - 0.5) * w];
            let angles = orbit_angles(orbit, w);
            let b = unit_bbox(unit, angles, centring(unit, angles));
            let (mx, my) = (b[0].abs().max(b[1].abs()), b[2].abs().max(b[3].abs()));
            fit = fit.min(0.5 * unit[0] / mx).min(0.5 * unit[1] / my);
        }
    }
    if fit < 1.0 { fit * FIT_MARGIN } else { 1.0 }
}

impl View {
    /// La caméra qui filme une boîte écran de `box_px` px (zoom compris) sous `pose`.
    ///
    /// - L'œil est sur l'orbite de `pose.orbit`, à `DISTANCE × min(boîte) × zoom^(−DOLLY)` du point
    ///   visé : la vue se resserre moitié par travelling, moitié par focale.
    /// - Au zoom 1, le point visé est décalé pour centrer l'écran (`centring`) et la focale réduite
    ///   pour qu'il tienne dans sa boîte depuis toute l'orbite (`envelope_fit`). Dès le zoom
    ///   `FULL_VIEW_ZOOM`, le point visé tombe au centre de l'image, grossi du zoom.
    pub fn new(box_px: [f32; 2], pose: CameraPose) -> View {
        let w = pose.weight.clamp(0.0, 1.0);
        let [bw, bh] = box_px;
        let m = bw.min(bh).max(1e-3);
        let zoom = pose.zoom.max(1.0);
        let unit = [bw / m, bh / m];
        let fade = ((zoom - 1.0) / (FULL_VIEW_ZOOM - 1.0)).clamp(0.0, 1.0);
        let fit = envelope_fit(unit, w);
        let fit = fit + (1.0 - fit) * fade;
        let angles = orbit_angles(pose.orbit, w);
        let shift = centring(unit, angles).map(|c| c * m * (1.0 - fade));
        let dist = DISTANCE * m * zoom.powf(-DOLLY);
        let target = [(pose.aim[0] - 0.5) * bw + shift[0], (pose.aim[1] - 0.5) * bh + shift[1]];
        orbit_view(target, dist * (1.0 - PRESS * pose.press * w), angles, dist * fit)
    }

    /// Axes de la caméra dans le monde : droite, bas, visée.
    fn basis(&self) -> ([f32; 3], [f32; 3], [f32; 3]) {
        let (sy, cy, sp, cp) = (self.yaw.sin(), self.yaw.cos(), self.pitch.sin(), self.pitch.cos());
        ([cy, 0.0, sy], [sy * sp, cp, -cy * sp], forward(self.yaw, self.pitch))
    }

    /// Un point du monde en px relatifs au point principal (le centre de la boîte) ; `None`
    /// derrière la caméra.
    pub fn project(&self, p: [f32; 3]) -> Option<[f32; 2]> {
        let (r, u, f) = self.basis();
        let q = sub(p, self.eye);
        let z = dot(f, q);
        (z > 1e-3).then(|| [self.focal * dot(r, q) / z, self.focal * dot(u, q) / z])
    }

    /// Azimut et élévation de l'œil, en degrés.
    pub fn angles_deg(&self) -> [f32; 2] {
        [-self.yaw.to_degrees(), -self.pitch.to_degrees()]
    }

    /// L'écran `box_px` vu par cette caméra, dans la convention de `TiltedQuad`.
    ///
    /// Un point `p` du plan, en px du plan (le monde multiplié par `scale`), vaut
    /// `w = R·p + (offset, 0)` dans le repère de la caméra et se projette en `P·w.xy / (P − w.z)`,
    /// avec `R = rotate_point(·, rot)` et `P = focal` : c'est la projection de `project`, le monde
    /// mis à l'échelle autour de l'œil pour que le centre de l'écran soit à la profondeur `P`.
    pub fn quad(&self, box_px: [f32; 2]) -> TiltedQuad {
        let (_, _, f) = self.basis();
        let project = |p: [f32; 3]| self.project(p).unwrap_or([p[0], p[1]]);
        let c = corners(box_px[0], box_px[1]).map(|[x, y]| {
            let [px, py] = project([x, y, 0.0]);
            (px, py)
        });
        let rot = [self.pitch.to_degrees(), self.yaw.to_degrees(), 0.0];
        TiltedQuad {
            corners: c,
            scale: self.focal / -dot(f, self.eye),
            depth_k: crate::regions::depth_coefficients(rot),
            rot,
            perspective: self.focal,
            offset: project([0.0; 3]),
            projective: true,
        }
    }
}

/// Coins TL, TR, BR, BL d'une boîte centrée.
fn corners(bw: f32, bh: f32) -> [[f32; 2]; 4] {
    let (hw, hh) = (bw * 0.5, bh * 0.5);
    [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
}

// ---- Le cadreur ----------------------------------------------------------------------------

/// Pulsation du lissage (rad/s) : une réponse critique, 95 % d'un saut en 0,95 s, sans
/// dépassement.
const FOLLOW_OMEGA: f32 = 5.0;
/// Anticipation (s) : un enregistrement se monte après coup, la caméra part avant le geste. Le
/// retard moyen du lissage est `2/ω` = 0,4 s ; il en reste 0,15.
const FOLLOW_LOOKAHEAD_S: f32 = 0.25;
/// Pas et longueur du noyau : ω·τ va jusqu'à 10, la queue coupée pèse 5·10⁻⁴.
const FOLLOW_STEP_S: f32 = 1.0 / 60.0;
const FOLLOW_TAPS: usize = 120;
/// La vue comptée plus large que `1/zoom` de l'écran, pour la portée du point visé.
const VIEW_MARGIN: f32 = 1.1;

/// Ce que le cadreur rend pour une frame, en fractions de l'écran recadré : le point visé et le
/// pointeur lissé.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Follow {
    pub aim: [f32; 2],
    pub orbit: [f32; 2],
}

impl Follow {
    pub const CENTRE: Follow = Follow { aim: [0.5; 2], orbit: [0.5; 2] };
}

/// Où `follow-cursor` vise à `t` et où il place l'œil, pour une région de zoom `zoom`. Sans
/// piste : le centre, caméra au repos.
///
/// Le pointeur (lu dans l'image source recadrée, borné à l'écran et à la fenêtre du clip) passe
/// par la réponse impulsionnelle d'un ressort critique, `h(τ) = ω²·τ·e^(−ωτ)`, avancée de
/// `FOLLOW_LOOKAHEAD_S` : une convolution sur 2 s de piste. C'est une pure fonction de `t`, sans
/// mémoire d'une frame à l'autre, au coût borné (120 lectures) quelle que soit la longueur de la
/// région. Pas de zone morte : la caméra vit avec le pointeur, le lissage la garde calme.
///
/// - `orbit` : le pointeur lissé, sur tout l'écran.
/// - `aim` : le même, borné avant lissage à `0,5 ± (0,5 − 0,5·VIEW_MARGIN/zoom)`, là où la vue
///   reste dans l'écran ; au zoom 1, le centre.
pub fn follow(frame: &CameraFrame, t: f32, zoom: f32) -> Follow {
    let Some(track) = frame.track else { return Follow::CENTRE };
    let reach = (0.5 - 0.5 * VIEW_MARGIN / zoom.max(1.0)).max(0.0);
    let [x0, y0, x1, y1] = frame.crop;
    let size = [(x1 - x0).max(1e-6), (y1 - y0).max(1e-6)];
    let (mut aim, mut orbit, mut total) = ([0.0f32; 2], [0.0f32; 2], 0.0f32);
    for k in 1..=FOLLOW_TAPS {
        let tau = k as f32 * FOLLOW_STEP_S;
        let weight = tau * (-FOLLOW_OMEGA * tau).exp();
        let at = (t + FOLLOW_LOOKAHEAD_S - tau).max(frame.window[0]).min(frame.window[1]);
        let Some((px, py)) = track.at(at) else { return Follow::CENTRE };
        let p = [((px - x0) / size[0]).clamp(0.0, 1.0), ((py - y0) / size[1]).clamp(0.0, 1.0)];
        for i in 0..2 {
            orbit[i] += weight * p[i];
            aim[i] += weight * p[i].clamp(0.5 - reach, 0.5 + reach);
        }
        total += weight;
    }
    Follow { aim: aim.map(|a| a / total), orbit: orbit.map(|o| o / total) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::CursorTrack;

    const BOX: [f32; 2] = [1536.0, 864.0];

    fn pose(orbit: [f32; 2], zoom: f32) -> CameraPose {
        let reach = (0.5 - 0.5 * VIEW_MARGIN / zoom).max(0.0);
        let aim = orbit.map(|o| o.clamp(0.5 - reach, 0.5 + reach));
        CameraPose { weight: 1.0, aim, orbit, zoom, press: 0.0 }
    }

    fn view(orbit: [f32; 2], zoom: f32) -> (View, [f32; 2]) {
        let bx = BOX.map(|b| b * zoom);
        (View::new(bx, pose(orbit, zoom)), bx)
    }

    /// L'enveloppe du chemin : pointeur sur une grille de l'écran, à chaque zoom de l'app et au
    /// zoom 1, pendant l'entrée aussi (le zoom et le poids montent ensemble, comme dans
    /// `zoom_state_in`), et au creux d'un clic.
    fn envelope() -> Vec<(f32, f32, [f32; 2], View, [f32; 2])> {
        let mut out = Vec::new();
        for zoom in [1.0f32, 1.25, 1.5, 1.8, 2.2, 3.5, 5.0] {
            let reach = (0.5 - 0.5 * VIEW_MARGIN / zoom).max(0.0);
            for k in [2, 5, 8, 10] {
                let weight = k as f32 / 10.0;
                let z = 1.0 + (zoom - 1.0) * weight;
                let bx = BOX.map(|b| b * z);
                for i in 0..=4 {
                    for j in 0..=4 {
                        let o = [i as f32 / 4.0, j as f32 / 4.0];
                        let aim = o.map(|c| c.clamp(0.5 - reach, 0.5 + reach));
                        for press in [0.0, -1.0] {
                            let p = CameraPose {
                                weight,
                                aim: aim.map(|a| 0.5 + (a - 0.5) * weight),
                                orbit: o.map(|a| 0.5 + (a - 0.5) * weight),
                                zoom: z,
                                press,
                            };
                            out.push((zoom, weight, o, View::new(bx, p), bx));
                        }
                    }
                }
            }
        }
        out
    }

    /// L'axe horizontal de l'image reste horizontal dans le monde, et une verticale du monde qui
    /// passe par le point regardé reste verticale à l'image : roulis nul sur toute l'enveloppe.
    #[test]
    fn the_roll_is_zero_on_the_whole_envelope() {
        for (zoom, weight, o, v, _) in envelope() {
            let (r, _, f) = v.basis();
            assert_eq!(r[1], 0.0, "l'axe horizontal de l'image quitte l'horizontale");
            let looked = [0, 1, 2].map(|k| v.eye[k] + 2500.0 * f[k]);
            for dy in [-400.0f32, -150.0, 150.0, 400.0] {
                let p = v.project([looked[0], looked[1] + dy, looked[2]]).unwrap();
                assert!(p[0].abs() < 2e-3, "zoom {zoom} poids {weight} {o:?} dy {dy} : {p:?}");
            }
        }
    }

    /// Pointeur à droite : l'œil passe à droite, le bord droit de l'écran est plus proche, donc
    /// plus haut à l'image que le gauche. En haut : l'œil monte, le bord haut est plus large que le
    /// bas. En bas : l'inverse. Plus le pointeur s'écarte, plus l'angle grandit.
    #[test]
    fn the_orbit_follows_the_pointer_side() {
        let height = |q: &TiltedQuad, a: usize, b: usize| (q.corners[b].1 - q.corners[a].1).abs();
        let width = |q: &TiltedQuad, a: usize, b: usize| (q.corners[b].0 - q.corners[a].0).abs();
        for zoom in [1.0f32, 1.8, 3.5] {
            let (right, bx) = view([0.9, 0.5], zoom);
            let (left, _) = view([0.1, 0.5], zoom);
            let (top, _) = view([0.5, 0.1], zoom);
            let (bottom, _) = view([0.5, 0.9], zoom);
            let (mid, _) = view([0.5, 0.5], zoom);
            let (qr, ql, qt, qb) = (right.quad(bx), left.quad(bx), top.quad(bx), bottom.quad(bx));
            // Coins TL, TR, BR, BL : bord gauche 0→3, droit 1→2, haut 0→1, bas 3→2.
            assert!(height(&qr, 1, 2) > 1.1 * height(&qr, 0, 3), "zoom {zoom} droite");
            assert!(height(&ql, 0, 3) > 1.1 * height(&ql, 1, 2), "zoom {zoom} gauche");
            assert!(width(&qt, 0, 1) > 1.05 * width(&qt, 3, 2), "zoom {zoom} haut");
            assert!(width(&qb, 3, 2) > 1.03 * width(&qb, 0, 1), "zoom {zoom} bas");
            let ([az_r, el_r], [az_l, _]) = (right.angles_deg(), left.angles_deg());
            let ([_, el_t], [_, el_b], [az_m, el_m]) = (top.angles_deg(), bottom.angles_deg(), mid.angles_deg());
            assert!((az_r - 0.8 * AZIMUTH_DEG).abs() < 1e-3 && (az_l + 0.8 * AZIMUTH_DEG).abs() < 1e-3);
            assert!(az_m.abs() < 1e-4 && (el_m - ELEVATION_DEG[0]).abs() < 1e-3 && el_r == el_m);
            assert!(el_t > el_m + 9.0 && el_b < el_m - 9.0, "{el_t} {el_m} {el_b}");
            // L'œil est bien du côté du pointeur.
            assert!(right.eye[0] > 0.0 && left.eye[0] < 0.0 && top.eye[1] < bottom.eye[1]);
        }
        let [a, b, c] = [0.6f32, 0.75, 0.95].map(|x| view([x, 0.5], 1.0).0.angles_deg()[0]);
        assert!(0.0 < a && a < b && b < c, "{a} {b} {c}");
    }

    /// Dès `FULL_VIEW_ZOOM`, le point visé tombe au point principal.
    #[test]
    fn the_camera_looks_at_its_aim() {
        for zoom in [2.0f32, 3.5] {
            let p = pose([0.62, 0.41], zoom);
            let bx = BOX.map(|b| b * zoom);
            let v = View::new(bx, p);
            let aim = [(p.aim[0] - 0.5) * bx[0], (p.aim[1] - 0.5) * bx[1], 0.0];
            let q = v.project(aim).unwrap();
            assert!(q[0].abs() < 1e-2 && q[1].abs() < 1e-2, "{q:?}");
        }
    }

    /// À poids nul, la caméra regarde l'écran de face et le rend à sa taille : le rendu plat,
    /// quels que soient le zoom et les clics.
    #[test]
    fn a_zero_weight_is_the_flat_layout() {
        for zoom in [1.0f32, 1.8, 5.0] {
            for press in [0.0, -1.0, 0.4] {
                let bx = BOX.map(|b| b * zoom);
                let p = CameraPose { weight: 0.0, aim: [0.5; 2], orbit: [0.5; 2], zoom, press };
                let q = View::new(bx, p).quad(bx);
                for (c, e) in q.corners.iter().zip(corners(bx[0], bx[1])) {
                    assert!((c.0 - e[0]).abs() < 0.05 && (c.1 - e[1]).abs() < 0.05, "{c:?} {e:?}");
                }
                assert!((q.scale - 1.0).abs() < 1e-4 && q.rot == [0.0; 3], "{} {:?}", q.scale, q.rot);
            }
        }
    }

    /// Au zoom 1, l'écran entier tient dans sa boîte depuis toute l'orbite, et la touche au pire
    /// de l'enveloppe : le containment est juste, pas une marge au jugé.
    #[test]
    fn at_zoom_1_the_whole_screen_stays_in_its_box() {
        for bx in [BOX, [864.0, 1536.0], [1000.0, 1000.0], [2560.0, 1080.0]] {
            let mut tightest = f32::MAX;
            for k in [1, 4, 7, 10] {
                let weight = k as f32 / 10.0;
                for i in 0..=20 {
                    for j in 0..=20 {
                        let o = [i as f32 / 20.0, j as f32 / 20.0].map(|c| 0.5 + (c - 0.5) * weight);
                        let p = CameraPose { weight, aim: [0.5; 2], orbit: o, zoom: 1.0, press: 0.0 };
                        let (mx, my) = View::new(bx, p).quad(bx).half_extents_px();
                        assert!(
                            mx <= bx[0] * 0.5 + 0.5 && my <= bx[1] * 0.5 + 0.5,
                            "{bx:?} poids {weight} {o:?} : {mx} {my}"
                        );
                        tightest = tightest.min((bx[0] * 0.5 - mx).min(bx[1] * 0.5 - my));
                    }
                }
            }
            println!("{bx:?} : au plus près, {tightest:.1} px du bord de la boîte");
            assert!(tightest < 0.01 * bx[0].min(bx[1]), "{bx:?} {tightest}");
        }
        let (mx, my) = View::new(BOX, CameraPose::REST).quad(BOX).half_extents_px();
        println!("repos 16:9 : {:.3} × {:.3} de la boîte", mx / (BOX[0] * 0.5), my / (BOX[1] * 0.5));
        assert!(mx > 0.8 * BOX[0] * 0.5 && my > 0.8 * BOX[1] * 0.5, "{mx} {my}");
    }

    /// Le containment est gelé par région : à zoom et poids donnés, la focale ne dépend ni du
    /// pointeur ni du point visé. L'écran ne respire pas pendant que la caméra tourne.
    #[test]
    fn the_scale_is_frozen_per_region() {
        for zoom in [1.0f32, 1.25, 1.8, 3.5] {
            let focal = view([0.5, 0.5], zoom).0.focal;
            for i in 0..=10 {
                for j in 0..=10 {
                    let v = view([i as f32 / 10.0, j as f32 / 10.0], zoom).0;
                    assert_eq!(v.focal, focal, "zoom {zoom} ({i}, {j})");
                }
            }
        }
        // Le clic recule l'œil sans toucher la focale : l'écran rapetisse, puis revient.
        let (still, bx) = view([0.7, 0.4], 1.0);
        let pressed = View::new(bx, CameraPose { press: -1.0, ..pose([0.7, 0.4], 1.0) });
        assert_eq!(still.focal, pressed.focal);
        let (s, p) = (still.quad(bx).half_extents_px(), pressed.quad(bx).half_extents_px());
        assert!(p.0 < s.0 * 0.975 && p.1 < s.1 * 0.975, "{s:?} {p:?}");
    }

    /// Le quad, sa translation, sa focale et sa rotation reproduisent la caméra : ce que le mode 15
    /// reconstruit (rayon par pixel) tombe exactement sur ce que le mode 8 dessine.
    #[test]
    fn the_quad_convention_reproduces_the_camera() {
        for (_, _, o, v, bx) in envelope().into_iter().step_by(37) {
            let q = v.quad(bx);
            let s = q.scale;
            let tol = 2e-4 * bx[0];
            for (fx, fy) in [(0.0, 0.0), (0.3, 0.7), (1.0, 1.0), (0.9, 0.1), (-0.05, 1.05)] {
                let p = [(fx - 0.5) * bx[0], (fy - 0.5) * bx[1], 0.0];
                let want = v.project(p).unwrap();
                let w = crate::regions::rotate_point(p.map(|c| c * s), q.rot);
                let (wx, wy) = (w[0] + q.offset[0], w[1] + q.offset[1]);
                let d = q.perspective - w[2];
                let got = [wx * q.perspective / d, wy * q.perspective / d];
                assert!(
                    (got[0] - want[0]).abs() < tol && (got[1] - want[1]).abs() < tol,
                    "{o:?} {got:?} {want:?}"
                );
                // Et la correspondance directe du warp (homographie des coins) est la même.
                let h = q.point_px(fx, fy);
                assert!((h.0 - want[0]).abs() < tol && (h.1 - want[1]).abs() < tol, "{o:?} {h:?} {want:?}");
            }
            // L'œil, dans le repère du plan, est celui de la caméra.
            let eye = crate::regions::rotate_point_inv([-q.offset[0], -q.offset[1], q.perspective], q.rot);
            for k in 0..3 {
                assert!((eye[k] - v.eye[k] * s).abs() < tol, "{o:?} {eye:?} {:?}", v.eye);
            }
        }
    }

    /// Le warp bilinéaire des angles fixes s'écarte de la projection exacte de plusieurs dizaines
    /// de px sous cette caméra (partie visible d'un cadre 1920×1080) : le warp projectif est
    /// nécessaire.
    #[test]
    fn the_bilinear_warp_is_too_far_from_the_camera() {
        let bilinear = |c: &[(f32, f32); 4], u: f32, v: f32| {
            let top = (c[0].0 + (c[1].0 - c[0].0) * u, c[0].1 + (c[1].1 - c[0].1) * u);
            let bottom = (c[3].0 + (c[2].0 - c[3].0) * u, c[3].1 + (c[2].1 - c[3].1) * u);
            (top.0 + (bottom.0 - top.0) * v, top.1 + (bottom.1 - top.1) * v)
        };
        let mut worst = 0.0f32;
        for (_, weight, _, v, bx) in envelope() {
            if weight < 1.0 {
                continue;
            }
            let q = v.quad(bx);
            for i in 0..=20 {
                for j in 0..=20 {
                    let (u, t) = (i as f32 / 20.0, j as f32 / 20.0);
                    let exact = q.point_px(u, t);
                    if exact.0.abs() > 960.0 || exact.1.abs() > 540.0 {
                        continue;
                    }
                    let b = bilinear(&q.corners, u, t);
                    worst = worst.max((b.0 - exact.0).hypot(b.1 - exact.1));
                }
            }
        }
        println!("écart bilinéaire / projectif, pire px visible : {worst:.0}");
        assert!(worst > 20.0, "{worst}");
    }

    /// Ce qui penche, et où. Le roulis est nul : une arête ne penche que par la perspective. La
    /// règle des 2° est relâchée pour cette caméra (une arête peut croiser un axe pendant que
    /// l'œil passe), mais au repos, pointeur au milieu, aucun bord vertical visible n'est droit :
    /// l'élévation de repos les fait converger. La pente du contenu au centre de la vue,
    /// `atan(tan(azimut)·sin(élévation))`, reste bornée : c'est ce qui se lit comme « penché »
    /// quand l'œil passe dans un coin.
    #[test]
    fn what_slopes_and_where() {
        let (half_w, half_h) = (960.0f32, 540.0f32);
        for zoom in [1.0f32, 1.25, 1.8, 2.2, 3.5, 5.0] {
            let (v, bx) = view([0.5, 0.5], zoom);
            let c = v.quad(bx).corners;
            for k in [1usize, 3] {
                let (a, b) = (c[k], c[(k + 1) % 4]);
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let visible = (0..=64)
                    .map(|i| (a.0 + dx * i as f32 / 64.0, a.1 + dy * i as f32 / 64.0))
                    .any(|p| p.0.abs() <= half_w && p.1.abs() <= half_h);
                let deg = dx.atan2(dy.abs()).to_degrees().abs();
                assert!(!visible || deg > 1.0, "zoom {zoom} arête {k} à {deg:.2}°");
            }
        }
        let mut worst = 0.0f32;
        for (_, _, _, v, _) in envelope() {
            let [az, el] = v.angles_deg().map(f32::to_radians);
            worst = worst.max((az.tan() * el.sin()).atan().to_degrees().abs());
        }
        println!("pente du contenu au centre de la vue, au pire de l'orbite : {worst:.2}°");
        assert!(worst < 7.0, "{worst}");
    }

    fn track(at: impl Fn(f32) -> (f32, f32)) -> CursorTrack {
        CursorTrack::new(
            (0..=1800)
                .map(|i| {
                    let t = i as f32 / 30.0;
                    let (x, y) = at(t);
                    (t, x, y)
                })
                .collect(),
            vec![],
            vec![],
        )
    }

    fn whole(track: &CursorTrack) -> CameraFrame<'_> {
        CameraFrame { track: Some(track), crop: [0.0, 0.0, 1.0, 1.0], window: [0.0, 100.0] }
    }

    /// Lecture, seek arrière, sauts : même cadrage pour le même `t`, et aucune frame ne saute.
    #[test]
    fn the_follow_is_a_pure_continuous_function_of_time() {
        let tr = track(|t| (0.5 + 0.4 * (t * 1.3).sin(), 0.5 + 0.3 * (t * 0.7).cos()));
        let f = whole(&tr);
        let at = |i: usize| follow(&f, 1.0 + i as f32 / 60.0, 2.0);
        let forward: Vec<_> = (0..600).map(at).collect();
        for i in (0..600).rev().step_by(7) {
            assert_eq!(at(i), forward[i], "frame {i}");
        }
        // Le pointeur va jusqu'à 0,56 écran par seconde : le cadrage reste en dessous, sans à-coup.
        let speed = |a: [f32; 2], b: [f32; 2]| (b[0] - a[0]).hypot(b[1] - a[1]) * 60.0;
        for w in forward.windows(3) {
            let (v0, v1) = (speed(w[0].orbit, w[1].orbit), speed(w[1].orbit, w[2].orbit));
            assert!(v1 < 0.56 && (v1 - v0).abs() < 0.02, "{w:?}");
        }
    }

    /// Un saut du pointeur : la caméra part avant (anticipation), ne dépasse jamais, et s'est
    /// posée à 95 % moins d'une seconde après. Le point visé fait le même chemin, borné à la
    /// portée du zoom.
    #[test]
    fn a_jump_settles_in_about_a_second() {
        let tr = track(|t| if t < 4.0 { (0.3, 0.6) } else { (0.8, 0.2) });
        let f = whole(&tr);
        let at = |t: f32| follow(&f, t, 2.0);
        assert!((at(3.5).orbit[0] - 0.3).abs() < 1e-4);
        assert!(at(3.9).orbit[0] > 0.31, "l'anticipation doit faire partir la caméra avant le saut");
        let progress = |t: f32| (at(t).orbit[0] - 0.3) / 0.5;
        let (mut last, mut settled) = (0.0, None);
        for i in 0..=300 {
            let t = 3.5 + i as f32 / 100.0;
            let p = progress(t);
            assert!(p >= last - 1e-5 && p <= 1.0 + 1e-4, "t {t} : {p} après {last}");
            if settled.is_none() && p >= 0.95 {
                settled = Some(t - 4.0);
            }
            last = p;
        }
        let settled = settled.expect("jamais posée");
        println!("95 % du saut {settled:.2} s après lui");
        assert!((0.6..=1.0).contains(&settled), "{settled}");
        // Le point visé : borné à 0,5 ± 0,225 au zoom 2.
        let posed = at(8.0);
        assert!((posed.aim[0] - 0.725).abs() < 1e-3 && (posed.aim[1] - 0.275).abs() < 1e-3, "{posed:?}");
        assert!((posed.orbit[0] - 0.8).abs() < 1e-3);
    }

    /// Le point visé reste là où la vue reste dans l'écran (au centre au zoom 1), l'orbite lit
    /// tout l'écran. Recadrage compris ; sans piste, le centre.
    #[test]
    fn the_aim_keeps_the_view_on_the_screen() {
        let corner = track(|_| (0.99, 0.01));
        for zoom in [1.0f32, 1.5, 2.0, 3.0] {
            let got = follow(&whole(&corner), 5.0, zoom);
            let reach = (0.5 - 0.5 * VIEW_MARGIN / zoom).max(0.0);
            assert!(
                (got.aim[0] - (0.5 + reach)).abs() < 1e-3 && (got.aim[1] - (0.5 - reach)).abs() < 1e-3,
                "{zoom} {got:?}"
            );
            assert!((got.orbit[0] - 0.99).abs() < 1e-3 && (got.orbit[1] - 0.01).abs() < 1e-3);
        }
        // Dans un recadrage [0,2 ; 0,4], x = 0,38 est tout à droite de ce qu'on voit ; hors du
        // recadrage, le pointeur compte pour le bord.
        let tr = track(|_| (0.38, 0.5));
        let cropped = CameraFrame { crop: [0.2, 0.0, 0.4, 1.0], ..whole(&tr) };
        assert!(follow(&cropped, 5.0, 2.0).orbit[0] > 0.89);
        assert!(follow(&whole(&tr), 5.0, 2.0).orbit[0] < 0.4);
        let outside = CameraFrame { crop: [0.0, 0.0, 0.3, 1.0], ..whole(&tr) };
        assert!((follow(&outside, 5.0, 2.0).orbit[0] - 1.0).abs() < 1e-5);
        assert_eq!(follow(&CameraFrame::NONE, 5.0, 2.0), Follow::CENTRE);
    }

    /// Le coût ne dépend pas de la longueur de la région : 120 lectures de piste par frame.
    /// Chaque mesure garde le meilleur de 7 passes : une préemption ne gonfle qu'une passe.
    #[test]
    fn the_follow_cost_is_bounded() {
        let tr = track(|t| (0.5 + 0.4 * (t * 0.9).sin(), 0.5 + 0.3 * (t * 0.4).cos()));
        let f = whole(&tr);
        let best = |run: &dyn Fn(usize)| {
            (0..7)
                .map(|_| {
                    let t0 = std::time::Instant::now();
                    (0..200).for_each(run);
                    t0.elapsed() / 200
                })
                .min()
                .unwrap()
        };
        let time = |t: f32| {
            best(&|i| {
                std::hint::black_box(follow(&f, t - i as f32 * 0.01, 2.0));
            })
        };
        let (early, late) = (time(3.0), time(59.0));
        let camera = best(&|i| {
            std::hint::black_box(View::new(BOX, pose([i as f32 / 200.0, 0.3], 1.5)));
        });
        println!("cadreur : {early:?} à 3 s, {late:?} à 59 s ; caméra : {camera:?}");
        assert!(late < std::time::Duration::from_millis(1), "{late:?}");
        assert!(late < early * 3 + std::time::Duration::from_micros(50), "{early:?} {late:?}");
        assert!(camera < std::time::Duration::from_millis(1), "{camera:?}");
    }
}
