//! Zoom regions + camera-fullscreen regions — port des enveloppes ease-in/hold/ease-out du
//! web (`zoomRegionUtils.ts` / `cameraFullscreenUtils.ts`) vers le natif, pour que le timing
//! des transitions soit identique en preview ET en export. Inclut le "connected zoom pan"
//! (chaînage lissé entre deux régions rapprochées), le focus "auto" (suivi de la télémétrie
//! curseur) et la rotation 3D (présets iso/left/right, cf. `compositor.rs` pour le rendu du
//! tilt perspective — ce module ne fait que le calcul temporel, pas le rendu GPU).

use crate::cursor::CursorTrack;
use crate::scene::{SceneCameraFullscreenRegion, SceneSpeedRegion, SceneZoomRegion};

/// Quantification commune vidéo/audio : le web retranche exactement 1 ms avant `ceil`.
pub const SPEED_FRAME_EPSILON_SEC: f64 = 0.001;
const MIN_SPEED_SEGMENT_SEC: f64 = 0.0001;

#[derive(Debug, Clone, Copy)]
pub struct SpeedSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub speed: f64,
    pub frame_count: u64,
}

/// Découpe toute la fenêtre gardée en spans contigus ; hors région la vitesse vaut 1×.
/// Les régions sont ordonnées par début et, si un ancien payload en superpose, la première
/// conserve la portion déjà couverte pour ne jamais émettre deux fois le même temps source.
pub fn speed_segments_for_window(
    regions: &[SceneSpeedRegion],
    source_start_sec: f64,
    source_end_sec: f64,
    fps: f64,
) -> Vec<SpeedSegment> {
    if source_end_sec <= source_start_sec || !fps.is_finite() || fps <= 0.0 {
        return Vec::new();
    }
    let mut overlapping: Vec<&SceneSpeedRegion> = regions
        .iter()
        .filter(|r| r.start_sec < source_end_sec && r.end_sec > source_start_sec)
        .collect();
    overlapping.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut spans = Vec::new();
    let mut cursor = source_start_sec;
    for region in overlapping {
        let start = region.start_sec.max(source_start_sec).max(cursor);
        let end = region.end_sec.min(source_end_sec);
        if start > cursor {
            push_speed_segment(&mut spans, cursor, start, 1.0, fps);
        }
        if end > start {
            let speed = if region.speed.is_finite() && region.speed > 0.0 {
                region.speed
            } else {
                1.0
            };
            push_speed_segment(&mut spans, start, end, speed, fps);
            cursor = end;
        }
    }
    if cursor < source_end_sec {
        push_speed_segment(&mut spans, cursor, source_end_sec, 1.0, fps);
    }
    spans
}

/// Multiplicateur de vitesse actif au temps source `t` (temps ABSOLU de la source, même
/// convention que `SceneSpeedRegion.start_sec`/`end_sec` — pas de fenêtre de clip à soustraire).
/// 1.0 hors de toute région. Utilisé par la preview live (`live.rs`) pour moduler le nombre de
/// frames décodées par tick réel — contrairement à `speed_segments_for_window` (export), qui a
/// besoin de pré-découper toute la fenêtre en spans pour connaître le compte de frames total à
/// l'avance, la lecture live avance tick par tick et n'a besoin que de la vitesse "maintenant".
///
/// BUG corrigé : ignorait `region.clip_index`, filtrant seulement par recouvrement temporel sur
/// la scène BRUTE (non filtrée par clip) — dès qu'un projet a plus d'un clip, deux clips peuvent
/// tout à fait partager la même fenêtre de temps source (chacun démarrant près de t=0 de son
/// propre fichier, cas courant), et la région du MAUVAIS clip matchait alors silencieusement (ou
/// aucune ne matchait quand le clip actif est censé être couvert par une région tournée d'un
/// autre index). Même garde-fou que `Scene::for_clip_window`'s `belongs` (scene.rs) : accepte la
/// région seulement si `clip_index` est absent (vieux payload) OU vaut `active_clip_index`.
pub fn speed_at(regions: &[SceneSpeedRegion], active_clip_index: usize, t: f64) -> f64 {
    for region in regions {
        let belongs = region.clip_index.map(|i| i == active_clip_index).unwrap_or(true);
        if belongs && t >= region.start_sec && t < region.end_sec {
            if region.speed.is_finite() && region.speed > 0.0 {
                return region.speed;
            }
            return 1.0;
        }
    }
    1.0
}

/// Le temps PROGRAMME (secondes de sortie) d'un clip, en fonction de son temps source.
///
/// L'export le connaît sans calcul : c'est `frames / out_fps`, le compteur de
/// `walk_composited_timeline`. La preview n'a pas ce compteur — sa lecture libre avance au pts
/// du décodeur et le renderer ne pousse un seek qu'en pause — donc elle le RECONSTRUIT depuis
/// la scène : les frames des clips précédents, puis celles des spans de vitesse du clip actif,
/// avec les mêmes `speed_segments_for_window` que l'export. Pour un temps source que l'export
/// vise (`start + k·speed/fps`), `at` rend exactement `(frames avant + k) / fps`.
///
/// Fonction pure du temps source : la même image donne le même temps programme, qu'on y
/// arrive en lecture ou par un seek. C'est tout ce que l'horloge garantit — pas un intégrateur.
///
/// ponytail: fenêtres déclarées, pas bornées à la durée réelle du fichier comme le fait
/// l'export (`available_duration_sec`) ; une source plus courte que sa fenêtre décale les
/// clips suivants d'autant. Même limite que `outputFrameCount.ts`.
#[derive(Debug, Clone)]
pub struct ProgrammeClock {
    /// Frames de sortie de tous les clips qui précèdent.
    frames_before: u64,
    segments: Vec<SpeedSegment>,
    fps: f64,
}

impl ProgrammeClock {
    /// `None` si l'index ne désigne aucun clip ou si `fps` n'est pas utilisable.
    pub fn for_clip(scene: &crate::scene::Scene, clip_index: usize, fps: f64) -> Option<Self> {
        if !fps.is_finite() || fps <= 0.0 || clip_index >= scene.clips.len() {
            return None;
        }
        // Même appartenance que `Scene::for_clip_window` : l'index décide quand il est là,
        // sinon le chevauchement de fenêtre (que `speed_segments_for_window` filtre déjà).
        let segments_of = |i: usize| {
            let clip = &scene.clips[i];
            let regions: Vec<SceneSpeedRegion> = scene
                .speed_regions
                .iter()
                .filter(|r| r.clip_index.map(|c| c == i).unwrap_or(true))
                .copied()
                .collect();
            speed_segments_for_window(&regions, clip.source_start_sec, clip.source_end_sec, fps)
        };
        let frames_before = (0..clip_index)
            .flat_map(&segments_of)
            .map(|s| s.frame_count)
            .sum();
        Some(Self { frames_before, segments: segments_of(clip_index), fps })
    }

    /// Temps programme au temps source `source_sec` du clip. Borné à la fenêtre du clip :
    /// avant, le premier frame ; après (ou sous une coupe en fin), le premier du clip suivant.
    pub fn at(&self, source_sec: f64) -> f64 {
        let mut frames = self.frames_before as f64;
        for s in &self.segments {
            if source_sec < s.end_sec {
                let k = ((source_sec - s.start_sec).max(0.0) / s.speed * self.fps)
                    .min(s.frame_count as f64);
                return (frames + k) / self.fps;
            }
            frames += s.frame_count as f64;
        }
        frames / self.fps
    }
}

fn push_speed_segment(
    spans: &mut Vec<SpeedSegment>,
    start_sec: f64,
    end_sec: f64,
    speed: f64,
    fps: f64,
) {
    let duration = end_sec - start_sec;
    if duration <= MIN_SPEED_SEGMENT_SEC {
        return;
    }
    let frames = (((duration - SPEED_FRAME_EPSILON_SEC) / speed) * fps)
        .ceil()
        .max(0.0) as u64;
    spans.push(SpeedSegment { start_sec, end_sec, speed, frame_count: frames });
}

// mêmes fenêtres de transition que le web (TRANSITION_WINDOW_MS etc., converties en secondes).
const TRANSITION_WINDOW_S: f32 = 1.01505;
const ZOOM_IN_TRANSITION_WINDOW_S: f32 = TRANSITION_WINDOW_S * 1.5;
const ZOOM_IN_OVERLAP_S: f32 = 0.5;
const FULLSCREEN_LEAD_OUT_WINDOW_S: f32 = TRANSITION_WINDOW_S * 1.5;
// port de `CHAINED_ZOOM_PAN_GAP_MS` / `CONNECTED_ZOOM_PAN_DURATION_MS` (TS).
const CHAINED_ZOOM_PAN_GAP_S: f32 = 1.5;
const CONNECTED_ZOOM_PAN_DURATION_S: f32 = 1.0;

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn sample_cubic_bezier(a1: f32, a2: f32, t: f32) -> f32 {
    let o = 1.0 - t;
    3.0 * a1 * o * o * t + 3.0 * a2 * o * t * t + t * t * t
}

fn sample_cubic_bezier_derivative(a1: f32, a2: f32, t: f32) -> f32 {
    let o = 1.0 - t;
    3.0 * a1 * o * o + 6.0 * (a2 - a1) * o * t + 3.0 * (1.0 - a2) * t * t
}

/// Port direct de `cubicBezier` (TS) : Newton-Raphson puis bissection de repli.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let target_x = clamp01(t);
    let mut solved_t = target_x;
    for _ in 0..8 {
        let cur_x = sample_cubic_bezier(x1, x2, solved_t) - target_x;
        let cur_d = sample_cubic_bezier_derivative(x1, x2, solved_t);
        if cur_x.abs() < 1e-6 || cur_d.abs() < 1e-6 {
            break;
        }
        solved_t -= cur_x / cur_d;
    }
    let (mut lower, mut upper) = (0.0f32, 1.0f32);
    solved_t = clamp01(solved_t);
    for _ in 0..10 {
        let cur_x = sample_cubic_bezier(x1, x2, solved_t);
        if (cur_x - target_x).abs() < 1e-6 {
            break;
        }
        if cur_x < target_x {
            lower = solved_t;
        } else {
            upper = solved_t;
        }
        solved_t = (lower + upper) * 0.5;
    }
    sample_cubic_bezier(y1, y2, solved_t)
}

/// Port de `easeOutScreenStudio` (TS) : cubic-bezier(0.16, 1, 0.3, 1).
fn ease_out_screen_studio(t: f32) -> f32 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, t)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Port de `computeRegionStrength` (TS, `zoomRegionUtils.ts`) : 0 hors fenêtre, ease-in avant
/// `startSec` (le zoom anticipe légèrement), plein régime pendant la région, ease-out après
/// `endSec`. Les temps reçus sont les temps source échantillonnés par le pipeline, donc ces
/// enveloppes restent alignées quand une speed region répète ou saute des frames.
///
/// `under_trim` coupe les enveloppes : la région vit sous une coupe, donc pleine force sur son
/// span et rien en dehors. Sans ça son ease-in (1,5 s AVANT `start_sec`) et son ease-out
/// déborderaient sur les frames GARDÉES de part et d'autre du trim — un zoom que l'export ne
/// rendra jamais, visible dans la preview juste à côté de la coupe. Cf. `SceneZoomRegion`.
fn zoom_region_strength(region: &SceneZoomRegion, t: f32) -> f32 {
    let start = region.start_sec as f32;
    let end = region.end_sec as f32;
    if region.under_trim {
        return if t >= start && t < end { 1.0 } else { 0.0 };
    }
    let zoom_in_end = start + ZOOM_IN_OVERLAP_S;
    let lead_in_start = zoom_in_end - ZOOM_IN_TRANSITION_WINDOW_S;
    let lead_out_end = end + TRANSITION_WINDOW_S;
    if t < lead_in_start || t > lead_out_end {
        return 0.0;
    }
    if t < zoom_in_end {
        let progress = (t - lead_in_start) / ZOOM_IN_TRANSITION_WINDOW_S;
        return ease_out_screen_studio(progress);
    }
    if t <= end {
        return 1.0;
    }
    let progress = clamp01((t - end) / TRANSITION_WINDOW_S);
    1.0 - ease_out_screen_studio(progress)
}

/// Facteur d'opacité du curseur (0.0..1.0) induit par les régions de zoom ayant `hide_cursor = true`.
/// Si aucune région masquant le curseur n'est active, retourne 1.0.
/// S'estompe avec l'ease-in du zoom (1.0 -> 0.0) et réapparaît avec l'ease-out (0.0 -> 1.0).
/// En cas de transition chaînée (connected pan), suit le même enchaînement que `zoom_state_at`.
pub fn zoom_cursor_alpha(regions: &[SceneZoomRegion], t: f32) -> f32 {
    if regions.is_empty() || !regions.iter().any(|r| r.hide_cursor) {
        return 1.0;
    }
    let pairs = connected_pairs(regions);

    // 1) transition chaînée : pan lissé de la région courante vers la suivante.
    for &(ci, ni, t_start, t_end) in &pairs {
        if t < t_start || t > t_end {
            continue;
        }
        let progress = ease_connected_pan(clamp01((t - t_start) / (t_end - t_start).max(1e-3)));
        let cur_alpha = if regions[ci].hide_cursor { 0.0 } else { 1.0 };
        let next_alpha = if regions[ni].hide_cursor { 0.0 } else { 1.0 };
        return lerp(cur_alpha, next_alpha, progress).clamp(0.0, 1.0);
    }

    // 2) palier chaîné : entre la fin de la transition et le début officiel de la région
    // suivante, celle-ci est déjà pleinement active (anticipe son propre ease-in).
    for &(_, ni, _, t_end) in &pairs {
        let next = &regions[ni];
        if t > t_end && t < next.start_sec as f32 {
            return if next.hide_cursor { 0.0 } else { 1.0 };
        }
    }

    // 3) région dominante indépendante — exclut celles déjà couvertes par une transition/palier
    // chaîné ci-dessus.
    let mut best: Option<(usize, f32)> = None;
    for (i, r) in regions.iter().enumerate() {
        let outgoing_past_end =
            pairs.iter().any(|&(ci, _, _, _)| ci == i && t > regions[i].end_sec as f32);
        let incoming_before_transition_end =
            pairs.iter().any(|&(_, ni, _, t_end)| ni == i && t < t_end);
        if outgoing_past_end || incoming_before_transition_end {
            continue;
        }
        let s = zoom_region_strength(r, t);
        if s <= 0.0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((bi, bs)) => s > bs || (s == bs && r.start_sec > regions[bi].start_sec),
        };
        if better {
            best = Some((i, s));
        }
    }

    match best {
        Some((i, strength)) => {
            if regions[i].hide_cursor {
                (1.0 - strength).clamp(0.0, 1.0)
            } else {
                1.0
            }
        }
        None => 1.0,
    }
}

