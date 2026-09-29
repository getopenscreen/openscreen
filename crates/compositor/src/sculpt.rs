//! Curseurs sculptés : la flèche et la main des cinq thèmes d'origine, modelées en volumes dans les
//! shaders (mode 15, `sculpt_proto`) au lieu d'extruder leur PNG — capsules et unions lissées,
//! extrusions arrondies, voxels, polyèdres taillés, pièces cerclées du trait de leur dessin (Star
//! Sprout). Ce module en tient ce que la géométrie doit savoir côté CPU : l'identifiant que lit le
//! shader, et la boîte du modèle (`SpriteShape`) qui pose le hotspot, règle la garde au sol et
//! borne la boîte de dessin.
//!
//! Les formes sont écrites dans le repère du PROTOTYPE où elles ont été dessinées : hauteur du
//! curseur 1, x à droite, y VERS LE HAUT, z vers la caméra, l'écran en z = 0. Les constantes
//! ci-dessous sont le miroir des `SCULPT_*` des trois shaders.
//!
//! Deux thèmes sont des tables que des scripts écrivent dans les trois shaders : les grilles de
//! voxels de Pixel Candy (`scripts/generate-pixel-candy-voxels.mjs`) et les plans taillés de Prism
//! Glow (`scripts/generate-prism-glow-gem.mjs`). On change le modèle dans le script, on le relance,
//! et on ajuste ici la boîte si la forme a bougé.

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
/// Le côté d'un voxel de Pixel Candy.
const VOX: f32 = 0.07;
/// Le plus haut : les yeux de l'étoile de Star Sprout, sur la flèche comme sur la manchette.
const Z_HIGH_ARROW: f32 = 0.31;
const Z_HIGH_HAND: f32 = 0.4;
/// Boîtes des modèles dans le prototype (x0, x1, haut). Leur hauteur est celle du sprite,
/// 1 / SCULPT_SCALE : le mode 15 tient le plus grand côté de la boîte pour 1 (`sprite_size`).
/// Celles du cristal, dont le pouce déborde ; des voxels, que leur anneau violet élargit d'une
/// cellule ; puis des thèmes cerclés, que leur trait élargit et que débordent l'étoile et les
/// feuilles (Star Sprout), les tirets du clic et le calque jaune (Pop Coral), le pouce.
const BOX_GEM_ARROW: [f32; 3] = [-0.1, 0.75, 0.09];
const BOX_GEM_HAND: [f32; 3] = [-0.39, 0.61, 0.03];
const BOX_PIXEL_ARROW: [f32; 3] = [-0.1, 0.6, 0.09];
const BOX_PIXEL_HAND: [f32; 3] = [-0.38, 0.73, 0.09];
const BOX_INK_ARROW: [f32; 3] = [-0.08, 0.6, 0.03];
const BOX_INK_HAND: [f32; 3] = [-0.36, 0.6, 0.03];
const BOX_CORAL_ARROW: [f32; 3] = [-0.35, 0.6, 0.06];
const BOX_CORAL_HAND: [f32; 3] = [-0.34, 0.62, 0.04];
const BOX_SPROUT_ARROW: [f32; 3] = [-0.08, 0.87, 0.03];
const BOX_SPROUT_HAND: [f32; 3] = [-0.33, 0.56, 0.03];

/// Dans l'ordre des identifiants du shader.
const THEMES: [&str; 5] = ["studio-ink", "prism-glow", "pop-coral", "pixel-candy", "star-sprout"];

/// Le haut de la silhouette (y du prototype) : l'anneau violet des voxels dépasse la pointe
/// d'une cellule, le sommet de la table taillée de la flèche dépasse le hotspot de 0,03, le bout
/// de l'index y est ; les thèmes cerclés tiennent leur hotspot au bord de leur trait, comme leur
/// PNG.
fn silhouette_top(theme: usize, arrow: bool) -> f32 {
    match (THEMES[theme], arrow) {
        ("pixel-candy", _) => VOX,
        ("studio-ink" | "pop-coral" | "star-sprout", _) => 0.0,
        (_, true) => 0.03,
        (_, false) => 0.0,
    }
}

