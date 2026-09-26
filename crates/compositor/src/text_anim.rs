//! Animations d'apparition du texte d'annotation.
//!
//! Port VERBATIM de `src/lib/annotationTextAnimation.ts` : même durée, mêmes easings, mêmes
//! amplitudes. Les sept animations étaient déjà nommées dans le schéma, traduites dans les treize
//! langues et transportées jusqu'ici par la scène — mais rien ne les jouait. Reprendre les
//! constantes du TS plutôt que d'en réinventer garantit qu'un projet fait à l'époque de l'aperçu
//! DOM s'anime toujours pareil.

/// Les décalages ci-dessous sont exprimés en px À CETTE HAUTEUR : l'appelant les met à l'échelle
/// de la sortie, exactement comme la taille de police (cf. `annotationScale.ts`). En pixels
/// absolus, la même animation sauterait de deux fois plus haut dans un rendu 4K que dans l'aperçu.
pub const ANIMATION_REFERENCE_HEIGHT: f32 = 1080.0;

pub const TEXT_ANIMATION_DURATION_MS: f32 = 700.0;

/// Sortie automatique : la même courbe que l'entrée, jouée à rebours et plus vite. Sans elle, la
/// fin de l'annotation est une coupe sèche alors que son arrivée est animée.
pub const TEXT_EXIT_DURATION_MS: f32 = 300.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextAnimationState {
    pub opacity: f32,
    pub scale: f32,
    pub translate_x: f32,
    pub translate_y: f32,
    /// Fraction du bloc révélée depuis la gauche (machine à écrire). 1 = tout visible.
    pub reveal: f32,
}