/// État de zoom complet au temps `t` : échelle, focus, ET tilt 3D (degrés X/Y/Z — rendu en
/// pixel shader par `compositor.rs`, ce module ne fait que le calcul temporel).
pub struct ZoomState {
    pub scale: f32,
    pub focus: [f32; 2],
    pub rotation: [f32; 3],
    /// À quel point un préset 3D est installé (0..1) : la force de la région quand elle en porte
    /// un, 0 sinon ; interpolé entre deux régions chaînées, et refermé en milieu de course
    /// quand leurs présets diffèrent. C'est la porte de `dynamic_tilt`.
    pub tilt: f32,
    /// Poids de l'impact du clic (0..1) : 1 sur une région qui l'active (`click_impact`),
    /// interpolé entre deux régions chaînées. Ne suffit pas seul : l'impact passe aussi par la
    /// porte de `tilt` (`dynamic_tilt`), donc rien sans préset.
    pub click_impact: f32,
}

const IDENTITY_ZOOM: ZoomState = ZoomState {
    scale: 1.0,
    focus: [0.5, 0.5],
    rotation: [0.0, 0.0, 0.0],
    tilt: 0.0,
    click_impact: 0.0,
};

/// 1 si la région porte un préset 3D, 0 sinon.
fn has_tilt(region: &SceneZoomRegion) -> f32 {
    if is_identity_rotation(rotation3d_for(&region.rotation)) { 0.0 } else { 1.0 }
}

/// 1 si la région active l'impact du clic, 0 sinon.
fn impact_flag(region: &SceneZoomRegion) -> f32 {
    if region.click_impact { 1.0 } else { 0.0 }
}

/// Port de `easeConnectedPan` (TS) : cubic-bezier(0.1, 0, 0.2, 1).
fn ease_connected_pan(t: f32) -> f32 {
    cubic_bezier(0.1, 0.0, 0.2, 1.0, t)
}

/// Port de `getRotation3D`/`ROTATION_3D_PRESETS` (TS, `types.ts`) — degrés (rotationX, Y, Z).
/// Angles des présets, en degrés X/Y/Z.
///
/// Les valeurs d'origine (iso [-10,-16,0], left [0,-22,0], right [0,22,0]) produisaient un quad
/// dont AU MOINS UNE ARÊTE tombait à moins de 0.1° d'un axe de l'image : les deux bords verticaux
/// pour left/right (une rotation Y pure laisse les verticales verticales — c'est de la géométrie,
/// pas un réglage), le bord haut pour iso, dont la remontée due au rotateX était annulée par la
/// division perspective à cette distance-là.
///
/// Une arête parfaitement verticale qui traverse du texte est indiscernable d'un `overflow:
/// hidden`. C'est ce qui a été rapporté trois fois comme « une troncature de l'enregistrement »,
/// alors que le plan était rendu en entier — mesuré au pixel sur un export 1920×1080 : bord droit
/// à 1539, coin calculé à 1540, arrondis présents aux quatre coins.
///
/// Chaque préset a donc maintenant ses trois composantes, choisies pour qu'aucune arête ne
/// s'approche d'un axe à moins de 2° (cf. `no_preset_has_an_axis_aligned_edge`) tout en gardant
/// l'identité du préset : left penche vers la gauche, right vers la droite, iso est le plus incliné.
fn rotation3d_for(rotation: &Option<String>) -> [f32; 3] {
    match rotation.as_deref() {
        Some("iso") => [-12.0, -18.0, -2.0],
        Some("left") => [-8.0, -16.0, -1.0],
        Some("right") => [-8.0, 16.0, 1.0],
        _ => [0.0, 0.0, 0.0],
    }
}

fn lerp_rotation3d(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/// Les trois segments d'une flèche d'annotation, en unités du viewBox SVG (0..100), repris
/// VERBATIM des tracés de `ArrowSvgs.tsx` : hampe puis deux barbes, toutes à bouts ronds. Garder
/// les mêmes nombres est ce qui garantit que le rendu natif et la preview dessinent la même
/// flèche — inutile de réinventer une géométrie « équivalente ».
pub fn arrow_segments_viewbox(direction: &str) -> [[f32; 4]; 3] {
    match direction {
        "up" => [[50.0, 20.0, 50.0, 80.0], [50.0, 20.0, 35.0, 35.0], [50.0, 20.0, 65.0, 35.0]],
        "down" => [[50.0, 20.0, 50.0, 80.0], [50.0, 80.0, 35.0, 65.0], [50.0, 80.0, 65.0, 65.0]],
        "left" => [[80.0, 50.0, 20.0, 50.0], [20.0, 50.0, 35.0, 35.0], [20.0, 50.0, 35.0, 65.0]],
        "up-right" => [[25.0, 75.0, 75.0, 25.0], [75.0, 25.0, 53.8, 25.0], [75.0, 25.0, 75.0, 46.2]],
        "up-left" => [[75.0, 75.0, 25.0, 25.0], [25.0, 25.0, 25.0, 46.2], [25.0, 25.0, 46.2, 25.0]],
        "down-right" => {
            [[25.0, 25.0, 75.0, 75.0], [75.0, 75.0, 75.0, 53.8], [75.0, 75.0, 53.8, 75.0]]
        }
        "down-left" => {
            [[75.0, 25.0, 25.0, 75.0], [25.0, 75.0, 46.2, 75.0], [25.0, 75.0, 25.0, 53.8]]
        }
        // "right" et tout ce qui n'est pas reconnu — même défaut que le schéma côté app.
        _ => [[20.0, 50.0, 80.0, 50.0], [80.0, 50.0, 65.0, 35.0], [80.0, 50.0, 65.0, 65.0]],
    }
}

/// Passe les segments du viewBox aux px locaux du quad, et rend la demi-épaisseur du trait.
///
/// Le SVG n'a pas de `preserveAspectRatio` explicite, donc il vaut `xMidYMid meet` : mise à
/// l'échelle **uniforme** au plus petit côté, centrée. La flèche n'est donc jamais étirée quand la
/// boîte n'est pas carrée, et `strokeWidth` suit la même échelle — c'est pour ça qu'il n'a pas
/// besoin de la convention de proportionnalité du `fontSize` : il est déjà exprimé dans le
/// viewBox, donc déjà relatif à la boîte.
pub fn arrow_local_geometry(
    direction: &str,
    stroke_width_viewbox: f32,
    quad_px: [f32; 2],
) -> ([[f32; 4]; 3], f32) {
    let scale = quad_px[0].min(quad_px[1]) / 100.0;
    let off = [(quad_px[0] - 100.0 * scale) * 0.5, (quad_px[1] - 100.0 * scale) * 0.5];
    let to_local = |v: [f32; 4]| {
        [
            off[0] + v[0] * scale,
            off[1] + v[1] * scale,
            off[0] + v[2] * scale,
            off[1] + v[3] * scale,
        ]
    };
    let segments = arrow_segments_viewbox(direction);
    let half_stroke = (stroke_width_viewbox.max(0.0) * scale) * 0.5;
    ([to_local(segments[0]), to_local(segments[1]), to_local(segments[2])], half_stroke)
}

/// Focus effectif d'une région à `t` : sa position fixe, sauf en mode "auto" où elle suit la
/// télémétrie curseur (port de `getResolvedFocus`, sans le clamp — le crop-window de
/// `compositor.rs` clampe déjà après coup, cf. `su0.clamp(...)`, donc redondant ici).
fn resolve_focus(region: &SceneZoomRegion, t: f32, cursor: Option<&CursorTrack>) -> [f32; 2] {
    if region.focus_mode.as_deref() == Some("auto") {
        if let Some(track) = cursor {
            // `follow_at`, pas `at` : la caméra suit la piste LISSÉE. Suivre la télémétrie brute
            // donne un pan nerveux — l'étage de lissage de `cursorFollowUtils.ts` manquait au
            // portage.
            if let Some((cx, cy)) = track.follow_at(t) {
                return [cx, cy];
            }
        }
    }
    [region.focus_x, region.focus_y]
}

/// Paires de régions adjacentes assez proches pour être chaînées (port de
/// `getConnectedRegionPairs`, TS) : (index courant, index suivant, début transition, fin
/// transition), en secondes. Indices dans `regions` (pas d'id nécessaire — contrairement au
/// web qui matche par `region.id` car il travaille sur des objets isolés, ici tout vient du
/// même slice donc les positions suffisent).
///
/// Les régions `under_trim` sont exclues du chaînage, des DEUX côtés : leur contenu est coupé au
/// rendu, donc un pan lissé vers (ou depuis) l'une d'elles ferait bouger des frames gardées au
/// nom d'une région que l'export ne joue pas. Elles restent des régions dominantes indépendantes,
/// sèches sur leur propre span (cf. `zoom_region_strength`).
fn connected_pairs(regions: &[SceneZoomRegion]) -> Vec<(usize, usize, f32, f32)> {
    let mut order: Vec<usize> = (0..regions.len()).filter(|&i| !regions[i].under_trim).collect();
    order.sort_by(|&a, &b| regions[a].start_sec.partial_cmp(&regions[b].start_sec).unwrap());
    let mut pairs = Vec::new();
    for w in order.windows(2) {
        let (ci, ni) = (w[0], w[1]);
        let gap = regions[ni].start_sec as f32 - regions[ci].end_sec as f32;
        if gap <= CHAINED_ZOOM_PAN_GAP_S {
            let transition_start = regions[ci].end_sec as f32;
            pairs.push((ci, ni, transition_start, transition_start + CONNECTED_ZOOM_PAN_DURATION_S));
        }
    }
    pairs
}

/// État de zoom au temps `t` (secondes source du clip actif). Port de
/// `findDominantRegion` (TS) : régions chaînées d'abord (transition puis
/// hold), sinon la région "dominante" indépendante la plus forte (ties → la plus récente).
/// Hors de toute région → identité (échelle 1, focus centre, tilt nul).
pub fn zoom_state_at(regions: &[SceneZoomRegion], t: f32, cursor: Option<&CursorTrack>) -> ZoomState {
    if regions.is_empty() {
        return IDENTITY_ZOOM;
    }
    let pairs = connected_pairs(regions);

    // 1) transition chaînée : pan lissé de la région courante vers la suivante.
    for &(ci, ni, t_start, t_end) in &pairs {
        if t < t_start || t > t_end {
            continue;
        }
        let progress = ease_connected_pan(clamp01((t - t_start) / (t_end - t_start).max(1e-3)));
        let (cur, next) = (&regions[ci], &regions[ni]);
        let cur_focus = resolve_focus(cur, t, cursor);
        let next_focus = resolve_focus(next, t, cursor);
        // Entre deux présets DIFFÉRENTS, la base traverse des poses qu'aucun préset ne valide
        // (left→right passe par Y = 0) : la marge que l'échelle gelée laissait au budget n'y est
        // plus. La porte se ferme donc en milieu de course et ne se rouvre qu'au ras des bouts —
        // 1 − 4p(1−p) vaut 1 en p = 0 et p = 1, donc aucun saut avec la région d'avant ni avec
        // le palier d'après. Cf. `the_chained_sweep_keeps_every_edge_off_axis_and_inside`.
        let (cur_rot, next_rot) = (rotation3d_for(&cur.rotation), rotation3d_for(&next.rotation));
        let crossing = if cur_rot == next_rot { 1.0 } else { 1.0 - 4.0 * progress * (1.0 - progress) };
        return ZoomState {
            scale: lerp(cur.scale, next.scale, progress),
            focus: [lerp(cur_focus[0], next_focus[0], progress), lerp(cur_focus[1], next_focus[1], progress)],
            rotation: lerp_rotation3d(cur_rot, next_rot, progress),
            tilt: lerp(has_tilt(cur), has_tilt(next), progress) * crossing,
            click_impact: lerp(impact_flag(cur), impact_flag(next), progress),
        };
    }

    // 2) palier chaîné : entre la fin de la transition et le début officiel de la région
    // suivante, celle-ci est déjà pleinement active (anticipe son propre ease-in).
    for &(_, ni, _, t_end) in &pairs {
        let next = &regions[ni];
        if t > t_end && t < next.start_sec as f32 {
            return ZoomState {
                scale: next.scale,
                focus: resolve_focus(next, t, cursor),
                rotation: rotation3d_for(&next.rotation),
                tilt: has_tilt(next),
                click_impact: impact_flag(next),
            };
        }
    }

    // 3) région dominante indépendante — exclut celles déjà couvertes par une transition/palier
    // chaîné ci-dessus (sinon leur propre ease-in/out "percerait" à travers la fenêtre chaînée).
    let mut best: Option<(usize, f32)> = None;
    for (i, r) in regions.iter().enumerate() {
        let outgoing_past_end =
            pairs.iter().any(|&(ci, _, _, _)| ci == i && t > regions[i].end_sec as f32);
        let incoming_before_transition_end = pairs.iter().any(|&(_, ni, _, t_end)| ni == i && t < t_end);
        if outgoing_past_end || incoming_before_transition_end {
            continue;
        }
        let s = zoom_region_strength(r, t);
        if s <= 0.0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((bi, bs)) => s > bs || (s == bs && r.start_sec > regions[bi].start_sec),
        };
        if better {
            best = Some((i, s));
        }
    }
    match best {
        Some((i, strength)) => {
            let r = &regions[i];
            let focus = resolve_focus(r, t, cursor);
            let scale = lerp(1.0, r.scale, strength);
            // La référence (`zoomTransform.ts`) fait converger le point de focus vers le centre
            // de l'écran LINÉAIREMENT : screen(f) = 0.5 + (f - 0.5)(1 - strength). Passer
            // `lerp(0.5, f, strength)` comme centre de crop ne donne pas ça — le crop mappant
            // screen(f) = 0.5 + (f - centre) * scale, on obtient
            // 0.5 + (f - 0.5)(1 - strength) * scale, soit un facteur en trop qui retient le point
            // loin du centre en milieu de rampe puis le rattrape. Ce balayage parasite se lit
            // comme si une région manuelle suivait le curseur. On inverse donc le mapping pour
            // trouver le centre qui produit la trajectoire de référence.
            let ease = |f: f32| f - (f - 0.5) * (1.0 - strength) / scale.max(1e-3);
            ZoomState {
                scale,
                focus: [ease(focus[0]), ease(focus[1])],
                rotation: lerp_rotation3d([0.0, 0.0, 0.0], rotation3d_for(&r.rotation), strength),
                tilt: has_tilt(r) * strength,
                click_impact: impact_flag(r),
            }
        }
        None => IDENTITY_ZOOM,
    }
}

