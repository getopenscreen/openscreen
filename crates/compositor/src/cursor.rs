//! Piste curseur depuis un `.cursor.json` openscreen. Fournit position interpolée
//! et facteur de « click bounce » — consommés par frame (temps fractionnaire), donc
//! le motion blur du curseur vient gratuitement du supersampling temporel.

use anyhow::{Context, Result};

// Paramètres de suivi auto — parité stricte avec
// `src/lib/zoomMath/constants.ts` (AUTO_FOLLOW_PARAMS), partagés
// là-bas entre preview et export pour que la caméra suive le curseur à l'identique.
const AUTO_FOLLOW_MIN_FACTOR: f32 = 0.1;
const AUTO_FOLLOW_MAX_FACTOR: f32 = 0.25;
const AUTO_FOLLOW_RAMP_DISTANCE: f32 = 0.15;
const AUTO_FOLLOW_REFERENCE_MS: f32 = 1000.0 / 40.0;

#[derive(Clone)]
pub struct CursorTrack {
    /// (t_secondes, cx, cy) normalisés dans le cadre screen, triés.
    samples: Vec<(f32, f32, f32)>,
    /// Même piste après lissage exponentiel adaptatif — ce que le suivi auto du zoom doit
    /// consommer. `samples` reste la piste BRUTE : le rendu du curseur lui-même et le click
    /// bounce doivent coller à la position réelle, seule la caméra est amortie.
    follow_samples: Vec<(f32, f32, f32)>,
    /// instants de clic (secondes) dans la fenêtre.
    clicks: Vec<f32>,
    /// CHANGEMENTS d'état du curseur : (instant, `"arrow"` / `"text"` / `"pointer"` / …), triés.
    /// Une fonction en escalier, pas une valeur par échantillon : l'état tient sur des secondes
    /// entières alors que la position est échantillonnée à ~120 Hz, donc n'enregistrer que les
    /// transitions garde cette liste minuscule et rend `type_at` trivial.
    types: Vec<(f32, String)>,
}

/// Interpolation linéaire dans une liste `(t, x, y)` triée ; saturation aux bornes.
fn sample_at(samples: &[(f32, f32, f32)], t: f32) -> Option<(f32, f32)> {
    if samples.is_empty() {
        return None;
    }
    if t <= samples[0].0 {
        let s = samples[0];
        return Some((s.1, s.2));
    }
    if t >= samples[samples.len() - 1].0 {
        let s = *samples.last().unwrap();
        return Some((s.1, s.2));
    }
    // recherche du segment encadrant
    let i = samples.partition_point(|s| s.0 <= t);
    let a = samples[i - 1];
    let b = samples[i];
    let f = if b.0 > a.0 { (t - a.0) / (b.0 - a.0) } else { 0.0 };
    Some((a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f))
}

/// Port de `advanceFollowFocus` (`cursorFollowUtils.ts`) : lissage exponentiel dont le facteur
/// croît avec la distance à la cible (loin = rattrape vite, près = décélère), corrigé en temps
/// pour être indépendant de la cadence.
///
/// La version TS est **séquentielle** : elle avance un `prev` d'une frame à l'autre. Rejouer ça
/// par frame ici ferait dépendre l'image du chemin parcouru pour l'atteindre — deux rendus du
/// même instant divergeraient selon qu'on y arrive en lecture ou par un seek, et la preview ne
/// correspondrait plus à l'export. On applique donc le même filtre UNE fois, sur les
/// échantillons de télémétrie eux-mêmes : le résultat est identique en lecture linéaire et reste
/// une pure fonction de `t`.
fn smooth_follow_samples(samples: &[(f32, f32, f32)]) -> Vec<(f32, f32, f32)> {
    let mut smoothed: Vec<(f32, f32, f32)> = Vec::with_capacity(samples.len());
    let mut prev: Option<(f32, f32, f32)> = None;
    for &(t, x, y) in samples {
        let Some((prev_t, px, py)) = prev else {
            smoothed.push((t, x, y));
            prev = Some((t, x, y));
            continue;
        };
        let dt_ms = (t - prev_t) * 1000.0;
        if !(dt_ms > 0.0) {
            // Horodatages dupliqués : on garde la valeur déjà lissée plutôt que de diviser par 0.
            smoothed.push((t, px, py));
            prev = Some((t, px, py));
            continue;
        }
        let (dx, dy) = (x - px, y - py);
        let distance = (dx * dx + dy * dy).sqrt();
        let ramp = (distance / AUTO_FOLLOW_RAMP_DISTANCE).min(1.0);
        let base = AUTO_FOLLOW_MIN_FACTOR + (AUTO_FOLLOW_MAX_FACTOR - AUTO_FOLLOW_MIN_FACTOR) * ramp;
        let factor = 1.0 - (1.0 - base).powf(dt_ms / AUTO_FOLLOW_REFERENCE_MS);
        let (nx, ny) = (px + dx * factor, py + dy * factor);
        smoothed.push((t, nx, ny));
        prev = Some((t, nx, ny));
    }
    smoothed
}

