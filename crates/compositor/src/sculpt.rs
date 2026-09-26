//! Curseurs sculptés : la flèche et la main des cinq thèmes d'origine, modelées en volumes dans les
//! shaders (mode 15, `sculpt_proto`) au lieu d'extruder leur PNG — capsules et unions lissées,
//! extrusions arrondies, voxels, polyèdres taillés. Ce module en tient ce que la géométrie doit
//! savoir côté CPU : l'identifiant que lit le shader, et la boîte du modèle (`SpriteShape`) qui pose
//! le hotspot, règle la garde au sol et borne la boîte de dessin.
//!
//! Les formes sont écrites dans le repère du PROTOTYPE où elles ont été dessinées : hauteur du
//! curseur 1, x à droite, y VERS LE HAUT, z vers la caméra, l'écran en z = 0. Les constantes
//! ci-dessous sont le miroir des `SCULPT_*` des trois shaders.
//!
//! Les voxels de la flèche de Pixel Candy (`SCULPT_ARROWPIX`, `SCULPT_ARROWBACK`) sont son polygone
//! échantillonné : une cellule de 1/16 porte un voxel quand son centre est à plus de 0,01 dedans, un
//! bloc de la couche violette quand il est à moins de 0,9 cellule. Changer le polygone, c'est
//! régénérer ces deux tables.

use crate::frame_geometry::SpriteShape;

/// Unités du sprite par unité du prototype : un curseur sculpté (~1,03 de haut) a alors la taille
/// de la flèche plate des thèmes, qui occupe 87,5 % de son sprite.
pub const SCULPT_SCALE: f32 = 0.85;
/// Hauteur, dans le prototype, du z = 0 du modèle (le hotspot) : le dessus de la pointe de la
/// flèche, l'axe du bout de l'index.
const ZREF_ARROW: f32 = 0.2;
const ZREF_HAND: f32 = 0.185;
/// Le dessous de tous les modèles, dans le prototype.
const Z_LOW: f32 = 0.05;
/// Le plus haut : la table de la flèche taillée, l'étoile de Star Sprout sur la manchette.
const Z_HIGH_ARROW: f32 = 0.29;
const Z_HIGH_HAND: f32 = 0.4;
/// Boîtes des deux formes dans le prototype (x0, x1, haut), qui contiennent leurs cinq variantes :
/// couche violette des voxels, étoile, cristal compris. Leur hauteur est celle du sprite, 1 / SCULPT_SCALE :
/// le mode 15 tient le plus grand côté de la boîte pour 1 (`sprite_size`).
const BOX_ARROW: [f32; 3] = [-0.1, 0.75, 0.09];
const BOX_HAND: [f32; 3] = [-0.27, 0.73, 0.07];

/// Dans l'ordre des identifiants du shader.
const THEMES: [&str; 5] = ["studio-ink", "prism-glow", "pop-coral", "pixel-candy", "star-sprout"];

/// Le haut de la silhouette (y du prototype) : la couche violette des voxels dépasse la pointe
/// d'une cellule, la pointe arrondie de la flèche et le sommet de sa table taillée dépassent le
/// hotspot de 0,03, le bout de l'index y est.
fn silhouette_top(theme: usize, arrow: bool) -> f32 {
    match (THEMES[theme], arrow) {
        ("pixel-candy", _) => 0.0625,
        (_, true) => 0.03,
        (_, false) => 0.0,
    }
}