/// La boîte du modèle (x0, x1, haut) dans le prototype.
fn model_box(theme: usize, arrow: bool) -> [f32; 3] {
    match (THEMES[theme], arrow) {
        ("studio-ink", true) => BOX_INK_ARROW,
        ("studio-ink", false) => BOX_INK_HAND,
        ("prism-glow", true) => BOX_GEM_ARROW,
        ("prism-glow", false) => BOX_GEM_HAND,
        ("pop-coral", true) => BOX_CORAL_ARROW,
        ("pop-coral", false) => BOX_CORAL_HAND,
        ("pixel-candy", true) => BOX_PIXEL_ARROW,
        ("pixel-candy", false) => BOX_PIXEL_HAND,
        ("star-sprout", true) => BOX_SPROUT_ARROW,
        ("star-sprout", false) => BOX_SPROUT_HAND,
        (other, _) => unreachable!("thème sculpté inconnu : {other}"),
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
    let [x0, x1, y1] = model_box(theme, arrow);
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
                ("SCULPT_VOX", VOX),
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

    /// Les plans taillés de Prism Glow, que `scripts/generate-prism-glow-gem.mjs` écrit dans les
    /// trois shaders, y sont les mêmes ; chaque pièce a ses plans et leurs normales sont unitaires.
    #[test]
    fn the_gem_tables_match_in_the_three_shaders() {
        let tables = [
            include_str!("shaders.hlsl"),
            include_str!("shaders.metal"),
            include_str!("vk_shaders/layer.wgsl"),
        ]
        .map(|src| {
            let a = src.find("// <prism-glow-gem>").expect("marqueur d'ouverture");
            let b = src.find("// </prism-glow-gem>").expect("marqueur de fermeture");
            let block = &src[a..b];
            let decimals: Vec<f32> = block
                .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                .filter(|t| t.contains('.'))
                .map(|t| t.parse().unwrap())
                .collect();
            let line = block.lines().find(|l| l.contains("GEM_PIECE")).unwrap();
            let list = &line[line.rfind(['(', '{']).unwrap() + 1..];
            let starts: Vec<usize> = list
                .split(|c: char| !c.is_ascii_digit())
                .filter(|t| !t.is_empty())
                .map(|t| t.parse().unwrap())
                .collect();
            (decimals, starts)
        });
        let (decimals, starts) = &tables[0];
        assert!(tables.iter().all(|t| t == &tables[0]), "tables différentes d'un shader à l'autre");
        assert_eq!(starts.len(), 9, "2 pièces de flèche, 6 de main");
        assert!(starts.windows(2).all(|w| w[1] >= w[0] + 4), "une pièce sans volume");
        let planes = starts[8];
        assert_eq!(decimals.len(), planes * 4 + 4 * 3, "plans puis boîtes");
        for p in decimals[..planes * 4].chunks(4) {
            let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            assert!((len - 1.0).abs() < 1e-3, "normale non unitaire : {p:?}");
        }
    }

    /// Les nombres de la table `name` d'un shader, du `=` à la fin de la liste, constructeurs de
    /// vecteurs retirés : la même table s'écrit alors pareil dans les trois langages.
    fn table(src: &str, name: &str) -> Vec<f32> {
        // La déclaration : `NAME =` en WGSL, `NAME[taille]` en HLSL et en Metal (pas un `NAME[i]` du code).
        let decl = format!("{name}[");
        let sized = |&i: &usize| src[i + decl.len()..].starts_with(|c: char| c.is_ascii_digit());
        let at = src.find(&format!("{name} =")).or_else(|| src.match_indices(&decl).map(|(i, _)| i).find(sized));
        let rest = &src[at.expect(name)..];
        let rest = &rest[rest.find('=').unwrap()..];
        let open = rest.find(['(', '{']).unwrap() + 1;
        let close = [rest.find(");"), rest.find("};")].into_iter().flatten().min().unwrap();
        let mut list = rest[open..close].to_string();
        for ty in ["vec2<f32>", "vec4<f32>", "vec4<i32>", "float2", "float4", "int4"] {
            list = list.replace(ty, "");
        }
        list.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .filter(|t| !t.is_empty())
            .map(|t| t.parse().unwrap_or_else(|_| panic!("{name} : nombre illisible {t}")))
            .collect()
    }

    /// Les grilles de Pixel Candy, que `scripts/generate-pixel-candy-voxels.mjs` écrit dans les
    /// trois shaders, y sont les mêmes ; le menthe est sur la face, l'anneau autour d'elle.
    #[test]
    fn the_voxel_tables_match_in_the_three_shaders() {
        let hlsl = include_str!("shaders.hlsl");
        let metal = include_str!("shaders.metal");
        let wgsl = include_str!("vk_shaders/layer.wgsl");
        let names = ["PIX_BODY", "PIX_MINT", "PIX_RING", "PIX_RECT_N", "PIX_GRID", "PIX_ORIGIN", "PIX_BOX", "PIX_RECT"];
        for name in names {
            let reference = table(wgsl, name);
            assert!(!reference.is_empty(), "{name} vide");
            assert_eq!(table(hlsl, name), reference, "{name} : HLSL et WGSL diffèrent");
            assert_eq!(table(metal, name), reference, "{name} : Metal et WGSL diffèrent");
        }
        let body = table(wgsl, "PIX_BODY");
        let mint = table(wgsl, "PIX_MINT");
        let ring = table(wgsl, "PIX_RING");
        for g in table(wgsl, "PIX_GRID").chunks(4) {
            let [_, rows, b, w] = [g[0], g[1], g[2], g[3]].map(|v| v as usize);
            for r in 0..rows {
                let (face, green) = (body[b + r] as u32, mint[b + r] as u32);
                assert_eq!(green & !face, 0, "menthe hors de la face, ligne {r}");
                assert_eq!((ring[w + r + 1] as u32 >> 1) & face, 0, "anneau sur la face, ligne {r}");
            }
        }
    }
}