/// Port de `computeCameraFullscreenRegionStrength` (TS) : progrès EXACTEMENT contenu dans
/// [startSec, endSec] (contrairement au zoom, qui anticipe avant `startSec`) — ease-in depuis
/// 0 pile à `startSec`, plein régime, ease-out jusqu'à 0 pile à `endSec`. Fenêtres bornées à la
/// moitié de la durée de la région pour que les régions courtes s'animent pleinement sans
/// déborder.
fn camera_fullscreen_region_strength(region: &SceneCameraFullscreenRegion, t: f32) -> f32 {
    let start = region.start_sec as f32;
    let end = region.end_sec as f32;
    if t <= start || t >= end {
        return 0.0;
    }
    let half = (end - start) * 0.5;
    let lead_in = TRANSITION_WINDOW_S.min(half);
    let lead_out = FULLSCREEN_LEAD_OUT_WINDOW_S.min(half);
    let lead_in_end = start + lead_in;
    let lead_out_start = end - lead_out;
    if t < lead_in_end {
        let progress = if lead_in > 0.0 { (t - start) / lead_in } else { 1.0 };
        return ease_out_screen_studio(progress);
    }
    if t <= lead_out_start {
        return 1.0;
    }
    let progress = if lead_out > 0.0 { (end - t) / lead_out } else { 0.0 };
    ease_out_screen_studio(progress)
}

/// Progrès Full Camera (0..1) au temps `t` : 0 = webcam à sa taille normale, 1 = plein cadre.
/// Régions superposées (ne devrait pas arriver, gardé défensif comme le web) → la plus forte
/// gagne.
pub fn camera_fullscreen_progress_at(regions: &[SceneCameraFullscreenRegion], t: f32) -> f32 {
    let mut strongest = 0.0f32;
    for r in regions {
        let s = camera_fullscreen_region_strength(r, t);
        if s > strongest {
            strongest = s;
        }
    }
    strongest
}

// ============ Rotation 3D (tilt perspective, présets iso/left/right) ================
// Port de `computeRotation3DContainScale` (TS, `types.ts`) — même formule, même ordre de
// composition ("CSS rotateX rotateY rotateZ s'applique droite-à-gauche : Z d'abord, puis Y,
// puis X"). `compositor.rs` s'en sert pour construire le quad tilté (4 coins projetés) rendu
// via un warp bilinéaire inverse en pixel shader (mode 8) — ce module ne fait que la géométrie.

/// `true` si la rotation est (quasi) neutre — mêmes seuils que `isRotation3DIdentity` (TS).
pub fn is_identity_rotation(r: [f32; 3]) -> bool {
    r[0].abs() < 0.01 && r[1].abs() < 0.01 && r[2].abs() < 0.01
}

/// Projette un point local (x0,y0,0) par la rotation 3D `rot` (degrés X/Y/Z) puis la
/// perspective `perspective` (distance en px ; <=0 = orthographique). `None` si le point
/// passe derrière le plan de projection (cas pathologique, comme le `return 1` du TS).
fn project_corner(x0: f32, y0: f32, rot: [f32; 3], perspective: f32) -> Option<(f32, f32)> {
    let (mut px, mut py, pz) = rotate_corner(x0, y0, rot);
    if perspective > 0.0 {
        let denom = perspective - pz;
        if denom <= 0.0 {
            return None;
        }
        let f = perspective / denom;
        px *= f;
        py *= f;
    }
    Some((px, py))
}

/// La rotation seule de `project_corner` : le point local (x0,y0,0) tourné par `rot` (degrés
/// X/Y/Z), AVANT perspective. `z > 0` = vers la caméra (la perspective divise par
/// `perspective - z`, donc agrandit), < 0 recule.
fn rotate_corner(x0: f32, y0: f32, rot: [f32; 3]) -> (f32, f32, f32) {
    let (a, b, g) = (rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians());
    let (ca, sa) = (a.cos(), a.sin());
    let (cb, sb) = (b.cos(), b.sin());
    let (cg, sg) = (g.cos(), g.sin());
    let (mut px, mut py, mut pz) = (x0, y0, 0.0f32);
    // rotateZ
    let (zx, zy) = (px * cg - py * sg, px * sg + py * cg);
    px = zx;
    py = zy;
    // rotateY
    let (yx, yz) = (px * cb + pz * sb, -px * sb + pz * cb);
    px = yx;
    pz = yz;
    // rotateX
    let (xy, xz) = (py * ca - pz * sa, py * sa + pz * ca);
    py = xy;
    pz = xz;
    (px, py, pz)
}

/// `(Kx, Ky)` tels que le `pz` de `rotate_corner(x0, y0, rot)` vaille `Kx·x0 + Ky·y0`.
///
/// Forme close du `pz` ci-dessus : le point part de z = 0, donc rotateZ ne touche pas z,
/// rotateY en tire `-x1·sb`, rotateX en tire `y1·sa + z·ca`, où (x1, y1) est le point après
/// rotateZ. En développant x1 = x0·cg − y0·sg et y1 = x0·sg + y0·cg, `pz` est linéaire en
/// (x0, y0) — d'où ces deux coefficients, sans rien de plus à calculer par pixel.
fn depth_coefficients(rot: [f32; 3]) -> (f32, f32) {
    let (a, b, g) = (rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians());
    let (ca, sa) = (a.cos(), a.sin());
    let sb = b.sin();
    let (cg, sg) = (g.cos(), g.sin());
    (sa * sg - sb * ca * cg, sa * cg + sb * ca * sg)
}

/// ROTATION_3D_PERSPECTIVE_FACTOR (TS) — à garder synchronisé avec `types.ts`, que la passe 3D
/// de l'exporteur canvas lit encore. Distance de fuite = facteur × min(w,h) : plus le facteur
/// est grand, plus la caméra est loin et plus la convergence des arêtes s'aplatit. À 2.6 elle
/// était si faible que l'inclinaison ne se lisait plus (le bord haut d'iso ressortait à 0.08° de
/// l'horizontale).
const PERSPECTIVE_FACTOR: f32 = 1.6;

/// Profondeur de champ du mode 8 : cercle de confusion, en texels SOURCE, par unité d'écart de
/// profondeur rapporté à la distance de fuite (`|z − z_focus| / P`).
///
/// Réglé une fois, en unités de P : cet écart ne dépend ni de la résolution ni du zoom (la
/// perspective se déduit de la taille du plan lui-même). Sur iso en 16:9, focus au centre, le
/// coin lointain est à ~0.19 P, soit un flou de ~4.6 texels ; focus sur le coin proche, l'écart
/// double et le shader plafonne (`DOF_MAX_LOD`, niveau 1.5 de la pyramide demi-résolution, soit
/// ~5.7 texels). Un flou exprimé en texels suit le CONTENU : la même zone est aussi floue quel
/// que soit le zoom qui l'affiche.
pub const DOF_COC_PER_DEPTH: f32 = 24.0;

/// Les 4 coins d'un quad `width`×`height` réduit de `scale`, projetés. `None` si un coin part
/// derrière le plan de fuite.
fn project_scaled_corners(
    width: f32,
    height: f32,
    scale: f32,
    rot: [f32; 3],
    perspective: f32,
) -> Option<[(f32, f32); 4]> {
    let (hw, hh) = (width * 0.5 * scale, height * 0.5 * scale);
    let source = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)];
    let mut out = [(0.0f32, 0.0f32); 4];
    for (i, &(x0, y0)) in source.iter().enumerate() {
        out[i] = project_corner(x0, y0, rot, perspective)?;
    }
    Some(out)
}

/// Demi-étendue des coins projetés sur chaque axe.
fn projected_extents(corners: &[(f32, f32); 4]) -> (f32, f32) {
    corners.iter().fold((0.0f32, 0.0f32), |(mx, my), &(x, y)| (mx.max(x.abs()), my.max(y.abs())))
}

/// Un écran incliné : ses 4 coins projetés, et la réduction qu'il a fallu pour qu'ils tiennent.
#[derive(Clone, Copy)]
pub struct TiltedQuad {
    /// Coins TL, TR, BR, BL en px relatifs au CENTRE du rect d'origine.
    pub corners: [(f32, f32); 4],
    /// Facteur de containment. Le plan mesure donc `taille_du_rect × scale` dans son PROPRE repère,
    /// avant projection — ce qu'il faut connaître pour y poser un rayon de coin à la bonne échelle.
    pub scale: f32,
    /// `(Kx, Ky)` : la profondeur d'un point du plan, en px, vaut `Kx·x + Ky·y` pour (x, y) sa
    /// position en px dans le repère du plan, centre à l'origine, AVANT projection. Positive =
    /// vers la caméra. Nulle quand le quad est rendu à plat.
    pub depth_k: (f32, f32),
}

/// Les 4 coins (TL, TR, BR, BL) du quad tilté en 3D, en px relatifs au CENTRE du rect d'origine
/// (0,0 = centre — l'appelant les recentre sur le centre réel à l'écran). `width`/`height` en
/// px = la taille du rect d'origine, aussi utilisée comme référence de perspective (comme le
/// web : la perspective/le containScale sont calculés sur la taille de l'élément lui-même).
///
/// `rot` = la rotation de BASE (préset × force), `rot_dyn` = la part dynamique (parallaxe,
/// cf. `dynamic_tilt`). L'échelle de containment se calcule sur la base SEULE ; la part
/// dynamique ne fait que re-projeter les coins à cette échelle gelée. Recalculer l'échelle
/// sur l'angle instantané faisait respirer tout le plan de 28 à 57 px à 1080p pour 3° de
/// mouvement — et l'arrondi de l'ombre et la boîte de clip du curseur avec lui. La marge que
/// la boucle laisse déjà (3,8 à 6 %) absorbe `DYNAMIC_TILT_BUDGET`
/// (cf. `the_budget_sweep_stays_inside_the_original_rect`).
pub fn rotated_quad_corners_px(
    width: f32,
    height: f32,
    rot: [f32; 3],
    rot_dyn: [f32; 3],
) -> TiltedQuad {
    let perspective = width.min(height) * PERSPECTIVE_FACTOR;
    let (half_w, half_h) = (width * 0.5, height * 0.5);

    // BUG corrigé : l'échelle de containment était calculée en projetant les coins PLEINE TAILLE,
    // puis on projetait les coins RÉDUITS. La division perspective n'étant pas linéaire en la
    // taille d'entrée — le `z` d'un coin bouge quand on le rapproche du centre —, réduire d'un
    // facteur mesuré sur le grand quad ne suffisait pas : le quad projeté débordait encore, et le
    // render target le coupait net (bords droits en haut et à droite d'un écran pourtant penché).
    //
    // On mesure donc sur les coins RÉELLEMENT projetés et on répète : chaque passe multiplie
    // l'échelle par le facteur de débordement observé. Ça converge en deux ou trois tours ; huit
    // est une borne large qui coûte quelques multiplications une fois par frame.
    let mut scale = 1.0f32;
    let mut corners = match project_scaled_corners(width, height, scale, rot, perspective) {
        Some(c) => c,
        // Un coin derrière le plan de fuite : on rend le quad non tourné plutôt qu'une projection
        // absurde (même repli qu'avant).
        None => {
            return TiltedQuad {
                corners: [
                    (-half_w, -half_h),
                    (half_w, -half_h),
                    (half_w, half_h),
                    (-half_w, half_h),
                ],
                scale: 1.0,
                depth_k: (0.0, 0.0),
            };
        }
    };
    for _ in 0..8 {
        let (max_x, max_y) = projected_extents(&corners);
        if max_x <= 0.0 || max_y <= 0.0 {
            break;
        }
        let fit = (half_w / max_x).min(half_h / max_y);
        // `fit >= 1` : le quad tient déjà. On ne l'agrandit jamais — le containment ne fait que
        // réduire, comme le web.
        if fit >= 0.999 {
            break;
        }
        scale *= fit;
        match project_scaled_corners(width, height, scale, rot, perspective) {
            Some(c) => corners = c,
            None => break,
        }
    }
    // La profondeur suit l'angle RÉELLEMENT dessiné (base + dynamique), sinon le flou se
    // décollerait du plan pendant la parallaxe.
    let mut drawn = rot;
    if rot_dyn != [0.0; 3] {
        let full = [rot[0] + rot_dyn[0], rot[1] + rot_dyn[1], rot[2] + rot_dyn[2]];
        // Un coin qui passerait derrière le plan de fuite : on garde la pose de base.
        if let Some(c) = project_scaled_corners(width, height, scale, full, perspective) {
            corners = c;
            drawn = full;
        }
    }
    TiltedQuad { corners, scale, depth_k: depth_coefficients(drawn) }
}

/// Amplitude maximale de la part dynamique du tilt, en degrés X/Y/Z. Partagée par tout ce qui
/// anime le plan (la parallaxe ici ; l'impact du clic ensuite) : les contributions s'ADDITIONNENT
/// puis la somme est bornée par `clamp_dynamic_tilt`.
///
/// - Z : 0. L'axe le plus étroit, à ~1° de casser la règle des 2°.
/// - X : ±1,9°. La limite de `left`/`right`, les plus serrés sur cet axe.
/// - Y : ±3°. Au-delà, `left` déborde sa boîte même à échelle gelée.
///
/// Reproduits par `the_budget_sweep_keeps_every_edge_off_axis` et
/// `the_budget_sweep_stays_inside_the_original_rect` sur tout le balayage, pas seulement aux
/// présets.
pub const DYNAMIC_TILT_BUDGET: [f32; 3] = [1.9, 3.0, 0.0];

/// Borne une part dynamique au budget, axe par axe.
pub fn clamp_dynamic_tilt(rot: [f32; 3]) -> [f32; 3] {
    let b = DYNAMIC_TILT_BUDGET;
    [rot[0].clamp(-b[0], b[0]), rot[1].clamp(-b[1], b[1]), rot[2].clamp(-b[2], b[2])]
}

/// Force du préset sous laquelle la part dynamique est nulle ; elle s'installe en smoothstep
/// jusqu'à 1. La spec disait 0,5 ; les maths de ce crate disent autrement : `left`/`right` ne
/// sortent de la bande des 2° qu'à 0,635 de force, et le budget plein ne leur laisse que
/// 0,034° de marge à force 1. Juste sous 1, la base perd plus d'angle que la porte n'en retire
/// — il faut une porte raide. 0,78 passe encore sous 2° (de 0,001°), 0,8 tient ; 0,85 garde
/// du jeu. Cf. `the_budget_sweep_keeps_every_edge_off_axis`.
const PARALLAX_GATE_START: f32 = 0.85;
/// Degrés de parallaxe par unité de vitesse (largeurs — ou hauteurs — de coupe par seconde),
/// avant saturation. Un balayage d'une demi-largeur par seconde penche d'environ 2° en Y, une
/// dérive lente (un dixième par seconde) d'un demi-degré. Près de la base des présets, 1° de Y
/// ne déplace le bord droit que d'environ 2 px à 1080p (le cosinus compense en partie la
/// perspective) : un gain plus faible ne se voyait pas.
const PARALLAX_DEG_PER_SPEED: f32 = 5.0;
/// Demi-fenêtre de la différence centrée qui mesure la vitesse, en secondes. Bien plus large
/// que le pas de télémétrie (33 ms) : la dérivée d'une interpolation linéaire est en escalier,
/// la moyenner sur 200 ms la rend continue.
const PARALLAX_VELOCITY_HALF_WINDOW_S: f32 = 0.1;

