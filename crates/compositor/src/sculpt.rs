//! Curseurs sculptés : la flèche et la main des thèmes d'origine, modelées en volumes dans les
//! shaders (mode 15, `sculpt_proto`) au lieu d'extruder leur PNG — voxels (Pixel Candy), pièces
//! cerclées du trait de leur dessin (Studio Ink, Pop Coral, Star Sprout). Prism Glow est à part :
//! un MAILLAGE tracé sur son dessin à facettes, un cristal lancé de rayons boîte par boîte
//! dans son serti marine (`prism_mesh`). Ce module en tient ce que la géométrie doit savoir côté
//! CPU : l'identifiant que lit le shader, et la boîte du modèle (`SpriteShape`) qui pose le
//! hotspot, règle la garde au sol et borne la boîte de dessin.
//!
//! Les formes sont écrites dans le repère du PROTOTYPE où elles ont été dessinées : hauteur du
//! curseur 1, x à droite, y VERS LE HAUT, z vers la caméra, l'écran en z = 0. Les constantes
//! ci-dessous sont le miroir des `SCULPT_*` des trois shaders.
//!
//! Les grilles de voxels de Pixel Candy sont des tables que
//! `scripts/generate-pixel-candy-voxels.mjs` écrit dans les trois shaders : on change la grille
//! dans le script, on le relance, et on ajuste ici la boîte si la forme a bougé.

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
/// Le côté d'un cube de Pixel Candy : seize lignes font un curseur haut de 1.
const VOX: f32 = 0.0625;
/// Le plus haut : les yeux de l'étoile de Star Sprout, sur la flèche comme sur la manchette.
const Z_HIGH_ARROW: f32 = 0.31;
const Z_HIGH_HAND: f32 = 0.4;
/// Boîtes des modèles dans le prototype (x0, x1, haut). Leur hauteur est celle du sprite,
/// 1 / SCULPT_SCALE : le mode 15 tient le plus grand côté de la boîte pour 1 (`sprite_size`).
/// Celles des cubes de Pixel Candy ; puis des thèmes cerclés, que leur trait élargit et que
/// débordent l'étoile et les feuilles (Star Sprout), les tirets du clic et les calques (Pop
/// Coral), le pouce.
const BOX_PIXEL_ARROW: [f32; 3] = [-0.03, 0.72, 0.03];
const BOX_PIXEL_HAND: [f32; 3] = [-0.345, 0.72, 0.03];
const BOX_INK_ARROW: [f32; 3] = [-0.08, 0.6, 0.03];
const BOX_INK_HAND: [f32; 3] = [-0.36, 0.6, 0.03];
const BOX_CORAL_ARROW: [f32; 3] = [-0.35, 0.6, 0.06];
const BOX_CORAL_HAND: [f32; 3] = [-0.38, 0.62, 0.04];
const BOX_SPROUT_ARROW: [f32; 3] = [-0.08, 0.87, 0.03];
const BOX_SPROUT_HAND: [f32; 3] = [-0.33, 0.56, 0.03];

/// Dans l'ordre des identifiants du shader.
const THEMES: [&str; 5] = ["studio-ink", "prism-glow", "pop-coral", "pixel-candy", "star-sprout"];

/// La boîte du modèle (x0, x1, haut) dans le prototype.
fn model_box(theme: usize, arrow: bool) -> [f32; 3] {
    match (THEMES[theme], arrow) {
        ("studio-ink", true) => BOX_INK_ARROW,
        ("studio-ink", false) => BOX_INK_HAND,
        ("pop-coral", true) => BOX_CORAL_ARROW,
        ("pop-coral", false) => BOX_CORAL_HAND,
        ("pixel-candy", true) => BOX_PIXEL_ARROW,
        ("pixel-candy", false) => BOX_PIXEL_HAND,
        ("star-sprout", true) => BOX_SPROUT_ARROW,
        ("star-sprout", false) => BOX_SPROUT_HAND,
        (other, _) => unreachable!("thème sculpté inconnu : {other}"),
    }
}