impl CursorTrack {
    /// Seul point de construction : garantit que `follow_samples` est toujours dérivé des
    /// échantillons courants. Une piste re-lissée (`smoothed`) recalcule donc aussi son suivi,
    /// pour que la caméra suive la trajectoire que l'utilisateur voit réellement.
    pub(crate) fn new(samples: Vec<(f32, f32, f32)>, clicks: Vec<f32>, types: Vec<(f32, String)>) -> CursorTrack {
        let follow_samples = smooth_follow_samples(&samples);
        CursorTrack { samples, follow_samples, clicks, types }
    }

    /// État du curseur au temps `t` : la dernière transition à `t` ou avant. `None` avant la
    /// première (enregistrement sans état tagué → l'appelant retombe sur la flèche).
    pub fn type_at(&self, t: f32) -> Option<&str> {
        let i = self.types.partition_point(|(tc, _)| *tc <= t);
        (i > 0).then(|| self.types[i - 1].1.as_str())
    }

    /// Nombre d'échantillons de la piste (utile au diag de chargement).
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Charge la fenêtre [offset_ms, offset_ms + dur_s*1000] et la ramène à t=0.
    pub fn load(path: &str, offset_ms: f64, dur_s: f64) -> Result<CursorTrack> {
        let txt = std::fs::read_to_string(path).with_context(|| format!("lecture {path}"))?;
        let v: serde_json::Value = serde_json::from_str(&txt)?;
        let arr = v["samples"].as_array().context("samples[]")?;
        let mut samples = Vec::new();
        let mut clicks = Vec::new();
        let mut types: Vec<(f32, String)> = Vec::new();
        let end = offset_ms + dur_s * 1000.0;
        for s in arr {
            let tm = s["timeMs"].as_f64().unwrap_or(-1.0);
            if tm < offset_ms || tm > end {
                continue;
            }
            let t = ((tm - offset_ms) / 1000.0) as f32;
            let cx = s["cx"].as_f64().unwrap_or(0.0) as f32;
            let cy = s["cy"].as_f64().unwrap_or(0.0) as f32;
            samples.push((t, cx, cy));
            if s["interactionType"].as_str() == Some("click") {
                clicks.push(t);
            }
            // Seules les TRANSITIONS sont retenues — voir `types`. Le helper
            // macOS rend nil hors texte/pointeur pour que le rendu retombe sur
            // la flèche. Le sidecar stocke ça en JSON null ou omet la clé.
            // Ignorer ces échantillons gardait le dernier type sémantique
            // (`pointer`/`text`) : un thème restait collé après le retour à la
            // flèche. Null / absence = reset vers `arrow`.
            let ct = match s.get("cursorType") {
                Some(v) => v.as_str().filter(|label| !label.is_empty()).unwrap_or("arrow"),
                None => "arrow",
            };
            if types.last().map(|(_, prev)| prev.as_str()) != Some(ct) {
                types.push((t, ct.to_string()));
            }
        }
        samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        clicks.sort_by(|a, b| a.partial_cmp(b).unwrap());
        types.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        Ok(CursorTrack::new(samples, clicks, types))
    }

    /// Position lissée au temps `t`, pour le suivi auto du zoom. La télémétrie brute est
    /// échantillonnée trop finement pour piloter une caméra directement : la suivre au sample
    /// près donne un pan nerveux. Voir `smooth_follow_samples`.
    pub fn follow_at(&self, t: f32) -> Option<(f32, f32)> {
        sample_at(&self.follow_samples, t)
    }

    /// Position (cx, cy) BRUTE au temps `t` (interpolation linéaire), ou None si hors piste.
    pub fn at(&self, t: f32) -> Option<(f32, f32)> {
        sample_at(&self.samples, t)
    }