/// La part dynamique du tilt au temps `t`, en degrés X/Y/Z, à AJOUTER à la rotation de base
/// (`rotated_quad_corners_px(.., base, dyn)`). Appelée UNE fois par frame, depuis `plan_frame`,
/// pour que l'écran, son ombre et le curseur portent le même angle.
///
/// - `track` : la piste curseur ; `None` (pas de sidecar) → rotation nulle.
/// - `cut` : la coupe visible, dans le repère NORMALISÉ du curseur (`[x0, y0, x1, y1]`). La
///   vitesse s'y mesure en coupes par seconde — ce que voit le spectateur. L'impact du clic
///   visera depuis ce même point.
/// - `strength` : à quel point le tilt est installé (0..1, cf. `ZoomState::tilt`). Rien sous
///   `PARALLAX_GATE_START` : pendant l'ease-in la base est encore dans (ou près de) la bande
///   des 2°, y ajouter du mouvement ferait longer un axe à une arête.
///
/// La vitesse est prise sur la piste de SUIVI (`follow_at`, déjà lissée), jamais sur `at()`, et
/// par différence centrée : aucune intégration d'une frame à l'autre, la frame reste une pure
/// fonction de `t` (cf. `smooth_follow_samples`).
///
/// Sens : le plan se penche vers le geste — curseur vers la droite → le bord droit recule
/// (+Y), vers le bas → le bord bas recule (−X). Même convention que l'impact du clic.
///
/// `impact` : l'impact du clic (`click_impact`), déjà pondéré par ses propres portes. Il
/// s'ADDITIONNE à la parallaxe, la somme est bornée au budget, puis la porte d'ease-in
/// s'applique au tout : les deux effets passent par la même porte et le même budget.
pub fn dynamic_tilt(
    t: f32,
    track: Option<&CursorTrack>,
    cut: [f32; 4],
    strength: f32,
    impact: [f32; 3],
) -> [f32; 3] {
    let gate = smoothstep(PARALLAX_GATE_START, 1.0, strength);
    if gate <= 0.0 {
        return [0.0; 3];
    }
    let h = PARALLAX_VELOCITY_HALF_WINDOW_S;
    let parallax = match track.map(|tr| (tr.follow_at(t - h), tr.follow_at(t + h))) {
        Some((Some(a), Some(b))) => {
            let (cw, ch) = ((cut[2] - cut[0]).max(1e-3), (cut[3] - cut[1]).max(1e-3));
            let (vx, vy) = ((b.0 - a.0) / (2.0 * h * cw), (b.1 - a.1) / (2.0 * h * ch));
            // Saturation douce : jamais au-delà du budget, sans plateau sec pendant un geste
            // rapide.
            let soft = |v: f32, budget: f32| budget * (PARALLAX_DEG_PER_SPEED * v / budget).tanh();
            let b = DYNAMIC_TILT_BUDGET;
            [soft(-vy, b[0]), soft(vx, b[1]), 0.0]
        }
        _ => [0.0; 3],
    };
    let sum = [parallax[0] + impact[0], parallax[1] + impact[1], parallax[2] + impact[2]];
    clamp_dynamic_tilt(sum).map(|d| d * gate)
}

/// Durée de l'impact du clic : la fenêtre de `CursorTrack::bounce`, pour que le plan et le
/// pointeur lisent comme un seul contact.
pub const CLICK_IMPACT_WINDOW_S: f32 = 0.26;
/// Amplitude `A` de l'impact, en degrés, au creux de `tap` pour un clic au bord de la coupe.
/// Calée sur le budget X (`DYNAMIC_TILT_BUDGET`, le plus serré) : un clic dans un coin pèse
/// autant sur les deux axes sans que X sature seul et ne tourne l'axe du pivot. Ce n'est PAS
/// le réglage `clickBounce` du curseur (brut sur [0, 5], 2,5 par défaut) : il rendrait le plan
/// 2,5 fois trop fort. Cf. `a_corner_click_moves_the_plane_visibly_at_a_frozen_scale`.
pub const CLICK_IMPACT_DEG: f32 = 1.9;
/// Valeur du pic de `sin(2πe)·(1−e)²` (en e ≈ 0,1904), pour que le creux de `tap` vaille −1.
const TAP_NORM: f32 = 0.610;

/// L'enveloppe de l'impact, `e` = temps depuis le clic / `CLICK_IMPACT_WINDOW_S`.
///
/// Courbe sœur de `CursorTrack::bounce`, qui reste intouchée : même instant de contact (creux
/// −1 à 49,5 ms) et même fenêtre (260 ms), mais sans la cassure de pente de `bounce` à 98,8 ms
/// (×2,45) — invisible sur un sprite de 30 px, brutale sur un plan entier. Rebond plus mou
/// (+0,164 à 165 ms contre 0,67) : un écran pèse plus qu'un pointeur. Retour à zéro avec une
/// pente nulle à 260 ms. Nulle hors de `[0, 1)`.
pub fn tap(e: f32) -> f32 {
    if !(0.0..1.0).contains(&e) {
        return 0.0;
    }
    let o = 1.0 - e;
    -(std::f32::consts::TAU * e).sin() * o * o / TAP_NORM
}

/// L'impact des clics au temps `t`, en degrés X/Y/Z, SANS ses portes (préset installé,
/// curseur visible, vitesse, masques : cf. `plan_frame`). À passer à `dynamic_tilt`.
///
/// Un pivot RIGIDE autour du centre : le côté cliqué recule, le plan ne se déforme pas
/// localement — la géométrie ne sait pas dessiner une bosse (`project_corner` part d'un point
/// z = 0, le warp est bilinéaire).
///
/// - `window` : la fenêtre source `[début, fin)` du clip actif. Un clic hors fenêtre est sur
///   une portion coupée : ses 260 ms déborderaient sur les frames gardées.
/// - `aim` : où tombe une position curseur dans la coupe VISIBLE (0..1 par axe), `None` hors
///   coupe — `frame_geometry::cursor_plane_point`, le test même de `plan_cursor`. Un clic hors
///   de ce qu'on voit ne bascule rien.
///
/// Loi : `A · Σ tap((t − t_c) / 0,26) · [+dy, −dx, 0]`, chaque composante de la somme bornée à
/// [−1, 1] avant `A` — un double clic à 33 ms d'écart atteindrait 1,81. `dx`, `dy` ∈ [−1, 1] :
/// le décalage du clic au centre de la coupe, y vers le bas, visé à `at(t_c)` sur la piste
/// brute (pas `at(t)` : un glisser ferait vaciller l'axe en plein impact). `tap` vaut −1 au
/// contact : clic à droite → +Y → le bord droit recule ; clic en bas → −X → le bord bas recule.
pub fn click_impact(
    t: f32,
    track: &CursorTrack,
    window: [f32; 2],
    aim: impl Fn((f32, f32)) -> Option<[f32; 2]>,
) -> [f32; 3] {
    let mut sum = [0.0f32; 2];
    for &tc in track.clicks_between(t - CLICK_IMPACT_WINDOW_S, t) {
        if tc < window[0] || tc >= window[1] {
            continue;
        }
        let Some([fx, fy]) = track.at(tc).and_then(&aim) else { continue };
        let (dx, dy) = ((2.0 * fx - 1.0).clamp(-1.0, 1.0), (2.0 * fy - 1.0).clamp(-1.0, 1.0));
        let k = tap((t - tc) / CLICK_IMPACT_WINDOW_S);
        sum[0] += k * dy;
        sum[1] -= k * dx;
    }
    [
        CLICK_IMPACT_DEG * sum[0].clamp(-1.0, 1.0),
        CLICK_IMPACT_DEG * sum[1].clamp(-1.0, 1.0),
        0.0,
    ]
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let u = clamp01((x - e0) / (e1 - e0));
    u * u * (3.0 - 2.0 * u)
}

impl TiltedQuad {
    /// Où tombe le point `(fx, fy)` du plan (0..1 depuis son coin haut-gauche), en px relatifs
    /// au CENTRE du rect d'origine — même repère que `corners`.
    ///
    /// C'est la correspondance DIRECTE du warp que le pixel shader du mode 8 parcourt à
    /// l'envers : lui part d'un pixel écran et cherche son (s, t) dans le quad, celle-ci part
    /// d'un (s, t) et donne le pixel. Bilinéaire des deux côtés — donc tout ce qu'on pose sur
    /// le plan incliné par cette fonction retombe exactement sur le contenu que le shader y a
    /// dessiné. Sans elle, un recouvrement comme le curseur reste sur le rect droit d'origine
    /// pendant que l'image, elle, est penchée.
    pub fn point_px(&self, fx: f32, fy: f32) -> (f32, f32) {
        let [tl, tr, br, bl] = self.corners;
        let top = (tl.0 + (tr.0 - tl.0) * fx, tl.1 + (tr.1 - tl.1) * fx);
        let bottom = (bl.0 + (br.0 - bl.0) * fx, bl.1 + (br.1 - bl.1) * fx);
        (top.0 + (bottom.0 - top.0) * fy, top.1 + (bottom.1 - top.1) * fy)
    }

    /// Le `mb` du draw mode 8 : `[gx, gy, z_focus, k]`.
    ///
    /// La profondeur du point (s, t) du plan (0..1, ce que le warp inverse du shader retrouve)
    /// vaut `(s − 0.5)·gx + (t − 0.5)·gy`, en px, positive vers la caméra : deux multiply-add par
    /// pixel, aucune trigo. `z_focus` est cette profondeur au point de focus du zoom
    /// (`focus_plane`, 0..1 dans le plan — `FrameGeometry::focus_plane`).
    ///
    /// `k` convertit l'écart de profondeur en cercle de confusion : `coc = k·|z − z_focus|`, en
    /// texels source (`DOF_COC_PER_DEPTH / P`). `dof = false` le laisse à 0 : le shader ne
    /// quitte alors jamais son échantillon net, et la sortie est celle d'avant l'effet à l'octet.
    ///
    /// `screen_px` est la taille du rect d'origine, celle passée à `rotated_quad_corners_px` : le
    /// plan mesure `screen_px × scale` dans son propre repère, et la distance de fuite en dérive.
    pub fn depth_mb(&self, screen_px: [f32; 2], focus_plane: [f32; 2], dof: bool) -> [f32; 4] {
        let gx = screen_px[0] * self.scale * self.depth_k.0;
        let gy = screen_px[1] * self.scale * self.depth_k.1;
        let z_focus = (focus_plane[0] - 0.5) * gx + (focus_plane[1] - 0.5) * gy;
        let perspective = screen_px[0].min(screen_px[1]) * PERSPECTIVE_FACTOR;
        let k = if dof && perspective > 0.0 { DOF_COC_PER_DEPTH / perspective } else { 0.0 };
        [gx, gy, z_focus, k]
    }

    /// Demi-largeur / demi-hauteur de la bounding box des coins projetés, en px.
    pub fn half_extents_px(&self) -> (f32, f32) {
        projected_extents(&self.corners)
    }
}

#[cfg(test)]
mod zoom_focus_tests {
    use super::*;
    use crate::scene::SceneZoomRegion;

    fn region(scale: f32, focus_x: f32) -> SceneZoomRegion {
        SceneZoomRegion {
            id: "z1".into(),
            clip_index: None,
            start_sec: 2.0,
            end_sec: 8.0,
            scale,
            focus_x,
            focus_y: 0.5,
            focus_mode: Some("manual".into()),
            rotation: None,
            under_trim: false,
            hide_cursor: false,
            click_impact: false,
        }
    }

    /// Le focus automatique ne « perd » jamais la piste : hors de ses bornes, il tient la
    /// dernière (ou la première) position suivie au lieu de retomber sur le point statique de la
    /// région. Sans ça, le plan net sauterait d'un bout de l'écran à l'autre à la fin de la
    /// télémétrie — et la netteté avec lui, maintenant que `z_focus` en dépend.
    #[test]
    fn auto_focus_holds_the_last_tracked_point_past_the_track() {
        let track = CursorTrack::new(vec![(3.0, 0.8, 0.2), (4.0, 0.9, 0.1)], Vec::new(), Vec::new());
        let mut r = region(1.5, 0.1);
        r.focus_mode = Some("auto".into());
        let last = track.follow_at(4.0).unwrap();
        for t in [4.5f32, 6.0, 7.9] {
            assert_eq!(resolve_focus(&r, t, Some(&track)), [last.0, last.1], "t = {t}");
        }
        let first = track.follow_at(3.0).unwrap();
        assert_eq!(resolve_focus(&r, 2.1, Some(&track)), [first.0, first.1]);
    }

    #[test]
    fn zoom_cursor_alpha_hides_during_zoom() {
        let mut r = region(2.0, 0.5);
        r.start_sec = 3.0;
        r.end_sec = 6.0;
        r.hide_cursor = true;

        let regions = vec![r];

        // Bien avant le zoom (t=0.0) -> pleine opacité
        assert_eq!(zoom_cursor_alpha(&regions, 0.0), 1.0);

        // Plein milieu du zoom (t=4.5) -> complètement masqué
        assert_eq!(zoom_cursor_alpha(&regions, 4.5), 0.0);

        // Bien après le zoom (t=10.0) -> pleine opacité
        assert_eq!(zoom_cursor_alpha(&regions, 10.0), 1.0);
    }

    #[test]
    fn zoom_cursor_alpha_connected_regions_stay_hidden() {
        let mut r1 = region(2.0, 0.5);
        r1.start_sec = 2.0;
        r1.end_sec = 4.0;
        r1.hide_cursor = true;

        let mut r2 = region(2.5, 0.5);
        r2.start_sec = 4.5;
        r2.end_sec = 7.0;
        r2.hide_cursor = true;

        let regions = vec![r1, r2];

        // Pendant la région 1 (t=3.0) -> masqué
        assert_eq!(zoom_cursor_alpha(&regions, 3.0), 0.0);
        // Pendant la transition chaînée (connected pan entre t=4.0 et t=4.3) -> reste masqué
        assert_eq!(zoom_cursor_alpha(&regions, 4.15), 0.0);
        // Pendant le palier chaîné (t=4.4) -> reste masqué
        assert_eq!(zoom_cursor_alpha(&regions, 4.4), 0.0);
        // Pendant la région 2 (t=5.5) -> masqué
        assert_eq!(zoom_cursor_alpha(&regions, 5.5), 0.0);
    }

    #[test]
    fn zoom_cursor_alpha_connected_regions_transition() {
        let mut r1 = region(2.0, 0.5);
        r1.start_sec = 2.0;
        r1.end_sec = 4.0;
        r1.hide_cursor = true;

        let mut r2 = region(2.5, 0.5);
        r2.start_sec = 4.5;
        r2.end_sec = 7.0;
        r2.hide_cursor = false;

        let regions = vec![r1, r2];

        // Avant la transition (r1 actif) -> 0.0
        assert_eq!(zoom_cursor_alpha(&regions, 3.0), 0.0);
        // Après la transition (r2 actif avec hide_cursor=false) -> 1.0
        assert_eq!(zoom_cursor_alpha(&regions, 5.5), 1.0);
    }