/// Le curseur sculpté que nomme la scène (`"<thème>/<état>"`, cf. `resolveCursorSprites`), sous
/// la forme que le mode 15 attend. `None` pour un nom inconnu : l'appelant extrude le sprite.
pub fn sculpted_shape(name: &str) -> Option<SpriteShape> {
    let (theme, state) = name.split_once('/')?;
    let theme = THEMES.iter().position(|t| *t == theme)?;
    let arrow = match state {
        "arrow" => true,
        "pointer" => false,
        _ => return None,
    };
    let [x0, x1, y1] = if arrow { BOX_ARROW } else { BOX_HAND };
    let (zref, z_high) = if arrow { (ZREF_ARROW, Z_HIGH_ARROW) } else { (ZREF_HAND, Z_HIGH_HAND) };
    let s = SCULPT_SCALE;
    // Repère du modèle : y vers le bas, le coin haut-gauche de la boîte est donc (x0, y1).
    let size = [(x1 - x0) * s, 1.0];
    Some(SpriteShape {
        size,
        hotspot: [-x0 * s / size[0], y1 * s],
        top: (y1 - silhouette_top(theme, arrow)) * s,
        max_height: (z_high - zref) * s,
        thick: (zref - Z_LOW) * s,
        sculpt: 1 + 2 * theme as u32 + u32::from(!arrow),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: [&str; 10] = [
        "studio-ink/arrow",
        "studio-ink/pointer",
        "prism-glow/arrow",
        "prism-glow/pointer",
        "pop-coral/arrow",
        "pop-coral/pointer",
        "pixel-candy/arrow",
        "pixel-candy/pointer",
        "star-sprout/arrow",
        "star-sprout/pointer",
    ];

    #[test]
    fn each_theme_arrow_and_hand_has_its_own_id_in_shader_order() {
        for (k, name) in NAMES.iter().enumerate() {
            let shape = sculpted_shape(name).expect(name);
            assert_eq!(shape.sculpt, k as u32 + 1, "{name}");
        }
    }

    #[test]
    fn other_states_and_themes_keep_the_extruded_sprite() {
        for name in ["default/arrow", "pop-coral/text", "pop-coral", "", "pop-coral/arrow/x"] {
            assert!(sculpted_shape(name).is_none(), "{name}");
        }
    }

    /// Le hotspot est dans la boîte, sous le haut de la silhouette ; le modèle a une épaisseur et
    /// une hauteur ; la boîte a la hauteur du sprite, son plus grand côté, comme le veut le mode 15.
    #[test]
    fn the_box_holds_the_hotspot_and_the_silhouette_top() {
        for name in NAMES {
            let s = sculpted_shape(name).unwrap();
            assert!((0.0..1.0).contains(&s.hotspot[0]) && (0.0..1.0).contains(&s.hotspot[1]), "{name}");
            assert!(s.top <= s.hotspot[1] + 1e-6, "{name} : haut de silhouette sous le hotspot");
            assert!(s.thick > 0.05 && s.max_height > 0.0, "{name}");
            assert!(s.size[0] < 1.0 && s.size[1] == 1.0, "{name} : le plus grand côté n'est pas 1");
        }
    }

    /// Les constantes que ce module et les shaders partagent ne divergent pas.
    #[test]
    fn the_shaders_mirror_the_constants() {
        let shaders = [
            ("shaders.hlsl", include_str!("shaders.hlsl")),
            ("shaders.metal", include_str!("shaders.metal")),
            ("vk_shaders/layer.wgsl", include_str!("vk_shaders/layer.wgsl")),
        ];
        for (file, src) in shaders {
            for (name, value) in [
                ("SCULPT_SCALE", SCULPT_SCALE),
                ("SCULPT_ZREF_ARROW", ZREF_ARROW),
                ("SCULPT_ZREF_HAND", ZREF_HAND),
                ("SCULPT_HOVER", Z_LOW),
            ] {
                let line = src
                    .lines()
                    .find(|l| l.contains(name) && l.contains('='))
                    .unwrap_or_else(|| panic!("{file} : {name} absent"));
                let v: f32 = line
                    .split('=')
                    .nth(1)
                    .and_then(|r| r.trim().trim_end_matches(';').trim().parse().ok())
                    .unwrap_or_else(|| panic!("{file} : {name} illisible : {line}"));
                assert_eq!(v, value, "{file} : {name}");
            }
        }
    }
}