    /// Facteur d'échelle « click bounce » — parité `getNativeCursorClickBounceScale` (TS,
    /// `nativeCursor.ts`) : le curseur PRESSE (rétrécit, 0..38% de la fenêtre d'animation)
    /// PUIS REBONDIT (grossit, 38..100%), pas un simple pop qui ne fait que grossir puis
    /// redécroître. Seul le clic le plus récent précédant `t` compte (au-delà de la fenêtre,
    /// un clic antérieur n'a plus aucun effet — contrairement à l'ancienne décroissance
    /// exponentielle à queue infinie qui masquait ce bug).
    pub fn bounce(&self, t: f32) -> f32 {
        const ANIM_S: f32 = 0.26; // NATIVE_CURSOR_CLICK_ANIMATION_MS (TS) = 260ms
        const PRESS_FRAC: f32 = 0.38;
        let mut last_tc: Option<f32> = None;
        for &tc in &self.clicks {
            if tc <= t {
                last_tc = Some(tc); // clics triés croissant -> garde le plus récent <= t
            } else {
                break;
            }
        }
        let Some(tc) = last_tc else { return 1.0 };
        let elapsed = (t - tc) / ANIM_S;
        if elapsed >= 1.0 {
            return 1.0;
        }
        if elapsed < PRESS_FRAC {
            let press = (elapsed / PRESS_FRAC * std::f32::consts::PI).sin();
            1.0 - press * 0.24
        } else {
            let rebound = ((elapsed - PRESS_FRAC) / (1.0 - PRESS_FRAC) * std::f32::consts::PI).sin();
            1.0 + rebound * 0.16
        }
    }

    /// Piste repositionnée par un ressort-amortisseur (parité `cursorPathSmoothing.ts` :
    /// resample à 240 Hz + intégration semi-implicite d'Euler). `factor` 0..1 = valeur brute
    /// du slider (0 = passthrough, retourne un clone). Les clics restent sur leurs instants
    /// bruts (le bounce est temporel, pas positionnel — ne doit pas suivre le lissage).
    pub fn smoothed(&self, factor: f32) -> CursorTrack {
        if self.samples.len() < 2 || factor <= 0.0 {
            return CursorTrack::new(self.samples.clone(), self.clicks.clone(), self.types.clone());
        }
        const STEP_S: f32 = 1.0 / 240.0;
        let start = self.samples[0].0;
        let end = self.samples[self.samples.len() - 1].0;
        let step_count = (((end - start) / STEP_S).round() as usize).max(1);
        let n = step_count + 1;
        let mut times = Vec::with_capacity(n);
        let mut raw_x = Vec::with_capacity(n);
        let mut raw_y = Vec::with_capacity(n);
        for i in 0..n {
            let t = if i == n - 1 { end } else { start + i as f32 * STEP_S };
            let (cx, cy) = self.at(t).unwrap_or((0.0, 0.0));
            times.push(t);
            raw_x.push(cx);
            raw_y.push(cy);
        }
        let (stiffness, damping, mass) = cursor_spring_config(factor);
        let xs = spring_smooth(&raw_x, stiffness, damping, mass, STEP_S);
        let ys = spring_smooth(&raw_y, stiffness, damping, mass, STEP_S);
        let samples = times.into_iter().zip(xs).zip(ys).map(|((t, x), y)| (t, x, y)).collect();
        // Comme les clics, les changements d'état gardent leurs instants bruts : le lissage
        // déplace la trajectoire, pas la chronologie de ce que faisait l'utilisateur.
        CursorTrack::new(samples, self.clicks.clone(), self.types.clone())
    }

    /// Opacité du curseur (0.0..1.0) selon l'inactivité (auto-hide).
    /// Si `auto_hide` est faux, retourne toujours 1.0.
    /// Si `auto_hide` est vrai :
    /// - Le curseur reste à 1.0 tant qu'il bouge ou clique, et pendant 1.5s après le dernier mouvement/clic.
    /// - Entre 1.5s et 1.8s d'inactivité, il s'estompe linéairement de 1.0 à 0.0 (fade-out 300ms).
    /// - Au-delà de 1.8s, opacité 0.0.
    pub fn opacity_at(&self, t: f32, auto_hide: bool) -> f32 {
        if !auto_hide || self.samples.is_empty() {
            return 1.0;
        }

        const IDLE_TIMEOUT_S: f32 = 1.5;
        const FADE_DURATION_S: f32 = 0.3;
        const MOVE_THRESH_SQ: f32 = 0.015 * 0.015;

        let last_click = match self.clicks.partition_point(|&tc| tc <= t) {
            0 => None,
            i => Some(self.clicks[i - 1]),
        };

        let (cx, cy) = match self.at(t) {
            Some(p) => p,
            None => return 1.0,
        };

        let idx = self.samples.partition_point(|s| s.0 <= t);
        let start_t = self.samples[0].0;

        let mut arrival_t = if idx > 0 { self.samples[idx - 1].0 } else { start_t };

        if idx > 0 {
            let mut i = idx - 1;
            while i > 0 {
                let prev = self.samples[i - 1];
                let dx = cx - prev.1;
                let dy = cy - prev.2;
                if dx * dx + dy * dy > MOVE_THRESH_SQ {
                    arrival_t = self.samples[i].0;
                    break;
                }
                if t - prev.0 > IDLE_TIMEOUT_S + FADE_DURATION_S {
                    arrival_t = prev.0;
                    break;
                }
                i -= 1;
                if i == 0 {
                    arrival_t = start_t;
                }
            }
        }

        if idx > 1 {
            let s1 = self.samples[idx - 1];
            let s0 = self.samples[idx - 2];
            let d_step = (s1.1 - s0.1) * (s1.1 - s0.1) + (s1.2 - s0.2) * (s1.2 - s0.2);
            if d_step > 0.005 * 0.005 && (t - s1.0).abs() < 0.1 {
                arrival_t = t;
            }
        }

        let mut last_activity = arrival_t;
        if let Some(tc) = last_click {
            if tc > last_activity {
                last_activity = tc;
            }
        }

        let idle_time = (t - last_activity).max(0.0);
        if idle_time <= IDLE_TIMEOUT_S {
            1.0
        } else if idle_time >= IDLE_TIMEOUT_S + FADE_DURATION_S {
            0.0
        } else {
            1.0 - (idle_time - IDLE_TIMEOUT_S) / FADE_DURATION_S
        }
    }
}