    /// Où le point source `f` atterrit à l'écran (0..1) : le crop est centré sur `focus` et
    /// couvre `1/scale` de la source, donc l'écran mappe `0.5 + (f - focus) * scale`.
    fn screen_x(state: &ZoomState, f: f32) -> f32 {
        0.5 + (f - state.focus[0]) * state.scale
    }

    #[test]
    fn manual_focus_travels_to_centre_linearly_during_the_ramp() {
        // L'invariant de `zoomTransform.ts` : screen(f) = 0.5 + (f - 0.5)(1 - progress). La
        // régression corrigée ici ajoutait un facteur `scale`, qui retenait le point loin du
        // centre en milieu de rampe puis le rattrapait — lu comme un pan parasite sur une région
        // pourtant en mode manuel.
        let f = 0.8;
        let target_scale = 2.5;
        let regions = [region(target_scale, f)];
        // Plusieurs instants de la fenêtre d'ease-in, pour balayer les progressions partielles.
        for step in 0..=20 {
            let t = 1.0 + step as f32 * 0.15;
            let state = zoom_state_at(&regions, t, None);
            // `progress` déduit du scale rendu, pour ne pas ré-implémenter l'easing dans le test.
            let progress = (state.scale - 1.0) / (target_scale - 1.0);
            let expected = 0.5 + (f - 0.5) * (1.0 - progress);
            assert!(
                (screen_x(&state, f) - expected).abs() < 1e-4,
                "t={t} progress={progress} screen={} attendu={expected}",
                screen_x(&state, f)
            );
        }
    }

    #[test]
    fn manual_focus_is_dead_centre_at_full_strength() {
        let f = 0.8;
        let regions = [region(2.5, f)];
        let state = zoom_state_at(&regions, 5.0, None);
        assert!((state.scale - 2.5).abs() < 1e-4, "plein régime attendu, scale={}", state.scale);
        assert!((screen_x(&state, f) - 0.5).abs() < 1e-4);
        assert!((state.focus[0] - f).abs() < 1e-4);
    }

    #[test]
    fn outside_every_region_the_frame_is_untouched() {
        let regions = [region(2.5, 0.8)];
        let state = zoom_state_at(&regions, 0.0, None);
        assert_eq!(state.scale, 1.0);
        assert_eq!(state.focus, [0.5, 0.5]);
    }

    /// Une région sous un trim est jouée SÈCHE : pleine échelle sur son span, identité juste
    /// avant et juste après. `region()` couvre [2,8] et son ease-in normal démarre 1,5 s avant
    /// `start_sec` — c'est exactement ce débordement qui atteindrait les frames GARDÉES autour
    /// de la coupe et ferait diverger la preview de l'export. Cf. issue #216.
    #[test]
    fn a_region_under_a_trim_has_no_transition_window() {
        let mut r = region(2.5, 0.5);
        r.under_trim = true;
        let regions = [r];
        assert_eq!(zoom_state_at(&regions, 1.5, None).scale, 1.0);
        assert_eq!(zoom_state_at(&regions, 2.0, None).scale, 2.5);
        assert_eq!(zoom_state_at(&regions, 7.9, None).scale, 2.5);
        assert_eq!(zoom_state_at(&regions, 8.0, None).scale, 1.0);
    }

    /// Et elle ne se chaîne pas avec sa voisine gardée : un pan lissé vers une région que
    /// l'export ne joue pas ferait bouger des frames qui, elles, sont rendues.
    #[test]
    fn a_region_under_a_trim_is_not_chained_with_its_neighbour() {
        let mut cut = region(3.0, 0.5);
        cut.under_trim = true;
        cut.start_sec = 9.0;
        cut.end_sec = 10.0;
        // Sans le filtre, l'écart de 1 s < CHAINED_ZOOM_PAN_GAP_S apparierait [2,8] et [9,10].
        assert!(connected_pairs(&[region(2.0, 0.5), cut]).is_empty());
    }
}

#[cfg(test)]
mod arrow_tests {
    use super::*;

    /// Ouverture d'une barbe par rapport au fût, en degrés. C'est ce paramètre — plus que la
    /// longueur — qui décide si une pointe ressemble à une flèche ou à un crochet.
    fn barb_opening_deg(dir: &str, barb: usize) -> f32 {
        let segs = arrow_segments_viewbox(dir);
        let tip = (segs[barb][0], segs[barb][1]);
        // direction du fût vue depuis la pointe : c'est celle de ses deux extrémités qui n'est
        // PAS la pointe.
        let shaft = segs[0];
        let back = if (shaft[0] - tip.0).abs() + (shaft[1] - tip.1).abs() < 1e-3 {
            (shaft[2] - tip.0, shaft[3] - tip.1)
        } else {
            (shaft[0] - tip.0, shaft[1] - tip.1)
        };
        let b = (segs[barb][2] - tip.0, segs[barb][3] - tip.1);
        let dot = back.0 * b.0 + back.1 * b.1;
        let mag = (back.0.hypot(back.1)) * (b.0.hypot(b.1));
        (dot / mag).clamp(-1.0, 1.0).acos().to_degrees()
    }

    #[test]
    fn every_arrowhead_opens_at_the_same_angle() {
        // La déformation des diagonales ne venait pas que de la taille : leurs barbes ouvraient à
        // ~25° du fût quand les cardinales ouvrent à 45°, ce qui donnait une pointe étroite,
        // avalée par le fût dès que le trait épaississait. Corriger la longueur seule ne suffisait
        // pas — ce test verrouille l'angle, qui est le paramètre réellement visible.
        for dir in ["up", "down", "left", "right", "up-right", "up-left", "down-right", "down-left"]
        {
            for barb in 1..=2 {
                let deg = barb_opening_deg(dir, barb);
                assert!(
                    (deg - 45.0).abs() < 1.0,
                    "{dir} barbe {barb} ouvre à {deg:.1}°, attendu 45°"
                );
            }
        }
    }

    #[test]
    fn a_diagonal_head_is_as_large_as_a_cardinal_one() {
        // Les barbes diagonales faisaient 15,8 unités contre 21,2 pour les cardinales : une
        // flèche en diagonale avait une tête ~25 % plus petite que sa voisine horizontale, ce
        // qui se lisait comme une déformation. Ce test interdit la divergence de revenir.
        let barb_len = |seg: [f32; 4]| ((seg[2] - seg[0]).powi(2) + (seg[3] - seg[1]).powi(2)).sqrt();
        let cardinal = barb_len(arrow_segments_viewbox("up")[1]);
        for dir in ["up-right", "up-left", "down-right", "down-left"] {
            for barb in 1..=2 {
                let len = barb_len(arrow_segments_viewbox(dir)[barb]);
                assert!(
                    (len - cardinal).abs() < 0.2,
                    "{dir} barbe {barb} = {len:.2}, cardinale = {cardinal:.2}"
                );
            }
        }
    }

    #[test]
    fn the_geometry_is_the_svg_geometry_verbatim() {
        // Parité avec `ArrowSvgs.tsx` : si ces nombres divergent, le rendu et la preview
        // dessinent deux flèches différentes.
        assert_eq!(
            arrow_segments_viewbox("right"),
            [[20.0, 50.0, 80.0, 50.0], [80.0, 50.0, 65.0, 35.0], [80.0, 50.0, 65.0, 65.0]]
        );
        assert_eq!(
            arrow_segments_viewbox("up"),
            [[50.0, 20.0, 50.0, 80.0], [50.0, 20.0, 35.0, 35.0], [50.0, 20.0, 65.0, 35.0]]
        );
    }

    #[test]
    fn an_unknown_direction_falls_back_to_right() {
        // Même défaut que le schéma côté app, pour qu'une donnée abîmée dessine quelque chose
        // de sensé plutôt que rien.
        assert_eq!(arrow_segments_viewbox("sideways"), arrow_segments_viewbox("right"));
    }

    #[test]
    fn a_square_quad_maps_the_viewbox_one_to_one() {
        let (segments, half) = arrow_local_geometry("right", 10.0, [100.0, 100.0]);
        // échelle 1, aucun centrage à appliquer
        assert_eq!(segments[0], [20.0, 50.0, 80.0, 50.0]);
        assert!((half - 5.0).abs() < 1e-6);
    }

    #[test]
    fn a_wide_quad_scales_uniformly_and_centres() {
        // `preserveAspectRatio` vaut `xMidYMid meet` par défaut : la flèche tient dans le PLUS
        // PETIT côté et se centre — elle n'est jamais étirée. Ici 400x200 -> échelle 2, et
        // 200px de marge horizontale à répartir, donc +100 sur les x.
        let (segments, half) = arrow_local_geometry("right", 4.0, [400.0, 200.0]);
        assert_eq!(segments[0], [100.0 + 40.0, 100.0, 100.0 + 160.0, 100.0]);
        // l'épaisseur suit la même échelle uniforme
        assert!((half - 4.0).abs() < 1e-6);
    }

    #[test]
    fn a_tall_quad_centres_vertically() {
        let (segments, _) = arrow_local_geometry("up", 4.0, [100.0, 300.0]);
        // échelle 1 (plus petit côté = 100), 200px de marge verticale -> +100 sur les y
        assert_eq!(segments[0], [50.0, 100.0 + 20.0, 50.0, 100.0 + 80.0]);
    }

    #[test]
    fn a_negative_stroke_width_cannot_produce_a_negative_half_width() {
        let (_, half) = arrow_local_geometry("right", -5.0, [100.0, 100.0]);
        assert_eq!(half, 0.0);
    }
}

#[cfg(test)]
mod tilt_tests {
    use super::*;
    use crate::scene::SceneZoomRegion;