/// Le curseur sculpté que nomme la scène est de verre (Prism Glow) : il réfracte ce qui est dessous.
pub fn refracts(name: &str) -> bool {
    sculpted_shape(name).is_some_and(|s| THEMES[((s.sculpt - 1) / 2) as usize] == "prism-glow")
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
    let sculpt = 1 + 2 * theme as u32 + u32::from(!arrow);
    if THEMES[theme] == "prism-glow" {
        // Le maillage est déjà dans le repère du modèle : sa boîte, son dessus et son dessous.
        let m = &crate::prism_mesh::MODELS[usize::from(!arrow)];
        return Some(SpriteShape {
            size: m.size,
            hotspot: m.hotspot,
            top: m.top,
            max_height: m.height,
            thick: m.thick,
            sculpt,
        });
    }
    let [x0, x1, y1] = model_box(theme, arrow);
    let (zref, z_high) = if arrow { (ZREF_ARROW, Z_HIGH_ARROW) } else { (ZREF_HAND, Z_HIGH_HAND) };
    let s = SCULPT_SCALE;
    // Repère du modèle : y vers le bas, le coin haut-gauche de la boîte est donc (x0, y1).
    let size = [(x1 - x0) * s, 1.0];
    Some(SpriteShape {
        size,
        hotspot: [-x0 * s / size[0], y1 * s],
        top: y1 * s,
        max_height: (z_high - zref) * s,
        thick: (zref - Z_LOW) * s,
        sculpt,
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
        for name in ["default/arrow", "pop-coral/text", "pop-coral", "", "pop-coral/arrow/x", "prism-glow/text"] {
            assert!(sculpted_shape(name).is_none(), "{name}");
        }
    }

    /// Le hotspot est dans la boîte, sous le haut de la silhouette ; le modèle a une épaisseur et
    /// une hauteur ; la boîte a la hauteur du sprite, son plus grand côté, comme le veut le mode 15.
    /// Le serti de Prism Glow est le plus mince (0,043) : c'est son épaisseur dans le dessin.
    #[test]
    fn the_box_holds_the_hotspot_and_the_silhouette_top() {
        for name in NAMES {
            let s = sculpted_shape(name).unwrap();
            assert!((0.0..1.0).contains(&s.hotspot[0]) && (0.0..1.0).contains(&s.hotspot[1]), "{name}");
            assert!(s.top <= s.hotspot[1] + 1e-6, "{name} : haut de silhouette sous le hotspot");
            assert!(s.thick > 0.04 && s.max_height > 0.0, "{name}");
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
                ("PRISM_BEVEL", crate::prism_mesh::BEVEL),
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
        for ty in ["vec2<f32>", "vec3<f32>", "vec4<f32>", "vec4<i32>", "float2", "float3", "float4", "int4"] {
            list = list.replace(ty, "");
        }
        list.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .filter(|t| !t.is_empty())
            .map(|t| t.parse().unwrap_or_else(|_| panic!("{name} : nombre illisible {t}")))
            .collect()
    }

    /// Les grilles de Pixel Candy, que `scripts/generate-pixel-candy-voxels.mjs` écrit dans les
    /// trois shaders, y sont les mêmes ; chaque pixel coloré est plein, et d'une seule couleur.
    #[test]
    fn the_voxel_tables_match_in_the_three_shaders() {
        let hlsl = include_str!("shaders.hlsl");
        let metal = include_str!("shaders.metal");
        let wgsl = include_str!("vk_shaders/layer.wgsl");
        let names = ["PIX_BODY", "PIX_LINE", "PIX_HI", "PIX_SHADE", "PIX_RECT_N", "PIX_GRID", "PIX_ORIGIN", "PIX_BOX", "PIX_RECT"];
        for name in names {
            let reference = table(wgsl, name);
            assert!(!reference.is_empty(), "{name} vide");
            assert_eq!(table(hlsl, name), reference, "{name} : HLSL et WGSL diffèrent");
            assert_eq!(table(metal, name), reference, "{name} : Metal et WGSL diffèrent");
        }
        let body = table(wgsl, "PIX_BODY");
        let classes = ["PIX_LINE", "PIX_HI", "PIX_SHADE"].map(|name| table(wgsl, name));
        for (i, &face) in body.iter().enumerate() {
            let mut seen = 0u32;
            for class in &classes {
                let m = class[i] as u32;
                assert_eq!(m & !(face as u32), 0, "couleur hors de la forme, ligne {i}");
                assert_eq!(m & seen, 0, "deux couleurs sur un pixel, ligne {i}");
                seen |= m;
            }
        }
    }

    /// Seul Prism Glow est de verre, flèche et main.
    #[test]
    fn only_prism_glow_refracts() {
        for name in NAMES {
            assert_eq!(refracts(name), name.starts_with("prism-glow/"), "{name}");
        }
        assert!(!refracts("prism-glow/text"));
    }

    /// Le maillage de Prism Glow tient dans sa boîte (le shader n'y lance de rayons que là), son
    /// dessous est à l'épaisseur annoncée (la garde au sol en dépend) et son sommet à la hauteur.
    #[test]
    fn the_prism_boxes_hold_their_mesh() {
        use crate::prism_mesh::{MODELS, POLYS, TRIS};
        for (k, name) in ["prism-glow/arrow", "prism-glow/pointer"].iter().enumerate() {
            let s = sculpted_shape(name).unwrap();
            let m = &MODELS[k];
            let [x0, y0] = [-s.hotspot[0] * s.size[0], -s.hotspot[1] * s.size[1]];
            let inside = |x: f32, y: f32| x >= x0 && x <= x0 + s.size[0] && y >= y0 && y <= y0 + s.size[1];
            let (mut zlo, mut zhi) = (f32::MAX, f32::MIN);
            for t in TRIS[4 * m.tri_start..4 * (m.tri_start + m.tri_count)].chunks(4) {
                for e in [[0.0; 3], [t[1][0], t[1][1], t[1][2]], [t[2][0], t[2][1], t[2][2]]] {
                    let [x, y, z] = [t[0][0] + e[0], t[0][1] + e[1], t[0][2] + e[2]];
                    assert!(inside(x, y), "{name} : sommet ({x}, {y}) hors de la boîte");
                    zlo = zlo.min(z);
                    zhi = zhi.max(z);
                }
            }
            let sil = &POLYS[m.sil_start..m.sil_start + m.sil_count];
            let out = &POLYS[m.out_start..m.out_start + m.out_count];
            for p in sil.iter().chain(out) {
                assert!(inside(p[0], p[1]), "{name} : contour ({}, {}) hors de la boîte", p[0], p[1]);
            }
            assert!((zlo + s.thick).abs() < 1e-5, "{name} : dessous {zlo}, épaisseur {}", s.thick);
            assert!((zhi - s.max_height).abs() < 1e-5, "{name} : sommet {zhi}, hauteur {}", s.max_height);
        }
    }

    /// Les trois shaders portent le maillage de `prism_mesh.rs` tel quel : triangles, boîtes,
    /// polygones, et les débuts et longueurs de chaque modèle dans ces tables. Le WGSL lit
    /// triangles, polygones et boîtes dans un uniform rempli de `prism_mesh.rs`
    /// (`compositor_linux.rs`) : il n'en déclare que la taille.
    #[test]
    fn the_shaders_carry_the_prism_mesh() {
        use crate::prism_mesh::{PrismModel, BOXES, MODELS, POLYS, TRIS};
        let per_model = |f: fn(&PrismModel) -> usize| MODELS.iter().map(|m| f(m) as f32).collect::<Vec<f32>>();
        let want: [(&str, Vec<f32>); 11] = [
            ("PRISM_TRIS", TRIS.iter().flatten().copied().collect()),
            ("PRISM_POLY", POLYS.iter().flatten().copied().collect()),
            ("PRISM_BOXES", BOXES.iter().flatten().copied().collect()),
            ("PRISM_BOX_START", per_model(|m| m.box_start)),
            ("PRISM_BOX_COUNT", per_model(|m| m.box_count)),
            ("PRISM_TRI_START", per_model(|m| m.tri_start)),
            ("PRISM_TRI_COUNT", per_model(|m| m.tri_count)),
            ("PRISM_SIL_START", per_model(|m| m.sil_start)),
            ("PRISM_SIL_COUNT", per_model(|m| m.sil_count)),
            ("PRISM_OUT_START", per_model(|m| m.out_start)),
            ("PRISM_OUT_COUNT", per_model(|m| m.out_count)),
        ];
        let wgsl = include_str!("vk_shaders/layer.wgsl");
        for field in [
            format!("tris: array<vec4<f32>, {}>", TRIS.len()),
            format!("poly: array<vec4<f32>, {}>", POLYS.len()),
            format!("boxes: array<vec4<f32>, {}>", BOXES.len()),
        ] {
            assert!(wgsl.contains(&field), "vk_shaders/layer.wgsl : `{field}` attendu dans PrismMesh");
        }
        for (file, src, tables) in [
            ("shaders.hlsl", include_str!("shaders.hlsl"), &want[..]),
            ("shaders.metal", include_str!("shaders.metal"), &want[..]),
            ("vk_shaders/layer.wgsl", wgsl, &want[3..]),
        ] {
            for (name, values) in tables {
                let got = table(src, name);
                assert_eq!(got.len(), values.len(), "{file} : {name}, nombre de valeurs");
                for (i, (g, w)) in got.iter().zip(values).enumerate() {
                    assert!((g - w).abs() <= 1e-6 + 1e-6 * w.abs(), "{file} : {name}[{i}] = {g} au lieu de {w}");
                }
            }
        }
    }

    /// Chaque triangle du cristal est dans une boîte et une seule, qui le contient : le shader ne
    /// teste les triangles d'une boîte que si le rayon la touche, un triangle hors de sa boîte
    /// disparaîtrait par endroits.
    #[test]
    fn each_crystal_triangle_sits_in_its_box() {
        use crate::prism_mesh::{BOXES, MODELS, TRIS};
        for (k, m) in MODELS.iter().enumerate() {
            let mut next = m.tri_start;
            for b in m.box_start..m.box_start + m.box_count {
                let (lo, hi) = (BOXES[2 * b], BOXES[2 * b + 1]);
                let (first, count) = (lo[3] as usize, hi[3] as usize);
                assert_eq!(first, next, "modèle {k}, boîte {b} : triangles non contigus");
                next += count;
                for t in TRIS[4 * first..4 * (first + count)].chunks(4) {
                    for e in [[0.0; 3], [t[1][0], t[1][1], t[1][2]], [t[2][0], t[2][1], t[2][2]]] {
                        let v = [t[0][0] + e[0], t[0][1] + e[1], t[0][2] + e[2]];
                        assert!((0..3).all(|a| v[a] >= lo[a] && v[a] <= hi[a]), "modèle {k}, boîte {b} : sommet {v:?} dehors");
                    }
                }
            }
            assert_eq!(next, m.tri_start + m.tri_count, "modèle {k} : triangles hors des boîtes");
        }
    }
}