/// Ressort-amortisseur, intégration semi-implicite (symplectique) d'Euler — stable pour ces
/// raideurs à la grille 240 Hz (port direct de `springSmooth` en TS).
fn spring_smooth(targets: &[f32], stiffness: f32, damping: f32, mass: f32, step_s: f32) -> Vec<f32> {
    let mut out = vec![0.0f32; targets.len()];
    if targets.is_empty() {
        return out;
    }
    let mut x = targets[0];
    let mut v = 0.0f32;
    out[0] = x;
    for i in 1..targets.len() {
        let accel = (-stiffness * (x - targets[i]) - damping * v) / mass;
        v += accel * step_s;
        x += v * step_s;
        out[i] = x;
    }
    out
}

/// Port direct de `getCursorSpringConfig` (TS) → (stiffness, damping, mass). N'accepte que
/// 0..1 (plage réelle du slider, cf. `RightPanes.tsx` : `smoothing * 100` sur un slider 0..100).
fn cursor_spring_config(smoothing_factor: f32) -> (f32, f32, f32) {
    let clamped = smoothing_factor.clamp(0.0, 2.0);
    if clamped <= 0.0 {
        return (1000.0, 100.0, 1.0);
    }
    const LEGACY_MAX: f32 = 0.5;
    if clamped <= LEGACY_MAX {
        let n = (clamped / LEGACY_MAX).clamp(0.0, 1.0);
        return (760.0 - n * 420.0, 34.0 + n * 24.0, 0.55 + n * 0.45);
    }
    let n = ((clamped - LEGACY_MAX) / (2.0 - LEGACY_MAX)).clamp(0.0, 1.0);
    (340.0 - n * 180.0, 58.0 + n * 22.0, 1.0 + n * 0.35)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'état du curseur est une fonction en escalier : il tient jusqu'à la transition
    /// suivante, il n'est pas interpolé, et avant la première il n'y en a pas.
    #[test]
    fn cursor_type_holds_until_the_next_transition() {
        let track = CursorTrack::new(
            vec![(0.0, 0.0, 0.0), (2.0, 1.0, 1.0)],
            vec![],
            vec![(0.5, "arrow".into()), (1.0, "text".into()), (1.5, "pointer".into())],
        );

        assert_eq!(track.type_at(0.0), None, "avant la première transition");
        assert_eq!(track.type_at(0.5), Some("arrow"), "à l'instant même de la transition");
        assert_eq!(track.type_at(0.9), Some("arrow"), "tient jusqu'à la suivante");
        assert_eq!(track.type_at(1.2), Some("text"));
        assert_eq!(track.type_at(99.0), Some("pointer"), "la dernière tient jusqu'à la fin");
    }

    /// Le lissage déplace la trajectoire, pas la chronologie : les états doivent survivre
    /// intacts à `smoothed()`, comme les clics.
    #[test]
    fn smoothing_preserves_cursor_types() {
        let track = CursorTrack::new(
            vec![(0.0, 0.0, 0.0), (0.5, 0.4, 0.4), (1.0, 1.0, 1.0)],
            vec![0.25],
            vec![(0.0, "arrow".into()), (0.6, "text".into())],
        );

        let smoothed = track.smoothed(0.4);
        assert_eq!(smoothed.type_at(0.1), Some("arrow"));
        assert_eq!(smoothed.type_at(0.7), Some("text"));
    }

    /// JSON null et une clé `cursorType` absente resetent vers la flèche,
    /// au lieu de garder le dernier `pointer`/`text`.
    #[test]
    fn null_cursor_type_resets_to_arrow() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "openscreen-cursor-null-reset-{}-{}.json",
            std::process::id(),
            unique
        ));
        std::fs::write(
            &path,
            r#"{"samples":[
                {"timeMs":0,"cx":0.1,"cy":0.1,"cursorType":"pointer"},
                {"timeMs":100,"cx":0.2,"cy":0.2,"cursorType":null},
                {"timeMs":200,"cx":0.3,"cy":0.3,"cursorType":"pointer"},
                {"timeMs":300,"cx":0.4,"cy":0.4}
            ]}"#,
        )
        .expect("write temp sidecar");
        let path_str = path.to_str().expect("utf-8 temp path");
        let track = CursorTrack::load(path_str, 0.0, 1.0).expect("load sidecar");
        let _ = std::fs::remove_file(&path);

        assert_eq!(track.type_at(0.00), Some("pointer"));
        assert_eq!(
            track.type_at(0.10),
            Some("arrow"),
            "JSON null must reset to arrow"
        );
        assert_eq!(
            track.type_at(0.20),
            Some("pointer"),
            "pointer after null must hold until the omitted-key sample"
        );
        assert_eq!(
            track.type_at(0.30),
            Some("arrow"),
            "omitted cursorType after pointer must reset to arrow independently"
        );
    }

    #[test]
    fn auto_hide_disabled_always_full_opacity() {
        let track = CursorTrack::new(
            vec![(0.0, 0.5, 0.5), (10.0, 0.5, 0.5)],
            vec![],
            vec![],
        );
        assert_eq!(track.opacity_at(0.0, false), 1.0);
        assert_eq!(track.opacity_at(5.0, false), 1.0);
        assert_eq!(track.opacity_at(10.0, false), 1.0);
    }

    #[test]
    fn auto_hide_fades_out_after_idle_timeout() {
        // Le curseur est stationnaire à (0.5, 0.5) de 0 à 5s.
        let track = CursorTrack::new(
            vec![(0.0, 0.5, 0.5), (1.0, 0.5, 0.5), (2.0, 0.5, 0.5), (3.0, 0.5, 0.5), (4.0, 0.5, 0.5)],
            vec![],
            vec![],
        );
        // Pendant 1.5s, opacité 1.0
        assert_eq!(track.opacity_at(0.0, true), 1.0);
        assert_eq!(track.opacity_at(1.0, true), 1.0);
        assert_eq!(track.opacity_at(1.5, true), 1.0);

        // Entre 1.5s et 1.8s, estompage linéaire
        let op_mid = track.opacity_at(1.65, true);
        assert!((op_mid - 0.5).abs() < 0.05, "mi-parcours d'estompage: {op_mid}");

        // À 1.8s et au-delà, opacité 0.0
        assert_eq!(track.opacity_at(1.8, true), 0.0);
        assert_eq!(track.opacity_at(3.0, true), 0.0);
    }

    #[test]
    fn auto_hide_wakes_on_movement_or_click() {
        // Reste immobile jusqu'à 2s, bouge à 2.5s, s'arrête, clic à 4.0s
        let track = CursorTrack::new(
            vec![
                (0.0, 0.1, 0.1),
                (1.0, 0.1, 0.1),
                (2.0, 0.1, 0.1),
                (2.5, 0.8, 0.8), // mouvement net
                (2.6, 0.8, 0.8),
                (4.0, 0.8, 0.8),
                (5.0, 0.8, 0.8),
            ],
            vec![4.0], // clic à 4.0s
            vec![],
        );

        // À 1.9s, inactif depuis 0s -> 0.0
        assert_eq!(track.opacity_at(1.9, true), 0.0);

        // À 2.5s, vient de bouger -> réveil à 1.0
        assert_eq!(track.opacity_at(2.5, true), 1.0);
        // À 3.5s, 1s après le mouvement -> toujours 1.0
        assert_eq!(track.opacity_at(3.5, true), 1.0);

        // Sans le clic à 4.0, à 4.5s (2s après 2.5) il serait éteint.
        // Mais le clic à 4.0s le réveille -> 1.0
        assert_eq!(track.opacity_at(4.2, true), 1.0);
        // Et s'éteint 1.8s après le clic (4.0 + 1.8 = 5.8s)
        assert_eq!(track.opacity_at(5.9, true), 0.0);
    }
}