    /// `point_px` doit rendre les coins du plan sur les coins projetés, sans quoi tout ce qu'on
    /// pose dessus (le curseur) se décale par rapport à l'image que le shader y a dessinée.
    #[test]
    fn the_plane_corners_map_to_the_projected_corners() {
        let quad = rotated_quad_corners_px(1920.0, 1080.0, preset("iso"), [0.0; 3]);
        for (i, (fx, fy)) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)].into_iter().enumerate()
        {
            let (x, y) = quad.point_px(fx, fy);
            let (ex, ey) = quad.corners[i];
            assert!((x - ex).abs() < 1e-3 && (y - ey).abs() < 1e-3, "coin {i}: {x},{y} != {ex},{ey}");
        }
    }

    /// Et le milieu du plan tombe au barycentre des quatre coins — la propriété qui distingue le
    /// bilinéaire (ce que fait le shader) d'un simple placement dans la bounding box.
    #[test]
    fn the_plane_centre_maps_to_the_centroid() {
        let quad = rotated_quad_corners_px(1920.0, 1080.0, preset("left"), [0.0; 3]);
        let (x, y) = quad.point_px(0.5, 0.5);
        let cx = quad.corners.iter().map(|c| c.0).sum::<f32>() / 4.0;
        let cy = quad.corners.iter().map(|c| c.1).sum::<f32>() / 4.0;
        assert!((x - cx).abs() < 1e-3 && (y - cy).abs() < 1e-3);
    }

    /// La raison d'être du correctif : sur un écran incliné, la position tiltée n'est PAS la
    /// position dans le rect droit. Si ces deux-là coïncidaient, le bug d'origine n'existerait
    /// pas — et ce test tomberait le jour où quelqu'un remettrait le rect droit.
    #[test]
    fn a_tilted_plane_moves_the_cursor_off_the_upright_rect() {
        let (w, h) = (1920.0f32, 1080.0f32);
        let quad = rotated_quad_corners_px(w, h, rotation3d_for(&Some("iso".into())), [0.0; 3]);
        let mut worst: f32 = 0.0;
        for (fx, fy) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.5, 0.0)] {
            let (x, y) = quad.point_px(fx, fy);
            // Le même point posé sur le rect droit, dans le même repère centré.
            let (ux, uy) = ((fx - 0.5) * w, (fy - 0.5) * h);
            worst = worst.max((x - ux).hypot(y - uy));
        }
        assert!(worst > 20.0, "ecart max au rect droit trop faible: {worst}px");
    }

    /// Le contrat du containment : après projection, aucun coin ne sort du rect d'origine.
    /// C'est ce qui garantit que le quad incliné n'est jamais coupé par le bord du cadre.
    #[test]
    fn every_preset_stays_inside_the_original_rect() {
        for (name, rot) in [
            ("iso", rotation3d_for(&Some("iso".into()))),
            ("left", rotation3d_for(&Some("left".into()))),
            ("right", rotation3d_for(&Some("right".into()))),
        ] {
            // Plusieurs formes de boîte : le débordement dépend du ratio.
            for (w, h) in [(1920.0f32, 1080.0f32), (1080.0, 1920.0), (800.0, 800.0)] {
                let corners = rotated_quad_corners_px(w, h, rot, [0.0; 3]).corners;
                let (max_x, max_y) = projected_extents(&corners);
                // Tolérance d'un demi-pixel : l'itération s'arrête à 0.1 % près.
                assert!(
                    max_x <= w * 0.5 + 0.5 && max_y <= h * 0.5 + 0.5,
                    "{name} {w}x{h} : étendue ({max_x:.1}, {max_y:.1}) dépasse ({:.1}, {:.1})",
                    w * 0.5,
                    h * 0.5
                );
            }
        }
    }

    /// Aucune arête d'un préset ne doit longer un axe de l'image. C'est LE critère qui distingue
    /// « un écran incliné » d'« un enregistrement tronqué » : un bord parfaitement vertical qui
    /// coupe une phrase se lit comme un `overflow: hidden`, quelle que soit la justesse du reste.
    #[test]
    fn no_preset_has_an_axis_aligned_edge() {
        for (name, rot) in [
            ("iso", rotation3d_for(&Some("iso".into()))),
            ("left", rotation3d_for(&Some("left".into()))),
            ("right", rotation3d_for(&Some("right".into()))),
        ] {
            let c = rotated_quad_corners_px(1920.0, 1080.0, rot, [0.0; 3]).corners;
            // haut, bas (contre l'horizontale) ; gauche, droite (contre la verticale)
            let h_angle = |p: (f32, f32), q: (f32, f32)| (q.1 - p.1).atan2(q.0 - p.0).to_degrees();
            let v_angle = |p: (f32, f32), q: (f32, f32)| (q.0 - p.0).atan2(q.1 - p.1).to_degrees();
            let edges = [
                ("haut", h_angle(c[0], c[1])),
                ("bas", h_angle(c[3], c[2])),
                ("gauche", v_angle(c[0], c[3])),
                ("droite", v_angle(c[1], c[2])),
            ];
            for (edge, angle) in edges {
                assert!(
                    angle.abs() >= 2.0,
                    "{name} : arête {edge} à {angle:.2}° de son axe — ça se lit comme une découpe"
                );
            }
        }
    }

    fn presets() -> [(&'static str, [f32; 3]); 3] {
        [
            ("iso", rotation3d_for(&Some("iso".into()))),
            ("left", rotation3d_for(&Some("left".into()))),
            ("right", rotation3d_for(&Some("right".into()))),
        ]
    }

    fn depth_at(mb: [f32; 4], s: f32, t: f32) -> f32 {
        (s - 0.5) * mb[0] + (t - 0.5) * mb[1]
    }

    /// La forme close de `depth_mb` doit redonner le `pz` que `project_corner` calcule — sur tout
    /// le plan, pas seulement aux coins, et dans le repère exact où les coins ont été projetés.
    #[test]
    fn the_closed_form_depth_matches_the_rotation() {
        for (name, rot) in presets() {
            for (w, h) in [(1920.0f32, 1080.0f32), (1080.0, 1920.0), (800.0, 800.0)] {
                let quad = rotated_quad_corners_px(w, h, rot, [0.0; 3]);
                let mb = quad.depth_mb([w, h], [0.5, 0.5], false);
                let perspective = w.min(h) * PERSPECTIVE_FACTOR;
                for (i, (s, t)) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)].into_iter().enumerate()
                {
                    let (x0, y0) = ((s - 0.5) * w * quad.scale, (t - 0.5) * h * quad.scale);
                    // Même repère que les coins : projeter ce point redonne le coin rendu.
                    let (px, py) = project_corner(x0, y0, rot, perspective).unwrap();
                    let (cx, cy) = quad.corners[i];
                    assert!((px - cx).abs() < 1e-2 && (py - cy).abs() < 1e-2, "{name} coin {i}");
                }
                for i in 0..=8 {
                    for j in 0..=8 {
                        let (s, t) = (i as f32 / 8.0, j as f32 / 8.0);
                        let (x0, y0) = ((s - 0.5) * w * quad.scale, (t - 0.5) * h * quad.scale);
                        let (_, _, pz) = rotate_corner(x0, y0, rot);
                        let z = depth_at(mb, s, t);
                        assert!(
                            (z - pz).abs() <= 1e-3 * w.max(h),
                            "{name} {w}x{h} ({s},{t}) : forme close {z} != pz {pz}"
                        );
                    }
                }
            }
        }
    }

    /// Le signe. Pour iso, le coin haut-droit est le PROCHE (dessiné plus grand), le bas-gauche le
    /// lointain : z(BL) < z(TR). Un signe inversé flouterait le coin proche, et la règle des 2°
    /// ne le verrait pas — d'où le recoupement avec la taille réellement dessinée.
    #[test]
    fn iso_depth_rises_towards_the_corner_drawn_larger() {
        let (w, h) = (1920.0f32, 1080.0f32);
        let rot = rotation3d_for(&Some("iso".into()));
        let quad = rotated_quad_corners_px(w, h, rot, [0.0; 3]);
        let mb = quad.depth_mb([w, h], [0.5, 0.5], false);
        let (z_tr, z_bl) = (depth_at(mb, 1.0, 0.0), depth_at(mb, 0.0, 1.0));
        assert!(z_bl < z_tr, "z(BL) = {z_bl} doit être < z(TR) = {z_tr}");
        // Grossissement perspective d'un coin = position projetée / position tournée.
        let magnification = |i: usize, s: f32, t: f32| {
            let (x0, y0) = ((s - 0.5) * w * quad.scale, (t - 0.5) * h * quad.scale);
            let (rx, ry, _) = rotate_corner(x0, y0, rot);
            quad.corners[i].0.hypot(quad.corners[i].1) / rx.hypot(ry)
        };
        let (m_tr, m_bl) = (magnification(1, 1.0, 0.0), magnification(3, 0.0, 1.0));
        assert!(m_tr > m_bl * 1.2, "TR x{m_tr} devrait être nettement plus grossi que BL x{m_bl}");
    }

    /// Le focus au centre du plan est à la profondeur du centre (0), et `k` reste nul réglage
    /// coupé : le shader ne quitte alors jamais son échantillon net.
    #[test]
    fn the_depth_slot_is_inert_when_off_and_centred() {
        for (name, rot) in presets() {
            let quad = rotated_quad_corners_px(1920.0, 1080.0, rot, [0.0; 3]);
            let mb = quad.depth_mb([1920.0, 1080.0], [0.5, 0.5], false);
            assert_eq!(mb[2], 0.0, "{name}");
            assert_eq!(mb[3], 0.0, "{name}");
            let off = quad.depth_mb([1920.0, 1080.0], [0.9, 0.2], false);
            assert!((off[2] - depth_at(off, 0.9, 0.2)).abs() < 1e-4, "{name}");
        }
        let flat = rotated_quad_corners_px(1920.0, 1080.0, [0.0, 0.0, 0.0], [0.0; 3]);
        assert_eq!(flat.depth_mb([1920.0, 1080.0], [0.1, 0.9], false), [0.0; 4]);
        // À plat, allumer ne floute rien : gx = gy = 0, donc |z − z_focus| = 0 partout.
        let lit = flat.depth_mb([1920.0, 1080.0], [0.1, 0.9], true);
        assert_eq!([lit[0], lit[1], lit[2]], [0.0; 3]);
    }

    /// Le cercle de confusion que le shader calcule (`k·|z − z_focus|`, texels source) : nul au
    /// focus, croissant vers le coin LOINTAIN, et le même en 1080p qu'en 4K — il est réglé en
    /// unités de la distance de fuite, pas en pixels de sortie.
    #[test]
    fn the_circle_of_confusion_grows_away_from_the_focus_and_ignores_resolution() {
        let rot = rotation3d_for(&Some("iso".into()));
        let coc = |w: f32, h: f32, focus: [f32; 2], s: f32, t: f32| {
            let quad = rotated_quad_corners_px(w, h, rot, [0.0; 3]);
            let mb = quad.depth_mb([w, h], focus, true);
            mb[3] * (depth_at(mb, s, t) - mb[2]).abs()
        };
        let centre = [0.5, 0.5];
        assert!(coc(1920.0, 1080.0, centre, 0.5, 0.5) < 1e-4);
        // Coin lointain (BL) : ~0.19 P, donc ~4.6 texels, bien au-dessus du seuil net (0.5).
        let far = coc(1920.0, 1080.0, centre, 0.0, 1.0);
        assert!((3.5..6.0).contains(&far), "coin lointain {far}");
        // Focus posé sur le coin proche (TR) : le lointain s'en éloigne encore.
        assert!(coc(1920.0, 1080.0, [1.0, 0.0], 0.0, 1.0) > far * 1.8);
        let far_4k = coc(3840.0, 2160.0, centre, 0.0, 1.0);
        assert!((far_4k - far).abs() < 1e-3 * far, "{far_4k} != {far}");
    }

    #[test]
    fn a_flat_quad_is_left_alone() {
        // Sans rotation, aucun containment ne doit s'appliquer : les coins sont ceux du rect.
        let corners = rotated_quad_corners_px(1000.0, 600.0, [0.0, 0.0, 0.0], [0.0; 3]).corners;
        let (max_x, max_y) = projected_extents(&corners);
        assert!((max_x - 500.0).abs() < 0.5 && (max_y - 300.0).abs() < 0.5);
    }

    #[test]
    fn the_tilt_actually_tilts() {
        // Garde-fou contre un containment trop zélé qui aplatirait l'effet : les quatre coins
        // d'un quad incliné ne peuvent pas rester alignés deux à deux comme un rectangle droit.
        let corners = rotated_quad_corners_px(1920.0, 1080.0, preset("iso"), [0.0; 3]).corners;
        let top_edge_slope = (corners[1].1 - corners[0].1).abs();
        assert!(top_edge_slope > 1.0, "arête supérieure horizontale : le tilt a disparu");
    }

    fn preset(name: &str) -> [f32; 3] {
        rotation3d_for(&Some(name.into()))
    }

    /// Plus petit écart d'une arête du quad à son axe, en degrés.
    fn min_edge_angle(c: &[(f32, f32); 4]) -> f32 {
        let h = |p: (f32, f32), q: (f32, f32)| (q.1 - p.1).atan2(q.0 - p.0).to_degrees().abs();
        let v = |p: (f32, f32), q: (f32, f32)| (q.0 - p.0).atan2(q.1 - p.1).to_degrees().abs();
        h(c[0], c[1]).min(h(c[3], c[2])).min(v(c[0], c[3])).min(v(c[1], c[2]))
    }

    /// Débordement relatif du quad hors du rect d'origine (> 0 = déborde).
    fn overflow(c: &[(f32, f32); 4], w: f32, h: f32) -> f32 {
        let (mx, my) = projected_extents(c);
        (mx / (w * 0.5)).max(my / (h * 0.5)) - 1.0
    }

    /// Toutes les parts dynamiques d'un budget réduit de `g`, sur une grille qui inclut les
    /// coins de la boîte (le pire cas combine les deux axes).
    fn budget_sweep(g: f32) -> impl Iterator<Item = [f32; 3]> {
        let n = 6;
        let b = DYNAMIC_TILT_BUDGET;
        (-n..=n).flat_map(move |i| {
            (-n..=n).map(move |j| {
                [b[0] * g * i as f32 / n as f32, b[1] * g * j as f32 / n as f32, 0.0]
            })
        })
    }

    /// La règle des 2° tient sur TOUT le balayage du budget, et pas qu'aux présets : à force 1
    /// sur la boîte entière, et pendant l'ease-in, où la part dynamique ne doit jamais faire
    /// passer une arête sous min(2°, ce que la base seule donne). Sous ~0,64 de force, `left`
    /// et `right` sont DÉJÀ dans la bande (l'ease-in traverse 0°) ; on ne leur demande alors que
    /// de ne pas empirer.
    #[test]
    fn the_budget_sweep_keeps_every_edge_off_axis() {
        let (w, h) = (1920.0f32, 1080.0f32);
        for name in ["iso", "left", "right"] {
            for k in 0..=400 {
                let strength = k as f32 / 400.0;
                let base = lerp_rotation3d([0.0; 3], preset(name), strength);
                let floor =
                    min_edge_angle(&rotated_quad_corners_px(w, h, base, [0.0; 3]).corners).min(2.0);
                let gate = smoothstep(PARALLAX_GATE_START, 1.0, strength);
                for d in budget_sweep(gate) {
                    let a = min_edge_angle(&rotated_quad_corners_px(w, h, base, d).corners);
                    assert!(
                        a >= floor - 1e-4,
                        "{name} force {strength} dyn {d:?} : arête à {a:.3}°, plancher {floor:.3}°"
                    );
                }
            }
        }
    }

    /// Les chiffres du budget sont ceux des maths du crate, à peu près au ras : 15 % de plus
    /// sur X ou Y, ou 1,2° sur Z, et `left` casse une des deux règles.
    #[test]
    fn the_budget_is_close_to_what_left_allows() {
        let (w, h) = (1920.0f32, 1080.0f32);
        let base = preset("left");
        let breaks = |d: [f32; 3]| {
            let c = rotated_quad_corners_px(w, h, base, d).corners;
            min_edge_angle(&c) < 2.0 || overflow(&c, w, h) > 0.0
        };
        let b = DYNAMIC_TILT_BUDGET;
        assert!(breaks([b[0] * 1.15, 0.0, 0.0]) || breaks([-b[0] * 1.15, 0.0, 0.0]), "X");
        assert!(breaks([0.0, b[1] * 1.15, 0.0]) || breaks([0.0, -b[1] * 1.15, 0.0]), "Y");
        assert!(breaks([0.0, 0.0, 1.2]) && breaks([0.0, 0.0, -1.2]), "Z");
        assert_eq!(b[2], 0.0, "Z n'a pas de budget");
    }

    /// Échelle gelée : la part dynamique ne fait que re-projeter les coins, et le quad ne
    /// déborde toujours pas du rect d'origine — sur les trois formes de boîte de
    /// `every_preset_stays_inside_the_original_rect`.
    #[test]
    fn the_budget_sweep_stays_inside_the_original_rect() {
        for name in ["iso", "left", "right"] {
            for (w, h) in [(1920.0f32, 1080.0f32), (1080.0, 1920.0), (800.0, 800.0)] {
                for k in 0..=40 {
                    let strength = k as f32 / 40.0;
                    let base = lerp_rotation3d([0.0; 3], preset(name), strength);
                    let gate = smoothstep(PARALLAX_GATE_START, 1.0, strength);
                    for d in budget_sweep(gate) {
                        let c = rotated_quad_corners_px(w, h, base, d).corners;
                        let (mx, my) = projected_extents(&c);
                        assert!(
                            mx <= w * 0.5 + 0.5 && my <= h * 0.5 + 0.5,
                            "{name} {w}x{h} force {strength} dyn {d:?} : ({mx:.1}, {my:.1})"
                        );
                    }
                }
            }
        }
    }

    /// Même double règle pendant une transition CHAÎNÉE, par le vrai `zoom_state_at` : entre
    /// deux présets différents, la base traverse des poses qu'aucun préset ne valide
    /// (left→right passe par Y = 0), et l'échelle gelée n'y laisse plus de marge. C'est la
    /// porte (`ZoomState::tilt`) qui doit tenir le budget à l'écart.
    #[test]
    fn the_chained_sweep_keeps_every_edge_off_axis_and_inside() {
        let region = |rotation: Option<&str>, start: f64, end: f64| SceneZoomRegion {
            id: "z".into(),
            clip_index: None,
            start_sec: start,
            end_sec: end,
            scale: 2.0,
            focus_x: 0.5,
            focus_y: 0.5,
            focus_mode: None,
            rotation: rotation.map(Into::into),
            under_trim: false,
            hide_cursor: false,
            click_impact: false,
        };
        let presets = [None, Some("iso"), Some("left"), Some("right")];
        for a in presets {
            for b in presets {
                // Transition chaînée sur [4, 5] s.
                let regions = [region(a, 1.0, 4.0), region(b, 4.5, 8.0)];
                for k in 0..=200 {
                    let t = 4.0 + k as f32 / 200.0;
                    let state = zoom_state_at(&regions, t, None);
                    let base = state.rotation;
                    let gate = smoothstep(PARALLAX_GATE_START, 1.0, state.tilt);
                    for (w, h) in [(1920.0f32, 1080.0f32), (1080.0, 1920.0), (800.0, 800.0)] {
                        let still = rotated_quad_corners_px(w, h, base, [0.0; 3]).corners;
                        let floor = min_edge_angle(&still).min(2.0);
                        // La boucle de containment s'arrête à `fit >= 0.999` : la base seule peut
                        // déjà dépasser d'un pixel. On juge la part dynamique, pas cette tolérance.
                        let (sx, sy) = projected_extents(&still);
                        let (lx, ly) = (sx.max(w * 0.5) + 0.5, sy.max(h * 0.5) + 0.5);
                        for d in budget_sweep(gate) {
                            let c = rotated_quad_corners_px(w, h, base, d).corners;
                            let (mx, my) = projected_extents(&c);
                            assert!(
                                mx <= lx && my <= ly,
                                "{a:?}→{b:?} {w}x{h} t {t} dyn {d:?} : ({mx:.1}, {my:.1})"
                            );
                            // La règle des 2° n'est posée qu'en 16:9, comme pour les présets.
                            if w <= h {
                                continue;
                            }
                            let angle = min_edge_angle(&c);
                            assert!(
                                angle >= floor - 1e-4,
                                "{a:?}→{b:?} {w}x{h} t {t} dyn {d:?} : arête à {angle:.3}°, plancher {floor:.3}°"
                            );
                        }
                    }
                }
                // Garde : entre deux présets identiques, la porte reste ouverte tout du long.
                if a.is_some() && a == b {
                    assert_eq!(zoom_state_at(&regions, 4.5, None).tilt, 1.0, "{a:?}");
                }
            }
        }
    }

    /// `quad.scale` ne dépend que de la base : ce qui se règle dessus (rayon de l'écran et de
    /// son ombre) ne respire pas avec la parallaxe.
    #[test]
    fn the_scale_is_frozen_while_only_the_dynamic_part_moves() {
        for name in ["iso", "left", "right"] {
            let base = preset(name);
            let frozen = rotated_quad_corners_px(1920.0, 1080.0, base, [0.0; 3]);
            for d in budget_sweep(1.0) {
                let q = rotated_quad_corners_px(1920.0, 1080.0, base, d);
                assert_eq!(q.scale, frozen.scale, "{name} {d:?}");
            }
            // Garde : la part dynamique bouge bien les coins.
            let moved = rotated_quad_corners_px(1920.0, 1080.0, base, [1.9, 3.0, 0.0]);
            assert!((moved.corners[1].0 - frozen.corners[1].0).abs() > 5.0);
            // La profondeur de champ suit l'angle DESSINÉ, pas la base seule.
            let d = [1.9, 3.0, 0.0];
            let full = [base[0] + d[0], base[1] + d[1], base[2] + d[2]];
            assert_eq!(moved.depth_k, depth_coefficients(full), "{name}");
            assert_ne!(moved.depth_k, frozen.depth_k, "{name}");
        }
    }

    /// Une piste qui file vers la droite à `speed` écrans/s puis s'arrête à `stop`.
    fn swipe(speed: f32, stop: f32) -> CursorTrack {
        let samples = (0..=300)
            .map(|i| {
                let t = i as f32 / 30.0;
                (t, 0.2 + speed * t.min(stop), 0.5)
            })
            .collect();
        CursorTrack::new(samples, vec![], vec![])
    }

    const FULL_CUT: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

    #[test]
    fn no_track_means_no_dynamic_tilt() {
        assert_eq!(dynamic_tilt(1.0, None, FULL_CUT, 1.0, [0.0; 3]), [0.0; 3]);
    }

    #[test]
    fn nothing_moves_during_the_ease_in() {
        let track = swipe(0.5, 1.5);
        for k in 0..=85 {
            let strength = k as f32 / 100.0;
            assert_eq!(
                dynamic_tilt(1.0, Some(&track), FULL_CUT, strength, [0.0; 3]),
                [0.0; 3],
                "force {strength}"
            );
        }
        assert_ne!(dynamic_tilt(1.0, Some(&track), FULL_CUT, 0.95, [0.0; 3]), [0.0; 3]);
    }

    /// Le geste penche le plan dans son sens, puis le plan revient à la pose du préset au repos.
    #[test]
    fn the_plane_leans_into_the_gesture_and_settles_at_rest() {
        let track = swipe(0.5, 1.5);
        let moving = dynamic_tilt(1.0, Some(&track), FULL_CUT, 1.0, [0.0; 3]);
        assert!(moving[1] > 0.5, "vers la droite → +Y : {moving:?}");
        assert!(moving[0].abs() < 1e-3 && moving[2] == 0.0, "{moving:?}");
        // La piste de suivi rattrape en quelques centaines de ms.
        let rest = dynamic_tilt(4.0, Some(&track), FULL_CUT, 1.0, [0.0; 3]);
        assert!(rest[1].abs() < 0.05, "au repos : {rest:?}");
        // Vers le bas → le bord bas recule (−X).
        let down = CursorTrack::new(
            (0..=60).map(|i| (i as f32 / 30.0, 0.5, 0.1 + 0.4 * i as f32 / 30.0)).collect(),
            vec![],
            vec![],
        );
        assert!(dynamic_tilt(1.0, Some(&down), FULL_CUT, 1.0, [0.0; 3])[0] < -0.5);
    }

    /// Quelle que soit la vitesse, la parallaxe reste dans le budget. Une coupe serrée (crop
    /// utilisateur) grossit la vitesse perçue, pas l'amplitude permise.
    #[test]
    fn the_amplitude_is_bounded() {
        let b = DYNAMIC_TILT_BUDGET;
        for speed in [0.1f32, 1.0, 10.0, 1000.0, -1000.0] {
            let track = swipe(speed, 9.0);
            for cut in [FULL_CUT, [0.4, 0.4, 0.45, 0.45]] {
                let d = dynamic_tilt(1.0, Some(&track), cut, 1.0, [0.0; 3]);
                assert!(d[0].abs() <= b[0] && d[1].abs() <= b[1] && d[2] == 0.0, "{speed} {d:?}");
            }
        }
        let fast = dynamic_tilt(1.0, Some(&swipe(1000.0, 9.0)), FULL_CUT, 1.0, [0.0; 3]);
        assert!(fast[1] > 2.9, "saturation au budget : {fast:?}");
    }

    /// Pure fonction de `t` : l'ordre des appels (lecture, seek arrière) ne change rien.
    #[test]
    fn the_dynamic_tilt_is_a_pure_function_of_time() {
        let track = swipe(0.7, 2.0);
        let at = |i: usize| dynamic_tilt(i as f32 / 30.0, Some(&track), FULL_CUT, 1.0, [0.0; 3]);
        let forward: Vec<_> = (0..90).map(at).collect();
        for i in (0..90).rev() {
            assert_eq!(at(i), forward[i]);
        }
    }

    // ---- Impact du clic ----------------------------------------------------------------

    const MS: f32 = 1.0 / 260.0;

    /// Creux −1 à 49,5 ms, rebond +0,164 à 165 ms, zéro à pente nulle à 260 ms, rien hors
    /// fenêtre.
    #[test]
    fn the_tap_envelope_has_its_contact_rebound_and_flat_landing() {
        let (mut lo, mut lo_ms) = (f32::MAX, 0.0);
        let (mut hi, mut hi_ms) = (f32::MIN, 0.0);
        for i in 0..2600 {
            let ms = i as f32 * 0.1;
            let v = tap(ms * MS);
            if v < lo {
                (lo, lo_ms) = (v, ms);
            }
            if v > hi {
                (hi, hi_ms) = (v, ms);
            }
        }
        assert!((lo + 1.0).abs() < 1e-3 && (lo_ms - 49.5).abs() < 0.3, "creux {lo} à {lo_ms} ms");
        assert!((hi - 0.164).abs() < 1e-3 && (hi_ms - 165.3).abs() < 0.5, "rebond {hi} à {hi_ms} ms");
        assert_eq!(tap(1.0), 0.0);
        assert_eq!(tap(-1e-4), 0.0);
        assert_eq!(tap(0.0), 0.0);
        // Pente nulle à l'atterrissage : à 1 ms de la fin, la valeur est déjà sous 1e-4.
        assert!(tap(259.0 * MS).abs() < 1e-4, "{}", tap(259.0 * MS));
        // Pas de cassure de pente (celle de `bounce` à 98,8 ms) : dérivée seconde bornée partout.
        let d2 = |e: f32| (tap(e + 1e-3) - 2.0 * tap(e) + tap(e - 1e-3)) / 1e-6;
        for i in 2..998 {
            assert!(d2(i as f32 / 1000.0).abs() < 60.0, "cassure à e = {}", i as f32 / 1000.0);
        }
    }

    /// Une piste immobile au point `(x, y)`, avec des clics.
    fn still(x: f32, y: f32, clicks: Vec<f32>) -> CursorTrack {
        CursorTrack::new((0..=90).map(|i| (i as f32 / 30.0, x, y)).collect(), clicks, vec![])
    }

    /// La coupe entière, sans restriction : le point de la piste EST le point du plan.
    fn full_aim(p: (f32, f32)) -> Option<[f32; 2]> {
        ((0.0..=1.0).contains(&p.0) && (0.0..=1.0).contains(&p.1)).then_some([p.0, p.1])
    }

    const WHOLE: [f32; 2] = [0.0, 100.0];

    /// Clic à droite → +Y ; en bas → −X ; au contact, le côté cliqué recule (z diminue).
    #[test]
    fn the_clicked_side_recedes() {
        let t = 1.0 + 49.5 / 1000.0;
        let right = click_impact(t, &still(1.0, 0.5, vec![1.0]), WHOLE, full_aim);
        assert!((right[1] - CLICK_IMPACT_DEG).abs() < 1e-2 && right[0].abs() < 1e-6, "{right:?}");
        let bottom = click_impact(t, &still(0.5, 1.0, vec![1.0]), WHOLE, full_aim);
        assert!((bottom[0] + CLICK_IMPACT_DEG).abs() < 1e-2 && bottom[1].abs() < 1e-6, "{bottom:?}");

        let z = |x: f32, y: f32, rot: [f32; 3]| rotate_corner(x, y, rot).2;
        for name in ["iso", "left", "right"] {
            let base = preset(name);
            let with = |d: [f32; 3]| [base[0] + d[0], base[1] + d[1], base[2] + d[2]];
            // Milieu du bord droit / du bord bas, et le bord opposé qui avance.
            assert!(z(960.0, 0.0, with(right)) < z(960.0, 0.0, base), "{name} droite");
            assert!(z(-960.0, 0.0, with(right)) > z(-960.0, 0.0, base), "{name} gauche");
            assert!(z(0.0, 540.0, with(bottom)) < z(0.0, 540.0, base), "{name} bas");
            assert!(z(0.0, -540.0, with(bottom)) > z(0.0, -540.0, base), "{name} haut");
        }
        // Au centre : pas d'axe, rien ne bouge.
        assert_eq!(click_impact(t, &still(0.5, 0.5, vec![1.0]), WHOLE, full_aim), [0.0; 3]);
    }

    /// Double clic : la somme est bornée — à 33 ms d'écart elle atteindrait 1,81.
    #[test]
    fn a_double_click_stays_bounded() {
        let track = still(1.0, 1.0, vec![1.0, 1.033]);
        let mut peak = 0.0f32;
        for i in 0..400 {
            let d = click_impact(1.0 + i as f32 / 1000.0, &track, WHOLE, full_aim);
            assert!(d[0].abs() <= CLICK_IMPACT_DEG && d[1].abs() <= CLICK_IMPACT_DEG, "{d:?}");
            peak = peak.max(d[1]);
        }
        assert_eq!(peak, CLICK_IMPACT_DEG, "la somme brute dépasse 1 et se fait borner");
    }

    /// Rien hors de la fenêtre du clic, du clip actif ou de la coupe visible.
    #[test]
    fn clicks_outside_the_window_the_clip_or_the_crop_do_nothing() {
        let track = still(1.0, 0.5, vec![1.0]);
        assert_eq!(click_impact(0.99, &track, WHOLE, full_aim), [0.0; 3], "avant le clic");
        assert_eq!(click_impact(1.26, &track, WHOLE, full_aim), [0.0; 3], "après 260 ms");
        let t = 1.05;
        assert_eq!(click_impact(t, &track, [1.01, 9.0], full_aim), [0.0; 3], "clic coupé avant");
        assert_eq!(click_impact(t, &track, [0.0, 1.0], full_aim), [0.0; 3], "fin exclusive");
        assert_ne!(click_impact(t, &track, [1.0, 9.0], full_aim), [0.0; 3], "début inclus");
        assert_eq!(click_impact(t, &track, WHOLE, |_| None), [0.0; 3], "hors coupe");
        assert_eq!(dynamic_tilt(t, None, FULL_CUT, 1.0, [0.0; 3]), [0.0; 3]);
    }

    /// L'axe est visé à l'instant du clic : un glisser qui suit ne le fait pas vaciller.
    #[test]
    fn the_aim_is_frozen_at_the_click() {
        let drag = CursorTrack::new(
            (0..=90)
                .map(|i| {
                    let t = i as f32 / 30.0;
                    (t, if t <= 1.0 { 1.0 } else { (1.0 - 3.0 * (t - 1.0)).max(0.0) }, 0.5)
                })
                .collect(),
            vec![1.0],
            vec![],
        );
        let rest = still(1.0, 0.5, vec![1.0]);
        for i in 0..26 {
            let t = 1.0 + i as f32 / 100.0;
            assert_eq!(
                click_impact(t, &drag, WHOLE, full_aim),
                click_impact(t, &rest, WHOLE, full_aim),
                "{t}"
            );
        }
    }

    /// L'impact passe par la porte de la parallaxe : rien pendant l'ease-in, et la somme des
    /// deux reste dans le budget — donc dans le balayage des tests de la règle des 2°.
    #[test]
    fn the_impact_shares_the_parallax_gate_and_budget() {
        let impact = [-CLICK_IMPACT_DEG, CLICK_IMPACT_DEG, 0.0];
        for k in 0..=85 {
            let strength = k as f32 / 100.0;
            assert_eq!(dynamic_tilt(1.0, None, FULL_CUT, strength, impact), [0.0; 3]);
        }
        assert_eq!(dynamic_tilt(1.0, None, FULL_CUT, 1.0, impact), impact);
        let b = DYNAMIC_TILT_BUDGET;
        assert!(CLICK_IMPACT_DEG <= b[0] && CLICK_IMPACT_DEG <= b[1]);
        // Parallaxe saturée dans le même sens : la SOMME est bornée.
        let fast = swipe(1000.0, 9.0);
        let d = dynamic_tilt(1.0, Some(&fast), FULL_CUT, 1.0, impact);
        assert!(d[1] <= b[1] && d[1] > b[1] - 1e-3, "{d:?}");
        let d = dynamic_tilt(1.0, Some(&fast), FULL_CUT, 0.95, impact);
        let gate = smoothstep(PARALLAX_GATE_START, 1.0, 0.95);
        assert!(d[1] <= b[1] * gate + 1e-5 && d[0].abs() <= b[0] * gate + 1e-5, "{d:?}");
    }

    /// Échelle gelée pendant l'impact : seuls les coins bougent, et assez pour se voir.
    #[test]
    fn a_corner_click_moves_the_plane_visibly_at_a_frozen_scale() {
        let track = still(1.0, 1.0, vec![1.0]);
        for name in ["iso", "left", "right"] {
            let base = rotated_quad_corners_px(1920.0, 1080.0, preset(name), [0.0; 3]);
            let mut worst = 0.0f32;
            for i in 0..=26 {
                let d = click_impact(1.0 + i as f32 / 100.0, &track, WHOLE, full_aim);
                let q = rotated_quad_corners_px(1920.0, 1080.0, preset(name), d);
                assert_eq!(q.scale, base.scale, "{name}");
                for (a, b) in q.corners.iter().zip(base.corners) {
                    worst = worst.max((a.0 - b.0).hypot(a.1 - b.1));
                }
            }
            // Mesuré : 24 px (iso), 25 (left), 27 (right) à 1080p pour un clic dans un coin.
            assert!(worst > 15.0, "{name} : {worst:.1} px, invisible");
        }
    }

    #[test]
    fn the_click_impact_weight_follows_the_region_flag() {
        let region = |click_impact: bool| SceneZoomRegion {
            id: "z".into(),
            clip_index: None,
            start_sec: 2.0,
            end_sec: 8.0,
            scale: 2.0,
            focus_x: 0.5,
            focus_y: 0.5,
            focus_mode: None,
            rotation: Some("iso".into()),
            under_trim: false,
            hide_cursor: false,
            click_impact,
        };
        assert_eq!(zoom_state_at(&[region(true)], 5.0, None).click_impact, 1.0);
        assert_eq!(zoom_state_at(&[region(false)], 5.0, None).click_impact, 0.0);
        assert_eq!(zoom_state_at(&[region(true)], 0.0, None).click_impact, 0.0, "hors région");
    }

    /// `ZoomState::tilt` : la force pour une région à préset, 0 sans préset.
    #[test]
    fn the_tilt_gate_follows_the_region_strength_only_with_a_preset() {
        let region = |rotation: Option<&str>| SceneZoomRegion {
            id: "z".into(),
            clip_index: None,
            start_sec: 2.0,
            end_sec: 8.0,
            scale: 2.0,
            focus_x: 0.5,
            focus_y: 0.5,
            focus_mode: None,
            rotation: rotation.map(Into::into),
            under_trim: false,
            hide_cursor: false,
            click_impact: false,
        };
        assert_eq!(zoom_state_at(&[region(Some("iso"))], 5.0, None).tilt, 1.0);
        assert_eq!(zoom_state_at(&[region(None)], 5.0, None).tilt, 0.0);
        let easing = zoom_state_at(&[region(Some("left"))], 1.2, None);
        assert!(easing.tilt > 0.0 && easing.tilt < 1.0, "{}", easing.tilt);
        assert_eq!(zoom_state_at(&[region(Some("left"))], 0.0, None).tilt, 0.0);
    }

    // ---- Mapping inverse du mode 8, reproduit à l'identique -------------------------------
    // Le pixel shader retrouve (s,t) dans le quad projeté en résolvant un système quadratique.
    // Le miroir ci-dessous est une COPIE de `shaders.hlsl` (mode 8) : même algèbre, même choix
    // de racine, mêmes tolérances. Il sert à interroger ce mapping sans GPU — un bord droit qui
    // tranche un écran penché ne peut venir que de trois endroits (les coins, ce mapping, le
    // rect source), et c'est le seul des trois qu'on ne pouvait pas encore examiner.

    fn cross2(a: (f32, f32), b: (f32, f32)) -> f32 {
        a.0 * b.1 - a.1 * b.0
    }

    fn sub(a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
        (a.0 - b.0, a.1 - b.1)
    }

    /// Point du quad pour un couple (s,t) — la direction que le shader inverse.
    fn forward_bilinear(corners: &[(f32, f32); 4], s: f32, t: f32) -> (f32, f32) {
        let (c00, c10, c11, c01) = (corners[0], corners[1], corners[2], corners[3]);
        let e = sub(c10, c00);
        let f = sub(c01, c00);
        let g = (c00.0 - c10.0 - c01.0 + c11.0, c00.1 - c10.1 - c01.1 + c11.1);
        (c00.0 + e.0 * s + f.0 * t + g.0 * s * t, c00.1 + e.1 * s + f.1 * t + g.1 * s * t)
    }

    /// `None` = le shader rend ce pixel TRANSPARENT (donc un trou dans l'écran incliné).
    fn shader_inverse_bilinear(corners: &[(f32, f32); 4], p: (f32, f32)) -> Option<(f32, f32)> {
        let (c00, c10, c11, c01) = (corners[0], corners[1], corners[2], corners[3]);
        let e = sub(c10, c00);
        let f = sub(c01, c00);
        let g = (c00.0 - c10.0 - c01.0 + c11.0, c00.1 - c10.1 - c01.1 + c11.1);
        let h = sub(p, c00);
        let k2 = cross2(g, f);
        let k1 = cross2(e, f) + cross2(h, g);
        let k0 = cross2(h, e);
        // Pour une racine `t` candidate, le `s` correspondant — et si le couple tombe dans le quad.
        let st_for_root = |t: f32| -> Option<(f32, f32)> {
            let denom_x = e.0 + g.0 * t;
            let denom_y = e.1 + g.1 * t;
            let s = if denom_x.abs() > denom_y.abs() {
                (h.0 - f.0 * t) / denom_x
            } else {
                (h.1 - f.1 * t) / denom_y
            };
            ((-0.02..=1.02).contains(&s) && (-0.02..=1.02).contains(&t)).then_some((s, t))
        };
        // Seuil RELATIF. Un prését « left »/« right » est une rotation Y pure : le quad projeté
        // est un trapèze symétrique dont `f` et `g` sont tous deux verticaux, donc k2 = 0
        // exactement — au bruit d'arrondi près, et ce bruit vaut quelques centièmes sur des
        // produits en 10^6. Un seuil absolu de 0.001 le manquait, l'équation partait dans la
        // branche quadratique avec un k2 ≈ 0, et `(-k1 + sqrt(k1²)) / 2k2` y perd toute
        // précision : soustraire deux nombres presque égaux ne laisse que du bruit, divisé
        // ensuite par un k2 minuscule. C'est ça qui amputait l'écran incliné.
        if k2.abs() < 1e-5 * k1.abs() {
            let t = if k1.abs() < 1e-6 { 0.0 } else { -k0 / k1 };
            return st_for_root(t);
        }
        let disc = k1 * k1 - 4.0 * k2 * k0;
        if disc < 0.0 {
            return None;
        }
        // Forme stable : `q` évite la soustraction catastrophique, et les deux racines s'en
        // déduisent sans jamais retrancher deux quantités voisines. Le signe s'écrit en ternaire
        // et non via `signum`, pour coller au shader — où `sign()` vaut 0 en 0 et annulerait `q`.
        let sign_k1 = if k1 >= 0.0 { 1.0 } else { -1.0 };
        let q = -0.5 * (k1 + sign_k1 * disc.sqrt());
        let roots = [q / k2, if q.abs() > 0.0 { k0 / q } else { q / k2 }];
        // Les DEUX racines sont essayées : trancher sur `t` seul retenait parfois celle dont le
        // `s` tombe hors du quad, et le pixel était alors déclaré dehors alors que l'autre racine
        // le plaçait dedans.
        st_for_root(roots[0]).or_else(|| st_for_root(roots[1]))
    }

    #[test]
    fn the_shader_mapping_covers_the_whole_tilted_quad() {
        // Le bug rapporté : « une sorte d'overflow hidden qui tronque le screen recording ». Si le
        // mapping inverse perd des pixels pourtant intérieurs au quad, le trou a exactement cette
        // allure — un bord net, sans rapport avec la géométrie visible.
        for (name, rot) in [
            ("iso", rotation3d_for(&Some("iso".into()))),
            ("left", rotation3d_for(&Some("left".into()))),
            ("right", rotation3d_for(&Some("right".into()))),
        ] {
            let corners = rotated_quad_corners_px(1920.0, 1080.0, rot, [0.0; 3]).corners;
            let mut dropped = Vec::new();
            let n = 64;
            for i in 0..=n {
                for j in 0..=n {
                    // On reste à un cheveu des arêtes : le contour exact est une frontière où le
                    // rejet est légitime.
                    let s = 0.002 + (i as f32 / n as f32) * 0.996;
                    let t = 0.002 + (j as f32 / n as f32) * 0.996;
                    let p = forward_bilinear(&corners, s, t);
                    match shader_inverse_bilinear(&corners, p) {
                        None => dropped.push((s, t)),
                        Some((s2, t2)) => {
                            // Retrouver le mauvais (s,t) est aussi grave : l'écran afficherait
                            // alors un morceau de lui-même au mauvais endroit.
                            if (s2 - s).abs() > 0.01 || (t2 - t).abs() > 0.01 {
                                dropped.push((s, t));
                            }
                        }
                    }
                }
            }
            assert!(
                dropped.is_empty(),
                "{name} : {} points intérieurs perdus par le mapping, p.ex. {:?}",
                dropped.len(),
                &dropped[..dropped.len().min(5)]
            );
        }
    }
}