impl TextAnimationState {
    /// L'état « rien à animer » — aussi celui d'une animation inconnue ou absente.
    pub const IDLE: TextAnimationState =
        TextAnimationState { opacity: 1.0, scale: 1.0, translate_x: 0.0, translate_y: 0.0, reveal: 1.0 };
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn ease_out_cubic(v: f32) -> f32 {
    let t = clamp01(v);
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_back(v: f32) -> f32 {
    let t = clamp01(v);
    const C1: f32 = 1.70158;
    const C3: f32 = C1 + 1.0;
    1.0 + C3 * (t - 1.0).powi(3) + C1 * (t - 1.0).powi(2)
}

/// État de l'animation `animation` après `elapsed_ms` depuis le début d'une annotation qui dure
/// `region_ms` au total.
///
/// L'entrée dure `TEXT_ANIMATION_DURATION_MS`, la sortie `TEXT_EXIT_DURATION_MS` et rejoue la même
/// courbe à rebours. Une région plus courte que les deux réunies partage son temps entre elles au
/// prorata : le texte atteint son état plein à la jonction au lieu d'être coupé en pleine entrée.
/// `pulse` est une emphase, pas une entrée : il n'a pas de sortie.
pub fn text_animation_state(
    animation: Option<&str>,
    elapsed_ms: f32,
    region_ms: f32,
) -> TextAnimationState {
    let name = animation.unwrap_or("none");
    if name == "none" {
        return TextAnimationState::IDLE;
    }
    let region_ms = region_ms.max(0.0);
    let ramp = |t: f32, len: f32| if len > 0.0 { clamp01(t / len) } else { 1.0 };
    let progress = if name == "pulse" {
        // Pas de sortie à qui céder du temps : le pulse garde sa durée pleine, comme avant.
        ramp(elapsed_ms.max(0.0), TEXT_ANIMATION_DURATION_MS)
    } else {
        let share = (region_ms / (TEXT_ANIMATION_DURATION_MS + TEXT_EXIT_DURATION_MS)).min(1.0);
        let enter = ramp(elapsed_ms.max(0.0), TEXT_ANIMATION_DURATION_MS * share);
        let exit = ramp(region_ms - elapsed_ms, TEXT_EXIT_DURATION_MS * share);
        // Les deux rampes valent 1 à la jonction : prendre la plus petite suffit à les enchaîner.
        enter.min(exit)
    };
    let eased = ease_out_cubic(progress);
    match name {
        "fade" => TextAnimationState { opacity: eased, ..TextAnimationState::IDLE },
        "rise" => TextAnimationState {
            opacity: eased,
            translate_y: (1.0 - eased) * 18.0,
            ..TextAnimationState::IDLE
        },
        "pop" => TextAnimationState {
            opacity: eased,
            scale: ease_out_back(progress).max(0.72),
            ..TextAnimationState::IDLE
        },
        "slide-left" => TextAnimationState {
            opacity: eased,
            translate_x: (1.0 - eased) * -28.0,
            ..TextAnimationState::IDLE
        },
        "typewriter" => TextAnimationState { reveal: progress, ..TextAnimationState::IDLE },
        "pulse" => TextAnimationState {
            scale: 1.0 + (progress * std::f32::consts::PI).sin() * 0.06,
            ..TextAnimationState::IDLE
        },
        // Un nom inconnu (projet plus récent que ce binaire) montre le texte tel quel plutôt que
        // de le faire disparaître.
        _ => TextAnimationState::IDLE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une région assez longue pour que ni l'entrée ni la sortie ne soient raccourcies.
    const LONG: f32 = 10_000.0;

    #[test]
    fn no_animation_shows_the_text_as_is() {
        for at in [0.0, 350.0, 5000.0] {
            assert_eq!(text_animation_state(None, at, LONG), TextAnimationState::IDLE);
            assert_eq!(text_animation_state(Some("none"), at, LONG), TextAnimationState::IDLE);
        }
    }

    #[test]
    fn an_unknown_name_shows_the_text_rather_than_hiding_it() {
        // Le pire comportement serait une opacité 0 : l'annotation disparaîtrait sans explication.
        assert_eq!(text_animation_state(Some("kenburns"), 0.0, LONG), TextAnimationState::IDLE);
    }

    #[test]
    fn every_animation_settles_on_the_plain_text() {
        // Propriété qui compte le plus : passée la durée, aucune animation ne laisse de trace.
        for name in ["fade", "rise", "pop", "slide-left", "typewriter", "pulse"] {
            let end = text_animation_state(Some(name), TEXT_ANIMATION_DURATION_MS + 1.0, LONG);
            assert!((end.opacity - 1.0).abs() < 1e-3, "{name} : opacité {}", end.opacity);
            assert!((end.scale - 1.0).abs() < 1e-3, "{name} : échelle {}", end.scale);
            assert!(end.translate_x.abs() < 1e-3 && end.translate_y.abs() < 1e-3, "{name} : décalé");
            assert!((end.reveal - 1.0).abs() < 1e-3, "{name} : révélation {}", end.reveal);
        }
    }

    #[test]
    fn fade_and_rise_start_invisible_and_below() {
        let fade = text_animation_state(Some("fade"), 0.0, LONG);
        assert_eq!(fade.opacity, 0.0);
        let rise = text_animation_state(Some("rise"), 0.0, LONG);
        assert_eq!(rise.opacity, 0.0);
        assert!((rise.translate_y - 18.0).abs() < 1e-3, "part de 18px plus bas");
    }

    #[test]
    fn slide_left_enters_from_the_right() {
        // Signe négatif = le texte commence décalé vers la gauche et revient, comme le TS.
        let s = text_animation_state(Some("slide-left"), 0.0, LONG);
        assert!((s.translate_x + 28.0).abs() < 1e-3, "translate_x = {}", s.translate_x);
    }

    #[test]
    fn pop_overshoots_then_comes_back() {
        // easeOutBack dépasse 1 avant de retomber : c'est ce qui donne le « pop ».
        let mid = (0..=100)
            .map(|i| text_animation_state(Some("pop"), i as f32 * 7.0, LONG).scale)
            .fold(0.0f32, f32::max);
        assert!(mid > 1.0, "aucun dépassement : échelle max {mid}");
        assert!(text_animation_state(Some("pop"), 0.0, LONG).scale >= 0.72, "plancher du TS respecté");
    }

    #[test]
    fn pulse_swells_in_the_middle_and_never_moves() {
        let mid = text_animation_state(Some("pulse"), TEXT_ANIMATION_DURATION_MS * 0.5, LONG);
        assert!((mid.scale - 1.06).abs() < 1e-3, "échelle {}", mid.scale);
        assert_eq!(mid.opacity, 1.0);
        assert_eq!(mid.translate_x, 0.0);
    }

    #[test]
    fn typewriter_reveals_linearly_and_only_from_the_left() {
        for (at, expected) in [(0.0, 0.0), (175.0, 0.25), (350.0, 0.5), (700.0, 1.0)] {
            let s = text_animation_state(Some("typewriter"), at, LONG);
            assert!((s.reveal - expected).abs() < 1e-3, "à {at}ms : {}", s.reveal);
            // Le texte reste opaque : c'est la largeur qui se dévoile, pas l'alpha (l'aperçu DOM
            // faisait exactement ça avec un `inset()`).
            assert_eq!(s.opacity, 1.0);
        }
    }

    #[test]
    fn a_negative_elapsed_time_is_the_start_not_the_end() {
        // Peut arriver d'une frame calculée juste avant le début de l'annotation.
        assert_eq!(text_animation_state(Some("fade"), -50.0, LONG).opacity, 0.0);
    }

    #[test]
    fn every_entrance_leaves_the_way_it_came() {
        // La sortie rejoue l'entrée à rebours : en fin de région, on retrouve l'état initial.
        for name in ["fade", "rise", "pop", "slide-left", "typewriter"] {
            let start = text_animation_state(Some(name), 0.0, LONG);
            let end = text_animation_state(Some(name), LONG, LONG);
            assert_eq!(start, end, "{name}");
            // Et à mi-sortie, on retrouve l'entrée au même avancement.
            let half_exit =
                text_animation_state(Some(name), LONG - TEXT_EXIT_DURATION_MS * 0.5, LONG);
            let half_enter =
                text_animation_state(Some(name), TEXT_ANIMATION_DURATION_MS * 0.5, LONG);
            assert_eq!(half_exit, half_enter, "{name}");
        }
    }

    #[test]
    fn the_exit_only_starts_in_the_last_300ms() {
        let before = text_animation_state(Some("fade"), LONG - TEXT_EXIT_DURATION_MS, LONG);
        assert_eq!(before, TextAnimationState::IDLE);
        let during = text_animation_state(Some("fade"), LONG - 100.0, LONG);
        assert!(during.opacity > 0.0 && during.opacity < 1.0, "opacité {}", during.opacity);
    }

    #[test]
    fn a_short_region_splits_its_time_between_entrance_and_exit() {
        // 500 ms < 700 + 300 : entrée 350 ms, sortie 150 ms, texte plein à la jonction.
        // Avant, la région s'arrêtait aux 5/7 de l'entrée : jamais pleinement visible.
        let region = 500.0;
        let at_join = text_animation_state(Some("fade"), 350.0, region);
        assert!((at_join.opacity - 1.0).abs() < 1e-3, "opacité {}", at_join.opacity);
        let rising = text_animation_state(Some("fade"), 175.0, region);
        let falling = text_animation_state(Some("fade"), 425.0, region);
        assert!((rising.opacity - falling.opacity).abs() < 1e-3, "{rising:?} / {falling:?}");
        assert_eq!(text_animation_state(Some("fade"), region, region).opacity, 0.0);
    }

    #[test]
    fn pulse_has_no_exit() {
        let s = text_animation_state(Some("pulse"), LONG - 10.0, LONG);
        assert_eq!(s, TextAnimationState::IDLE);
    }

    #[test]
    fn a_short_region_does_not_speed_up_pulse() {
        // Sans sortie, rien à partager : dans 500 ms, le pulse culmine toujours à 350 ms
        // (mi-course de ses 700 ms) au lieu de s'achever là.
        let mid = text_animation_state(Some("pulse"), TEXT_ANIMATION_DURATION_MS * 0.5, 500.0);
        assert!((mid.scale - 1.06).abs() < 1e-3, "échelle {}", mid.scale);
    }

    #[test]
    fn an_empty_region_does_not_divide_by_zero() {
        assert!(text_animation_state(Some("fade"), 0.0, 0.0).opacity.is_finite());
    }
}