#[cfg(test)]
mod exporter_frame_totals {
    use super::*;
    use crate::scene::SceneSpeedRegion;

    fn region(start_sec: f64, end_sec: f64, speed: f64) -> SceneSpeedRegion {
        SceneSpeedRegion { clip_index: None, start_sec, end_sec, speed }
    }

    fn frames(start_sec: f64, end_sec: f64, regions: &[SceneSpeedRegion], fps: f64) -> u64 {
        speed_segments_for_window(regions, start_sec, end_sec, fps)
            .iter()
            .map(|segment| segment.frame_count)
            .sum()
    }

    /// Le total que la barre d'export doit viser, mesuré sur ce que `walk_composited_timeline`
    /// itère réellement.
    ///
    /// Le jumeau de ce test est `src/lib/exporter/outputFrameCount.test.ts`, avec la MÊME
    /// table de chiffres. Le natif n'envoie qu'un compteur de frames brut ; le total et donc
    /// le pourcentage sont calculés côté TS, et rien ne reliait les deux calculs. Résultat
    /// livré : le total TS ignorait les speed regions, donc un clip entièrement en 1,25×
    /// rendait 80 % des frames annoncées et la barre s'arrêtait à 80 % — le « figé à ~80 % »
    /// d'OpenScreen#371, au chiffre près. Toucher un côté doit faire rougir l'autre.
    #[test]
    fn speed_segments_match_the_exporter_frame_totals() {
        const FPS: f64 = 30.0;
        assert_eq!(frames(0.0, 10.0, &[], FPS), 300, "sans région");
        assert_eq!(
            frames(0.0, 10.0, &[region(0.0, 10.0, 1.25)], FPS),
            240,
            "1,25× : 80 % de 300, exactement le symptôme"
        );
        assert_eq!(frames(0.0, 10.0, &[region(0.0, 10.0, 0.5)], FPS), 600, "0,5×");
        assert_eq!(
            frames(0.0, 10.0, &[region(2.0, 4.0, 2.0)], FPS),
            60 + 30 + 180,
            "couverture partielle"
        );
        assert_eq!(
            frames(1.0, 5.0, &[region(0.0, 100.0, 2.0)], FPS),
            60,
            "région débordant la fenêtre gardée"
        );
        assert_eq!(
            frames(0.0, 10.0, &[region(2.0, 6.0, 2.0), region(4.0, 8.0, 4.0)], FPS),
            60 + 60 + 15 + 60,
            "recouvrement : la première région garde la portion déjà couverte"
        );
        assert_eq!(
            frames(0.0, 10.0, &[region(0.0, 10.0, 0.0)], FPS),
            300,
            "vitesse non positive traitée comme 1×"
        );
        assert_eq!(frames(4.0, 4.0, &[], FPS), 0, "fenêtre vide");
        assert_eq!(frames(0.0, 10.0, &[], 0.0), 0, "fps non positif");
    }
}

#[cfg(test)]
mod programme_clock {
    use super::*;
    use crate::scene::Scene;

    const FPS: f64 = 30.0;

    /// Deux clips du même fichier, une région de vitesse chacun, et une région du clip 1 posée
    /// dans la fenêtre du clip 0 : seul son `clipIndex` dit qu'elle n'est pas à lui.
    fn scene() -> Scene {
        Scene::from_json(
            r##"{
            "clips":[{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":4,"webcamOffsetSec":0,"hasAudio":false},
                     {"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":10,"sourceEndSec":13,"webcamOffsetSec":0,"hasAudio":false}],
            "layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},
            "effects":{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0},
            "background":{"kind":"color","color":"#000000"},
            "zoomRegions":[],
            "speedRegions":[{"clipIndex":0,"startSec":1.0,"endSec":2.0,"speed":2.0},
                            {"clipIndex":1,"startSec":0.5,"endSec":3.5,"speed":4.0},
                            {"clipIndex":1,"startSec":11.0,"endSec":12.0,"speed":0.5}],
            "cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},
            "cropByClip":[null,null],
            "output":{"width":1920,"height":1080,"fps":null}
        }"##,
        )
        .expect("scène")
    }

    /// La preview et l'export tombent sur le même temps programme : pour chaque frame que la
    /// marche d'export compose (mêmes spans, même cible source, même `frames / out_fps`),
    /// l'horloge interrogée au seul temps source rend la même valeur.
    #[test]
    fn the_clock_matches_the_export_walk_at_every_frame() {
        let scene = scene();
        let mut frames: u64 = 0;
        for (i, clip) in scene.clips.iter().enumerate() {
            let window = scene.for_clip_window(i, clip.source_start_sec, clip.source_end_sec);
            let clock = ProgrammeClock::for_clip(&scene, i, FPS).expect("horloge");
            let segments = speed_segments_for_window(
                &window.speed_regions,
                clip.source_start_sec,
                clip.source_end_sec,
                FPS,
            );
            for s in &segments {
                for k in 0..s.frame_count {
                    let target = s.start_sec + k as f64 * s.speed / FPS;
                    let export = (frames as f64 / FPS) as f32;
                    let preview = clock.at(target) as f32;
                    assert!(
                        (export - preview).abs() <= 1e-6,
                        "clip {i} frame {frames} (source {target}) : export {export}, preview {preview}"
                    );
                    frames += 1;
                }
            }
        }
        // 1 s à 1×, 1 s à 2×, 2 s à 1× ; puis 1 s à 1×, 1 s à 0,5×, 1 s à 1×.
        assert_eq!(
            frames,
            30 + 15 + 60 + 30 + 60 + 30,
            "garde : la région du clip 1 posée dans la fenêtre du clip 0 doit être ignorée"
        );
    }

    /// Le temps programme ne saute pas à la frontière de clip et ne recule jamais.
    #[test]
    fn the_clock_is_continuous_across_clips_and_clamped_to_the_window() {
        let scene = scene();
        let first = ProgrammeClock::for_clip(&scene, 0, FPS).expect("clip 0");
        let second = ProgrammeClock::for_clip(&scene, 1, FPS).expect("clip 1");
        assert_eq!(first.at(0.0), 0.0);
        assert_eq!(first.at(4.0), second.at(10.0));
        assert_eq!(second.at(10.0), 105.0 / FPS);
        // Hors fenêtre (sous une coupe) : borné, jamais extrapolé.
        assert_eq!(second.at(3.0), second.at(10.0));
        assert_eq!(second.at(99.0), 225.0 / FPS);
        let mut last = -1.0;
        for step in 0..=1300 {
            let t = second.at(step as f64 / 100.0);
            assert!(t >= last, "recul à {step}");
            last = t;
        }
        assert!(ProgrammeClock::for_clip(&scene, 2, FPS).is_none());
        assert!(ProgrammeClock::for_clip(&scene, 0, 0.0).is_none());
    }
}
