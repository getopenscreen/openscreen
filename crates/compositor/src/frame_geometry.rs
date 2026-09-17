//! La géométrie de composition, sans backend.
//!
//! Tout ce qui décide OÙ va un calque et de quoi il a l'air — placements de preset,
//! coupe source, cover-fit, rayons, ombres, timeline de la fixture, parsing des
//! couleurs CSS — par opposition à ce qui l'envoie au GPU. Rien ici ne connaît
//! D3D11 ni Metal, et le module est donc compilé sur les deux plateformes
//! (`pub mod frame_geometry;` sans `cfg`, comme `regions.rs` juste à côté).
//!
//! # Pourquoi ce module existe
//!
//! Ce code vivait dans `compositor_windows.rs`. Le port macOS a besoin des mêmes
//! placements au pixel près — c'est la propriété « iso-render » que le projet
//! mesure — et la seule façon de garantir que deux backends s'accordent est qu'ils
//! lisent la même fonction, pas qu'ils entretiennent deux copies qui doivent rester
//! d'accord. C'est le même raisonnement que `timeline_walk.rs`.
//!
//! Effet de bord immédiat : cette géométrie et ses tests, qui n'avaient jamais été
//! exécutés ailleurs que sur Windows, tournent maintenant aussi dans le job macOS.

// Sur macOS, la moitié de ce module est encore sans consommateur : le moteur Metal
// n'a pas de `compose_frame` en couches, donc rien n'appelle encore `screen_source_rect`,
// `cover_uv_rect`, les fractions d'ombre ou `CursorPlacement`. Ce n'est PAS du code mort —
// c'est du code que le port n'a pas encore atteint, et il est exercé par ses tests sur les
// deux plateformes. Le `allow` saute quand le pilotage des couches arrive côté Metal.
#![allow(dead_code)]

use crate::config::Cfg;
use crate::scene::{Scene, SceneCrop};

/// Constant buffer d'un calque : **128 octets**, un par draw.
///
/// C'est le contrat partagé par les trois côtés — `cbuffer Layer` dans `shaders.hlsl`,
/// `struct Layer` dans `shaders.metal`, et ce struct. Les trois doivent s'accorder champ
/// pour champ ET octet pour octet : un décalage ne produit pas d'erreur, il produit un
/// shader qui lit `color` là où on a écrit `fx`.
///
/// `align(16)` vient de la version macOS ; sous `repr(C)` seul, les offsets sont déjà
/// 0/16/32/40/44/48/64/80/96/112 des deux côtés — l'alignement Rust ne change que
/// l'adresse du struct, pas son contenu, et Windows le `copy_nonoverlapping` dans un
/// constant buffer mappé où l'alignement source est sans effet. Les deux formes étaient
/// donc compatibles ; les unifier évite qu'elles cessent de l'être.
///
/// (Le commentaire d'origine annonçait « 64 octets ». Il n'a jamais été juste : dix champs,
/// trente-deux `f32`.)
#[repr(C, align(16))]
#[derive(Clone, Copy, Default)]
pub struct LayerCB {
    pub dst: [f32; 4],
    pub src: [f32; 4],
    pub quad_px: [f32; 2],
    pub radius_px: f32,
    pub mode: f32,
    pub color: [f32; 4],
    pub fx: [f32; 4],
    pub src_prev: [f32; 4],
    pub dst_prev: [f32; 4],
    pub mb: [f32; 4], // mb[0] = nombre de taps de motion blur
}

pub const OUT_W: u32 = 1920;
pub const OUT_H: u32 = 1080;
/// Parse une couleur "#rgb" / "#rrggbb" (sRGB, comme les wallpapers web) → [r,g,b,a] 0..1.
/// Les couleurs plates suivent le même chemin que `bg_color` (pas de linéarisation).
/// Décode une data URL base64 (`data:image/png;base64,AAAA…`) en octets. `None` si ce n'en est
/// pas une — l'appelant retombe alors sur une lecture disque.
///
/// Écrit à la main plutôt qu'avec une dépendance : c'est le seul usage de base64 du projet, et le
/// décodeur tient en quinze lignes vérifiables. Les caractères hors alphabet (retours à la ligne
/// d'un URI replié, `=` de padding) sont ignorés, ce qui rend la fonction tolérante sans être
/// laxiste : un caractère invalide ne peut pas décaler le flux, il est simplement absent.
pub(crate) fn decode_data_uri(uri: &str) -> Option<Vec<u8>> {
    let rest = uri.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    if !rest[..comma].contains("base64") {
        return None;
    }
    let payload = &rest[comma + 1..];
    let sextet = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(payload.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in payload.bytes() {
        let Some(v) = sextet(byte) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
pub(crate) fn parse_hex(s: &str) -> Option<[f32; 4]> {
    // Le contrat accepte du CSS, pas seulement de l'hex : la bridge des captions produit du
    // `rgba(r, g, b, a)` (l'inspector stocke couleur + opacité séparément, et `captionBackgroundCss`
    // les recombine en rgba pour la preview) et les stops de gradient arrivent aussi sous cette
    // forme. `transparent` est un cas particulier documenté : alpha 0, pas de plaque. Tout le
    // reste tombe sur None → l'appelant applique son fallback (alpha 0 pour un fond, alpha 1
    // pour un texte, etc.) — la même sémantique qu'avant l'ajout du parseur rgba.
    let trimmed = s.trim();
    if trimmed.eq_ignore_ascii_case("transparent") {
        return Some([0.0, 0.0, 0.0, 0.0]);
    }
    // CSS Color 4 fait de `rgb()` et `rgba()` des synonymes : les deux acceptent 3 ou 4
    // composantes. On les traite donc par le même chemin plutôt que d'imposer une arité par
    // nom — refuser `rgba(0, 0, 0)` ne « signalerait » rien d'utile, ça retomberait sur le
    // fallback de l'appelant, c'est-à-dire une plaque invisible : exactement le bug #178.
    if let Some(inner) =
        strip_color_fn(trimmed, "rgba").or_else(|| strip_color_fn(trimmed, "rgb"))
    {
        return parse_rgb_components(inner);
    }
    let h = trimmed.trim_start_matches('#');
    // Un corps hex est ASCII par définition, et les découpes par octet ci-dessous (`h[i..=i]`,
    // `h[0..2]`…) paniqueraient au milieu d'un caractère multi-octets qui ferait pile 3 ou 6
    // octets (`éa`, `€€`). On refuse avant de découper.
    if !h.is_ascii() {
        return None;
    }
    let (r, g, b) = match h.len() {
        3 => {
            let d = |i: usize| u8::from_str_radix(&h[i..=i], 16).ok().map(|v| v * 17);
            (d(0)?, d(1)?, d(2)?)
        }
        6 => (
            u8::from_str_radix(&h[0..2], 16).ok()?,
            u8::from_str_radix(&h[2..4], 16).ok()?,
            u8::from_str_radix(&h[4..6], 16).ok()?,
        ),
        _ => return None,
    };
    Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0])
}
/// `rgba(0, 0, 0, 0.55)` → `"0, 0, 0, 0.55"` (le contenu entre les parenthèses), None si
/// l'enveloppe n'est pas de la forme `fn(...)`. Tolère les espaces et les tabs, refuse les
/// virgules finales et les arguments vides — le gradient parser a déjà démontré que la couche
/// application produit des chaînes propres, donc rester strict ici évite d'avaler des CSS
/// tordus qu'on ne maîtrise pas. La casse du préfixe est libre (`RGBA(...)` est valide) parce
/// que CSS le permet.
pub(crate) fn strip_color_fn<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    // `get` rend None si `name.len()` n'est pas une frontière de caractère : c'est ce qui rend
    // le slice `s[..name.len()]` juste en dessous sûr par construction. Un `&s[..n]` direct
    // paniquerait au milieu d'un caractère multi-octets (`#ab€cd` coupe dans le `€`), et une
    // panique traverserait le pont N-API au lieu de retomber sur le fallback de l'appelant —
    // le contraire de ce que ce parseur promet.
    let after_name = s.get(name.len()..)?;
    if !s[..name.len()].eq_ignore_ascii_case(name) {
        return None;
    }
    let inner = after_name.strip_prefix('(')?.strip_suffix(')')?.trim();
    if inner.is_empty() {
        return None;
    }
    Some(inner)
}
/// `"r, g, b"` ou `"r, g, b, a"` (floats 0..255 pour r/g/b, 0..1 pour a) → `[r, g, b, a]` en
/// 0..1, l'alpha valant 1 (opaque) quand elle est absente. Toute autre arité → None. Tolère
/// les espaces autour des virgules, pas les pourcentages : le gradient parser n'envoie pas de
/// `rgb(50%, …)` et les couches UI qui le font n'arrivent pas ici (les couleurs wallpaper
/// passent par une autre route, cf. `parseWallpaper`).
pub(crate) fn parse_rgb_components(s: &str) -> Option<[f32; 4]> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    let (rgb, alpha) = match parts.as_slice() {
        [r, g, b] => ([r, g, b], 1.0),
        // L'alpha est déjà sur [0..1] par convention (`rgba(...,0.55)`, pas `rgba(...,55)`).
        [r, g, b, a] => ([r, g, b], parse_color_channel(a, 1.0)?),
        _ => return None,
    };
    Some([
        parse_color_channel(rgb[0], 255.0)?,
        parse_color_channel(rgb[1], 255.0)?,
        parse_color_channel(rgb[2], 255.0)?,
        alpha,
    ])
}
pub(crate) fn parse_color_channel(raw: &str, max: f32) -> Option<f32> {
    let n: f32 = raw.parse().ok()?;
    if !n.is_finite() || n < 0.0 || n > max {
        return None;
    }
    Some(n / max)
}
/// Le recadrage `[x0, y0, x1, y1]` en fractions de la source (repère normalisé du curseur),
/// l'image entière quand il est absent ou invalide.
fn normalized_crop(crop: Option<SceneCrop>) -> [f32; 4] {
    crop.and_then(|crop| {
        if !crop.x.is_finite() || !crop.y.is_finite()
            || !crop.width.is_finite() || !crop.height.is_finite()
        {
            return None;
        }
        let x0 = crop.x.clamp(0.0, 1.0);
        let y0 = crop.y.clamp(0.0, 1.0);
        let x1 = (crop.x + crop.width).clamp(x0, 1.0);
        let y1 = (crop.y + crop.height).clamp(y0, 1.0);
        (x1 > x0 && y1 > y0).then_some([x0, y0, x1, y1])
    })
    .unwrap_or([0.0, 0.0, 1.0, 1.0])
}

/// Rect source après crop puis zoom, dans les UV de la texture D3D. `u_max`/`v_max`
/// excluent le padding NV12 ; le crop reste donc exprimé dans le frame visible (0..1),
/// comme `VirtualPreview.cropVideoStyle`, puis le focus du zoom est remappé dans ce crop.
pub(crate) fn screen_source_rect(
    u_max: f32,
    v_max: f32,
    crop: Option<SceneCrop>,
    zoom: f32,
    focus: [f32; 2],
) -> [f32; 4] {
    let [x0, y0, x1, y1] = normalized_crop(crop);
    let (cu0, cv0, cu1, cv1) = (x0 * u_max, y0 * v_max, x1 * u_max, y1 * v_max);
    let (cw, ch) = (cu1 - cu0, cv1 - cv0);
    let zoom = if zoom.is_finite() && zoom >= 1.0 { zoom } else { 1.0 };
    let fx = if focus[0].is_finite() { focus[0].clamp(0.0, 1.0) } else { 0.5 };
    let fy = if focus[1].is_finite() { focus[1].clamp(0.0, 1.0) } else { 0.5 };
    let (hu, hv) = (cw / (2.0 * zoom), ch / (2.0 * zoom));
    // `.max(cu0/cv0)` absorbs the tiny float inversion possible at zoom=1.
    let su0 = (cu0 + fx * cw - hu).clamp(cu0, (cu1 - 2.0 * hu).max(cu0));
    let sv0 = (cv0 + fy * ch - hv).clamp(cv0, (cv1 - 2.0 * hv).max(cv0));
    [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv]
}
/// Rect DESTINATION de l'écran quand on dessine une coupe source PLUS LARGE que celle qui
/// remplissait la boîte — le cœur du correctif #179.
///
/// Le zoom natif se jouait entièrement dans la coupe source (`screen_source_rect` rétrécit
/// la coupe autour du focus) pendant que la boîte, elle, ne bougeait pas : le zoom
/// s'arrêtait donc à la frontière paddée au lieu d'atteindre les bords du cadre. La
/// référence fait l'inverse — `applyZoomTransform` (TS) met à l'échelle et translate le
/// CONTENEUR CAMÉRA, masque compris, donc la boîte paddée grandit avec le zoom, sort de
/// l'étage, et le padding s'efface.
///
/// On rend donc le zoom à la boîte : la coupe dessinée redevient le simple crop
/// (`cut`, zoom 1) et c'est la boîte qui porte le grossissement. `cut_ref` est la coupe
/// d'AVANT (zoom entier, celle qui remplissait `base`) et sert de référence : on reporte
/// `cut` à travers le mapping `cut_ref → base`.
///
/// C'est ce report qui fait toute la sûreté du correctif. Le mapping image→écran est
/// conservé PAR CONSTRUCTION — même grossissement, même cadrage, même point de focus au
/// même pixel — quel que soit le crop, le clamp de bord ou le `cover`, puisque tout cela
/// est déjà cuit dans les deux coupes. Seule l'ÉTENDUE dessinée grandit, et c'est
/// exactement elle qui déborde le padding. Tout ce qui roule sur ce mapping (curseur,
/// tilt 3D, motion blur) est donc inchangé.
///
/// Pas de clamp dans le cadre : la boîte doit pouvoir en sortir (« No stage clamping »,
/// `frameRenderer.cameraAwareMaskRect`) — le rasterizer coupe ce qui dépasse, comme il le
/// fait déjà pour le fond flouté.
pub(crate) fn remap_box(base: [f32; 4], cut_ref: [f32; 4], cut: [f32; 4]) -> [f32; 4] {
    let (rw, rh) = ((cut_ref[2] - cut_ref[0]), (cut_ref[3] - cut_ref[1]));
    if !(rw > 1e-6 && rh > 1e-6) {
        return base;
    }
    [
        base[0] + base[2] * (cut[0] - cut_ref[0]) / rw,
        base[1] + base[3] * (cut[1] - cut_ref[1]) / rh,
        base[2] * (cut[2] - cut[0]) / rw,
        base[3] * (cut[3] - cut[1]) / rh,
    ]
}
/// Où tombe le point de focus du zoom dans la coupe DESSINÉE `cut`, en 0..1 de cette coupe.
///
/// `focus` est exprimé dans le crop utilisateur (la convention de `screen_source_rect`), pas
/// dans `cut` : les deux diffèrent dès qu'un crop ou un cover s'en mêle. Le zoom, lui, ne compte
/// pas : la coupe dessinée est prise à zoom 1 (issue #179). Et le centre de la coupe zoomée
/// n'est pas le focus dès qu'elle bute sur un bord, d'où le report du point lui-même, sans
/// jamais supposer (0.5, 0.5).
pub(crate) fn focus_in_cut(
    u_max: f32,
    v_max: f32,
    crop: Option<SceneCrop>,
    focus: [f32; 2],
    cut: [f32; 4],
) -> [f32; 2] {
    // Zoom 1 : la coupe est le crop entier, quel que soit le focus.
    let [cu0, cv0, cu1, cv1] = screen_source_rect(u_max, v_max, crop, 1.0, [0.5, 0.5]);
    let f = |v: f32| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.5 };
    let (u, v) = (cu0 + f(focus[0]) * (cu1 - cu0), cv0 + f(focus[1]) * (cv1 - cv0));
    let local = |x: f32, a: f32, b: f32| if b - a > 1e-6 { ((x - a) / (b - a)).clamp(0.0, 1.0) } else { 0.5 };
    [local(u, cut[0], cut[2]), local(v, cut[1], cut[3])]
}
/// Sous-rect SOURCE (en UV de texture) qui remplit une boîte de ratio `box_ar` **sans
/// déformer** l'image : le plus grand rect centré ayant ce ratio, tiré de la frame
/// visible — l'équivalent de `object-fit: cover` côté web.
///
/// C'est LA primitive qui garantit qu'une couche vidéo n'est jamais étirée. Le
/// contrat est déplacé de l'appelant (« donne-moi un dst au ratio de la source »,
/// hypothèse qu'un preset pouvait violer en silence) vers le calcul lui-même
/// (« quel que soit le dst, je choisis la coupe qui l'habille »).
///
/// * `visible` : dimensions RÉELLES de l'image dans la texture (`AVFrame::width/height`) ;
///   elles peuvent être plus petites que la texture, qui est allouée avec du padding
///   décodeur — d'où la division finale par `tex`.
/// * `tex` : dimensions de la texture, pour normaliser en UV.
/// * `box_ar` : ratio largeur/hauteur de la boîte de destination, en pixels de rendu.
///
/// Retourne `(u0, v0, u1, v1)`. Quand la boîte a déjà le ratio de la source, la coupe
/// est la frame entière — donc aucun changement de pixel sur les placements qui étaient
/// déjà corrects.
pub(crate) fn cover_crop_uv(visible: [f32; 2], tex: [f32; 2], box_ar: f32) -> (f32, f32, f32, f32) {
    let (cam_w, cam_h) = (visible[0].max(1.0), visible[1].max(1.0));
    let (tex_w, tex_h) = (tex[0].max(1.0), tex[1].max(1.0));
    let full = [0.0, 0.0, cam_w / tex_w, cam_h / tex_h];
    let [u0, v0, u1, v1] = cover_uv_rect(full, tex, box_ar);
    (u0, v0, u1, v1)
}

/// Camera equivalent of the screen crop pipeline: apply the user crop first, then a centred
/// cover-crop inside that authored window so arbitrary layout slots never stretch the image.
pub(crate) fn webcam_source_rect(
    visible: [f32; 2],
    tex: [f32; 2],
    crop: Option<SceneCrop>,
    box_ar: f32,
) -> [f32; 4] {
    let u_max = visible[0].max(1.0) / tex[0].max(1.0);
    let v_max = visible[1].max(1.0) / tex[1].max(1.0);
    cover_uv_rect(
        screen_source_rect(u_max, v_max, crop, 1.0, [0.5, 0.5]),
        tex,
        box_ar,
    )
}
/// Rétrécit un rect SOURCE déjà exprimé en UV (`[u0, v0, u1, v1]`) autour de son
/// centre pour qu'il porte le ratio `box_ar` une fois rapporté aux pixels de la
/// texture. C'est la forme générale de `object-fit: cover`, et LA primitive qui
/// garantit qu'une couche vidéo n'est jamais étirée.
///
/// Deux appelants, deux points d'entrée dans le rect :
///   - la **webcam** part de la frame visible entière (`cover_crop_uv`) ;
///   - l'**écran** part du rect déjà réduit par le crop utilisateur ET le zoom,
///     et n'applique ce cover que dans les layouts qui le demandent
///     (`Scene.layout.screen_cover` — les blocs side-by-side / top-bottom, où le
///     web fait exactement la même chose via `screenCover`).
///
/// Rogner APRÈS le crop et le zoom est ce qui rend l'opération composable : le
/// crop décide quoi montrer, le zoom où regarder, le cover comment habiller la
/// boîte. Chacun réduit le rect précédent, jamais ne le déforme.
///
/// Quand le rect a déjà le ratio de la boîte, il est renvoyé inchangé — donc
/// aucun placement déjà correct ne bouge.
pub(crate) fn cover_uv_rect(uv: [f32; 4], tex: [f32; 2], box_ar: f32) -> [f32; 4] {
    let (tex_w, tex_h) = (tex[0].max(1.0), tex[1].max(1.0));
    let (w_uv, h_uv) = ((uv[2] - uv[0]).max(1e-6), (uv[3] - uv[1]).max(1e-6));
    // ratio du rect courant, en PIXELS (les UV sont anisotropes dès que la
    // texture n'est pas carrée — d'où le passage par `tex`).
    let (w_px, h_px) = (w_uv * tex_w, h_uv * tex_h);
    let cur_ar = w_px / h_px;
    let box_ar = if box_ar.is_finite() && box_ar > 0.0 { box_ar } else { cur_ar };
    let (new_w_px, new_h_px) = if box_ar >= cur_ar {
        (w_px, w_px / box_ar) // boîte plus large → pleine largeur, on rogne en hauteur
    } else {
        (h_px * box_ar, h_px) // boîte plus haute → pleine hauteur, on rogne en largeur
    };
    let (new_w, new_h) = (new_w_px / tex_w, new_h_px / tex_h);
    let (cx, cy) = (uv[0] + w_uv * 0.5, uv[1] + h_uv * 0.5);
    [cx - new_w * 0.5, cy - new_h * 0.5, cx + new_w * 0.5, cy + new_h * 0.5]
}
pub const HALF_W: u32 = OUT_W / 2;
pub const HALF_H: u32 = OUT_H / 2;
pub const FIXTURE_FRAMES: u32 = 360;
pub(crate) const FPS: f32 = 60.0;
/// La profondeur de champ tourne-t-elle sur le backend CPU (WARP, lavapipe) ? Le seul drapeau
/// partagé qui la coupe là-bas si son coût y devient prohibitif (seuil fixé par la spec :
/// 10 ms/frame). Mesuré (`tests/tilted_depth_of_field.rs`, 1080p iso, trois passes) : WARP
/// +3.8 / +6.3 / +12.2 ms/frame, soit +35 à +45 % ; le matériel +0.04 à +0.08 ms/frame. Médiane
/// sous le seuil : l'effet reste allumé partout, ce drapeau est le levier si ça change.
pub const DOF_ON_CPU_BACKEND: bool = true;
/// Niveaux de la pyramide de profondeur de champ (demi-résolution de la texture décodeur, donc
/// son niveau 0 est le niveau 1 d'une pyramide pleine résolution). Le shader plafonne sa lecture
/// à `DOF_MAX_LOD` (1.5) ; les niveaux au-delà laissent la marge de relever ce plafond sans
/// toucher aux trois backends. Jamais plus que la chaîne complète d'une très petite source.
pub fn dof_pyramid_levels(w: u32, h: u32) -> u32 {
    const DOF_PYRAMID_LEVELS: u32 = 5;
    DOF_PYRAMID_LEVELS.min(32 - w.max(h).max(1).leading_zeros())
}
/// Longueurs de style exprimées en FRACTION du petit côté du cadre, et non en pixels.
///
/// Elles étaient écrites en px bruts au point d'appel, ce qui voulait dire « px du render
/// target » — donc une proportion DIFFÉRENTE selon la taille de rendu : 40 px, c'est 3,7 % d'un
/// cadre 1080 mais 1,9 % d'un 2160. L'ombre était donc deux fois plus douce en preview qu'à
/// l'export, et un export 4K la recevait deux fois plus faible qu'un 1080p — même famille de bug
/// que les rayons venus de l'app, mais née à l'intérieur du natif. Les valeurs ci-dessous sont
/// les anciennes constantes rapportées au cadre 1080 contre lequel elles avaient été réglées :
/// le rendu à cette résolution est donc inchangé, et devient enfin identique partout ailleurs.
pub(crate) const SHADOW_TUNING_REF_PX: f32 = 1080.0;
pub(crate) const SCREEN_SHADOW_SPREAD_FRAC: f32 = 40.0 / SHADOW_TUNING_REF_PX;
pub(crate) const SCREEN_SHADOW_OFFSET_FRAC: f32 = 16.0 / SHADOW_TUNING_REF_PX;
pub(crate) const WEBCAM_SHADOW_SPREAD_FRAC: f32 = 32.0 / SHADOW_TUNING_REF_PX;
pub(crate) const WEBCAM_SHADOW_OFFSET_FRAC: f32 = 12.0 / SHADOW_TUNING_REF_PX;
/// Opacité FIXE de l'ombre portée de la caméra (layout PiP uniquement). Contrairement à
/// l'ombre de l'écran — dont l'opacité est pilotée par le slider Shadow (`shadow_scale`) —
/// l'ombre de la caméra est une ombre légère NON paramétrable : même valeur quelle que soit
/// la position du slider. Parité avec le preset PiP côté web (`compositeLayout.ts`,
/// `rgba(0,0,0,0.35)`), dont l'ombre est elle aussi un forfait fixe et PiP-only.
pub(crate) const WEBCAM_SHADOW_OPACITY: f32 = 0.35;
/// Taille de base du curseur, même convention (34 px réglés contre un cadre 1080).
pub(crate) const CURSOR_BASE_SIZE_FRAC: f32 = 34.0 / SHADOW_TUNING_REF_PX;

/// Hauteur de la barre de titre du cadre de fenêtre, en fraction du petit côté de la boîte où
/// l'écran tenait sans cadre. Environ 35 px sur une boîte de 864 px (1080p, padding 50 %) : la
/// proportion d'une barre de titre de bureau à cette échelle.
pub(crate) const WINDOW_FRAME_BAR_FRAC: f32 = 0.04;
/// Épaisseur du filet qui borde le cadre, même référence : environ un pixel sur la même boîte.
/// Pas de plancher en px — il rendrait le filet plus épais, en proportion, dans la petite
/// preview qu'à l'export ; le shader l'estompe plutôt que de le faire disparaître.
pub(crate) const WINDOW_FRAME_LINE_FRAC: f32 = 0.0012;

/// Le cadre de fenêtre posé autour de l'écran (`effects.frame`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowFrame {
    pub dark: bool,
    /// Marges du cadre autour de `s_dst`, en FRACTION de cette boîte : gauche, haut, droite, bas
    /// (le haut est la barre de titre, les trois autres le filet). Des fractions et non des px :
    /// `remap_box` agrandit la boîte sous un zoom (#179) et le cadre doit grandir avec elle. Ce
    /// sont aussi, prises en négatif ou au-delà de 1, les coordonnées du plan où
    /// `TiltedQuad::point_px` extrapole les coins du cadre sous un préset 3D.
    pub margins: [f32; 4],
    /// Rayon extérieur du cadre, en px de la boîte droite : c'est lui que règle Roundness quand
    /// il y a un cadre. L'écran n'arrondit plus que ses coins bas, de ce rayon moins le filet.
    pub radius: f32,
}

/// Rétrécit la boîte écran `a` (fractions de sortie) pour que l'écran ET son cadre tiennent là
/// où l'écran seul tenait. Rend la nouvelle boîte écran et les marges du cadre (cf.
/// `WindowFrame::margins`).
///
/// Sans ça le cadre déborderait de la boîte, donc du canvas à petit padding. La boîte garde son
/// ratio (celui du crop, déjà cuit dans `a`) et se centre dans `a` ; sous `cover` (layouts en
/// bloc) l'écran prend au contraire tout ce que le cadre laisse, le cover rognant la source.
pub(crate) fn fit_in_window_frame(a: [f32; 4], render_px: [f32; 2], cover: bool) -> ([f32; 4], [f32; 4]) {
    let [rw, rh] = render_px;
    let (aw, ah) = (a[2] * rw, a[3] * rh);
    let m = aw.min(ah);
    let bar = WINDOW_FRAME_BAR_FRAC * m;
    let line = WINDOW_FRAME_LINE_FRAC * m;
    let (iw, ih) = ((aw - 2.0 * line).max(1.0), (ah - bar - line).max(1.0));
    let (sw, sh) = if cover {
        (iw, ih)
    } else {
        let ar = aw / ah.max(1e-4);
        if iw / ih > ar { (ih * ar, ih) } else { (iw, iw / ar) }
    };
    let (fw, fh) = (sw + 2.0 * line, sh + bar + line);
    let (cx, cy) = ((a[0] + a[2] * 0.5) * rw, (a[1] + a[3] * 0.5) * rh);
    let (x0, y0) = (cx - fw * 0.5 + line, cy - fh * 0.5 + bar);
    ([x0 / rw, y0 / rh, sw / rw, sh / rh], [line / sw, bar / sh, line / sw, line / sh])
}

/// Qui porte l'ombre portée de l'écran, et avec quelle silhouette.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ShadowCaster {
    /// Rect droit (mode 2) : `dst` en fractions de sortie, `size_px` sa taille, `radius` en px.
    Upright { dst: [f32; 4], size_px: [f32; 2], radius: f32 },
    /// Quad incliné (mode 12) : coins TL, TR, BR, BL relatifs à `center_px`, rayon du plan.
    Tilted { corners: [(f32, f32); 4], center_px: [f32; 2], radius: f32 },
}
/// Rect [x,y,w,h] normalisé d'un sprite de curseur de taille `w`×`h` dont le pivot `hotspot`
/// (fraction 0..1 de l'image) doit tomber exactement sur `center`.
///
/// L'invariant est que `center` reste sur le pixel désigné QUELLE QUE SOIT la taille : le
/// décalage grandit avec le sprite, donc il doit être une fraction de `w`/`h` et pas une
/// constante. Un pivot centré en dur (0.5) laissait la pointe dériver de plus en plus loin de
/// la zone visée à mesure qu'on agrandissait le curseur.
pub(crate) fn cursor_sprite_dst(center: [f32; 2], w: f32, h: f32, hotspot: [f32; 2]) -> [f32; 4] {
    [center[0] - w * hotspot[0], center[1] - h * hotspot[1], w, h]
}
/// Où poser le curseur, et dans quel repère.
///
/// Le curseur remplace un pointeur qui faisait partie de l'image capturée, donc il vit SUR la
/// surface de l'écran, pas dans un calque au-dessus. Quand cet écran est incliné en 3D, ce n'est
/// donc pas seulement sa position qu'il faut projeter mais son sprite entier : autrement il se
/// lit comme un autocollant plat posé sur une scène en perspective.
#[derive(Clone, Copy)]
pub enum CursorPlacement {
    /// Écran droit : centre en coordonnées sortie 0..1.
    Upright { center: [f32; 2] },
    /// Écran incliné : position 0..1 DANS le plan, plus de quoi projeter les coins du sprite.
    Tilted {
        /// Position du pivot dans le plan (0..1 depuis son coin haut-gauche).
        plane_pt: [f32; 2],
        quad: crate::regions::TiltedQuad,
        /// Centre du plan en px sortie — `quad.corners` y est relatif.
        center_px: [f32; 2],
        /// Taille du rect d'écran NON incliné en px : l'unité dans laquelle la taille du
        /// curseur est exprimée, et donc ce qui la convertit en fraction du plan.
        screen_px: [f32; 2],
        /// Taille de la cible de rendu en px, pour repasser des px aux 0..1 de la sortie.
        render_px: [f32; 2],
    },
}
impl CursorPlacement {
    /// Interpolation entre deux placements, pour les copies de la traînée de flou. Sur un plan
    /// incliné on interpole DANS le plan : la traînée suit alors la surface au lieu de couper
    /// droit à travers la perspective.
    ///
    /// Le plan lui-même est interpolé aussi. Sous un vrai tilt les deux bornes partagent le même
    /// quad (`a + (a - a) * f` rend `a` au bit près, rien ne bouge) ; mais le curseur modélisé
    /// sur écran droit porte un quad identité taillé dans `s_dst` d'un côté et `s_dst_prev` de
    /// l'autre, et garder celui de la queue décalerait la tête quand le zoom bouge.
    pub(crate) fn lerp(self, other: CursorPlacement, f: f32) -> CursorPlacement {
        match (self, other) {
            (
                CursorPlacement::Tilted { plane_pt: a, quad, center_px, screen_px, render_px },
                CursorPlacement::Tilted {
                    plane_pt: b,
                    quad: quad_b,
                    center_px: center_b,
                    screen_px: screen_b,
                    ..
                },
            ) => CursorPlacement::Tilted {
                plane_pt: [lerp(a[0], b[0], f), lerp(a[1], b[1], f)],
                quad: crate::regions::TiltedQuad {
                    corners: std::array::from_fn(|i| {
                        (
                            lerp(quad.corners[i].0, quad_b.corners[i].0, f),
                            lerp(quad.corners[i].1, quad_b.corners[i].1, f),
                        )
                    }),
                    scale: lerp(quad.scale, quad_b.scale, f),
                    depth_k: (
                        lerp(quad.depth_k.0, quad_b.depth_k.0, f),
                        lerp(quad.depth_k.1, quad_b.depth_k.1, f),
                    ),
                    rot: std::array::from_fn(|i| lerp(quad.rot[i], quad_b.rot[i], f)),
                    perspective: lerp(quad.perspective, quad_b.perspective, f),
                    offset: std::array::from_fn(|i| lerp(quad.offset[i], quad_b.offset[i], f)),
                    projective: quad.projective,
                },
                center_px: [lerp(center_px[0], center_b[0], f), lerp(center_px[1], center_b[1], f)],
                screen_px: [lerp(screen_px[0], screen_b[0], f), lerp(screen_px[1], screen_b[1], f)],
                render_px,
            },
            (a, b) => {
                let (p, q) = (a.upright_center(), b.upright_center());
                CursorPlacement::Upright {
                    center: [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f],
                }
            }
        }
    }

    /// Le centre en coordonnées sortie, quel que soit le repère — ce dont ont besoin le curseur
    /// math de secours et le calcul de vélocité.
    pub(crate) fn upright_center(self) -> [f32; 2] {
        match self {
            CursorPlacement::Upright { center } => center,
            CursorPlacement::Tilted { plane_pt, quad, center_px, render_px, .. } => {
                let (px, py) = quad.point_px(plane_pt[0], plane_pt[1]);
                [(center_px[0] + px) / render_px[0], (center_px[1] + py) / render_px[1]]
            }
        }
    }
}

/// `LayerCB` du sprite de curseur, pour les trois backends : mode 7 sur écran droit, mode 13
/// posé sur le plan incliné.
///
/// `sprite_px` = taille du sprite en px de sortie (ratio de l'image déjà appliqué).
pub fn cursor_sprite_cb(
    placement: CursorPlacement,
    sprite_px: [f32; 2],
    hotspot: [f32; 2],
    alpha: f32,
    clip: [f32; 4],
    render_px: [f32; 2],
) -> LayerCB {
    let [pw, ph] = sprite_px;
    let [rw, rh] = render_px;
    match placement {
        CursorPlacement::Upright { center } => LayerCB {
            dst: cursor_sprite_dst(center, pw / rw, ph / rh, hotspot),
            src: [0.0, 0.0, 1.0, 1.0],
            mode: 7.0,
            color: [1.0, 1.0, 1.0, alpha],
            fx: clip,
            ..Default::default()
        },
        CursorPlacement::Tilted { plane_pt, quad, center_px, screen_px, .. } => {
            // Le sprite est posé DANS le plan : sa taille devient une fraction du plan
            // (l'unité de `size_px` est le rect d'écran non incliné), et ses 4 coins
            // traversent la même projection que la vidéo. La réduction due au tilt vient
            // donc de la projection elle-même — rien à multiplier à la main.
            let (wf, hf) = (pw / screen_px[0], ph / screen_px[1]);
            let x0 = plane_pt[0] - hotspot[0] * wf;
            let y0 = plane_pt[1] - hotspot[1] * hf;
            let corners =
                [(x0, y0), (x0 + wf, y0), (x0 + wf, y0 + hf), (x0, y0 + hf)].map(|(fx, fy)| {
                    let (px, py) = quad.point_px(fx, fy);
                    (center_px[0] + px, center_px[1] + py)
                });
            let (min_x, max_x) = corners
                .iter()
                .fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
            let (min_y, max_y) = corners
                .iter()
                .fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
            // Le quad projeté d'un sprite peut être très fin de biais : une bbox d'un pixel
            // de large ferait diverger le warp inverse, donc plancher à 1 px.
            let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
            let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
            let [tl0, tl1] = local(corners[0]);
            let [tr0, tr1] = local(corners[1]);
            let [br0, br1] = local(corners[2]);
            let [bl0, bl1] = local(corners[3]);
            LayerCB {
                dst: [min_x / rw, min_y / rh, bw / rw, bh / rh],
                quad_px: [bw, bh],
                mode: 13.0,
                color: [1.0, 1.0, 1.0, alpha],
                fx: [tl0, tl1, tr0, tr1],
                src_prev: [br0, br1, bl0, bl1],
                // Le clip vit ici et NON dans `fx` (mode 7) : `fx` porte les coins.
                dst_prev: clip,
                // `mb.x` : 1 = warp projectif (caméra réelle).
                mb: [quad.warp_flag(), 0.0, 0.0, 0.0],
                ..Default::default()
            }
        }
    }
}

/// Gain de l'éclairage de la caméra réelle : une lampe posée sur la caméra, dont la lumière
/// décroît avec le carré de la distance. 1 = la décroissance physique ; moins, pour que le
/// contenu reste lisible. L'œil en orbite passe loin de l'axe : à 22° d'azimut, l'écart d'un bord
/// à l'autre vaut `0,42·gain` en 16:9, soit ±4 % ici.
pub const CAMERA_LIGHT_GAIN: f32 = 0.2;

/// `LayerCB` de l'écran incliné (mode 8), pour les trois backends : le quad projeté est dessiné
/// dans sa BBOX et le fragment remonte au (s, t) du plan par le warp inverse. Pas de flou de
/// mouvement sur ce chemin : `src_prev`/`dst_prev` y portent déjà les coins et le plan.
///
/// - `src` : la coupe source en UV texture ; `center_px` : le centre du rect `s_px` à l'écran ;
/// - `radius` : le rayon de l'écran droit, que le plan réduit de `quad.scale` ;
/// - `square_top` : 1 sous un cadre de fenêtre (coins hauts carrés) ;
/// - `dof` : la profondeur de champ tourne (`FrameGeometry::depth_of_field_on`).
///
/// Sous la caméra réelle (`quad.projective`) : `dst_prev.w` = 1 (warp projectif), et `color.xy`
/// porte l'éclairage, `1 + color.x·(s − 0,5) + color.y·(t − 0,5)` : la lampe de la caméra, fixe
/// dans le monde comme l'œil, éclaire un peu plus le côté proche. Nuls sous un angle fixe, dont le
/// rendu reste celui d'avant à l'octet.
#[allow(clippy::too_many_arguments)]
pub fn tilted_screen_cb(
    quad: &crate::regions::TiltedQuad,
    s_px: [f32; 2],
    center_px: [f32; 2],
    src: [f32; 4],
    focus_plane: [f32; 2],
    radius: f32,
    square_top: f32,
    dof: bool,
    render_px: [f32; 2],
) -> LayerCB {
    let [rw, rh] = render_px;
    let corners = quad.corners;
    // Taille du plan dans son propre repère, avant projection : c'est là que vit le rayon, pour
    // qu'il reste constant le long du bord au lieu de s'étirer avec la perspective.
    let plane_px = [s_px[0] * quad.scale, s_px[1] * quad.scale];
    let (min_x, max_x) =
        corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
    let (min_y, max_y) =
        corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
    let bbox_w = (max_x - min_x).max(1.0);
    let bbox_h = (max_y - min_y).max(1.0);
    // Coins en px LOCAUX à la bbox, pour matcher `i.local` du shader.
    let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x, y - min_y] };
    let [tl0, tl1] = local(corners[0]);
    let [tr0, tr1] = local(corners[1]);
    let [br0, br1] = local(corners[2]);
    let [bl0, bl1] = local(corners[3]);
    let light = if quad.projective {
        // Œil dans le repère du plan, et la dérivée de (d_centre / d)² au centre du plan.
        let eye = crate::regions::rotate_point_inv(
            [-quad.offset[0], -quad.offset[1], quad.perspective],
            quad.rot,
        );
        let e2 = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2];
        let k = 2.0 * CAMERA_LIGHT_GAIN / e2.max(1e-6);
        [k * plane_px[0] * eye[0], k * plane_px[1] * eye[1], 0.0, 0.0]
    } else {
        [0.0; 4]
    };
    LayerCB {
        dst: [(center_px[0] + min_x) / rw, (center_px[1] + min_y) / rh, bbox_w / rw, bbox_h / rh],
        src,
        quad_px: [bbox_w, bbox_h],
        // Le rayon suit la réduction du plan : l'écran incliné est plus petit, ses coins le sont
        // d'autant, exactement comme s'il s'éloignait.
        radius_px: radius * quad.scale,
        mode: 8.0,
        color: light,
        fx: [tl0, tl1, tr0, tr1],
        src_prev: [br0, br1, bl0, bl1],
        dst_prev: [plane_px[0], plane_px[1], square_top, quad.warp_flag()],
        // Gradient de profondeur du plan, profondeur du focus et `k` (`depth_mb`).
        mb: quad.depth_mb(s_px, focus_plane, dof),
        ..Default::default()
    }
}

/// `LayerCB` d'une ombre portée par un quadrilatère (mode 12). `corners` (TL, TR, BR, BL) en px
/// de sortie ABSOLUS. Même boîte que `draw_quad_shadow` des backends : le quad élargi du
/// `spread`, pour que la pénombre ne se coupe pas net.
pub(crate) fn quad_shadow_cb(
    corners: &[(f32, f32); 4],
    radius: f32,
    spread: f32,
    opacity: f32,
    render_px: [f32; 2],
) -> LayerCB {
    let (min_x, max_x) =
        corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
    let (min_y, max_y) =
        corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
    let box_w = (max_x - min_x) + 2.0 * spread;
    let box_h = (max_y - min_y) + 2.0 * spread;
    let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x + spread, y - min_y + spread] };
    let [tl0, tl1] = local(corners[0]);
    let [tr0, tr1] = local(corners[1]);
    let [br0, br1] = local(corners[2]);
    let [bl0, bl1] = local(corners[3]);
    LayerCB {
        dst: [
            (min_x - spread) / render_px[0],
            (min_y - spread) / render_px[1],
            box_w / render_px[0],
            box_h / render_px[1],
        ],
        quad_px: [box_w, box_h],
        radius_px: radius,
        mode: 12.0,
        color: [0.0, 0.0, 0.0, opacity],
        fx: [tl0, tl1, tr0, tr1],
        src_prev: [br0, br1, bl0, bl1],
        mb: [0.0, spread, 1.0, 0.0],
        ..Default::default()
    }
}

/// Le plus grand rayon que le mode 12 accepte sur ce quad sans se retourner.
///
/// Le shader rentre chaque arête de `r` (`line_cross`) : dès que `r` dépasse la demi-distance
/// entre deux arêtes opposées, les arêtes rentrées se croisent et le quad « rentré » est retourné
/// — la pénombre sort alors n'importe où. La demi-distance se mesure du milieu d'une arête à la
/// droite de l'arête opposée (exact pour des arêtes parallèles, proche sous nos petits angles),
/// et `0.8×` garde une marge pour l'écart au parallélisme.
pub(crate) fn quad_shadow_max_radius(c: &[(f32, f32); 4]) -> f32 {
    let dist_to_line = |p: (f32, f32), a: (f32, f32), b: (f32, f32)| {
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        ((p.0 - a.0) * ey - (p.1 - a.1) * ex).abs() / ex.hypot(ey).max(1e-6)
    };
    let mid = |a: (f32, f32), b: (f32, f32)| ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5);
    let half_min = (0..4)
        .map(|k| {
            let (a, b) = (c[k], c[(k + 1) % 4]);
            let (o0, o1) = (c[(k + 2) % 4], c[(k + 3) % 4]);
            dist_to_line(mid(o0, o1), a, b) * 0.5
        })
        .fold(f32::MAX, f32::min);
    0.8 * half_min
}
pub(crate) fn ease_in_out_cubic(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x < 0.5 {
        4.0 * x * x * x
    } else {
        1.0 - (-2.0 * x + 2.0).powi(3) / 2.0
    }
}
pub(crate) fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
pub(crate) fn lerp4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)]
}
/// Un calque vidéo animé (rect sortie, taille px, rayon) — screen ou webcam.
#[derive(Clone, Copy)]
pub(crate) struct Placement {
    pub(crate) dst: [f32; 4],
    pub(crate) radius: f32,
}
/// Paramètres d'une frame : dérivés du temps par la timeline (§8).
#[derive(Clone, Copy)]
pub(crate) struct FrameParams {
    pub(crate) zoom: f32,
    pub(crate) focus: [f32; 2],
    pub(crate) screen: Placement,
    pub(crate) webcam: Placement, // dst carré (w en px via OUT_W)
}
/// Timeline figée de la fixture (6 s) : zoom 1.0→1.8→1.0, layout A(PIP)↔B(côte à côte).
/// `frame` fractionnaire pour permettre le supersampling temporel (flou de mouvement).
/// Gaté par `cfg` : zoom et layout ne bougent que si activés.
pub(crate) fn timeline(frame: f32, cfg: &Cfg) -> FrameParams {
    let t = frame / FPS; // secondes

    // zoom : montée [0,3s] puis descente [3s,6s], easeInOutCubic
    let zoom = if cfg.zoom {
        let zt = if t < 3.0 { ease_in_out_cubic(t / 3.0) } else { ease_in_out_cubic((6.0 - t) / 3.0) };
        1.0 + 0.8 * zt
    } else {
        1.0
    };

    // layout A = PIP bas-droite ; B = côte à côte. Transitions A→B [2,2.5]s, B→A [4,4.5]s.
    let lf = if !cfg.layout_anim {
        0.0
    } else if t < 2.0 {
        0.0
    } else if t < 2.5 {
        ease_in_out_cubic((t - 2.0) / 0.5)
    } else if t < 4.0 {
        1.0
    } else if t < 4.5 {
        1.0 - ease_in_out_cubic((t - 4.0) / 0.5)
    } else {
        0.0
    };

    // Layout A (PIP)
    let a_screen = Placement { dst: [0.05, 0.05, 0.90, 0.90], radius: 24.0 };
    let a_side = 320.0_f32;
    let a_webcam = Placement {
        dst: [
            (OUT_W as f32 - 40.0 - a_side) / OUT_W as f32,
            (OUT_H as f32 - 40.0 - a_side) / OUT_H as f32,
            a_side / OUT_W as f32,
            a_side / OUT_H as f32,
        ],
        radius: 40.0,
    };
    // Layout B (côte à côte) : screen à gauche (16:9), webcam carré à droite
    let b_screen = Placement { dst: [0.035, 0.22, 0.60, 0.5625], radius: 20.0 };
    let b_side = 520.0_f32;
    let b_webcam = Placement {
        dst: [
            0.70,
            (OUT_H as f32 - b_side) * 0.5 / OUT_H as f32,
            b_side / OUT_W as f32,
            b_side / OUT_H as f32,
        ],
        radius: 40.0,
    };

    FrameParams {
        zoom,
        focus: [0.5, 0.32],
        screen: Placement { dst: lerp4(a_screen.dst, b_screen.dst, lf), radius: lerp(a_screen.radius, b_screen.radius, lf) },
        webcam: Placement { dst: lerp4(a_webcam.dst, b_webcam.dst, lf), radius: lerp(a_webcam.radius, b_webcam.radius, lf) },
    }
}
/// Placements statiques screen+webcam pour un preset de layout de l'app (contrat de scène) —
/// remplace le planning A↔B fixture de `timeline()`. Zoom = 1 (les zoom regions viennent ensuite).
/// La taille/forme/miroir webcam restent appliqués par-dessus via `LiveParams`.
pub(crate) fn preset_placements(preset: &str) -> FrameParams {
    // plein cadre : le padding l'insère ensuite (padding 0 → bord à bord).
    let full_screen = Placement { dst: [0.0, 0.0, 1.0, 1.0], radius: 24.0 };
    // PiP bas-droite (≈ layout A fixture).
    let a_side = 320.0_f32;
    let pip_webcam = Placement {
        dst: [
            (OUT_W as f32 - 40.0 - a_side) / OUT_W as f32,
            (OUT_H as f32 - 40.0 - a_side) / OUT_H as f32,
            a_side / OUT_W as f32,
            a_side / OUT_H as f32,
        ],
        radius: 40.0,
    };
    // webcam hors écran (no-webcam) : quad de taille nulle, jamais visible.
    let off_webcam = Placement { dst: [2.0, 2.0, 0.0, 0.0], radius: 0.0 };

    let (screen, webcam) = match preset {
        "dual-frame" => {
            // côte à côte : screen 16:9 à gauche, webcam carré à droite (≈ layout B fixture).
            let b_side = 520.0_f32;
            (
                Placement { dst: [0.035, 0.22, 0.60, 0.5625], radius: 20.0 },
                Placement {
                    dst: [
                        0.70,
                        (OUT_H as f32 - b_side) * 0.5 / OUT_H as f32,
                        b_side / OUT_W as f32,
                        b_side / OUT_H as f32,
                    ],
                    radius: 40.0,
                },
            )
        }
        "vertical-stack" => {
            // haut/bas : screen en haut, webcam carré centré en bas.
            let w_side = 360.0_f32;
            (
                Placement { dst: [0.13, 0.04, 0.74, 0.52], radius: 20.0 },
                Placement {
                    dst: [
                        0.5 - (w_side * 0.5) / OUT_W as f32,
                        0.60,
                        w_side / OUT_W as f32,
                        w_side / OUT_H as f32,
                    ],
                    radius: 40.0,
                },
            )
        }
        "no-webcam" => (full_screen, off_webcam),
        _ => (full_screen, pip_webcam), // "picture-in-picture" (défaut)
    };

    FrameParams { zoom: 1.0, focus: [0.5, 0.5], screen, webcam }
}

// Les quatre items qui suivent existaient en DOUBLE, un exemplaire par backend, et les
// commentaires macOS affirmaient « mêmes champs et même layout » puis « mêmes formules ».
// Les deux affirmations étaient fausses sur trois valeurs :
//
//     bg_color défaut          windows [0.10, 0.11, 0.14, 1.0]   macos [0, 0, 0, 0]
//     has_webcam défaut        windows true                       macos false
//     webcam_shape_code(_)     windows 3 ("rounded")              macos 0 ("rectangle")
//
// La troisième est celle qui mord : `live_params_from_scene` l'appelle, et `webcam_shape`
// vaut "rounded" par défaut côté app — donc la même scène décrivait une caméra arrondie
// sur Windows et rectangulaire sur macOS. Les valeurs Windows font foi : c'est le backend
// qui rend en production aujourd'hui.

/// Valeurs continues pilotées par l'inspector (celles qui étaient codées en dur dans
/// `compose_frame`). Le défaut reproduit le rendu actuel → bench/export inchangés.
/// Les booléens/taps (fond flouté, ombre on/off, coins on/off, motion blur) restent
/// portés par le `Cfg` que le thread live reconstruit depuis les switches.
#[derive(Clone, Copy)]
pub struct LiveParams {
    pub bg_color: [f32; 4],       // fond plat (mode couleur) quand non flouté
    pub shadow_scale: f32,        // multiplie l'opacité des ombres (1 = défaut, 0 = off)
    pub radius_scale: f32,        // multiplie le rayon des coins (1 = défaut, 0 = carré)
    pub padding: f32,             // 0..1 : inset supplémentaire du screen (0 = défaut fixture)
    pub webcam_size_scale: f32,   // multiplie la taille de la webcam (1 = défaut)
    pub webcam_mirror: bool,      // miroir horizontal de la webcam
    pub webcam_shape: u32,        // 0=rect, 1=circle, 2=square, 3=rounded (défaut)
    pub cursor_size_scale: f32,   // multiplie la taille du curseur (1 = défaut)
    pub cursor_bounce_scale: f32, // multiplie l'amplitude du click-bounce (1 = défaut, 0 = off)
    /// 0..1 : flou de mouvement DU CURSEUR (indépendant du motion blur écran/`cfg.mblur_n`).
    /// Approximé par le même mécanisme de traînée fantôme (taps décalés le long de la
    /// vélocité), pas par un flou gaussien variable comme le canvas web — plus simple à
    /// réutiliser côté GPU, effet de streak équivalent.
    pub cursor_motion_blur: f32,
    /// Flèche modélisée en 3D (mode 15, cf. `plan_cursor`). `false` = le sprite plat d'avant.
    pub cursor_model3d: bool,
    /// Masquage auto du curseur en cas d'inactivité.
    pub cursor_auto_hide: bool,
    /// False when the "webcam" decoder is actually just the screen video again (the TS side
    /// falls `webcamPath` back to the screen asset's own path when a clip has no real camera,
    /// purely so the decoder pipeline has something valid to open) — drawing the PiP box in
    /// that case duplicates the screen video into its own corner. Derived per clip from the
    /// screen/webcam paths via `webcam_is_real`: in `live.rs` for the preview, in
    /// `timeline_walk.rs` for every export. Defaults `true` (draw) so fixture/bench renders
    /// and any caller that never sets it keep their old behavior.
    pub has_webcam: bool,
}

fn same_source_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Période commune des mouvements de fond (s). Chaque période du shader (20, 24, 30, 40, 12,
/// 120 s) la divise, donc replier le temps dessus ne crée aucun raccord visible — et garde au
/// shader un temps borné, là où un `f32` de plusieurs heures perdrait la finesse du bruit.
pub const GRADIENT_MOTION_PERIOD_S: f32 = 120.0;

/// Emplacements libres du mode 5 pour le fond animé : `fx.zw` = (temps programme replié, indice
/// du mouvement), `mb.x` = aspect w/h de la sortie (les nappes de l'aurore restent rondes).
///
/// `GradientMotion::None` rend les zéros d'avant l'animation, emplacement pour emplacement : le
/// dégradé immobile reste celui d'aujourd'hui, octet pour octet. Fonction pure du temps
/// programme, jamais d'un état porté de frame en frame — preview et export, lecture et seek
/// tombent sur la même image.
pub fn gradient_motion_slots(
    motion: crate::scene::GradientMotion,
    programme_t: f32,
    aspect: f32,
) -> ([f32; 2], [f32; 4]) {
    use crate::scene::GradientMotion as M;
    let index = match motion {
        M::None => return ([0.0, 0.0], [0.0; 4]),
        M::Drift => 1.0,
        M::Aurora => 2.0,
        M::Waves => 3.0,
    };
    (
        [programme_t.rem_euclid(GRADIENT_MOTION_PERIOD_S), index],
        [aspect, 0.0, 0.0, 0.0],
    )
}

/// True when this clip really has a camera to draw.
///
/// TWO ways the app says "no camera", and both must be caught here, because the
/// webcam decoder is opened either way — the live path falls back to the SCREEN
/// file when the webcam path won't open, and `ExportDialog` sends the screen path
/// outright, so the decoder always yields frames. Whether those frames are the
/// camera or a second copy of the screen is decided HERE and nowhere else.
///
///   - the empty string, which is what `sceneDescription.ts` and
///     `NativeCompositorOverlay` send for an asset with no `cameraTrack`;
///   - the screen's own path, which `ExportDialog.tsx` sends and which older
///     scenes still use.
///
/// Missing the empty-string case is what put the screen recording inside the PiP
/// box: `"" != "/…/recording.mp4"`, so the box was drawn, and the decoder behind
/// it was the screen fallback.
pub fn webcam_is_real(webcam_path: &str, screen_path: &str) -> bool {
    !webcam_path.trim().is_empty() && !same_source_path(webcam_path, screen_path)
}

impl Default for LiveParams {
    fn default() -> Self {
        Self {
            bg_color: [0.10, 0.11, 0.14, 1.0],
            shadow_scale: 1.0,
            radius_scale: 1.0,
            padding: 0.0,
            webcam_size_scale: 1.0,
            webcam_mirror: false,
            webcam_shape: 3,
            cursor_size_scale: 1.0,
            cursor_bounce_scale: 1.0,
            cursor_motion_blur: 0.0,
            cursor_model3d: false,
            cursor_auto_hide: false,
            has_webcam: true,
        }
    }
}

/// "rectangle"|"circle"|"square"|"rounded" -> code webcam_shape (0/1/2/3). Partagé entre le
/// live (`live.rs::set_param_str`) et l'export (construit `LiveParams` depuis la scène) — une
/// seule table de vérité pour ce mapping.
pub fn webcam_shape_code(shape: &str) -> u32 {
    match shape {
        "rectangle" => 0,
        "circle" => 1,
        "square" => 2,
        _ => 3, // "rounded" (défaut)
    }
}

/// Construit les `LiveParams` équivalents à ce que l'inspector pousse en live, mais depuis la
/// scène de l'app — l'export est un rendu one-shot sans historique de sliders, donc il doit lire
/// directement la config déjà posée dans la scène plutôt que dupliquer un mécanisme d'inspector.
/// Unités identiques à `RightPanes.tsx` (mêmes conversions, pas de re-normalisation) : voir
/// `sceneDescription.ts` pour la correspondance settings -> champs de scène.
pub fn live_params_from_scene(s: &crate::scene::Scene) -> LiveParams {
    LiveParams {
        shadow_scale: s.effects.shadow,
        // `radius_scale` reste le multiplicateur du chemin INSPECTOR (bench/GUI standalone) ; le
        // rayon écran d'une scène vient désormais de `effects.roundness_frac`, lu directement
        // dans `compose_frame`. Le faire transiter ici obligeait à le normaliser par un rayon de
        // fixture (`p.screen.radius`, 24 px) pour ressortir la valeur de départ — un aller-retour
        // qui ne servait qu'à faire passer des pixels pour un ratio.
        padding: s.effects.padding,
        webcam_size_scale: s.layout.webcam_size,
        webcam_mirror: s.layout.webcam_mirror,
        webcam_shape: webcam_shape_code(&s.layout.webcam_shape),
        cursor_size_scale: s.cursor.size,
        cursor_bounce_scale: s.cursor.click_bounce,
        cursor_motion_blur: s.cursor.motion_blur,
        cursor_model3d: s.cursor.model3d,
        cursor_auto_hide: s.cursor.auto_hide,
        ..LiveParams::default()
    }
}

/// Ce que `plan_frame` a besoin de savoir. Rien ici n'est un objet backend : ce sont des
/// dimensions, la scène, et les réglages live. C'est ce qui rend la fonction partageable.
pub struct FrameGeometryInput<'a> {
    /// Taille de la cible de rendu en px (`Compositor::rw()`/`rh()` côté Windows,
    /// `render_w`/`render_h` côté macOS).
    pub render_px: [f32; 2],
    /// Dimensions de la TEXTURE écran. Sur D3D11VA elles sont alignées macrobloc
    /// (1080 → 1088) ; sur CoreVideo elles sont nominales. L'écart est voulu et c'est
    /// exactement pourquoi `u_max`/`v_max` existent — ne jamais supposer texture == visible.
    pub screen_tex_px: [f32; 2],
    pub screen_visible_px: [f32; 2],
    pub webcam_visible_px: [f32; 2],
    /// Fraction utile de la texture écran : `visible / texture`.
    pub u_max: f32,
    pub v_max: f32,
    pub frame: f32,
    pub cfg: &'a Cfg,
    pub live: LiveParams,
    pub scene: Option<&'a Scene>,
    pub cursor: Option<&'a crate::cursor::CursorTrack>,
    pub timeline_t_override: Option<f32>,
    /// Temps PROGRAMME (secondes de sortie), continu à travers les coupes et les clips :
    /// `frames / out_fps` à l'export, `regions::ProgrammeClock` en preview. `None` = fixture
    /// (`frame / FPS`). Voir `FrameGeometry::programme_t`.
    pub programme_time: Option<f32>,
}

/// Les 15 valeurs que la moitié « dessin » consomme. Sur les 75 locaux que le calcul
/// produit, 60 meurent avant le premier draw — ce sont ceux-là, et seulement ceux-là,
/// qui traversent.
pub struct FrameGeometry {
    pub scene_preset: Option<String>,
    pub mb_taps: f32,
    pub mb_amount: f32,
    pub source_t: f32,
    /// Horloge des effets qui vivent sur la SORTIE et non sur la source (fond animé) :
    /// `source_t` saute à chaque coupe et à chaque clip, pas elle. Recopiée telle quelle de
    /// l'entrée, jamais déduite de `frame` — en preview ce compteur n'est qu'un tick, qui
    /// diffère entre lecture et seek pour la même image.
    pub programme_t: f32,
    /// Rotation 3D de BASE (préset × force) : elle seule fixe l'échelle de containment et le
    /// choix mode 0 / mode 8.
    pub zoom_rotation: [f32; 3],
    /// Part dynamique du tilt (parallaxe, `regions::dynamic_tilt`), ajoutée à la base à la
    /// projection. Nulle quand la base est neutre.
    pub zoom_rotation_dyn: [f32; 3],
    /// Caméra réelle de `follow-cursor` (`camera.rs`), `None` sans elle. Jamais en même temps
    /// qu'une `zoom_rotation` non nulle.
    pub camera: Option<crate::camera::CameraPose>,
    pub padding_scale: f32,
    /// Coupe source de l'écran en UV texture (crop utilisateur + zoom).
    pub cut: [f32; 4],
    /// Point de focus du zoom (résolu : suivi curseur et rampe compris) en 0..1 DANS la coupe
    /// dessinée `cut`, c'est-à-dire dans le plan que le mode 8 incline. Borné au plan : un focus
    /// que le cover a rogné retombe sur le bord. C'est lui qui fixe `z_focus` (`depth_mb`).
    pub focus_plane: [f32; 2],
    /// Réglage « Depth of field » du projet. Ne décide rien seul : voir `depth_of_field_on`.
    pub depth_of_field: bool,
    pub s_dst: [f32; 4],
    pub s_dst_prev: [f32; 4],
    /// Boîte écran **sans le zoom** : le conteneur auquel les annotations et les
    /// sous-titres sont ancrés — sauf le flou de confidentialité, qui suit le contenu
    /// (`privacy_mask`).
    ///
    /// C'est `s_dst` avant le `remap_box` du zoom, donc le rect que l'app a résolu
    /// (`layout.screenRect`, rétréci par `fitInWindowFrame` sous un cadre) et que l'overlay web
    /// reçoit comme conteneur. Le contrat de
    /// `SceneAnnotation` est explicite : « deliberately NOT affected by the zoom crop — the
    /// overlay is a sibling of the element carrying the zoom transform, so annotations hold
    /// still while the content zooms underneath them ». Tant que le zoom vivait dans la
    /// coupe source, `s_dst` tenait ce rôle ; depuis l'issue #179 il vit dans la BOÎTE, donc
    /// `s_dst` grandit et se déplace avec lui — et les annotations le suivaient, sous-titres
    /// compris, qui se mettaient à zoomer avec l'écran.
    pub s_ann: [f32; 4],
    pub s_radius: f32,
    pub frame_min_px: f32,
    pub w_dst: [f32; 4],
    pub w_dst_prev: [f32; 4],
    pub w_px: [f32; 2],
    pub w_radius: f32,
    pub shape_fade: f32,
    /// Cadre de fenêtre autour de l'écran. `None` : aucun, et le rendu est celui d'avant le
    /// cadre, à l'octet. `Some` : `s_dst` est déjà la boîte rétrécie, et `s_radius` le rayon des
    /// seuls coins BAS de l'écran (les coins hauts sont carrés, sous la barre de titre).
    pub window_frame: Option<WindowFrame>,
}

/// Rect de destination d'une annotation dans un rect d'ancrage, en fractions de la sortie.
///
/// Pour le texte, les flèches, les images et les sous-titres, `anchor` est TOUJOURS `s_ann`,
/// le rect écran sans le zoom — jamais `s_dst`. (Le flou passe par
/// `FrameGeometry::privacy_mask`, qui fait l'inverse exprès.) Les deux
/// coïncident sans zoom, ce qui rend l'erreur invisible sur la moitié des scènes ; sous
/// zoom, `s_dst` grandit et emmène annotations et sous-titres avec lui, alors que le
/// contrat de `SceneAnnotation` les veut « deliberately NOT affected by the zoom crop ».
///
/// Version libre plutôt que méthode : Windows déstructure `FrameGeometry` dès l'entrée de
/// `compose_frame`, donc il n'a plus de `&self` à offrir quand il dessine les annotations.
/// Les trois backends partagent malgré tout CETTE arithmétique-ci — le bug est reparu sur
/// Linux après avoir été corrigé sur Windows et macOS (issue #179) parce que chacun en
/// gardait sa copie.
///
/// Attention : le choix du rect passé en `anchor` reste, lui, au call site des backends
/// Metal et D3D (leur `draw_annotations` prend le rect en paramètre). Seul Linux part
/// directement de `FrameGeometry`. Passer `s_dst` ici reste donc possible sur deux
/// backends sur trois — d'où le nom du paramètre côté appelants, et les tests.
pub fn annotation_dst_in(anchor: [f32; 4], x: f32, y: f32, w: f32, h: f32) -> [f32; 4] {
    [anchor[0] + x * anchor[2], anchor[1] + y * anchor[3], w * anchor[2], h * anchor[3]]
}

impl FrameGeometry {
    /// Le quad de l'écran incliné pour une boîte de `s_px` px, `None` quand l'écran est droit.
    /// LE point de passage de l'écran, de son ombre, du curseur et du masque de flou : tous
    /// doivent porter la même séparation base / dynamique, sinon ils se décollent.
    ///
    /// Sous la caméra réelle, c'est l'écran vu par elle (`camera::View::quad`), même boîte.
    pub fn screen_tilt(&self, s_px: [f32; 2]) -> Option<crate::regions::TiltedQuad> {
        if let Some(pose) = self.camera {
            return Some(crate::camera::View::new(s_px, pose).quad(s_px));
        }
        self.tilted().then(|| {
            crate::regions::rotated_quad_corners_px(
                s_px[0],
                s_px[1],
                self.zoom_rotation,
                self.zoom_rotation_dyn,
            )
        })
    }

    /// L'écran passe-t-il par le plan projeté (modes 8, 12, 13, 14) plutôt que par le rect droit ?
    pub fn tilted(&self) -> bool {
        self.camera.is_some() || !crate::regions::is_identity_rotation(self.zoom_rotation)
    }

    /// La profondeur de champ tourne-t-elle sur CETTE frame ? Réglage allumé, écran réellement
    /// incliné (à plat le mode 8 n'est pas dessiné), et backend qui en a les moyens (cf.
    /// `DOF_ON_CPU_BACKEND`). Une seule réponse pour les trois backends : elle décide à la fois
    /// du remplissage de la pyramide et du `k` du mode 8, qui ne doivent jamais diverger.
    pub fn depth_of_field_on(&self, cpu_backend: bool) -> bool {
        self.depth_of_field && self.tilted() && (DOF_ON_CPU_BACKEND || !cpu_backend)
    }

    /// `annotation_dst_in` appliqué à `s_ann`, pour les backends qui tiennent la géométrie
    /// entière — c'est-à-dire ceux qui n'ont aucune raison de choisir un rect.
    pub fn annotation_dst(&self, x: f32, y: f32, w: f32, h: f32) -> [f32; 4] {
        annotation_dst_in(self.s_ann, x, y, w, h)
    }

    /// Hauteur en px du rect d'ancrage des annotations, pour `rh` px de sortie.
    ///
    /// `font_size_rel` est une fraction de cette hauteur (cf. `annotationScale.ts`) :
    /// la prendre sur `s_dst` ferait grossir le texte avec le zoom, exactement comme
    /// `annotation_dst` le déplacerait.
    pub fn annotation_anchor_h_px(&self, rh: f32) -> f32 {
        self.s_ann[3] * rh
    }

    /// 1 quand l'écran doit garder ses coins HAUTS carrés (il est sous la barre de titre d'un
    /// cadre), 0 sinon. Le mode 0 le lit dans `mb.w`, le mode 8 dans `dst_prev.z` — deux
    /// emplacements que ces modes laissaient à zéro, d'où un rendu inchangé sans cadre.
    pub fn screen_square_top(&self) -> f32 {
        if self.window_frame.is_some() { 1.0 } else { 0.0 }
    }

    /// Le plan incliné de l'écran, `None` quand il est droit. Même appel que les backends : un
    /// calcul déterministe, donc le même quadrilatère au bit près.
    fn screen_tilt_in(&self, render_px: [f32; 2]) -> Option<crate::regions::TiltedQuad> {
        self.screen_tilt([self.s_dst[2] * render_px[0], self.s_dst[3] * render_px[1]])
    }

    fn screen_center_px(&self, render_px: [f32; 2]) -> [f32; 2] {
        [
            (self.s_dst[0] + self.s_dst[2] * 0.5) * render_px[0],
            (self.s_dst[1] + self.s_dst[3] * 0.5) * render_px[1],
        ]
    }

    /// Les coins TL, TR, BR, BL du cadre, en px relatifs au centre de l'écran, plus l'échelle du
    /// plan (1 à plat). Incliné, c'est le MÊME `TiltedQuad` que l'écran, prolongé au-delà de
    /// 0..1 : un warp bilinéaire est entièrement fixé par ses quatre coins, donc le prolonger
    /// donne exactement le plan que le mode 8 dessine, et le cadre penche avec l'écran sans
    /// aucune trigonométrie de plus. Sous la caméra réelle, le prolongement est celui de
    /// l'homographie, et le drapeau rendu (`TiltedQuad::warp_flag`) le dit au mode 14.
    fn window_frame_corners(
        &self,
        frame: &WindowFrame,
        render_px: [f32; 2],
    ) -> ([(f32, f32); 4], f32, f32) {
        let [ml, mt, mr, mb] = frame.margins;
        let quad = self.screen_tilt_in(render_px).unwrap_or_else(|| {
            let (hw, hh) = (self.s_dst[2] * render_px[0] * 0.5, self.s_dst[3] * render_px[1] * 0.5);
            crate::regions::TiltedQuad {
                corners: [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)],
                scale: 1.0,
                depth_k: (0.0, 0.0),
                rot: [0.0; 3],
                perspective: 0.0,
                offset: [0.0; 2],
                projective: false,
            }
        });
        let corners = [
            quad.point_px(-ml, -mt),
            quad.point_px(1.0 + mr, -mt),
            quad.point_px(1.0 + mr, 1.0 + mb),
            quad.point_px(-ml, 1.0 + mb),
        ];
        (corners, quad.scale, quad.warp_flag())
    }

    /// Ce qui porte l'ombre portée : le cadre quand il y en a un — sinon l'ombre tomberait sous
    /// l'écran seul et la barre de titre flotterait au-dessus d'elle —, l'écran sinon, avec
    /// exactement l'arithmétique que les backends faisaient avant le cadre.
    pub fn shadow_caster(&self, render_px: [f32; 2]) -> ShadowCaster {
        let center_px = self.screen_center_px(render_px);
        match (&self.window_frame, self.screen_tilt_in(render_px)) {
            (None, None) => ShadowCaster::Upright {
                dst: self.s_dst,
                size_px: [self.s_dst[2] * render_px[0], self.s_dst[3] * render_px[1]],
                radius: self.s_radius,
            },
            (None, Some(quad)) => ShadowCaster::Tilted {
                corners: quad.corners,
                center_px,
                radius: self.s_radius * quad.scale,
            },
            (Some(frame), None) => {
                let [ml, mt, mr, mb] = frame.margins;
                let d = self.s_dst;
                let dst = [
                    d[0] - ml * d[2],
                    d[1] - mt * d[3],
                    d[2] * (1.0 + ml + mr),
                    d[3] * (1.0 + mt + mb),
                ];
                ShadowCaster::Upright {
                    dst,
                    size_px: [dst[2] * render_px[0], dst[3] * render_px[1]],
                    radius: frame.radius,
                }
            }
            (Some(frame), Some(_)) => {
                let (corners, scale, _) = self.window_frame_corners(frame, render_px);
                ShadowCaster::Tilted { corners, center_px, radius: frame.radius * scale }
            }
        }
    }

    /// Décalage de l'ombre portée de l'écran, en px de sortie : vers le bas sous un écran droit
    /// ou un angle fixe (inchangé) ; sous la caméra réelle, le long de la lumière qui éclaire aussi
    /// la flèche modélisée (`MODEL_LIGHT`), pour que les deux ombres tombent du même côté. La
    /// direction glisse avec le poids de la caméra : aucun saut à l'entrée du zoom.
    pub fn screen_shadow_offset(&self) -> [f32; 2] {
        let off = SCREEN_SHADOW_OFFSET_FRAC * self.frame_min_px;
        let Some(pose) = self.camera else { return [0.0, off] };
        let (lx, ly) = (-MODEL_LIGHT[0], -MODEL_LIGHT[1]);
        let n = lx.hypot(ly);
        let w = pose.weight.clamp(0.0, 1.0);
        let dir = [lx / n * w, ly / n * w + (1.0 - w)];
        let len = dir[0].hypot(dir[1]).max(1e-6);
        [off * dir[0] / len, off * dir[1] / len]
    }

    /// Le calque du cadre (mode 14), à dessiner après l'ombre et AVANT l'écran. `None` sans cadre.
    ///
    /// Une seule forme pour le cas droit et le cas incliné : le mode 14 fait toujours le warp
    /// inverse du mode 8, et sur un rect ce warp est l'identité exacte (le terme quadratique est
    /// nul). Le calque se construit donc ici, une fois, pour les trois backends.
    pub fn window_frame_cb(&self, render_px: [f32; 2]) -> Option<LayerCB> {
        let frame = self.window_frame.as_ref()?;
        let [rw, rh] = render_px;
        let (corners, scale, warp) = self.window_frame_corners(frame, render_px);
        let center = self.screen_center_px(render_px);
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        let bbox = [(max_x - min_x).max(1.0), (max_y - min_y).max(1.0)];
        let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
        let [tl, tr, br, bl] = corners.map(local);
        let [ml, mt, mr, mb] = frame.margins;
        let (s_w, s_h) = (self.s_dst[2] * rw, self.s_dst[3] * rh);
        // Dimensions dans le repère du plan, avant projection, comme `plane_px` au mode 8.
        let plane_px = [s_w * (1.0 + ml + mr) * scale, s_h * (1.0 + mt + mb) * scale];
        let (bar_px, line_px) = (mt * s_h * scale, ml * s_w * scale);
        let (fill, line) = if frame.dark {
            ([0.165, 0.165, 0.180, 1.0], [1.0, 1.0, 1.0, 0.14])
        } else {
            ([0.925, 0.925, 0.935, 1.0], [0.0, 0.0, 0.0, 0.16])
        };
        Some(LayerCB {
            dst: [(center[0] + min_x) / rw, (center[1] + min_y) / rh, bbox[0] / rw, bbox[1] / rh],
            // `src.x` : 1 = warp projectif (caméra réelle). Le mode 14 ne lit pas d'UV.
            src: [warp, 0.0, 0.0, 0.0],
            quad_px: bbox,
            radius_px: frame.radius * scale,
            mode: 14.0,
            color: fill,
            fx: [tl[0], tl[1], tr[0], tr[1]],
            src_prev: [br[0], br[1], bl[0], bl[1]],
            dst_prev: [plane_px[0], plane_px[1], bar_px, line_px],
            mb: line,
            ..Default::default()
        })
    }

    /// Où dessiner le masque d'une annotation « flou » pour qu'il couvre le CONTENU qu'il
    /// cachait au repos, et à quelle force. `None` si le rect est dégénéré.
    ///
    /// C'est l'exception au contrat de `annotation_dst_in`, et elle est voulue. Une flèche ou un
    /// texte peuvent rester immobiles pendant que l'image zoome dessous ; un masque de
    /// confidentialité, non : ancré sur `s_ann`, il masquait un rectangle FIXE de la sortie
    /// pendant que le mot de passe grossissait dans `s_dst` et sortait de dessous — en preview
    /// comme dans le fichier exporté.
    ///
    /// Le contenu à la fraction `f` de l'écran tombe exactement en `s_dst.xy + f * s_dst.wh` :
    /// la coupe source ne dépend pas du zoom (elle est prise à zoom 1), seul `s_dst` en porte
    /// l'agrandissement. Sous un préset 3D il tombe en `centre + quad.point_px(f)`, le warp que
    /// le mode 8 inverse ; un warp bilinéaire restreint à un sous-rectangle est le warp
    /// bilinéaire de ses quatre coins, donc warper ces coins-là est exact.
    ///
    /// Tout arrondi va du côté du SUR-masquage : 1 px de marge autour du rect, la trace du flou
    /// de mouvement incluse, et une force qui ne descend jamais sous celle du repos.
    pub fn privacy_mask(
        &self,
        annotation: &crate::scene::SceneAnnotation,
        render_px: [f32; 2],
    ) -> Option<PrivacyMask> {
        let [rw, rh] = render_px;
        let (x, y, w, h) = (annotation.x, annotation.y, annotation.w, annotation.h);
        if w <= 0.0 || h <= 0.0 || rw <= 0.0 || rh <= 0.0 {
            return None;
        }
        // Un sous-titre (`space: "frame"`) se mesure sur le cadre de sortie, que le zoom ne
        // touche pas. Aucune annotation flou n'envoie la clé aujourd'hui ; si un jour c'est le
        // cas, elle garde le comportement du cadre.
        if annotation.in_frame_space() {
            let dst = annotation_dst_in([0.0, 0.0, 1.0, 1.0], x, y, w, h);
            let dst = pad_rect(dst, render_px, PRIVACY_MASK_PAD_PX);
            return Some(PrivacyMask::upright(dst, render_px, 1.0));
        }
        let upright = annotation_dst_in(self.s_dst, x, y, w, h);
        // Grossissement du zoom : le contenu grandit de `s_dst / s_ann`, le grain du masque doit
        // grandir d'autant, sinon une mosaïque de 12 px ne moyenne plus que 6 px de source sur
        // un zoom x2 et le texte redevient lisible.
        let zoom_k =
            if self.s_ann[3] > 0.0 { (self.s_dst[3] / self.s_ann[3]).max(1.0) } else { 1.0 };

        if !self.tilted() {
            // Le mode 0 étale chaque pixel entre sa position courante et celle de la frame
            // précédente (`dst_prev = s_dst_prev`) : pendant une rampe de zoom, une copie traînée
            // du secret sort du rect courant. Chaque coordonnée étalée reste entre ses deux
            // extrémités, donc la boîte englobante des deux rects la contient.
            // Mêmes conditions que le shader : `(int) mb.x > 1` et `saturate(mb.y) > 0.001`.
            let trail = self.mb_taps >= 2.0 && self.mb_amount > 0.001 && self.s_dst_prev != self.s_dst;
            let rect = if trail {
                union_rect(upright, annotation_dst_in(self.s_dst_prev, x, y, w, h))
            } else {
                upright
            };
            let dst = pad_rect(rect, render_px, PRIVACY_MASK_PAD_PX * zoom_k);
            let mut mask = PrivacyMask::upright(dst, render_px, zoom_k);
            // Un ovale inscrit dans la boîte ÉLARGIE ne contient plus l'ovale courant dès que
            // les deux centres diffèrent : son bord laisserait passer une frange du secret. On
            // retombe alors sur le rectangle, comme le tracé libre.
            mask.oval_ok = !trail;
            return Some(mask);
        }

        // Écran incliné (le mode 8 n'a pas de flou de mouvement : pas de trace à couvrir).
        // Même quad et même centre que le dessin de l'écran et que `plan_cursor`.
        let s_px = [self.s_dst[2] * rw, self.s_dst[3] * rh];
        let quad = self.screen_tilt(s_px)?;
        let centre = [
            (self.s_dst[0] + self.s_dst[2] * 0.5) * rw,
            (self.s_dst[1] + self.s_dst[3] * 0.5) * rh,
        ];
        // La marge se prend en fraction du contenu, comme sur le chemin droit : `zoom_k` px de
        // la boîte zoomée, soit un pixel de la boîte au repos. La projection l'emmène ensuite
        // avec le contenu qu'elle borde.
        let (mx, my) = (
            PRIVACY_MASK_PAD_PX * zoom_k / s_px[0].max(1.0),
            PRIVACY_MASK_PAD_PX * zoom_k / s_px[1].max(1.0),
        );
        let (x0, y0, x1, y1) = (x - mx, y - my, x + w + mx, y + h + my);
        let at = |fx: f32, fy: f32| {
            let (px, py) = quad.point_px(fx, fy);
            [centre[0] + px, centre[1] + py]
        };
        let pts = [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
        let (mut min_x, mut min_y) = (f32::MAX, f32::MAX);
        let (mut max_x, mut max_y) = (f32::MIN, f32::MIN);
        for [px, py] in pts {
            min_x = min_x.min(px);
            min_y = min_y.min(py);
            max_x = max_x.max(px);
            max_y = max_y.max(py);
        }
        // Plancher d'un pixel : un masque très fin ferait diverger le warp inverse.
        let quad_px = [(max_x - min_x).max(1.0), (max_y - min_y).max(1.0)];
        let local = pts.map(|[px, py]| [px - min_x, py - min_y]);
        // La perspective grossit localement le côté proche : la force suit l'arête la plus
        // agrandie par rapport au rect droit zoomé, pour que nulle part le masque ne soit plus
        // fin, rapporté au contenu, qu'au repos.
        let (ew, eh) = ((x1 - x0) * s_px[0], (y1 - y0) * s_px[1]);
        let len = |a: [f32; 2], b: [f32; 2]| (b[0] - a[0]).hypot(b[1] - a[1]);
        let tilt_k = (len(pts[0], pts[1]) / ew)
            .max(len(pts[3], pts[2]) / ew)
            .max(len(pts[0], pts[3]) / eh)
            .max(len(pts[1], pts[2]) / eh);
        Some(PrivacyMask {
            dst: [min_x / rw, min_y / rh, quad_px[0] / rw, quad_px[1] / rh],
            quad_px,
            warp: Some(local),
            projective: quad.projective,
            strength: (zoom_k * tilt_k).max(1.0),
            oval_ok: true,
        })
    }
}

/// Marge ajoutée autour d'un masque de confidentialité, en px de la boîte écran AU REPOS : un
/// pixel n'est couvert que si son CENTRE tombe dans le rect, alors que le bord du contenu, lui,
/// est échantillonné en bilinéaire, sur un demi-texel source. Sans marge, la rangée de bord
/// laisse passer une frange du secret. Sous un zoom la frange grossit avec le contenu, d'où le
/// facteur `zoom_k` appliqué par `privacy_mask`.
pub const PRIVACY_MASK_PAD_PX: f32 = 1.0;

/// Placement d'un masque de confidentialité, prêt pour le mode 10.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrivacyMask {
    /// Rect de dessin, en fractions de sortie : la boîte englobante quand l'écran est incliné.
    pub dst: [f32; 4],
    /// Taille de `dst` en px de sortie.
    pub quad_px: [f32; 2],
    /// Écran incliné : coins TL, TR, BR, BL du masque, en px locaux à `dst` (la convention de
    /// `i.local` dans le shader). `None` : le masque est le rect `dst` lui-même.
    pub warp: Option<[[f32; 2]; 4]>,
    /// `warp` suit l'homographie de ses coins (caméra réelle) plutôt que leur warp bilinéaire.
    pub projective: bool,
    /// Multiplicateur du rayon de flou et du pas de mosaïque, jamais sous 1.
    pub strength: f32,
    /// `false` quand le rect a été élargi à la trace du flou de mouvement : un ovale inscrit
    /// dans ce rect-là ne couvrirait plus l'ovale courant, le backend dessine alors le rect.
    pub oval_ok: bool,
}

impl PrivacyMask {
    fn upright(dst: [f32; 4], render_px: [f32; 2], strength: f32) -> Self {
        Self {
            dst,
            quad_px: [dst[2] * render_px[0], dst[3] * render_px[1]],
            warp: None,
            projective: false,
            strength,
            oval_ok: true,
        }
    }

    /// Les champs du mode 10 qui portent le masque incliné : `(dst_prev, src_prev, mb)`, avec
    /// `dst_prev` = TL, TR, `src_prev` = BR, BL, `mb.z` = 1 et `mb.w` = 1 pour le warp projectif.
    /// Le mode 10 lit déjà `fx` pour ses propres réglages, d'où ces trois champs-là, qu'il ne
    /// lisait pas.
    pub fn warp_fields(&self) -> ([f32; 4], [f32; 4], [f32; 4]) {
        match self.warp {
            None => ([0.0; 4], [0.0; 4], [0.0; 4]),
            Some([tl, tr, br, bl]) => (
                [tl[0], tl[1], tr[0], tr[1]],
                [br[0], br[1], bl[0], bl[1]],
                [0.0, 0.0, 1.0, if self.projective { 1.0 } else { 0.0 }],
            ),
        }
    }
}

fn union_rect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let (x0, y0) = (a[0].min(b[0]), a[1].min(b[1]));
    let (x1, y1) = ((a[0] + a[2]).max(b[0] + b[2]), (a[1] + a[3]).max(b[1] + b[3]));
    [x0, y0, x1 - x0, y1 - y0]
}

fn pad_rect(r: [f32; 4], render_px: [f32; 2], pad_px: f32) -> [f32; 4] {
    let (px, py) = (pad_px / render_px[0], pad_px / render_px[1]);
    [r[0] - px, r[1] - py, r[2] + 2.0 * px, r[3] + 2.0 * py]
}

/// Où va chaque calque, pour une frame — sans toucher au GPU.
///
/// C'est la première moitié de `compose_frame`, mot pour mot : 353 lignes qui ne
/// contenaient pas un seul appel D3D11. Les deux backends doivent produire ces
/// placements au pixel près (la propriété « iso-render » que le projet mesure), et la
/// seule façon fiable d'y arriver est qu'ils appellent la même fonction.
pub fn plan_frame(input: &FrameGeometryInput) -> FrameGeometry {
    let (rw, rh) = (input.render_px[0], input.render_px[1]);
    let (stw, sth) = (input.screen_tex_px[0], input.screen_tex_px[1]);
    let (scw, sch) = (input.screen_visible_px[0], input.screen_visible_px[1]);
    let (wcw, wch) = (input.webcam_visible_px[0], input.webcam_visible_px[1]);
    let (u_max, v_max) = (input.u_max, input.v_max);
    let (frame, cfg) = (input.frame, input.cfg);
    let lp = input.live;
    let scene = input.scene;
    let cursor = input.cursor;

        // Scène de l'app présente → placements du layout preset (ou, mieux, le rect résolu par
        // l'app dans `layout.webcam_rect`) ; sinon planning fixture (bench).
        let scene_preset: Option<String> =
            scene.map(|s| s.layout.preset.clone());
        // Webcam rect résolu par l'app (= `computeCompositeLayout`, source de vérité unique
        // entre preview et natif) : quand il est présent ET que la scène est posée, on l'utilise
        // COMME placement de base. Sinon, fallback sur `preset_placements` historique (PiP
        // codé en dur à 320 px + 40 px de marge — l'arrangement qui dérivait de la preview).
        let app_webcam_rect: Option<[f32; 4]> = scene
            .and_then(|s| s.layout.webcam_rect)
            .map(|r| [r.x, r.y, r.width, r.height]);
        // Idem pour l'écran. Les deux rects viennent du MÊME appel `computeCompositeLayout`, donc
        // les consommer ensemble est la seule façon de garder le bloc écran+caméra cohérent :
        // n'en prendre qu'un revenait à mélanger la géométrie de l'app et un placement fixture.
        let app_screen_rect: Option<[f32; 4]> = scene
            .and_then(|s| s.layout.screen_rect)
            .map(|r| [r.x, r.y, r.width, r.height]);
        let (mut p, mut pp) = match &scene_preset {
            Some(preset) => {
                // Chaque rect résolu par l'app remplace INDÉPENDAMMENT sa contrepartie du
                // preset ; sinon celle du preset reste (le padding slider l'insèrera ensuite
                // dans `scale_frame`).
                //
                // Avant, ce match portait sur `app_webcam_rect` et le rect ÉCRAN n'était donc
                // honoré que si un rect webcam arrivait aussi. Un layout sans caméra gardait
                // l'écran plein cadre du preset — pendant que `fit_screen` (plus bas) coupait
                // quand même son fit au ratio du crop, puisqu'un `app_screen_rect` était bien
                // présent. Résultat : un clip recadré sans caméra était étiré, et aucune des
                // deux voies ne le rattrapait. Coupler l'écran à la présence de la caméra
                // n'avait aucune raison d'être — ce sont deux calques indépendants.
                let mut fp = preset_placements(preset);
                if let Some(wr) = app_webcam_rect {
                    fp.webcam.dst = wr;
                }
                if let Some(sr) = app_screen_rect {
                    fp.screen.dst = sr;
                }
                (fp, fp) // layout statique → vélocité nulle
            }
            None => (timeline(frame, cfg), timeline(frame - 1.0, cfg)),
        };
        // Motion blur écran : quand la scène (contrat de l'app) est posée, c'est elle qui pilote
        // (parité inspector : 1.0 + motion_blur*15 taps), sinon on retombe sur `cfg.mblur_n`
        // (le bench fixture continue d'utiliser ses taps explicites).
        let mb_taps = scene
            .map(|s| 1.0 + s.effects.motion_blur.clamp(0.0, 1.0) * 15.0)
            .unwrap_or(cfg.mblur_n as f32);
        let mb_amount = scene
            .map(|s| s.effects.motion_blur.clamp(0.0, 1.0))
            .unwrap_or(if cfg.mblur_n > 1 { 1.0 } else { 0.0 });

        // Zoom regions + Full Camera : filtrées en amont pour le clip actif et échantillonnées
        // dans le même référentiel source que le PTS du décodeur écran.
        let empty_zoom: Vec<crate::scene::SceneZoomRegion> = Vec::new();
        let empty_cam: Vec<crate::scene::SceneCameraFullscreenRegion> = Vec::new();
        let zoom_regions = scene.map(|s| &s.zoom_regions).unwrap_or(&empty_zoom);
        let cam_regions =
            scene.map(|s| &s.camera_fullscreen_regions).unwrap_or(&empty_cam);
        let webcam_reactive = scene.map(|s| s.layout.webcam_reactive_zoom).unwrap_or(false);
        let source_t = input.timeline_t_override.unwrap_or(frame / FPS);
        let source_t_prev = source_t - 1.0 / FPS;
        // le focus "auto" (suivi curseur) réutilise la même piste que le rendu du curseur.
        let cursor_for_zoom = cursor;
        // La rotation 3D (mode 8, pas de motion blur dans ce chemin — cf. le commentaire au
        // point d'appel) n'est calculée QUE pour la frame courante ; `pp` ne sert qu'au zoom
        // écran normal (vélocité pour le motion blur du chemin non-tilté).
        let mut zoom_rotation = [0.0f32; 3];
        let mut zoom_tilt = 0.0f32;
        let mut zoom_click_impact = 0.0f32;
        let mut zoom_camera = 0.0f32;
        let mut zoom_aim = [0.5f32; 2];
        let mut zoom_orbit = [0.5f32; 2];
        // Curseur masqué → pas de piste pour ce qui anime le plan (parallaxe, impact, caméra
        // `follow-cursor`) : l'export ne charge la piste que si le curseur est affiché
        // (`timeline_walk`), la preview toujours. Sans cette porte, la preview pencherait un
        // plan que l'export laisse immobile.
        let parallax_track = cursor_for_zoom.filter(|_| scene.is_some_and(|s| s.cursor.show));
        let active_crop = scene.and_then(|scene| {
            scene.crop_by_clip.get(scene.active_clip_index).copied().flatten()
        });
        if !zoom_regions.is_empty() {
            // La caméra `follow-cursor` lit le curseur dans l'image SOURCE recadrée — pas dans la
            // coupe zoomée, qu'un focus auto recentre sur lui — et ignore ce qu'une coupe retire.
            let camera = crate::regions::CameraFrame {
                track: parallax_track,
                crop: normalized_crop(active_crop),
                window: scene
                    .and_then(|s| s.clips.get(s.active_clip_index))
                    .map(|c| [c.source_start_sec as f32, c.source_end_sec as f32])
                    .unwrap_or([f32::NEG_INFINITY, f32::INFINITY]),
            };
            let zs = crate::regions::zoom_state_in(zoom_regions, source_t, cursor_for_zoom, &camera);
            p.zoom = zs.scale;
            p.focus = zs.focus;
            zoom_rotation = zs.rotation;
            zoom_tilt = zs.tilt;
            zoom_click_impact = zs.click_impact;
            zoom_camera = zs.camera;
            zoom_aim = zs.aim;
            zoom_orbit = zs.orbit;
            let zs_p = crate::regions::zoom_state_at(zoom_regions, source_t_prev, cursor_for_zoom);
            pp.zoom = zs_p.scale;
            pp.focus = zs_p.focus;
        }
        // Full Camera ignore le rétrécissement réactif de la webcam (design web : mélanger
        // "rétrécit pour le zoom" et "grandit en plein cadre" dans la même frame n'a pas de sens).
        let cam_progress = crate::regions::camera_fullscreen_progress_at(cam_regions, source_t);
        let cam_progress_prev =
            crate::regions::camera_fullscreen_progress_at(cam_regions, source_t_prev);
        // rétrécissement réactif : la webcam rétrécit pendant un zoom actif (1/zoom, plancher
        // 0.35 — parité `reactiveWebcamScale`, TS). Ignoré pendant Full Camera (voir ci-dessus).
        let reactive_scale = |zoom: f32, progress: f32| -> f32 {
            if webcam_reactive && progress <= 0.0 && zoom.is_finite() && zoom > 0.0 {
                (1.0 / zoom).clamp(0.35, 1.0)
            } else {
                1.0
            }
        };
        // `lp.webcam_size_scale` vient de `scene.layout.webcamSize` (voir `live_params_from_scene`)
        // — le MÊME nombre que le fraction webcamSizePreset déjà pris en compte côté app pour
        // calculer `wr` (`computeCompositeLayout`, TS). Quand l'app fournit un `webcam_rect`
        // explicite, la taille y est donc déjà cuite : réappliquer `lp.webcam_size_scale` ici
        // double-échelonnerait la boîte (ex. un preset 34% → webcam rendue à ~34%×34% ≈ 12% au
        // lieu de 34%, la webcam apparaissant bien plus petite que ce que montre l'aperçu web).
        // Seul `reactive_scale` (rétrécissement pendant un zoom, une valeur ANIMÉE par frame que
        // le rect statique de l'app ne capture pas) doit encore s'appliquer dans ce cas.
        let base_size_scale = if app_webcam_rect.is_some() { 1.0 } else { lp.webcam_size_scale };
        let webcam_size_scale = base_size_scale * reactive_scale(p.zoom, cam_progress);
        let webcam_size_scale_prev = base_size_scale * reactive_scale(pp.zoom, cam_progress_prev);

        // padding : échelle globale du layout autour du centre du cadre (parité web frameRenderer :
        // paddingScale = 1 - padding*0.4 → padding 0 = plein cadre). S'applique à TOUS les presets :
        // côté web, side-by-side et top/bottom soudent écran+caméra en un bloc unique et c'est ce
        // bloc que le padding rétrécit (cf. `compositeLayout.ts`, branche `block`). Vertical-stack
        // en était exempté tant qu'il était full-bleed ; il ne l'est plus.
        let padding_scale = 1.0 - lp.padding * 0.4;
        let scale_frame = |dst: [f32; 4], s: f32| -> [f32; 4] {
            [0.5 + (dst[0] - 0.5) * s, 0.5 + (dst[1] - 0.5) * s, dst[2] * s, dst[3] * s]
        };
        // webcam : ancrée à son coin bas-droite (grandit vers le haut-gauche, pas depuis le centre).
        let scale_corner_br = |dst: [f32; 4], s: f32| -> [f32; 4] {
            let (brx, bry) = (dst[0] + dst[2], dst[1] + dst[3]);
            let (nw, nh) = (dst[2] * s, dst[3] * s);
            [brx - nw, bry - nh, nw, nh]
        };
        // parité web (compositeLayout) : rectangle/rounded gardent le ratio natif de la webcam ;
        // square/circle forcent un carré (side = min). Le placement de base est carré → on ajuste
        // ici, en gardant le coin bas-droite fixe (cohérent avec le size-scale).
        let is_square_shape = matches!(lp.webcam_shape, 1 | 2); // circle | square
        let cam_ar = if is_square_shape { 1.0 } else { (wcw / wch).max(0.01) };
        let fit_cam_aspect = |dst: [f32; 4]| -> [f32; 4] {
            let s = (dst[2] * rw).min(dst[3] * rh); // côté carré de base (px)
            let (pw, ph) = if cam_ar >= 1.0 { (s, s / cam_ar) } else { (s * cam_ar, s) };
            let (nw, nh) = (pw / rw, ph / rh);
            let (brx, bry) = (dst[0] + dst[2], dst[1] + dst[3]);
            [brx - nw, bry - nh, nw, nh]
        };
        // Variantes ancrées au CENTRE (au lieu du coin bas-droite) de `dst`, pour le cas où
        // `dst` vient de `app_webcam_rect` : ce rect est déjà la position que l'utilisateur a
        // choisie/déplacée (résolue côté app via `computeCompositeLayout`, même convention
        // centre-fraction que `cx`/`cy` dans `compositeLayout.ts`) — l'ancrer au coin bas-droite
        // comme le fait `fit_cam_aspect` (pensé pour le placement par DÉFAUT, ancré à ce coin
        // avec une marge fixe) réancre silencieusement la webcam glissée n'importe où d'autre à
        // ce coin, ignorant la position réelle choisie par l'utilisateur — le bug rapporté
        // (webcam glissée au coin bas-gauche, DOM/JSON envoyé au natif confirmant une position
        // flush, mais rendu natif visiblement décalé). Le centre est le point fixe qui a un sens
        // pour un rect DÉJÀ positionné par l'app ; le coin bas-droite n'a de sens que pour le
        // placement par défaut, qui grandit depuis ce coin faute de position explicite.
        let scale_center = |dst: [f32; 4], s: f32| -> [f32; 4] {
            let (cx, cy) = (dst[0] + dst[2] * 0.5, dst[1] + dst[3] * 0.5);
            let (nw, nh) = (dst[2] * s, dst[3] * s);
            [cx - nw * 0.5, cy - nh * 0.5, nw, nh]
        };
        // Le ratio de sortie réel (peut différer du canvas interne 16:9 fixe) et le facteur
        // d'étirement non uniforme que `blit_resized` appliquera en fin de pipeline — nécessaires
        // ici (avant `undistort`, plus bas) pour que le fit ci-dessous cible le ratio de boîte tel
        // qu'il apparaîtra APRÈS cet étirement, pas tel qu'il est dans l'espace canvas pré-étirement
        // (sinon le fit et l'undistort composent deux corrections indépendantes et sur-rétrécissent
        // le contenu — cf. rapport utilisateur : crop 9:16 + sortie 9:16 + padding 0% laissait
        // quand même une grosse marge, alors que le crop correspond déjà exactement au cadre).
        // Le crop de l'utilisateur (dialogue "Edit clip") a son PROPRE ratio (ex. une bande
        // verticale 9:16 recadrée dans une source 16:9) — le zoom appliqué ensuite (§
        // `screen_source_rect`) le préserve (mêmes facteurs sur les deux axes), donc c'est bien
        // le ratio du CROP qui doit dimensionner le quad de destination, pas celui (fixe, issu
        // du preset de layout) de `p.screen.dst`. Sans ça, le rect recadré (dont le ratio propre
        // diffère de la boîte du preset) se retrouve étiré pour remplir cette boîte — parité web
        // cassée : `computeCompositeLayout`/`centerRectInBounds` (TS) contiennent déjà le crop
        // dans sa boîte en respectant son ratio, le natif ne le faisait pas (rapport utilisateur).
        let crop_aspect = match active_crop {
            Some(c) if c.width > 0.0001 && c.height > 0.0001 => {
                (c.width * scw) / (c.height * sch).max(0.0001)
            }
            _ => scw / sch.max(0.0001),
        };
        // Contain (parité `centerRectInBounds`) : rétrécit `dst` (centré) pour que son ratio
        // devienne `aspect`, sans jamais dépasser sa boîte d'origine — mais la boîte de référence
        // doit être mesurée telle qu'elle apparaîtra APRÈS l'étirement de sortie (`dst` * ratio de
        // sortie), pas dans l'espace canvas 16:9 pré-étirement : sinon le fit cible le mauvais
        // ratio de boîte dès que la sortie n'est pas 16:9. `undistort` (plus bas) annule ensuite
        // exactement ce même facteur, donc convertir le résultat en fraction canvas se fait par
        // `/ uniform_stretch` (propriété de `undistort` : le ratio final ne dépend que de la
        // taille de `dst` en PIXELS CANVAS, jamais du ratio de sortie choisi).
        let fit_dst_to_aspect = |dst: [f32; 4], aspect: f32| -> [f32; 4] {
            let box_w_px = dst[2] * rw;
            let box_h_px = dst[3] * rh;
            let box_ar = box_w_px / box_h_px.max(0.0001);
            let (nw_px, nh_px) = if aspect > box_ar {
                (box_w_px, box_w_px / aspect.max(0.0001))
            } else {
                (box_h_px * aspect, box_h_px)
            };
            let (nw, nh) = (nw_px / rw, nh_px / rh);
            let (cx, cy) = (dst[0] + dst[2] * 0.5, dst[1] + dst[3] * 0.5);
            [cx - nw * 0.5, cy - nh * 0.5, nw, nh]
        };
        // Quand l'app a résolu la boîte écran, elle a DÉJÀ appliqué le padding (le rect est
        // calculé contre `maxContentSize`) et l'a DÉJÀ mise au ratio du crop
        // (`computeCompositeLayout` reçoit la taille de la source recadrée) : rejouer
        // `scale_frame` + `fit_dst_to_aspect` par-dessus appliquerait le padding deux fois et
        // re-contiendrait une boîte déjà au bon ratio. Même raisonnement que pour la webcam.
        let fit_screen = |dst: [f32; 4]| {
            if app_screen_rect.is_some() {
                dst
            } else {
                fit_dst_to_aspect(scale_frame(dst, padding_scale), crop_aspect)
            }
        };
        // Issue #179 : le zoom se jouait entièrement dans la coupe source, donc la boîte
        // écran restait au rect paddé et le zoom butait sur cette frontière au lieu
        // d'atteindre les bords du cadre. On rend le zoom à la BOÎTE (cf. `remap_box`) :
        // la coupe dessinée redevient le crop nu, la boîte porte le grossissement et
        // déborde le padding — c'est la géométrie de `applyZoomTransform` (TS).
        let s_box = fit_screen(p.screen.dst);
        let s_box_prev = fit_screen(pp.screen.dst);
        // Cadre de fenêtre : l'écran rétrécit pour que lui ET son cadre tiennent dans la boîte
        // où il tenait seul — le padding garde donc son sens, et rien ne sort du canvas. Le reste
        // du calcul (cover, zoom, rayon) part de cette boîte rétrécie.
        let frame_kind = scene.map(|s| s.effects.frame).unwrap_or_default();
        let screen_cover = scene.map(|s| s.layout.screen_cover).unwrap_or(false);
        let (s_base, frame_margins) = match frame_kind {
            crate::scene::SceneFrame::None => (s_box, None),
            _ => {
                let (b, m) = fit_in_window_frame(s_box, [rw, rh], screen_cover);
                (b, Some(m))
            }
        };
        let s_base_prev = match frame_margins {
            None => s_box_prev,
            Some(_) => fit_in_window_frame(s_box_prev, [rw, rh], screen_cover).0,
        };
        // Layouts "bloc" (side-by-side / top-bottom) : la boîte écran est un SLOT au ratio
        // arbitraire, et le web y fait tenir l'image en `cover` (`computeCompositeLayout`
        // renvoie `screenCover: true`, honoré par `frameRenderer`). Le natif l'ignorait, donc
        // il étirait la source pour remplir le slot — visible dès que le clip est recadré,
        // puisque le crop éloigne encore le ratio de la source de celui du slot.
        //
        // Le cover s'applique APRÈS le crop et le zoom, sur leur rect résultant : le crop
        // décide quoi montrer, le zoom où regarder, le cover comment habiller la boîte. Son
        // ratio de boîte se lit sur `s_base` : `remap_box` met les deux axes à la même
        // échelle, donc la boîte finale a le même ratio et le cover ne dépend pas d'elle
        // (ce qui casserait la circularité coupe → boîte → coupe).
        let cover_box_ar = scene.and_then(|s| {
            s.layout
                .screen_cover
                .then_some((s_base[2] * rw) / (s_base[3] * rh).max(0.0001))
        });
        let cover = |uv: [f32; 4]| -> [f32; 4] {
            match cover_box_ar {
                Some(ar) => cover_uv_rect(uv, [stw as f32, sth as f32], ar),
                None => uv,
            }
        };
        // La coupe RÉFÉRENCE (zoom entier) est celle qui remplissait la boîte paddée avant
        // ce correctif ; la coupe DESSINÉE ne porte plus que le crop. `remap_box` reporte la
        // seconde à travers le mapping de la première, ce qui conserve le cadrage exact.
        // Le focus courant reste volontairement utilisé pour la frame précédente, comme avant.
        let cut_ref = cover(screen_source_rect(u_max, v_max, active_crop, p.zoom, p.focus));
        let cut_ref_prev = cover(screen_source_rect(u_max, v_max, active_crop, pp.zoom, p.focus));
        let cut = cover(screen_source_rect(u_max, v_max, active_crop, 1.0, p.focus));
        // Impact du clic : mêmes piste, coupe, porte et budget que la parallaxe sous un angle fixe ;
        // sous la caméra réelle, les mêmes clics font reculer l'œil.
        let (impact, press) = match (scene, parallax_track) {
            (Some(s), Some(track)) if zoom_click_impact > 0.0 => {
                let (tilt, press) = click_impact_at(s, cfg, &lp, track, source_t, cut, [u_max, v_max]);
                (tilt.map(|d| d * zoom_click_impact), press * zoom_click_impact)
            }
            _ => ([0.0; 3], 0.0),
        };
        // Sous la caméra réelle, la visée et l'orbite vivent dans le recadrage, comme le focus :
        // même report dans la coupe (un cover la rogne). La mise au point suit le pointeur lissé
        // (l'orbite), pas le point visé : celui-ci reste au centre au zoom 1 et bute sur sa portée
        // au zoom, là où le spectateur regarde le pointeur.
        let camera = (zoom_camera > 0.0).then(|| crate::camera::CameraPose {
            weight: zoom_camera,
            aim: focus_in_cut(u_max, v_max, active_crop, zoom_aim, cut),
            orbit: focus_in_cut(u_max, v_max, active_crop, zoom_orbit, cut),
            zoom: p.zoom,
            press,
        });
        let focus_plane = match camera {
            Some(pose) => pose.orbit,
            None => focus_in_cut(u_max, v_max, active_crop, p.focus, cut),
        };
        let s_dst = remap_box(s_base, cut_ref, cut);
        // Parallaxe : calculée ici, une fois la coupe connue — elle mesure la vitesse du curseur
        // en coupes VISIBLES par seconde. La coupe visible est `cut_ref`, zoom compris : `cut`
        // ne porte plus que le crop depuis #179, et sous un x2 le même geste traverse deux fois
        // plus d'écran. La coupe passe au repère normalisé du curseur.
        let cut_norm = [
            cut_ref[0] / u_max.max(1e-6),
            cut_ref[1] / v_max.max(1e-6),
            cut_ref[2] / u_max.max(1e-6),
            cut_ref[3] / v_max.max(1e-6),
        ];
        let zoom_rotation_dyn = crate::regions::dynamic_tilt(
            source_t,
            parallax_track,
            cut_norm,
            zoom_tilt,
            impact,
        );
        let s_dst_prev = remap_box(s_base_prev, cut_ref_prev, cut);
        // le padding n'affecte QUE l'écran (la quantité de fond révélée). La webcam reste ancrée
        // en bas-droite à sa marge fixe, quelle que soit la valeur de padding (pas de scale_frame)
        // — SAUF quand l'app a résolu un placement explicite (`app_webcam_rect`, drag-to-reposition
        // compris). Ce rect est déjà exprimé en fraction du VRAI output (calculé côté web par
        // `computeCompositeLayout` avec les vraies dimensions de sortie), position ET aspect déjà
        // corrects — `fit_cam_aspect`/`scale_corner_br` (chemin preset par défaut) sont donc
        // doublement inadaptés ici : ils réancrent au coin bas-droite (ignorant la position
        // choisie par l'utilisateur) ET recalculent l'aspect en pixels du canvas fixe 16:9
        // (`OUT_W`×`OUT_H`), une référence différente du vrai output dès que la sortie n'est pas
        // 16:9 (rapport utilisateur : webcam glissée au coin bas-gauche en 9:16, JSON envoyé au
        // natif confirmant une position flush, mais rendu native visiblement décalé ET trop
        // petit). On garde seulement `scale_center` (zoom réactif, préserve position+aspect) puis
        // on pré-compense par `inverse_undistort` pour annuler le `undistort()` générique
        // appliqué plus bas à tous les calques (écran compris) — sans quoi ce rect déjà correct
        // se ferait déformer une seconde fois par cet undistort partagé.
        let mut w_dst = if app_webcam_rect.is_some() {
            scale_center(p.webcam.dst, webcam_size_scale)
        } else {
            fit_cam_aspect(scale_corner_br(p.webcam.dst, webcam_size_scale))
        };
        let mut w_dst_prev = if app_webcam_rect.is_some() {
            scale_center(pp.webcam.dst, webcam_size_scale_prev)
        } else {
            fit_cam_aspect(scale_corner_br(pp.webcam.dst, webcam_size_scale_prev))
        };

        // Full Camera : la caméra PREND le cadre — parité `computeCameraFullscreenRect` (TS).
        // La cible est exactement [0,0,1,1] : pas de marge, pas de padding, pas d'arrondi, et
        // plus rien de la composition (fond, écran, ombre) derrière. Le rect change de ratio en
        // chemin, mais `cover_crop_uv` (plus bas) dérive la coupe source du ratio RÉEL de la
        // boîte à chaque frame : la caméra n'est donc jamais étirée pendant l'animation.
        let fullscreen_dst = |dst: [f32; 4], progress: f32| -> [f32; 4] {
            if progress <= 0.0 {
                return dst;
            }
            let lerp = |a: f32, b: f32| a + (b - a) * progress;
            [lerp(dst[0], 0.0), lerp(dst[1], 0.0), lerp(dst[2], 1.0), lerp(dst[3], 1.0)]
        };
        // Petit côté de la boîte caméra AVANT que Full Camera ne la fasse grandir. C'est la
        // référence du rayon de coin : le zoom réactif est déjà dedans (il rétrécit la boîte,
        // donc l'arrondi suit tout seul — parité `borderRadius * reactiveFactor` côté TS), alors
        // que Full Camera ne fait pas grossir l'arrondi, il le DISSOUT (cf. `shape_fade`).
        let w_nominal_min = (w_dst[2] * rw).min(w_dst[3] * rh);
        w_dst = fullscreen_dst(w_dst, cam_progress);
        w_dst_prev = fullscreen_dst(w_dst_prev, cam_progress_prev);

        // Contre-étirement "fit" : le canvas interne compose TOUJOURS en OUT_W×OUT_H (16:9),
        // puis `blit_resized` étire tout, de façon non uniforme si besoin, vers la résolution
        // de sortie demandée — voulu pour que le FOND (dessiné plus bas en dst=[0,0,1,1])
        // remplisse tout le cadre quel que soit le ratio choisi. Mais l'écran et la webcam ne
        // doivent PAS être déformés par cet étirement : on rétrécit ici leur rect de
        // destination (centré, dans cet espace 16:9 PRÉ-étirement) par l'inverse du plus fort
        // des deux facteurs d'étirement, pour qu'après l'étirement final leur ratio d'origine
        // reste préservé (letterboxé/pillarboxé sur le fond, qui lui reste plein cadre) — mode
        // "fit"/contain. Si l'utilisateur veut un rendu "fill" (remplir sans bandes), il ajuste
        // le crop lui-même ; le natif ne fait plus ce choix à sa place en étirant l'image.
        // Le dessin du coin (SDF, shaders.hlsl) compare le rayon à `quad_px`, exprimé en px du
        // RENDER TARGET : c'est donc dans cet espace-là qu'il faut le lui donner.
        //
        // Toutes les longueurs de la scène sont des FRACTIONS ; on les multiplie ici par ce
        // qu'elles mesurent, dans l'espace du render target. C'est ce qui rend preview et export
        // identiques : « un pixel » n'y désigne pas la même chose (la preview rastérise dans un
        // cadre contain-fitté plus petit, cf. `preview_render_size`), alors qu'une fraction, si.
        // `frame_min_px` est la référence des quantités relatives au CADRE ; un rayon de coin,
        // lui, se mesure contre sa propre boîte — il doit rester en place quand on redimensionne
        // la boîte, pas suivre le cadre.
        let frame_min_px = rw.min(rh);
        let s_min_px = (s_dst[2] * rw).min(s_dst[3] * rh);
        let app_screen_radius_frac = scene.and_then(|s| s.layout.screen_radius_frac);
        let scene_roundness_frac = scene.map(|s| s.effects.roundness_frac);
        // Le rayon suit la boîte : quand le zoom l'agrandit (issue #179), les coins grandissent
        // avec elle puis sortent du cadre — comme le masque de la référence, qui porte le même
        // `br: maskBorderRadius * camS` et quitte l'étage au même moment.
        // Avec un cadre, le rayon appartient au CADRE : c'est sa boîte extérieure qui sert de
        // référence, et Roundness arrondit le cadre au lieu de doubler un arrondi d'écran.
        let rounded_box_min_px = match frame_margins {
            None => s_min_px,
            Some([ml, mt, mr, mb]) => {
                ((s_dst[2] * rw) * (1.0 + ml + mr)).min((s_dst[3] * rh) * (1.0 + mt + mb))
            }
        };
        let outer_radius = match (cfg.rounded, app_screen_radius_frac, scene_roundness_frac) {
            (false, _, _) => 0.0,
            // Preset en bloc : le rayon appartient à la boîte écran (parité exacte avec la caméra).
            (true, Some(f), _) => f * rounded_box_min_px,
            // Scène sans rayon imposé : slider Roundness, relatif au cadre.
            (true, None, Some(f)) => f * frame_min_px,
            // Fixture/bench (pas de scène) : chemin inspector historique, inchangé.
            (true, None, None) => p.screen.radius * lp.radius_scale,
        };
        // Sous un cadre, l'écran est rentré du filet : ses coins bas restent concentriques à
        // ceux du cadre en perdant l'épaisseur du filet ; ses coins hauts sont carrés (shader).
        let window_frame = frame_margins.map(|margins| WindowFrame {
            dark: frame_kind == crate::scene::SceneFrame::WindowDark,
            margins,
            radius: outer_radius,
        });
        let s_radius = match frame_margins {
            None => outer_radius,
            Some([ml, ..]) => (outer_radius - ml * s_dst[2] * rw).max(0.0),
        };
        let w_px = [w_dst[2] * rw, w_dst[3] * rh];
        // Rayon caméra. Le slider Roundness ne s'y applique jamais (il ne vaut que pour l'ÉCRAN).
        // Quand l'app le résout (`computeCompositeLayout`, source unique), on le prend : c'est la
        // seule façon que les deux moitiés d'un layout en bloc soient encadrées à l'identique,
        // l'écran consommant déjà `screen_radius_frac` du même calcul. La table ci-dessous en
        // était une SECONDE, indépendante — fraction différente (0.12 vs 0.06 côté web) et sans
        // bornes — donc écran et caméra ne pouvaient pas s'accorder.
        let app_webcam_radius_frac = scene.and_then(|s| s.layout.webcam_radius_frac);
        // Full Camera dissout la forme en même temps qu'elle prend le cadre : le rayon fond
        // vers 0 avec `cam_progress`, donc le cercle devient un rect à coins de plus en plus
        // francs puis un plein cadre net — aucun masque ne survit au plein écran (parité
        // `computeCameraFullscreenRect`, qui ramène `maskShape` à "rectangle" et lerpe le
        // rayon vers 0 pour exactement la même raison).
        let shape_fade = (1.0 - cam_progress).clamp(0.0, 1.0);
        let w_radius = shape_fade
            * w_nominal_min
            * match app_webcam_radius_frac {
                Some(f) => f,
                // Fallback (payload sans fraction, fixture/bench) : l'ancienne table, keyée sur la
                // forme. Rectangle ET square n'ont qu'un léger arrondi (0.12) et ne diffèrent que
                // par le ratio ; rounded est nettement plus arrondi (0.3) ; circle = demi-côté.
                None => match lp.webcam_shape {
                    1 => 0.5,
                    3 => 0.3,
                    _ => 0.12,
                },
            };

    FrameGeometry {
        scene_preset,
        mb_taps,
        mb_amount,
        source_t,
        programme_t: input.programme_time.unwrap_or(frame / FPS),
        zoom_rotation,
        zoom_rotation_dyn,
        camera,
        padding_scale,
        cut,
        focus_plane,
        // Sans scène (bench fixture), aucune zoom region, donc aucun tilt : rien à défocaliser.
        depth_of_field: scene.is_some_and(|s| s.effects.depth_of_field),
        s_dst,
        s_dst_prev,
        // La boîte écran telle qu'elle serait sans zoom : `remap_box` n'est PAS appliqué. Le
        // cadre, lui, l'est : c'est le rect du CONTENU, celui où l'overlay web pose ses poignées
        // (`fitInWindowFrame` côté TS, même calcul), et sans quoi un flou tracé sur un secret
        // tombait une barre de titre plus haut que ce qu'il devait couvrir.
        s_ann: s_base,
        s_radius,
        frame_min_px,
        w_dst,
        w_dst_prev,
        w_px,
        w_radius,
        shape_fade,
        window_frame,
    }
}

/// Le curseur, prêt à dessiner : où, à quelle taille, avec quelle traînée.
///
/// Extrait de la moitié « dessin » de `compose_frame` pour la même raison que
/// `plan_frame` : deux backends qui doivent poser le curseur au pixel près ne peuvent pas
/// entretenir deux copies de ce mapping. Le placement dépend de la coupe source, du zoom,
/// du padding et de l'inclinaison — autant d'endroits où deux implémentations dérivent.
pub struct CursorPlan {
    pub placement: CursorPlacement,
    /// Placement à `t - trail_frames/FPS`, pour la traînée. `placement` quand il n'y en a pas.
    pub prev_placement: CursorPlacement,
    /// Côté du sprite en px de sortie (bounce et padding déjà appliqués).
    pub size_px: f32,
    /// Nombre d'échantillons de la traînée. 1 = curseur net, pas d'accumulation.
    pub taps: u32,
    /// Rect de clip « Clip to canvas » (mode 4/7 du shader lit `fx`).
    pub clip: [f32; 4],
    /// État du curseur à cet instant (`arrow`, `pointer`, …) pour choisir le sprite.
    pub cursor_type: Option<String>,
    /// Opacité effective (0..1) tenant compte de l'inactivité (auto-hide) et du zoom.
    pub alpha: f32,
    /// Curseur modélisé (mode 15) : `Some` quand le réglage est allumé, que le thème est celui par
    /// défaut et que l'état résout un sprite (le sien, sinon la flèche) ; sa pose tient déjà compte
    /// de la part « pointeur » de ce sprite. Le placement est alors toujours `Tilted` (quad
    /// identité sur un écran droit), et le sprite est extrudé au lieu d'être posé à plat.
    pub model: Option<CursorPose>,
    /// L'impact des clics récents sur l'écran (mode 16), à dessiner SOUS le curseur. Vide sans
    /// curseur modélisé, sans clic récent ou à `clickBounce` nul.
    pub impacts: Vec<LayerCB>,
}

impl CursorPlan {
    /// Le plan tel qu'un backend le dessine. La traînée du curseur modélisé coûte une marche
    /// de rayons par copie : mesuré en 1080p (taille 10, 16 copies), +0,6 à +0,9 ms/frame sur GPU
    /// mais +68 à +98 ms sur WARP. Le backend logiciel ne dessine donc que la tête ; le sprite
    /// plat, lui, garde sa traînée partout.
    pub fn for_backend(mut self, cpu_backend: bool) -> CursorPlan {
        if cpu_backend && self.model.is_some() {
            self.taps = 1;
            self.prev_placement = self.placement;
        }
        self
    }
}

/// Ce que `plan_cursor` doit savoir en plus de `FrameGeometry`.
pub struct CursorPlanInput<'a> {
    pub render_px: [f32; 2],
    pub u_max: f32,
    pub v_max: f32,
    pub cfg: &'a Cfg,
    pub live: LiveParams,
    pub scene: Option<&'a Scene>,
    pub track: &'a crate::cursor::CursorTrack,
    /// Temps curseur, déjà résolu (`cursor_t_override` ou `frame / FPS`).
    pub t: f32,
}

/// Opacité du curseur à `t`, avant placement : 0 quand il est masqué (`cursor.show`), sinon
/// l'auto-hide × le `hideCursor` des régions de zoom. Partagée par `plan_cursor` et l'impact du
/// clic : le plan ne bascule que sous un pointeur qu'on voit.
pub fn cursor_alpha(
    scene: Option<&Scene>,
    cfg: &Cfg,
    live: &LiveParams,
    track: &crate::cursor::CursorTrack,
    t: f32,
) -> f32 {
    if !scene.map(|s| s.cursor.show).unwrap_or(cfg.cursor) {
        return 0.0;
    }
    let idle_alpha = track.opacity_at(t, live.cursor_auto_hide);
    let zoom_alpha = match scene {
        Some(s) => crate::regions::zoom_cursor_alpha(&s.zoom_regions, t),
        None => 1.0,
    };
    idle_alpha * zoom_alpha
}

/// Où tombe la position curseur `p` (repère normalisé de l'écran) dans la coupe `cut` (UV
/// texture), en fraction 0..1 par axe ; `None` hors coupe. Le test « pointeur dans la coupe »
/// de `plan_cursor`, repris tel quel par l'impact du clic.
pub fn cursor_plane_point(cut: [f32; 4], uv_max: [f32; 2], p: (f32, f32)) -> Option<[f32; 2]> {
    let [su0, sv0, su1, sv1] = cut;
    let (hu, hv) = ((su1 - su0) * 0.5, (sv1 - sv0) * 0.5);
    let fx = (p.0 * uv_max[0] - su0) / (2.0 * hu);
    let fy = (p.1 * uv_max[1] - sv0) / (2.0 * hv);
    ((0.0..=1.0).contains(&fx) && (0.0..=1.0).contains(&fy)).then_some([fx, fy])
}

/// L'impact des clics (`regions::click_impact`) avec les portes qui dépendent de la scène, à
/// multiplier encore par le poids des régions (`ZoomState::click_impact`) ; la porte du préset
/// vient ensuite, dans `dynamic_tilt`.
///
/// - curseur visible (`cursor_alpha`) : `cursor.show` explicite, parce que l'export ne charge la
///   piste que si le curseur est affiché alors que la preview la charge toujours ;
/// - clics dans la fenêtre source du clip actif seulement (cf. `click_impact`) ;
/// - vitesse : poids `clamp(2 − vitesse, 0, 1)`. À 100× une frame couvre 3,3 s de source, la
///   courbe serait échantillonnée une fois, au hasard : une secousse d'une frame ;
/// - masques de confidentialité : rien tant qu'un flou/mosaïque est visible. Le masque suit
///   déjà le quad dynamique (`privacy_mask`), c'est une marge de sûreté que la spec demande.
fn click_impact_at(
    scene: &Scene,
    cfg: &Cfg,
    live: &LiveParams,
    track: &crate::cursor::CursorTrack,
    t: f32,
    cut: [f32; 4],
    uv_max: [f32; 2],
) -> ([f32; 3], f32) {
    let Some(clip) = scene.clips.get(scene.active_clip_index) else { return ([0.0; 3], 0.0) };
    let masked = scene.annotations.iter().any(|a| {
        a.kind == "blur" && a.blur.is_some() && t >= a.start_sec as f32 && t < a.end_sec as f32
    });
    if masked {
        return ([0.0; 3], 0.0);
    }
    let speed = crate::regions::speed_at(&scene.speed_regions, scene.active_clip_index, t as f64);
    let speed_weight = (2.0 - speed as f32).clamp(0.0, 1.0);
    let weight = cursor_alpha(Some(scene), cfg, live, track, t) * speed_weight;
    if weight <= 0.0 {
        return ([0.0; 3], 0.0);
    }
    let window = [clip.source_start_sec as f32, clip.source_end_sec as f32];
    let aim = |p| cursor_plane_point(cut, uv_max, p);
    (
        crate::regions::click_impact(t, track, window, aim).map(|d| d * weight),
        crate::regions::click_press(t, track, window, aim) * weight,
    )
}

/// `None` = rien à dessiner cette frame : curseur masqué, pointeur hors du rect source
/// courant (zoom serré, hors écran), ou sprite réduit à rien au creux d'un click bounce
/// extrême — un état normal en lecture, pas une erreur.
pub fn plan_cursor(g: &FrameGeometry, input: &CursorPlanInput) -> Option<CursorPlan> {
    let (rw, rh) = (input.render_px[0], input.render_px[1]);

    let alpha = cursor_alpha(input.scene, input.cfg, &input.live, input.track, input.t);
    if alpha <= 0.001 {
        return None;
    }

    let s_px = [g.s_dst[2] * rw, g.s_dst[3] * rh];
    let tilt = g.screen_tilt(s_px);
    let quad_center_px = [
        (g.s_dst[0] + g.s_dst[2] * 0.5) * rw,
        (g.s_dst[1] + g.s_dst[3] * 0.5) * rh,
    ];
    let cursor_type = input.track.type_at(input.t);
    let model_sprite =
        modelled_sprite(input.scene, cursor_type).filter(|_| input.live.cursor_model3d);
    let model3d = model_sprite.is_some();
    let place = |cxy: Option<(f32, f32)>, dst: [f32; 4]| -> Option<CursorPlacement> {
        cxy.and_then(|p| {
            let [fx, fy] = cursor_plane_point(g.cut, [input.u_max, input.v_max], p)?;
            Some(match tilt.as_ref() {
                Some(&quad) => CursorPlacement::Tilted {
                    plane_pt: [fx, fy],
                    quad,
                    center_px: quad_center_px,
                    screen_px: s_px,
                    render_px: [rw, rh],
                },
                // Le curseur modélisé a toujours besoin d'un plan : sur écran droit, un plan
                // IDENTITÉ taillé dans `dst`. À rotation nulle `rotated_quad_corners_px` rend les
                // coins exacts (±w/2, ±h/2, échelle 1) : même caméra, même mode 15.
                None if model3d => {
                    let screen_px = [dst[2] * rw, dst[3] * rh];
                    CursorPlacement::Tilted {
                        plane_pt: [fx, fy],
                        quad: crate::regions::rotated_quad_corners_px(
                            screen_px[0],
                            screen_px[1],
                            [0.0; 3],
                            [0.0; 3],
                        ),
                        center_px: [(dst[0] + dst[2] * 0.5) * rw, (dst[1] + dst[3] * 0.5) * rh],
                        screen_px,
                        render_px: [rw, rh],
                    }
                }
                None => CursorPlacement::Upright {
                    center: [dst[0] + fx * dst[2], dst[1] + fy * dst[3]],
                },
            })
        })
    };
    // Le curseur modélisé touche le plan à chaque clic : il se pose sur le point cliqué brut
    // (`pinned_at`), pas sur la piste lissée qui traîne derrière la souris. Le sprite plat garde
    // la piste telle quelle, son rendu est celui d'avant.
    let at = |t: f32| if model3d { input.track.pinned_at(t) } else { input.track.at(t) };
    let placement = place(at(input.t), g.s_dst)?;

    let lp = input.live;
    // `cursor_bounce_scale` est le clickBounce brut (0..5) : au-delà de 1/0.24 ≈ 4.17, le creux
    // de la pression (0.76) passe sous zéro. Une taille négative retournerait le sprite, donc
    // plancher à 0 — le curseur disparaît le temps du creux, c'est ce qu'une telle amplitude dit.
    // Le curseur modélisé n'a pas de rebond d'échelle : le clic le fait toucher le plan à la place.
    let bounce = if model3d {
        1.0
    } else {
        (1.0 + (input.track.bounce(input.t) - 1.0) * lp.cursor_bounce_scale).max(0.0)
    };
    let size_px =
        CURSOR_BASE_SIZE_FRAC * g.frame_min_px * lp.cursor_size_scale * bounce * g.padding_scale;
    // Taille nulle = rien à dessiner, et surtout rien à projeter : sur un plan incliné les quatre
    // coins du sprite se confondent, et le warp inverse du mode 13 résout alors 0/0. Son rejet
    // ne tiendrait qu'à des comparaisons avec NaN, que Metal (fast-math) ne garantit pas.
    // Couvre aussi la traînée : ses copies partagent `size_px`.
    if !(size_px > 0.0) {
        return None;
    }

    let blur01 = lp.cursor_motion_blur.clamp(0.0, 1.0);
    let has_scene = input.scene.is_some();
    let (taps, prev_placement) = if !has_scene {
        let taps = input.cfg.mblur_n;
        let prev = if taps <= 1 {
            placement
        } else {
            place(at(input.t - 1.0 / FPS), g.s_dst_prev).unwrap_or(placement)
        };
        (taps, prev)
    } else if blur01 <= 0.001 {
        (1, placement)
    } else {
        // Intervalle d'obturateur court, borné à 1 frame (100% blur = 1 frame d'exposition)
        let trail_dt = blur01 / FPS;
        let prev = place(at(input.t - trail_dt), g.s_dst_prev).unwrap_or(placement);
        let c_now = placement.upright_center();
        let c_prev = prev.upright_center();
        let dist_px = ((c_now[0] - c_prev[0]) * rw).hypot((c_now[1] - c_prev[1]) * rh);
        if dist_px < 1.0 {
            // Quasi immobile : pas de copies superflues
            (1, placement)
        } else {
            // Densité d'échantillonnage adaptée à la distance pour éliminer les fantômes discrets
            let needed = (dist_px / 2.5).ceil() as u32;
            let taps = needed.clamp(2, 16);
            (taps, prev)
        }
    };

    // « Clip to canvas » : la BOUNDING BOX des quatre coins projetés du plan — le rect dans
    // lequel le curseur a le droit d'exister (`pout` est en 0..1 sortie, comme ce rect).
    let cursor_bounds: [f32; 4] = match tilt.as_ref() {
        None => g.s_dst,
        Some(quad) => {
            let (hx, hy) = quad.half_extents_px();
            [
                (quad_center_px[0] - hx) / rw,
                (quad_center_px[1] - hy) / rh,
                2.0 * hx / rw,
                2.0 * hy / rh,
            ]
        }
    };
    let clip = match input.scene {
        Some(s) if s.cursor.clip_to_bounds => cursor_bounds,
        _ => [-1.0, -1.0, 3.0, 3.0],
    };

    // L'impact : un anneau par clic récent, centré sur son point BRUT, là où la pointe se pose.
    let strength = (lp.cursor_bounce_scale / MODEL_CLICK_BOUNCE_REF).clamp(0.0, 2.0);
    let impacts = if model3d && strength > 0.0 {
        let half_px = IMPACT_EXTENT * size_px * (0.75 + 0.25 * strength);
        input
            .track
            .clicks_with_points(input.t - IMPACT_DELAY_S - IMPACT_S, input.t - IMPACT_DELAY_S)
            .filter_map(|(tc, p)| {
                let impact = impact_at(input.t - tc, strength)?;
                cursor_impact_cb(place(Some(p), g.s_dst)?, half_px, impact, alpha)
            })
            .collect()
    } else {
        Vec::new()
    };

    Some(CursorPlan {
        placement,
        prev_placement,
        size_px,
        taps,
        clip,
        cursor_type: cursor_type.map(str::to_string),
        alpha,
        model: model_sprite.map(|s| {
            let pointing = pointing_factor([s.hotspot_x, s.hotspot_y]);
            cursor_pose(input.track, input.t, lp.cursor_bounce_scale, pointing)
        }),
        impacts,
    })
}

// ============ Curseur modélisé (mode 15) ============
//
// Le sprite de l'état courant (thème par défaut) devient un OBJET : sa silhouette extrudée, lancée
// de rayons par pixel dans le shader, éclairée, et qui porte une vraie ombre sur l'écran. La
// silhouette est le champ de distance signé que `cursor_sdf` tire de l'alpha du sprite ; le dessus
// porte l'art du sprite, les flancs et le chanfrein la couleur de son bord. Rust ne fait ici que la
// pose (fonction pure de `t`), la caméra et la boîte de dessin ; les trois shaders font le reste
// avec les MÊMES constantes.
//
// Repère du MODÈLE : unité = plus grand côté du sprite (`size_px`, la taille du curseur), origine
// au hotspot de la face du dessus, x à droite, y vers le bas, z vers la caméra ; le modèle occupe
// z de -MODEL_THICK à 0.
//
// Emplacements du `LayerCB` au mode 15 (128 octets, inchangés) :
//   dst           rect de dessin (sortie 0..1) : boîte du modèle ET de son ombre
//   quad_px       taille de ce rect en px (le VS en tire `local`)
//   src.xy        décalage px : `local + src.xy` = pixel relatif à l'axe de la caméra, ancrage ôté
//   src.z         P, distance caméra–plan (px) ; src.w = U, l'unité du modèle (px du plan)
//   color.rg      coin haut-gauche du sprite, repère du modèle (unités)
//   color.b       écrasement : l'épaisseur vaut MODEL_THICK × color.b (`CursorPose::squash`).
//                 Un texel du sprite se tire de la taille du champ (`SDF_UPSAMPLE` / plus grand côté)
//   color.a       opacité (auto-hide, zoom)
//   fx.xyz        rotation dessinée du plan (rad, X/Y/Z, ordre de `regions::rotate_point`)
//   fx.w          tangage du modèle (rad)
//   src_prev.xyz  hotspot de la face du dessus, repère du plan (px, centre du plan à l'origine)
//   src_prev.w    lacet du modèle (rad)
//   dst_prev      rect de clip « Clip to canvas » (sortie 0..1), comme au mode 13
//   mb.xy         demi-taille du plan dans son repère (px) : l'ombre s'arrête à ses bords
//   mb.zw         translation du plan dans le repère caméra (px, `TiltedQuad::offset`) : le
//                 plan vaut `R·p + (mb.zw, 0)`, œil en (0, 0, P). Nulle sous un angle fixe.
//   radius_px     rapport w/h du sprite : sa taille (unités) en découle, plus grand côté = 1
// Textures : le sprite RGBA (alpha droit) et son champ R16F (`cursor_sdf`), sur le même rect.
//   Windows et macOS : sprite en t2/texture(2) (`texImg`), champ en t4/texture(4) (`texSdf`).
//   Linux : sprite au binding 1 (`texY`), champ au binding 2 (`texU`).

/// Épaisseur du modèle : la face du dessus est en z = 0, celle du dessous en z = -épaisseur.
pub const MODEL_THICK: f32 = 0.19;
/// Rayon du chanfrein arrondi des arêtes du dessus et du dessous.
pub const MODEL_BEVEL: f32 = 0.045;
/// Direction VERS la lumière, repère caméra (x droite, y bas, z vers le spectateur) : en haut à
/// gauche, devant. Unitaire. Miroir de `MODEL_LIGHT` dans les trois shaders.
pub const MODEL_LIGHT: [f32; 3] = [-0.4194, -0.5792, 0.6990];

/// Garde au sol au repos, en unités du modèle.
const MODEL_HOVER: f32 = 0.35;
/// Gain sur `tap` pour la descente : à 1,25 le modèle reste posé de 27 à 74 ms après le clic,
/// assez pour qu'au moins une image le montre au contact jusqu'à 21 i/s.
const MODEL_CONTACT_GAIN: f32 = 1.25;
/// Tangage au repos (queue relevée, pointe vers le bas) et supplément au creux de la pression.
const MODEL_PITCH_IDLE_DEG: f32 = 18.0;
const MODEL_PITCH_PRESS_DEG: f32 = 10.0;
/// Le supplément de tangage suit `clickBounce` rapporté à sa valeur par défaut, borné à 2×.
const MODEL_CLICK_BOUNCE_REF: f32 = 2.5;
/// Lacet maximal, et la vitesse (largeurs de l'écran par seconde) qui en donne 76 % (`tanh 1`).
const MODEL_YAW_MAX_DEG: f32 = 25.0;
const MODEL_YAW_SPEED: f32 = 0.8;
/// Demi-fenêtre de la différence centrée qui mesure la vitesse (comme la parallaxe du plan).
const MODEL_YAW_HALF_WINDOW_S: f32 = 0.1;
/// Combien de temps avant un clic le modèle se tourne vers sa cible.
const MODEL_AIM_S: f32 = 0.3;
/// Écrasement au creux du clic (part de l'épaisseur perdue), à `clickBounce` par défaut.
/// L'épaisseur ne descend jamais sous `MODEL_SQUASH_MIN` (deux chanfreins, plus un peu de flanc).
const MODEL_SQUASH: f32 = 0.3;
const MODEL_SQUASH_MIN: f32 = 0.55;
/// Hotspot → part « pointeur » (cf. `pointing_factor`) : sous `LO` (distance au centre rapportée
/// au demi-côté), un curseur centré ; au-delà de `HI`, un pointeur. La flèche est à 0,83.
const MODEL_POINTING_LO: f32 = 0.3;
const MODEL_POINTING_HI: f32 = 0.75;
/// Pénombre (miroir des shaders) : un point du plan est dans l'ombre douce quand son rayon vers
/// la lumière passe à moins de `t / MODEL_SOFTNESS` du modèle, `t` la distance parcourue, et
/// jamais au-delà de `MODEL_SHADOW_PAD` (la marche s'arrête à la boîte du modèle élargie d'autant).
const MODEL_SOFTNESS: f32 = 6.0;
const MODEL_SHADOW_PAD: f32 = 0.45;
/// Portée de l'ombre de contact (miroir des shaders), en unités du modèle.
const MODEL_CONTACT_RADIUS: f32 = 0.12;

/// Ce que le mode 15 sait du sprite qu'il extrude : son rect dans le repère du modèle et le haut
/// de sa silhouette. Tiré du PNG par `cursor_sdf::CursorSdf`, le hotspot venant de la scène.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpriteShape {
    /// Taille du sprite en unités du modèle : son plus grand côté vaut 1.
    pub size: [f32; 2],
    /// Hotspot, fraction du sprite (`SceneCursorSprite`).
    pub hotspot: [f32; 2],
    /// Haut de la silhouette (alpha 0,5), fraction de la hauteur du sprite.
    pub top: f32,
}

impl SpriteShape {
    /// Coin haut-gauche du sprite, repère du modèle.
    pub(crate) fn origin(&self) -> [f32; 2] {
        [-self.hotspot[0] * self.size[0], -self.hotspot[1] * self.size[1]]
    }

    /// La boîte englobante du modèle écrasé à `squash` : le rect du sprite, sur toute l'épaisseur.
    fn model_box(&self, squash: f32) -> ([f32; 3], [f32; 3]) {
        let [x, y] = self.origin();
        ([x, y, -MODEL_THICK * squash], [x + self.size[0], y + self.size[1], 0.0])
    }

    /// Hauteur du hotspot du dessus quand le point le plus bas du modèle basculé de `pitch` (≥ 0)
    /// et écrasé à `squash` affleure le plan : le bas du haut de la silhouette (y minimal, face du
    /// dessous) ; à plat, toute la face du dessous. Le chanfrein arrondit ce coin et laisse,
    /// basculé, un jour d'au plus ~1 % de l'unité, invisible sous l'ombre de contact.
    fn contact_lift(&self, pitch: f32, squash: f32) -> f32 {
        let y_top = (self.top - self.hotspot[1]) * self.size[1];
        MODEL_THICK * squash * pitch.cos() - y_top * pitch.sin()
    }
}

/// Part « pointeur » d'un sprite, de 0 à 1, d'après son seul hotspot : sa distance au centre du
/// sprite, rapportée au demi-côté (norme max). Près d'un bord (flèche, main qui pointe, aide,
/// flèche haute) le curseur désigne de sa pointe, et le modèle penche et tourne comme la flèche ;
/// au centre (I, croix, redimensionnements, déplacement, interdit, attente, poing fermé) il ne
/// fait ni l'un ni l'autre : tourner une flèche de redimensionnement en change le sens, et basculer
/// une forme autour de son centre en enfoncerait la moitié dans le plan.
pub fn pointing_factor(hotspot: [f32; 2]) -> f32 {
    let r = 2.0 * (hotspot[0] - 0.5).abs().max((hotspot[1] - 0.5).abs());
    let u = ((r - MODEL_POINTING_LO) / (MODEL_POINTING_HI - MODEL_POINTING_LO)).clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

/// La pose du curseur modélisé à un instant : une fonction pure de `t`, comme tout le reste de
/// la frame (preview == export, lecture == seek).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorPose {
    /// Garde au sol du point le plus bas, en unités du modèle : 0 = il touche le plan.
    pub clearance: f32,
    /// Tangage (rad) autour de l'axe x passant par le hotspot : la queue monte, la pointe descend.
    pub pitch: f32,
    /// Lacet (rad) autour de la normale du plan, appliqué après le tangage : positif = sens
    /// horaire à l'écran (y vers le bas), la pointe part vers la droite.
    pub yaw: f32,
    /// Épaisseur du modèle rapportée à `MODEL_THICK` : moins de 1 quand le clic l'écrase.
    pub squash: f32,
}

/// La pose à `t`. `click_bounce` est le réglage brut (0..5, 2,5 par défaut), `pointing` la part
/// « pointeur » du sprite (`pointing_factor`).
///
/// - Hauteur : `MODEL_HOVER` au repos ; chaque clic le fait descendre TOUCHER le plan au creux de
///   `regions::tap`, la courbe de l'impact du clic, dont le creux (49,5 ms) est celui de la
///   pression de `CursorTrack::bounce` : le modèle, le plan et le rebond d'échelle lisent le même
///   contact à la même image. Dernier clic avant `t`, comme `bounce`. Tous les états.
/// - Tangage : 18° au repos, jusqu'à +10° au creux de la pression, fois `clickBounce`.
/// - Lacet : vers la vitesse horizontale lissée (`follow_at`, différence centrée), et vers la
///   cible d'un clic dans les 300 ms qui le précèdent ; borné à ±25° en douceur (`tanh`), nul au
///   repos. Les contributions des clics montent avant eux et retombent sur la fenêtre de l'impact,
///   donc la pose reste continue en `t`.
/// - Tangage et lacet sont multipliés par `pointing` : entiers pour la flèche, nuls pour un
///   curseur centré.
/// - Écrasement : sur la même courbe `tap`, l'épaisseur descend à 1 − `MODEL_SQUASH` au creux,
///   puis le rebond l'épaissit un instant. Fois `clickBounce`, comme le tangage ; tous les états.
///   L'empreinte ne change pas : pas de rebond d'échelle en 3D.
pub fn cursor_pose(
    track: &crate::cursor::CursorTrack,
    t: f32,
    click_bounce: f32,
    pointing: f32,
) -> CursorPose {
    use crate::regions::{tap, CLICK_IMPACT_WINDOW_S};
    let k = track.last_click_at(t).map(|tc| tap((t - tc) / CLICK_IMPACT_WINDOW_S)).unwrap_or(0.0);
    let clearance = MODEL_HOVER * (1.0 + MODEL_CONTACT_GAIN * k).max(0.0);
    let strength = (click_bounce / MODEL_CLICK_BOUNCE_REF).clamp(0.0, 2.0);
    let press = (-k).max(0.0) * strength;
    let pitch = pointing * (MODEL_PITCH_IDLE_DEG + MODEL_PITCH_PRESS_DEG * press).to_radians();
    let squash = (1.0 + MODEL_SQUASH * k * strength).max(MODEL_SQUASH_MIN);

    let smooth = |x: f32| {
        let u = x.clamp(0.0, 1.0);
        u * u * (3.0 - 2.0 * u)
    };
    let h = MODEL_YAW_HALF_WINDOW_S;
    let mut v = match (track.follow_at(t - h), track.follow_at(t + h)) {
        (Some(a), Some(b)) => (b.0 - a.0) / (2.0 * h),
        _ => 0.0,
    };
    if let Some(here) = track.follow_at(t) {
        for (tc, target) in track.clicks_with_points(t - CLICK_IMPACT_WINDOW_S, t + MODEL_AIM_S) {
            let w = if tc > t {
                smooth(1.0 - (tc - t) / MODEL_AIM_S)
            } else {
                1.0 - smooth((t - tc) / CLICK_IMPACT_WINDOW_S)
            };
            v += w * (target.0 - here.0) / MODEL_AIM_S;
        }
    }
    let yaw = pointing * MODEL_YAW_MAX_DEG.to_radians() * (v / MODEL_YAW_SPEED).tanh();
    CursorPose { clearance, pitch, yaw, squash }
}

/// Le sprite du thème par défaut que les backends résoudraient pour `cursor_type`, s'il y en a
/// un : c'est lui que le mode 15 extrude. Même résolution qu'eux : l'état s'il a un sprite, sinon
/// la flèche. Les autres thèmes restent plats.
fn modelled_sprite<'a>(
    scene: Option<&'a Scene>,
    cursor_type: Option<&str>,
) -> Option<&'a crate::scene::SceneCursorSprite> {
    let s = scene.filter(|s| s.cursor.theme == "default")?;
    let sprites = &s.cursor.cursor_sprites;
    cursor_type.and_then(|k| sprites.get(k)).or_else(|| sprites.get("arrow"))
}

/// La caméra et la pose d'un curseur modélisé posé en `placement` : de quoi projeter n'importe
/// quel point du modèle exactement comme le mode 15 le rend.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelView {
    /// Rotation dessinée du plan, degrés (`TiltedQuad::rot`).
    rot: [f32; 3],
    perspective: f32,
    /// Translation du plan dans le repère caméra (`TiltedQuad::offset`).
    offset: [f32; 2],
    /// L'unité du modèle (plus grand côté du sprite) en px du plan.
    unit: f32,
    /// Hotspot du dessus, repère du plan (px).
    tip: [f32; 3],
    /// Décalage écran qui pose la pointe sur le pixel du contenu (warp bilinéaire du mode 8).
    anchor: [f32; 2],
    center: [f32; 2],
    half: [f32; 2],
    pose: CursorPose,
    shape: SpriteShape,
}

impl ModelView {
    /// `None` pour un placement droit (`plan_cursor` n'en produit pas pour le modèle) ou une
    /// caméra dégénérée.
    ///
    /// Le hotspot est posé sur le rayon de vue qui passe par le point du contenu (`plane_pt`),
    /// à sa hauteur : la pointe reste donc sur le même pixel quand la flèche monte ou descend, et
    /// seule l'ombre dit la hauteur. Le contenu, lui, est dessiné par un warp BILINÉAIRE des coins
    /// projetés, qui s'écarte de la perspective exacte de quelques px : tout le rendu est décalé
    /// de l'écart au point visé (`anchor`), pour que la pointe tombe sur le pixel que montre
    /// l'écran.
    ///
    /// Le hotspot est posé à `clearance + contact_lift` : le point le plus bas du modèle posé,
    /// quel qu'il soit, est à `clearance` du plan, donc rien ne passe jamais dessous.
    pub(crate) fn new(
        placement: CursorPlacement,
        size_px: f32,
        pose: CursorPose,
        shape: SpriteShape,
    ) -> Option<Self> {
        let CursorPlacement::Tilted { plane_pt, quad, center_px, screen_px, .. } = placement else {
            return None;
        };
        let s = quad.scale;
        let half = [screen_px[0] * s * 0.5, screen_px[1] * s * 0.5];
        let perspective = quad.perspective;
        let unit = size_px * s;
        let eye = crate::regions::rotate_point_inv(
            [-quad.offset[0], -quad.offset[1], perspective],
            quad.rot,
        );
        if !(unit > 0.0) || !(eye[2] > 1e-3) {
            return None;
        }
        let ground =
            [(plane_pt[0] - 0.5) * 2.0 * half[0], (plane_pt[1] - 0.5) * 2.0 * half[1], 0.0];
        let height = unit * (pose.clearance + shape.contact_lift(pose.pitch, pose.squash));
        let k = height / eye[2];
        let tip =
            [ground[0] + (eye[0] - ground[0]) * k, ground[1] + (eye[1] - ground[1]) * k, height];
        let mut view = ModelView {
            rot: quad.rot,
            perspective,
            offset: quad.offset,
            unit,
            tip,
            anchor: [0.0; 2],
            center: center_px,
            half,
            pose,
            shape,
        };
        let exact = view.project(ground)?;
        let (bx, by) = quad.point_px(plane_pt[0], plane_pt[1]);
        view.anchor = [center_px[0] + bx - exact[0], center_px[1] + by - exact[1]];
        Some(view)
    }

    /// Point du modèle (unités) → repère du plan (px) : tangage, lacet, échelle, hotspot.
    pub(crate) fn model_to_plane(&self, q: [f32; 3]) -> [f32; 3] {
        let (cp, sp) = (self.pose.pitch.cos(), self.pose.pitch.sin());
        let (cy, sy) = (self.pose.yaw.cos(), self.pose.yaw.sin());
        let (x, y, z) = (q[0], q[1] * cp - q[2] * sp, q[1] * sp + q[2] * cp);
        let (x, y) = (x * cy - y * sy, x * sy + y * cy);
        [self.tip[0] + self.unit * x, self.tip[1] + self.unit * y, self.tip[2] + self.unit * z]
    }

    /// Point du repère du plan → px de sortie : la perspective exacte, puis l'ancrage.
    pub(crate) fn project(&self, p: [f32; 3]) -> Option<[f32; 2]> {
        let w = crate::regions::rotate_point(p, self.rot);
        let d = self.perspective - w[2];
        if !(d > 1e-3) {
            return None;
        }
        let f = self.perspective / d;
        let (x, y) = (w[0] + self.offset[0], w[1] + self.offset[1]);
        Some([self.center[0] + self.anchor[0] + x * f, self.center[1] + self.anchor[1] + y * f])
    }

    /// La lumière dans le repère du plan (elle est fixée à la caméra, pas au plan).
    pub(crate) fn light(&self) -> [f32; 3] {
        crate::regions::rotate_point_inv(MODEL_LIGHT, self.rot)
    }

    /// Boîte (px de sortie, `[x0, y0, x1, y1]`) qui contient le modèle ET son ombre : les huit
    /// coins de la boîte du modèle, et leur projection au sol le long de la lumière, élargie de la
    /// portée de la pénombre et du contact. Conservatrice : le shader ne dessine rien hors d'elle.
    ///
    /// Portée : un rayon qui passe à `d` d'un point du modèle part d'un point du sol décalé d'au
    /// plus `d / lz` de son ombre géométrique (`lz` = élévation de la lumière au-dessus du plan),
    /// et la pénombre s'arrête à `d = min(t / MODEL_SOFTNESS, MODEL_SHADOW_PAD)`.
    pub(crate) fn footprint(&self) -> Option<[f32; 4]> {
        let (lo, hi) = self.shape.model_box(self.pose.squash);
        let light = self.light();
        let lz = light[2].max(0.2);
        let corners: [[f32; 3]; 8] = std::array::from_fn(|i| {
            self.model_to_plane([
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ])
        });
        let top = corners.iter().fold(0.0f32, |m, p| m.max(p[2])) / self.unit;
        let penumbra = (top / lz / MODEL_SOFTNESS).min(MODEL_SHADOW_PAD);
        let reach = (penumbra / lz + MODEL_CONTACT_RADIUS) * self.unit;
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut add = |p: [f32; 2]| {
            b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        };
        for p in corners {
            add(self.project(p)?);
            let h = p[2].max(0.0) / lz;
            let g = [p[0] - light[0] * h, p[1] - light[1] * h];
            for (dx, dy) in [(-reach, -reach), (reach, -reach), (reach, reach), (-reach, reach)] {
                add(self.project([g[0] + dx, g[1] + dy, 0.0])?);
            }
        }
        const PAD_PX: f32 = 2.0;
        Some([b[0] - PAD_PX, b[1] - PAD_PX, b[2] + PAD_PX, b[3] + PAD_PX])
    }
}

/// `LayerCB` du curseur modélisé (mode 15) posé en `placement`, pour les trois backends : le
/// sprite `shape` extrudé. `None` quand il n'y a rien à dessiner (placement droit, caméra
/// dégénérée). Voir l'en-tête de cette section pour l'emploi des emplacements.
pub fn cursor_model_cb(
    placement: CursorPlacement,
    size_px: f32,
    pose: CursorPose,
    shape: SpriteShape,
    alpha: f32,
    clip: [f32; 4],
) -> Option<LayerCB> {
    let view = ModelView::new(placement, size_px, pose, shape)?;
    let CursorPlacement::Tilted { render_px: [rw, rh], .. } = placement else { return None };
    let [x0, y0, x1, y1] = view.footprint()?;
    // Bords entiers : `local` vaut alors k + 0,5 au centre des pixels, comme le rastériseur.
    let (x0, y0, x1, y1) = (x0.floor(), y0.floor(), x1.ceil(), y1.ceil());
    let (bw, bh) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
    let r = view.rot.map(f32::to_radians);
    Some(LayerCB {
        dst: [x0 / rw, y0 / rh, bw / rw, bh / rh],
        src: [
            x0 - view.center[0] - view.anchor[0],
            y0 - view.center[1] - view.anchor[1],
            view.perspective,
            view.unit,
        ],
        quad_px: [bw, bh],
        mode: 15.0,
        color: [shape.origin()[0], shape.origin()[1], pose.squash, alpha],
        fx: [r[0], r[1], r[2], pose.pitch],
        src_prev: [view.tip[0], view.tip[1], view.tip[2], pose.yaw],
        dst_prev: clip,
        mb: [view.half[0], view.half[1], view.offset[0], view.offset[1]],
        radius_px: shape.size[0] / shape.size[1],
        ..Default::default()
    })
}

// ============ Impact du clic (mode 16) ============
//
// Sous le curseur modélisé, chaque clic laisse sur l'écran une tache de pression sous la pointe et
// un anneau qui s'étend depuis le point cliqué. Les deux sont posés SUR le plan, comme le sprite du
// mode 13 : un carré du plan centré sur le point, dont les coins passent par la projection du
// contenu, puis le warp inverse du shader. Ils suivent donc l'inclinaison et la caméra, et leur
// centre est le pixel cliqué. Rust calcule la courbe dans le temps ; les shaders ne dessinent
// que la forme de l'instant.
//
// Emplacements du `LayerCB` au mode 16 (longueurs en fractions du demi-côté du carré) :
//   dst, quad_px  bbox du carré projeté (sortie 0..1, px)
//   fx, src_prev  coins TL, TR puis BR, BL, en px locaux à la bbox (comme au mode 13)
//   mb.x          1 = warp projectif (caméra réelle)
//   mb.y, mb.z    rayon et opacité de la tache de pression
//   src           rayon de l'anneau, sa demi-épaisseur, son opacité, celle de son halo sombre
//   dst_prev      le carré en fractions du plan (x, y, l, h) : rien n'est dessiné hors de l'écran
//   radius_px     largeur de l'antialiasing
//   color         teinte de l'anneau (rgb), opacité du curseur (a)

/// L'impact part du creux de `tap`, l'instant du contact : la pression y est au plus fort.
const IMPACT_DELAY_S: f32 = 0.0495;
/// Durée de l'anneau.
const IMPACT_S: f32 = 0.4;
/// Demi-côté du carré de l'impact, en tailles de curseur, à `clickBounce` par défaut.
const IMPACT_EXTENT: f32 = 0.7;

/// L'impact d'un clic, `age` secondes après lui, à la force `strength` (`clickBounce` rapporté à
/// sa valeur par défaut). `None` hors de sa fenêtre.
///
/// L'anneau part de 12 % du carré et s'arrête à 80 % en décélérant (cubique), s'amincit de moitié
/// et s'éteint en `(1 − u)²`. La tache de pression, elle, ne dure que le contact et son rebond.
fn impact_at(age: f32, strength: f32) -> Option<Impact> {
    let u = (age - IMPACT_DELAY_S) / IMPACT_S;
    if !(0.0..1.0).contains(&u) {
        return None;
    }
    let smooth = |a: f32, b: f32, x: f32| {
        let v = ((x - a) / (b - a)).clamp(0.0, 1.0);
        v * v * (3.0 - 2.0 * v)
    };
    let grow = 1.0 - (1.0 - u).powi(3);
    let fade = (1.0 - u).powi(2) * smooth(0.0, 0.05, u) * strength.min(1.0);
    Some(Impact {
        ring_r: 0.12 + 0.68 * grow,
        ring_w: 0.05 * (1.0 - 0.5 * grow),
        ring_a: 0.9 * fade,
        halo_a: 0.3 * fade,
        spot_r: 0.3,
        spot_a: 0.3 * (1.0 - smooth(0.0, 0.45, u)) * smooth(0.0, 0.05, u) * strength.min(1.0),
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Impact {
    ring_r: f32,
    ring_w: f32,
    ring_a: f32,
    halo_a: f32,
    spot_r: f32,
    spot_a: f32,
}

/// `LayerCB` de l'impact (mode 16) centré sur le point du plan de `placement`, carré de demi-côté
/// `half_px` (px du rect d'écran non incliné, l'unité de la taille du curseur). `None` pour un
/// placement droit : le curseur modélisé a toujours un plan.
fn cursor_impact_cb(
    placement: CursorPlacement,
    half_px: f32,
    impact: Impact,
    alpha: f32,
) -> Option<LayerCB> {
    let CursorPlacement::Tilted { plane_pt, quad, center_px, screen_px, render_px: [rw, rh] } =
        placement
    else {
        return None;
    };
    let (hx, hy) = (half_px / screen_px[0], half_px / screen_px[1]);
    let (x0, y0) = (plane_pt[0] - hx, plane_pt[1] - hy);
    let corners = [(x0, y0), (x0 + 2.0 * hx, y0), (x0 + 2.0 * hx, y0 + 2.0 * hy), (x0, y0 + 2.0 * hy)]
        .map(|(fx, fy)| {
            let (px, py) = quad.point_px(fx, fy);
            (center_px[0] + px, center_px[1] + py)
        });
    let (min_x, max_x) =
        corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
    let (min_y, max_y) =
        corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
    let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
    let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
    let [tl0, tl1] = local(corners[0]);
    let [tr0, tr1] = local(corners[1]);
    let [br0, br1] = local(corners[2]);
    let [bl0, bl1] = local(corners[3]);
    Some(LayerCB {
        dst: [min_x / rw, min_y / rh, bw / rw, bh / rh],
        src: [impact.ring_r, impact.ring_w, impact.ring_a, impact.halo_a],
        quad_px: [bw, bh],
        // Un px à l'écran, en fractions du demi-côté, pris sur le petit axe de la bbox.
        radius_px: 2.0 / bw.min(bh),
        mode: 16.0,
        color: [1.0, 1.0, 1.0, alpha],
        fx: [tl0, tl1, tr0, tr1],
        src_prev: [br0, br1, bl0, bl1],
        dst_prev: [x0, y0, 2.0 * hx, 2.0 * hy],
        mb: [quad.warp_flag(), impact.spot_r, impact.spot_a, 0.0],
    })
}

/// Poids d'un échantillon du flou de mouvement de curseur (0 = queue/passé, taps-1 = tête/courant).
///
/// Poids croissant de 0.25 (queue) à 1.0 (tête), normalisé pour que la somme valle 1.0.
/// La somme des (0.25 + 0.75 * k / (taps - 1)) pour k de 0 à taps-1 vaut taps * (0.25 + 1.0) / 2 = taps * 0.625.
#[inline]
pub fn cursor_tap_weight(k: u32, taps: u32) -> f32 {
    if taps <= 1 {
        return 1.0;
    }
    let t = k as f32 / (taps - 1) as f32;
    let ramp = 0.25 + 0.75 * t;
    let sum = taps as f32 * 0.625;
    ramp / sum
}

/// Les clés à évincer d'un cache de textures pour repasser sous `budget`, la moins récemment
/// utilisée d'abord. `entries` porte `(clé, octets, tick d'usage)`.
///
/// `protect_from` est le tick au DÉBUT DE LA FRAME EN COURS : toute entrée touchée depuis est
/// intouchable. Protéger la seule entrée qu'on vient de poser ne suffit pas — une frame échantillonne
/// plusieurs textures (fond d'écran, fond de caméra, sprites de curseur), et évincer l'une d'elles
/// parce qu'une autre vient d'arriver la ferait recharger à la frame suivante, puis rechasser la
/// suivante : le cache se mettrait à battre au lieu de servir. Un décodage mesuré à 129 ms en
/// release contre les ~3,5 ms d'une frame, c'est un échange qu'aucun budget mémoire ne justifie.
///
/// Si le jeu actif dépasse à lui seul le budget, la fonction s'arrête AU-DESSUS du budget plutôt
/// que d'y toucher. Dépasser est le moindre mal.
///
/// Partagé plutôt que recopié dans chaque backend, pour la raison qui vaut pour tout ce module :
/// trois copies d'une politique d'éviction finiraient par diverger sans que rien ne le dise.
pub fn lru_evictions(entries: &[(String, u64, u64)], budget: u64, protect_from: u64) -> Vec<String> {
    let mut total: u64 = entries.iter().map(|(_, bytes, _)| *bytes).sum();
    if total <= budget {
        return Vec::new();
    }
    let mut candidates: Vec<&(String, u64, u64)> =
        entries.iter().filter(|(_, _, tick)| *tick < protect_from).collect();
    candidates.sort_by_key(|(_, _, tick)| *tick);
    let mut out = Vec::new();
    for (key, bytes, _) in candidates {
        if total <= budget {
            break;
        }
        total -= bytes;
        out.push(key.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::lru_evictions;

    /// `(clé, octets, tick)` — le tick croît avec l'usage, donc le plus petit est le plus ancien.
    fn e(key: &str, mb: u64, tick: u64) -> (String, u64, u64) {
        (key.to_string(), mb * 1024 * 1024, tick)
    }

    const BUDGET: u64 = 512 * 1024 * 1024;

    #[test]
    fn evicts_nothing_while_under_budget() {
        assert!(lru_evictions(&[e("a", 100, 1), e("b", 100, 2)], BUDGET, 2).is_empty());
    }

    /// La plus ancienne part d'abord, et on s'arrête DÈS qu'on repasse sous le budget : évincer
    /// au-delà ne rendrait que des rechargements.
    #[test]
    fn evicts_oldest_first_and_stops_at_the_budget() {
        let entries = [e("vieux", 100, 1), e("moyen", 100, 2), e("neuf", 100, 9)];
        assert_eq!(lru_evictions(&entries, 250 * 1024 * 1024, 9), vec!["vieux".to_string()]);
    }

    /// TOUT le jeu actif de la frame est protégé, pas seulement la dernière entrée posée. Une
    /// frame qui échantillonne un fond d'écran ET un fond de caméra ne doit pas voir le premier
    /// évincé parce que le second vient d'arriver — sinon les deux se chassent l'un l'autre à
    /// chaque frame.
    #[test]
    fn protects_every_texture_used_this_frame() {
        // frame commencée au tick 5 : `ecran` et `camera` servent tous deux maintenant.
        let entries = [e("vieux", 100, 2), e("ecran", 400, 5), e("camera", 400, 6)];
        assert_eq!(lru_evictions(&entries, BUDGET, 5), vec!["vieux".to_string()]);
    }

    /// Jeu actif plus gros que le budget : on rend ce qu'on peut et on reste au-dessus, plutôt que
    /// de faire disparaître des textures dont cette frame a besoin.
    #[test]
    fn gives_up_rather_than_evicting_the_active_set() {
        let entries = [e("a", 100, 1), e("actif", 900, 5)];
        assert_eq!(lru_evictions(&entries, 256 * 1024 * 1024, 5), vec!["a".to_string()]);
    }

    use super::*;

    /// La scène de référence du golden : un cas qui exerce le padding, le crop, le zoom,
    /// une caméra PiP décalée, un rayon et une inclinaison nulle.
    fn golden_scene() -> Scene {
        Scene::from_json(
            r##"{
            "clips":[{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":true}],
            "layout":{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,
                      "webcamPosition":{"cx":0.8577,"cy":0.8159},"webcamReactiveZoom":false},
            "effects":{"padding":0.51,"blur":false,"shadow":0.35,"roundnessFrac":0.0255,"motionBlur":0.35},
            "background":{"kind":"color","color":"#1e1e2e"},
            "zoomRegions":[],
            "cursor":{"show":true,"size":7.76,"smoothing":0,"motionBlur":0.35,"clickBounce":1,"clipToBounds":false,"theme":"default"},
            "cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],
            "output":{"width":1170,"height":658,"fps":60}
        }"##,
        )
        .expect("golden scene")
    }

    fn golden_input(scene: &Scene, cfg: &Cfg) -> FrameGeometryInput<'static> {
        // SAFETY-free: on fuit volontairement les deux références pour obtenir un
        // `'static` dans le test — la scène et le cfg vivent jusqu'à la fin du process.
        let scene: &'static Scene = Box::leak(Box::new(scene.clone()));
        let cfg: &'static Cfg = Box::leak(Box::new(cfg.clone()));
        FrameGeometryInput {
            render_px: [1170.0, 658.0],
            screen_tex_px: [1920.0, 1088.0],
            screen_visible_px: [1920.0, 1080.0],
            webcam_visible_px: [1280.0, 720.0],
            u_max: 1920.0 / 1920.0,
            v_max: 1080.0 / 1088.0,
            frame: 90.0,
            cfg,
            live: live_params_from_scene(scene),
            scene: Some(scene),
            cursor: None,
            timeline_t_override: Some(1.5),
            // Distinct de `source_t` et de `frame / FPS` : un croisement des trois se verrait.
            programme_time: Some(2.25),
        }
    }

    /// Le JSON de la scène zoomée, brut : `tilted_golden_scene` n'en change QUE la
    /// rotation, et le faire par substitution garantit que les deux scènes ne diffèrent
    /// pas ailleurs sans qu'on s'en aperçoive.
    fn zoomed_golden_scene_json() -> &'static str {
        r##"{
            "clips":[{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":true}],
            "layout":{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,
                      "webcamPosition":{"cx":0.8577,"cy":0.8159},"webcamReactiveZoom":false},
            "effects":{"padding":0.51,"blur":false,"shadow":0.35,"roundnessFrac":0.0255,"motionBlur":0.35},
            "background":{"kind":"color","color":"#1e1e2e"},
            "zoomRegions":[{"clipIndex":0,"startSec":0.0,"endSec":5.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}],
            "cursor":{"show":true,"size":7.76,"smoothing":0,"motionBlur":0.35,"clickBounce":1,"clipToBounds":false,"theme":"default"},
            "cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],
            "output":{"width":1170,"height":658,"fps":60}
        }"##
    }

    /// La même scène, avec une région de zoom active à `t = 1.5 s`.
    fn zoomed_golden_scene() -> Scene {
        Scene::from_json(zoomed_golden_scene_json()).expect("zoomed golden scene")
    }

    /// L'ancre des annotations ne bouge PAS avec le zoom, alors que la boîte écran, si.
    ///
    /// C'est tout le contrat de `SceneAnnotation` : l'overlay web est frère de l'élément qui
    /// porte la transform de zoom, donc annotations et sous-titres tiennent en place pendant
    /// que le contenu grossit dessous. Tant que le zoom vivait dans la coupe source, `s_dst`
    /// jouait ce rôle sans effort ; depuis l'issue #179 il vit dans la BOÎTE, et le natif
    /// zoomait les sous-titres avec l'écran. Ce test échoue si `s_ann` se remet à suivre.
    #[test]
    fn the_annotation_anchor_ignores_the_zoom() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let plain = golden_scene();
        let zoomed = zoomed_golden_scene();
        let a = plan_frame(&golden_input(&plain, &cfg));
        let b = plan_frame(&golden_input(&zoomed, &cfg));

        assert_ne!(
            a.s_dst, b.s_dst,
            "le zoom doit bel et bien agir sur la boîte écran (issue #179) — \
             sinon ce test ne prouve rien"
        );
        assert_eq!(
            a.s_ann, b.s_ann,
            "l'ancre des annotations a suivi le zoom : sans zoom {:?}, avec zoom {:?}",
            a.s_ann, b.s_ann
        );
        // Et sans zoom, l'ancre EST la boîte écran : `s_ann` ne doit pas devenir un rect
        // parallèle qui dériverait de `s_dst` pour d'autres raisons (padding, cover, crop).
        assert_eq!(a.s_ann, a.s_dst, "sans zoom, ancre et boîte écran coïncident");
    }

    /// Scène à boîte écran résolue par l'app, pour le cadre de fenêtre. `frame` est inséré tel
    /// quel dans `effects` (chaîne vide = clé absente).
    fn framed_scene(frame: &str, rotation: &str, zoom: f32, cover: bool) -> Scene {
        Scene::from_json(&format!(
            r##"{{
            "clips":[{{"screenPath":"/s.mp4","webcamPath":"","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":false}}],
            "layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,
                      "webcamReactiveZoom":false,"screenRect":{{"x":0.1,"y":0.1,"width":0.8,"height":0.8}},"screenCover":{cover}}},
            "effects":{{"padding":0.2,"blur":false,"shadow":0.5,"roundnessFrac":0.03,"motionBlur":0{frame}}},
            "background":{{"kind":"color","color":"#1e1e2e"}},
            "zoomRegions":[{{"clipIndex":0,"startSec":0.0,"endSec":5.0,"scale":{zoom},"focusX":0.5,"focusY":0.5,"rotation":{rotation}}}],
            "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":1,"clipToBounds":false,"theme":"default"}},
            "cropByClip":[null],
            "output":{{"width":1920,"height":1080,"fps":60}}
        }}"##
        ))
        .expect("framed scene")
    }

    fn framed_plan(scene: &Scene) -> FrameGeometry {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let mut input = golden_input(scene, &cfg);
        input.render_px = [1920.0, 1080.0];
        plan_frame(&input)
    }

    const RENDER: [f32; 2] = [1920.0, 1080.0];

    fn contains(outer: [f32; 4], inner: [f32; 4], eps: f32) -> bool {
        inner[0] >= outer[0] - eps
            && inner[1] >= outer[1] - eps
            && inner[0] + inner[2] <= outer[0] + outer[2] + eps
            && inner[1] + inner[3] <= outer[1] + outer[3] + eps
    }

    /// Sans cadre — clé absente ou `"none"` —, la géométrie est celle d'avant le cadre, champ
    /// pour champ, et l'ombre reprend exactement l'arithmétique des backends.
    #[test]
    fn no_frame_leaves_the_geometry_untouched() {
        for rotation in ["null", r#""iso""#] {
            let absent = framed_plan(&framed_scene("", rotation, 1.5, false));
            let none = framed_plan(&framed_scene(r#","frame":"none""#, rotation, 1.5, false));
            assert_eq!(absent.s_dst, none.s_dst);
            assert_eq!(absent.s_ann, none.s_ann);
            assert_eq!(absent.s_radius.to_bits(), none.s_radius.to_bits());
            assert!(none.window_frame.is_none());
            assert!(none.window_frame_cb(RENDER).is_none());
            assert_eq!(none.screen_square_top(), 0.0);
            let s_px = [none.s_dst[2] * RENDER[0], none.s_dst[3] * RENDER[1]];
            let expected = match none.screen_tilt_in(RENDER) {
                None => ShadowCaster::Upright { dst: none.s_dst, size_px: s_px, radius: none.s_radius },
                Some(q) => ShadowCaster::Tilted {
                    corners: q.corners,
                    center_px: none.screen_center_px(RENDER),
                    radius: none.s_radius * q.scale,
                },
            };
            assert_eq!(none.shadow_caster(RENDER), expected);
            // Sans zoom, l'ancre des annotations reste la boîte écran.
            let rest = framed_plan(&framed_scene(r#","frame":"none""#, rotation, 1.0, false));
            assert_eq!(rest.s_ann, rest.s_dst);
            // Et cette boîte est celle que la scène a résolue, au bit près : sans cadre, rien ne
            // la rétrécit. Épinglé sur l'entrée, pas sur une mesure du code.
            let want: [f32; 4] = [0.1, 0.1, 0.8, 0.8];
            assert_eq!(rest.s_dst.map(f32::to_bits), want.map(f32::to_bits));
            assert_eq!(rest.s_ann.map(f32::to_bits), want.map(f32::to_bits));
            assert_eq!(rest.s_radius.to_bits(), (0.03f32 * 1080.0).to_bits());
        }
    }

    /// Sous un cadre, le masque de confidentialité couvre le rect que l'overlay web montre à
    /// l'utilisateur : l'overlay pose ses poignées sur `fitInWindowFrame(screenRect)` (TS), le
    /// portage de `fit_in_window_frame`. Ancré sur la boîte non rétrécie, le masque tombait une
    /// barre de titre plus bas que le secret tracé, et en laissait une bande lisible.
    #[test]
    fn a_framed_privacy_mask_covers_what_the_overlay_shows() {
        // A plat seulement : incliné, le contenu ne tombe plus dans un rect droit, et l'overlay
        // web ne s'incline pas non plus (limite antérieure au cadre).
        {
            let rotation = "null";
            let g = framed_plan(&framed_scene(r#","frame":"window-light""#, rotation, 1.0, false));
            // Valeurs épinglées aussi dans `compositeLayout.test.ts` : les deux portages
            // doivent rendre ce rect-là.
            let overlay = fit_in_window_frame([0.1, 0.1, 0.8, 0.8], RENDER, false).0;
            let want = [223.6416 / 1920.0, 142.56 / 1080.0, 1472.7168 / 1920.0, 828.4032 / 1080.0];
            for k in 0..4 {
                assert!((overlay[k] - want[k]).abs() < 1e-5, "{overlay:?} au lieu de {want:?}");
            }
            assert_eq!(g.s_ann, overlay, "{rotation}: l'ancre n'est pas le rect de l'overlay");
            for (x, y) in [(0.0, 0.0), (0.62, 0.18), (0.8, 0.9)] {
                let mut a = blur_annotation("");
                (a.x, a.y) = (x, y);
                let drawn = annotation_dst_in(overlay, a.x, a.y, a.w, a.h);
                let m = g.privacy_mask(&a, RENDER).expect("masque");
                assert!(contains(m.dst, drawn, 1e-6), "{rotation}: masque {:?} / tracé {drawn:?}", m.dst);
                // Et il ne déborde que de sa marge d'un pixel.
                assert!((m.dst[1] - drawn[1]).abs() * RENDER[1] < 1.01);
            }
        }
    }

    /// À plat : le cadre contient l'écran, porte l'ombre, et le tout tient dans la boîte où
    /// l'écran tenait seul — au ratio près, l'écran garde celui de sa source.
    #[test]
    fn the_flat_frame_wraps_the_screen_inside_the_old_box() {
        for (frame, dark) in [(r#","frame":"window-light""#, false), (r#","frame":"window-dark""#, true)] {
            for cover in [false, true] {
                let old = framed_plan(&framed_scene("", "null", 1.0, cover));
                let g = framed_plan(&framed_scene(frame, "null", 1.0, cover));
                let wf = g.window_frame.expect("un cadre");
                assert_eq!(wf.dark, dark);
                assert_eq!(g.screen_square_top(), 1.0);
                let ShadowCaster::Upright { dst: outer, size_px, radius } = g.shadow_caster(RENDER) else {
                    panic!("un cadre droit porte une ombre droite");
                };
                assert!(contains(outer, g.s_dst, 1e-6), "cadre {outer:?} / écran {:?}", g.s_dst);
                assert!(contains(old.s_dst, outer, 1e-6), "boîte {:?} / cadre {outer:?}", old.s_dst);
                // Il remplit la boîte sur au moins un axe : le padding garde son sens.
                let fills = (outer[2] - old.s_dst[2]).abs() < 1e-5 || (outer[3] - old.s_dst[3]).abs() < 1e-5;
                assert!(fills, "le cadre ne remplit pas la boîte : {outer:?} dans {:?}", old.s_dst);
                // La barre de titre est en haut, le filet ailleurs.
                assert!(wf.margins[1] * g.s_dst[3] > 10.0 * wf.margins[0] * g.s_dst[2]);
                if !cover {
                    let ar = |r: [f32; 4]| (r[2] * RENDER[0]) / (r[3] * RENDER[1]);
                    assert!((ar(g.s_dst) - ar(old.s_dst)).abs() < 1e-3, "l'écran a changé de ratio");
                }
                // Roundness arrondit le cadre ; l'écran perd l'épaisseur du filet.
                assert!((radius - old.s_radius).abs() < old.s_radius * 0.05, "rayon {radius} vs {}", old.s_radius);
                let line_px = wf.margins[0] * g.s_dst[2] * RENDER[0];
                assert!((g.s_radius - (radius - line_px)).abs() < 1e-3);
                // Le calque du cadre : un rect exact, bbox comprise.
                let cb = g.window_frame_cb(RENDER).expect("calque");
                assert_eq!(cb.mode, 14.0);
                assert!((cb.quad_px[0] - size_px[0]).abs() < 1e-2 && (cb.quad_px[1] - size_px[1]).abs() < 1e-2);
                assert_eq!([cb.fx[0], cb.fx[1]], [0.0, 0.0]);
                assert!((cb.src_prev[0] - size_px[0]).abs() < 1e-2 && (cb.src_prev[1] - size_px[1]).abs() < 1e-2);
                assert!((cb.dst_prev[0] - size_px[0]).abs() < 1e-2);
                assert_eq!(cb.radius_px, radius);
            }
        }
    }

    /// Incliné : le cadre est le même plan que l'écran, prolongé. Les coins de l'écran sont
    /// l'image bilinéaire des coins du cadre aux fractions de ses marges — la propriété qui
    /// garantit que le cadre penche exactement comme le contenu —, le cadre contient l'écran,
    /// porte l'ombre (mode 12), et tient dans la boîte d'avant.
    #[test]
    fn the_tilted_frame_is_the_screen_plane_extended() {
        for preset in [r#""iso""#, r#""left""#, r#""right""#] {
            let old = framed_plan(&framed_scene("", preset, 1.0, false));
            let g = framed_plan(&framed_scene(r#","frame":"window-light""#, preset, 1.0, false));
            let wf = g.window_frame.expect("un cadre");
            let quad = g.screen_tilt_in(RENDER).expect("incliné");
            let ShadowCaster::Tilted { corners: frame, center_px, radius } = g.shadow_caster(RENDER) else {
                panic!("un cadre incliné porte une ombre inclinée");
            };
            assert_eq!(center_px, g.screen_center_px(RENDER));
            assert!((radius - wf.radius * quad.scale).abs() < 1e-4);

            let [ml, mt, mr, mb] = wf.margins;
            let frame_quad = crate::regions::TiltedQuad { corners: frame, ..quad };
            let (u0, v0) = (ml / (1.0 + ml + mr), mt / (1.0 + mt + mb));
            let (u1, v1) = ((1.0 + ml) / (1.0 + ml + mr), (1.0 + mt) / (1.0 + mt + mb));
            for (i, (u, v)) in [(u0, v0), (u1, v0), (u1, v1), (u0, v1)].into_iter().enumerate() {
                let (x, y) = frame_quad.point_px(u, v);
                let (sx, sy) = quad.corners[i];
                assert!((x - sx).abs() < 0.05 && (y - sy).abs() < 0.05, "{preset} coin {i}: {x},{y} vs {sx},{sy}");
            }

            // Le cadre contient l'écran : chaque coin de l'écran est du bon côté des 4 arêtes.
            for &(px, py) in &quad.corners {
                for k in 0..4 {
                    let (ax, ay) = frame[k];
                    let (bx, by) = frame[(k + 1) % 4];
                    let cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
                    assert!(cross > 0.0, "{preset}: coin d'écran hors du cadre (arête {k})");
                }
            }

            // Il tient dans la boîte où l'écran tenait seul. Le prolongement bilinéaire n'est pas
            // une vraie projection et le containment ne porte que sur l'écran : on tolère 1 %.
            let (min_x, max_x) = frame.iter().fold((f32::MAX, f32::MIN), |(a, b), &(x, _)| (a.min(x), b.max(x)));
            let (min_y, max_y) = frame.iter().fold((f32::MAX, f32::MIN), |(a, b), &(_, y)| (a.min(y), b.max(y)));
            let bbox = [
                (center_px[0] + min_x) / RENDER[0],
                (center_px[1] + min_y) / RENDER[1],
                (max_x - min_x) / RENDER[0],
                (max_y - min_y) / RENDER[1],
            ];
            assert!(contains(old.s_dst, bbox, 0.01), "{preset}: cadre {bbox:?} hors de {:?}", old.s_dst);

            let cb = g.window_frame_cb(RENDER).expect("calque");
            assert!((cb.dst_prev[2] - mt * g.s_dst[3] * RENDER[1] * quad.scale).abs() < 1e-3);
            assert_eq!(g.screen_square_top(), 1.0);
        }
    }

    /// Sous un zoom (#179) le cadre grandit avec la boîte : ses marges sont des fractions de
    /// `s_dst`, qui porte le grossissement. L'ancre des annotations, elle, ne bouge pas.
    #[test]
    fn the_frame_zooms_with_the_box() {
        let frame = r#","frame":"window-dark""#;
        let rest = framed_plan(&framed_scene(frame, "null", 1.0, false));
        let zoomed = framed_plan(&framed_scene(frame, "null", 2.0, false));
        assert_eq!(rest.window_frame.unwrap().margins, zoomed.window_frame.unwrap().margins);
        assert!((zoomed.s_dst[2] / rest.s_dst[2] - 2.0).abs() < 1e-4);
        assert_eq!(rest.s_ann, zoomed.s_ann);
        let ShadowCaster::Upright { dst, .. } = zoomed.shadow_caster(RENDER) else { panic!() };
        assert!(contains(dst, zoomed.s_dst, 1e-6));
    }

    /// La même scène, zoomée ET inclinée par un préset de rotation 3D.
    fn tilted_golden_scene() -> Scene {
        Scene::from_json(
            &zoomed_golden_scene_json().replace(r#""rotation":"none""#, r#""rotation":"iso""#),
        )
        .expect("tilted golden scene")
    }

    /// Le rect et la taille de police d'une annotation ne bougent ni sous le zoom ni sous
    /// une rotation 3D.
    ///
    /// `the_annotation_anchor_ignores_the_zoom` prouve que `plan_frame` **calcule** la
    /// bonne ancre ; il ne dit rien de ce que le backend en fait. Linux, lui, refaisait
    /// l'arithmétique contre `s_dst` — donc sous-titres qui grossissent et dérivent, sur
    /// la seule plateforme qui n'avait pas été corrigée. Ce test porte sur les fonctions
    /// que les backends appellent maintenant, pas sur le champ brut : la méthode côté
    /// Linux ET `annotation_dst_in`, par où passent Metal et D3D.
    ///
    /// Ce qu'il ne couvre toujours PAS : le choix du rect au call site de Metal et D3D,
    /// qui prennent leur ancre en paramètre. Ce niveau-là n'est vérifiable qu'en rendant
    /// des pixels.
    ///
    /// Le flou de confidentialité est l'exception, et elle a ses propres tests plus bas
    /// (`a_privacy_mask_*`) : lui DOIT suivre le contenu, sinon ce qu'il cache sort de dessous.
    ///
    /// La rotation compte autant que le zoom : un préset iso/left/right est une propriété
    /// de région de zoom, donc l'incliner amenait aussi la boîte — et les sous-titres
    /// partaient avec elle, sans pour autant suivre le plan incliné. Les deux symptômes,
    /// une seule cause.
    #[test]
    fn the_annotation_rect_and_font_ignore_zoom_and_rotation() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let rh = 658.0;
        // Un rect d'annotation quelconque, décentré : au centre, un rect qui suivrait le
        // zoom garderait le même centre et la moitié de l'erreur passerait inaperçue.
        let (x, y, w, h) = (0.04, 0.78, 0.92, 0.22);

        let plain = plan_frame(&golden_input(&golden_scene(), &cfg));
        let zoomed = plan_frame(&golden_input(&zoomed_golden_scene(), &cfg));
        let tilted = plan_frame(&golden_input(&tilted_golden_scene(), &cfg));

        // Le garde-fou : sans lui, un `plan_frame` qui cesserait d'appliquer le zoom
        // rendrait les assertions suivantes vraies pour la mauvaise raison.
        assert_ne!(
            plain.s_dst, zoomed.s_dst,
            "le zoom doit agir sur la boîte écran — sinon ce test ne prouve rien"
        );
        assert!(
            !crate::regions::is_identity_rotation(tilted.zoom_rotation),
            "le préset iso doit produire une rotation — sinon ce test ne prouve rien"
        );

        let expected = plain.annotation_dst(x, y, w, h);
        for (name, g) in [("zoom", &zoomed), ("rotation 3D", &tilted)] {
            let got = g.annotation_dst(x, y, w, h);
            assert_eq!(
                got, expected,
                "le rect de l'annotation a suivi le {name} : {got:?} au lieu de {expected:?}"
            );
            assert_eq!(
                g.annotation_anchor_h_px(rh),
                plain.annotation_anchor_h_px(rh),
                "la taille de police a suivi le {name}"
            );
            // Metal et D3D n'appellent pas la méthode : ils passent leur rect d'ancrage à
            // `annotation_dst_in`. Les deux chemins doivent rendre le MÊME rect, sinon le
            // « corrigé sur une plateforme seulement » recommence par le bas.
            assert_eq!(
                annotation_dst_in(g.s_ann, x, y, w, h),
                got,
                "le chemin des backends Metal/D3D diverge de la méthode sous le {name}"
            );
            // Et le garde-fou qui donne un sens aux deux précédents : nourrie avec `s_dst`,
            // la même fonction rend un rect DIFFÉRENT. Sans ça, un `annotation_dst_in`
            // devenu constant satisferait tout ce qui précède.
            assert_ne!(
                annotation_dst_in(g.s_dst, x, y, w, h),
                expected,
                "sous le {name}, ancrer sur `s_dst` devrait déplacer le rect — \
                 si les deux coïncident, ce test ne prouve plus rien"
            );
        }
    }

    /// Le focus de profondeur (`z_focus`, mode 8) passe par la coupe réellement dessinée.
    ///
    /// Crop décalé ET focus collé au bord droit sous un zoom x2 : la coupe zoomée bute sur le
    /// bord, son centre tombe à 0.75 du crop alors que le point visé est à 0.95. C'est ce point-là
    /// que le plan doit tenir net, pas le centre, et encore moins (0.5, 0.5).
    #[test]
    fn the_depth_focus_goes_through_the_drawn_cut() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let json = zoomed_golden_scene_json()
            .replace(r#""rotation":"none""#, r#""rotation":"iso""#)
            .replace(r#""focusX":0.5"#, r#""focusX":0.95"#)
            .replace(
                r#""cropByClip":[{"x":0,"y":0,"#,
                r#""cropByClip":[{"x":0.3,"y":0.1,"#,
            );
        let scene = Scene::from_json(&json).expect("scène inclinée recadrée");
        let input = golden_input(&scene, &cfg);
        let g = plan_frame(&input);
        assert!(!crate::regions::is_identity_rotation(g.zoom_rotation), "garde : iso doit incliner");
        assert!((g.focus_plane[0] - 0.95).abs() < 1e-4, "focus x {:?}", g.focus_plane);
        assert!((g.focus_plane[1] - 0.3).abs() < 1e-4, "focus y {:?}", g.focus_plane);

        // Garde : la coupe zoomée est bien clampée, son centre n'est PAS le focus.
        let crop = scene.crop_by_clip[0];
        let cut_ref = screen_source_rect(input.u_max, input.v_max, crop, 2.0, [0.95, 0.3]);
        let centre_local = ((cut_ref[0] + cut_ref[2]) * 0.5 - g.cut[0]) / (g.cut[2] - g.cut[0]);
        assert!((centre_local - 0.75).abs() < 1e-3, "garde : centre de coupe {centre_local}");

        // Et `z_focus` est la profondeur de CE point, pas celle du centre du plan.
        let render = input.render_px;
        let s_px = [g.s_dst[2] * render[0], g.s_dst[3] * render[1]];
        let quad = g.screen_tilt(s_px).expect("iso incline");
        let mb = quad.depth_mb(s_px, g.focus_plane, g.depth_of_field_on(false));
        assert!(mb[3] > 0.0, "réglage absent de la scène : la profondeur de champ est allumée");
        assert!(!g.depth_of_field_on(true) || DOF_ON_CPU_BACKEND);
        let want = (0.95 - 0.5) * mb[0] + (0.3 - 0.5) * mb[1];
        assert!((mb[2] - want).abs() < 1e-3 && mb[2].abs() > 1.0, "z_focus {} au lieu de {want}", mb[2]);
    }

    /// Un cover rogne la coupe dans le crop : le focus s'y reporte, et retombe sur le bord du
    /// plan quand le cover l'a coupé.
    #[test]
    fn the_depth_focus_follows_a_cover_cut_and_clamps_to_it() {
        let cut = [0.25, 0.0, 0.75, 1.0];
        for (focus, want) in [([0.6, 0.5], [0.7, 0.5]), ([0.95, 0.5], [1.0, 0.5]), ([f32::NAN, 0.0], [0.5, 0.0])] {
            let got = focus_in_cut(1.0, 1.0, None, focus, cut);
            assert!((got[0] - want[0]).abs() < 1e-5 && (got[1] - want[1]).abs() < 1e-5, "{got:?} != {want:?}");
        }
    }

    fn blur_annotation(json_extra: &str) -> crate::scene::SceneAnnotation {
        serde_json::from_str(&format!(
            r#"{{"id":"secret","startSec":0,"endSec":10,"kind":"blur",
                "x":0.62,"y":0.18,"w":0.2,"h":0.1{json_extra},
                "blur":{{"style":"mosaic","shape":"rectangle","color":"white","intensity":12,"blockSize":12}}}}"#
        ))
        .expect("annotation flou valide")
    }

    fn inside(r: [f32; 4], x: f32, y: f32) -> bool {
        x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]
    }

    /// Au repos, le masque est le rect de l'annotation, marge d'un pixel comprise.
    #[test]
    fn a_privacy_mask_at_rest_is_the_annotation_rect_plus_a_pixel() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let g = plan_frame(&golden_input(&golden_scene(), &cfg));
        let a = blur_annotation("");
        let render = [1170.0, 658.0];
        let m = g.privacy_mask(&a, render).expect("masque");
        assert!(m.oval_ok);
        let r = g.annotation_dst(a.x, a.y, a.w, a.h);
        let (px, py) = (1.0 / render[0], 1.0 / render[1]);
        let want = [r[0] - px, r[1] - py, r[2] + 2.0 * px, r[3] + 2.0 * py];
        for k in 0..4 {
            assert!((m.dst[k] - want[k]).abs() < 1e-6, "{:?} au lieu de {want:?}", m.dst);
        }
        assert_eq!(m.warp, None);
        assert_eq!(m.strength, 1.0);
    }

    /// Sous un zoom, le masque couvre le MÊME contenu qu'au repos.
    ///
    /// La vérification passe par ce que le mode 0 dessine vraiment : l'UV `cut + c * taille`
    /// au point `s_dst + c * taille`. On relit l'UV que le masque couvrait au repos, puis on
    /// cherche où ce contenu tombe sous le zoom, sans passer par `privacy_mask`.
    #[test]
    fn a_privacy_mask_follows_the_zoomed_content() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let plain = plan_frame(&golden_input(&golden_scene(), &cfg));
        let zoomed = plan_frame(&golden_input(&zoomed_golden_scene(), &cfg));
        assert_ne!(plain.s_dst, zoomed.s_dst, "garde : le zoom doit agir");
        let a = blur_annotation("");
        let render = [1170.0, 658.0];
        let m = zoomed.privacy_mask(&a, render).expect("masque");
        assert_eq!(m.warp, None);

        let uv_at_rest = |fx: f32, fy: f32| {
            let c = plain.cut;
            (c[0] + fx * (c[2] - c[0]), c[1] + fy * (c[3] - c[1]))
        };
        let drawn_under_zoom = |(u, v): (f32, f32)| {
            let (c, d) = (zoomed.cut, zoomed.s_dst);
            (d[0] + (u - c[0]) / (c[2] - c[0]) * d[2], d[1] + (v - c[1]) / (c[3] - c[1]) * d[3])
        };
        let corners = [(a.x, a.y), (a.x + a.w, a.y), (a.x + a.w, a.y + a.h), (a.x, a.y + a.h)];
        for (fx, fy) in corners {
            let (x, y) = drawn_under_zoom(uv_at_rest(fx, fy));
            assert!(
                inside(m.dst, x, y),
                "le coin ({fx}, {fy}) du contenu tombe en ({x}, {y}), hors de {:?}",
                m.dst
            );
        }
        // Serré : la marge grossit avec le contenu, un pixel du repos devient deux sous un x2.
        let (x0, y0) = drawn_under_zoom(uv_at_rest(a.x, a.y));
        assert!((m.dst[0] - (x0 - 2.0 / render[0])).abs() < 1e-5, "{:?}", m.dst);
        assert!((m.dst[1] - (y0 - 2.0 / render[1])).abs() < 1e-5, "{:?}", m.dst);
        // L'ancien placement ratait le contenu : c'est la fuite que ce test garde fermée.
        let old = zoomed.annotation_dst(a.x, a.y, a.w, a.h);
        let (cx, cy) = drawn_under_zoom(uv_at_rest(a.x + a.w * 0.5, a.y + a.h * 0.5));
        assert!(!inside(old, cx, cy), "garde : sous ce zoom l'ancien rect devrait rater le contenu");
        // Le grain grandit avec le contenu : un zoom x2 double le pas de mosaïque.
        assert!((m.strength - 2.0).abs() < 1e-3, "force {} au lieu de 2", m.strength);
    }

    /// La parallaxe (`regions::dynamic_tilt`) passe par `plan_frame` une seule fois, et le
    /// curseur la porte comme l'écran : même quad, même échelle gelée. Curseur masqué ou
    /// région sans préset → rien ne bouge.
    #[test]
    fn the_cursor_rides_the_same_dynamic_tilt_as_the_screen() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        // Le curseur file vers la droite autour de t = 1,5 s (l'instant de `golden_input`).
        let track: &'static crate::cursor::CursorTrack = Box::leak(Box::new(
            crate::cursor::CursorTrack::new(
                (0..=90).map(|i| (i as f32 / 30.0, 0.05 + 0.1 * i as f32 / 30.0, 0.3)).collect(),
                vec![],
                vec![],
            ),
        ));
        let with_track = |scene: &Scene| FrameGeometryInput {
            cursor: Some(track),
            ..golden_input(scene, &cfg)
        };

        let still = plan_frame(&golden_input(&tilted_golden_scene(), &cfg));
        let g = plan_frame(&with_track(&tilted_golden_scene()));
        assert_eq!(still.zoom_rotation_dyn, [0.0; 3], "sans piste");
        assert_eq!(g.zoom_rotation, still.zoom_rotation, "la base ne dépend pas du curseur");
        assert!(g.zoom_rotation_dyn[1] > 0.1, "vers la droite → +Y : {:?}", g.zoom_rotation_dyn);

        let render = [1170.0, 658.0];
        let s_px = [g.s_dst[2] * render[0], g.s_dst[3] * render[1]];
        let quad = g.screen_tilt(s_px).expect("iso incline");
        let still_quad = still.screen_tilt(s_px).expect("iso incline");
        assert_eq!(quad.scale, still_quad.scale, "échelle gelée");
        assert_ne!(quad.corners, still_quad.corners, "la parallaxe bouge les coins");

        let plan = plan_cursor(
            &g,
            &CursorPlanInput {
                render_px: render,
                u_max: 1.0,
                v_max: 1080.0 / 1088.0,
                cfg: &cfg,
                live: live_params_from_scene(&tilted_golden_scene()),
                scene: Some(&tilted_golden_scene()),
                track,
                t: 1.5,
            },
        )
        .expect("curseur visible");
        match plan.placement {
            CursorPlacement::Tilted { quad: cursor_quad, .. } => {
                assert_eq!(cursor_quad.corners, quad.corners);
                assert_eq!(cursor_quad.scale, quad.scale);
            }
            _ => panic!("le curseur doit suivre le plan incliné"),
        }

        let hidden_json = zoomed_golden_scene_json()
            .replace(r#""rotation":"none""#, r#""rotation":"iso""#)
            .replace(r#""show":true"#, r#""show":false"#);
        let hidden = plan_frame(&with_track(&Scene::from_json(&hidden_json).expect("scène")));
        assert_eq!(hidden.zoom_rotation_dyn, [0.0; 3], "curseur masqué : pas de piste en export");

        let flat = plan_frame(&with_track(&zoomed_golden_scene()));
        assert_eq!(flat.zoom_rotation_dyn, [0.0; 3], "sans préset");
    }

    /// La vitesse se mesure dans la coupe VISIBLE, zoom compris : sous un x2, le même geste
    /// traverse deux fois plus d'écran et penche donc plus le plan (hors saturation).
    #[test]
    fn the_parallax_speed_is_measured_in_the_zoomed_cut() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let track: &'static crate::cursor::CursorTrack = Box::leak(Box::new(
            crate::cursor::CursorTrack::new(
                (0..=90).map(|i| (i as f32 / 30.0, 0.05 + 0.1 * i as f32 / 30.0, 0.3)).collect(),
                vec![],
                vec![],
            ),
        ));
        let lean = |scale: &str| {
            let json = zoomed_golden_scene_json()
                .replace(r#""rotation":"none""#, r#""rotation":"iso""#)
                .replace(r#""scale":2.0"#, scale);
            let scene = Scene::from_json(&json).expect("scène");
            plan_frame(&FrameGeometryInput { cursor: Some(track), ..golden_input(&scene, &cfg) })
                .zoom_rotation_dyn[1]
        };
        let (flat, zoomed) = (lean(r#""scale":1.0"#), lean(r#""scale":2.0"#));
        let budget = crate::regions::DYNAMIC_TILT_BUDGET[1];
        assert!(flat > 0.1 && zoomed < budget * 0.9, "garde, hors saturation : {flat} {zoomed}");
        assert!(zoomed > flat * 1.4, "zoom x2 : {zoomed} devrait dépasser {flat} nettement");
    }

    /// L'impact du clic passe par `plan_frame` et chacune de ses portes l'éteint : région sans
    /// l'option ou sans préset, curseur masqué (réglage ou région), clic hors du clip actif ou
    /// de la coupe, vitesse ≥ 2×, masque de flou visible.
    #[test]
    fn every_gate_cancels_the_click_impact() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        // Pointeur immobile près du bord droit du crop (0,61 de large), clic 50 ms avant
        // l'instant du golden (1,5 s) : le creux de `tap`.
        let track_at = |x: f32| -> &'static crate::cursor::CursorTrack {
            Box::leak(Box::new(crate::cursor::CursorTrack::new(
                (0..=90).map(|i| (i as f32 / 30.0, x, 0.3)).collect(),
                vec![1.45],
                vec![],
            )))
        };
        let on_edge = track_at(0.6);
        let impact_json = zoomed_golden_scene_json()
            .replace(r#""rotation":"none""#, r#""rotation":"iso","clickImpact":true"#);
        let dyn_of = |edit: &dyn Fn(String) -> String, track| {
            let scene = Scene::from_json(&edit(impact_json.clone())).expect("scène");
            plan_frame(&FrameGeometryInput { cursor: Some(track), ..golden_input(&scene, &cfg) })
                .zoom_rotation_dyn
        };
        let same = |s: String| s;
        let on = dyn_of(&same, on_edge);
        assert!(on[1] > 1.5, "clic à droite → +Y : {on:?}");

        let insert = |field: &'static str| {
            move |s: String| s.replace(r#""cursor":"#, &format!(r#"{field},"cursor":"#))
        };
        let cases: [(&str, Box<dyn Fn(String) -> String>); 7] = [
            ("option absente", Box::new(|s: String| s.replace(r#","clickImpact":true"#, ""))),
            ("sans préset", Box::new(|s: String| s.replace(r#""rotation":"iso""#, r#""rotation":"none""#))),
            ("curseur masqué", Box::new(|s: String| s.replace(r#""show":true"#, r#""show":false"#))),
            ("région hideCursor", Box::new(|s: String| s.replace(r#""clickImpact":true"#, r#""clickImpact":true,"hideCursor":true"#))),
            ("clic avant le clip", Box::new(|s: String| s.replace(r#""sourceStartSec":0"#, r#""sourceStartSec":1.46"#))),
            ("vitesse 2x", Box::new(insert(r#""speedRegions":[{"clipIndex":0,"startSec":1.0,"endSec":2.0,"speed":2.0}]"#))),
            ("flou visible", Box::new(insert(r#""annotations":[{"id":"b","startSec":1.0,"endSec":2.0,"kind":"blur","x":0.1,"y":0.1,"w":0.2,"h":0.2,"blur":{"style":"mosaic","shape":"rectangle","color":"black","intensity":8,"blockSize":16}}]"#))),
        ];
        for (name, edit) in &cases {
            assert_eq!(dyn_of(edit.as_ref(), on_edge), [0.0; 3], "{name}");
        }
        assert_eq!(dyn_of(&same, track_at(0.9)), [0.0; 3], "clic hors du crop");

        // Un flou qui n'est plus visible ne retient rien ; une vitesse 1,5× pèse moitié.
        let later_blur = insert(r#""annotations":[{"id":"b","startSec":3.0,"endSec":4.0,"kind":"blur","x":0.1,"y":0.1,"w":0.2,"h":0.2,"blur":{"style":"blur","shape":"rectangle","color":"black","intensity":8,"blockSize":16}}]"#);
        assert_eq!(dyn_of(&later_blur, on_edge), on);
        let slow = dyn_of(
            &insert(r#""speedRegions":[{"clipIndex":0,"startSec":1.0,"endSec":2.0,"speed":1.5}]"#),
            on_edge,
        );
        assert!((slow[1] - on[1] * 0.5).abs() < 1e-4, "{slow:?} vs {on:?}");

        // Le curseur monte sur le même plan basculé que l'écran.
        let g = plan_frame(&FrameGeometryInput {
            cursor: Some(on_edge),
            ..golden_input(&Scene::from_json(&impact_json).expect("scène"), &cfg)
        });
        let render = [1170.0, 658.0];
        let s_px = [g.s_dst[2] * render[0], g.s_dst[3] * render[1]];
        let quad = g.screen_tilt(s_px).expect("iso incline");
        let scene = Scene::from_json(&impact_json).expect("scène");
        let plan = plan_cursor(
            &g,
            &CursorPlanInput {
                render_px: render,
                u_max: 1.0,
                v_max: 1080.0 / 1088.0,
                cfg: &cfg,
                live: live_params_from_scene(&scene),
                scene: Some(&scene),
                track: on_edge,
                t: 1.5,
            },
        )
        .expect("curseur visible");
        match plan.placement {
            CursorPlacement::Tilted { quad: cursor_quad, .. } => {
                assert_eq!(cursor_quad.corners, quad.corners)
            }
            _ => panic!("le curseur doit suivre le plan incliné"),
        }
    }

    /// `follow-cursor` passe par `plan_frame` : l'écran n'est pas incliné, la caméra vise et tourne
    /// avec le pointeur lu dans le RECADRAGE, la boîte zoome sur son centre sans glisser, la mise au
    /// point suit la visée, un clic fait reculer l'œil sans presser l'écran, et curseur masqué
    /// (l'export n'a alors pas de piste) la caméra vise le centre, au repos.
    #[test]
    fn the_follow_camera_aims_at_the_pointer_in_the_crop() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let json = zoomed_golden_scene_json()
            .replace(r#""rotation":"none""#, r#""rotation":"follow-cursor","clickImpact":true"#);
        let scene = Scene::from_json(&json).expect("scène");
        let parked = |x: f32, clicks: Vec<f32>| -> &'static crate::cursor::CursorTrack {
            Box::leak(Box::new(crate::cursor::CursorTrack::new(
                (0..=90).map(|i| (i as f32 / 30.0, x, 0.3)).collect(),
                clicks,
                vec![],
            )))
        };
        let plan = |scene: &Scene, track| {
            plan_frame(&FrameGeometryInput { cursor: Some(track), ..golden_input(scene, &cfg) })
        };
        // Le crop du golden fait 0,61 de large : x = 0,55 est tout à droite de ce qu'on voit, alors
        // que dans l'image entière ce serait presque le centre.
        let right = plan(&scene, parked(0.55, vec![]));
        let left = plan(&scene, parked(0.05, vec![]));
        let (cr, cl) = (right.camera.expect("caméra"), left.camera.expect("caméra"));
        assert_eq!(cr.weight, 1.0);
        // Zoom 2 : la vue reste dans l'écran tant que la visée reste dans [0,275 ; 0,725].
        assert!(cr.aim[0] > 0.72 && cl.aim[0] < 0.28, "{:?} {:?}", cr.aim, cl.aim);
        // L'orbite lit tout le recadrage, sans la borne du zoom : 0,55 y tombe à 0,9.
        assert!(cr.orbit[0] > 0.89 && cl.orbit[0] < 0.1, "{:?} {:?}", cr.orbit, cl.orbit);
        assert_eq!((cr.zoom, cr.press), (2.0, 0.0));
        assert_eq!((right.zoom_rotation, right.zoom_rotation_dyn), ([0.0; 3], [0.0; 3]));
        assert_eq!(right.focus_plane, cr.orbit, "la mise au point suit le pointeur");
        assert_eq!(right.s_dst, left.s_dst, "la boîte ne glisse pas");
        assert!(right.tilted() && right.depth_of_field_on(false) == right.depth_of_field);

        let render = [1170.0, 658.0];
        let s_px = [right.s_dst[2] * render[0], right.s_dst[3] * render[1]];
        let (qr, ql) = (right.screen_tilt(s_px).expect("caméra"), left.screen_tilt(s_px).expect("caméra"));
        assert!(qr.projective && ql.projective);
        assert!((qr.scale - ql.scale).abs() < 0.03, "{} {}", qr.scale, ql.scale);
        // Visant à droite, la caméra rejette le centre de l'écran à gauche de l'image ; vue de la
        // droite, le bord droit de l'écran est le plus haut.
        assert!(qr.offset[0] < -100.0 && ql.offset[0] > 100.0, "{:?} {:?}", qr.offset, ql.offset);
        let edge = |q: &crate::regions::TiltedQuad, a: usize, b: usize| q.corners[b].1 - q.corners[a].1;
        assert!(edge(&qr, 1, 2) > edge(&qr, 0, 3) && edge(&ql, 0, 3) > edge(&ql, 1, 2));

        // L'ombre de l'écran tombe du côté de celle de la flèche (lumière en haut à gauche), sur la
        // même longueur que l'ombre droite, qui reste verticale.
        let flat = plan(&zoomed_golden_scene(), parked(0.55, vec![]));
        let ([fx, fy], [cx, cy]) = (flat.screen_shadow_offset(), right.screen_shadow_offset());
        assert!(fx == 0.0 && fy > 0.0, "{fx} {fy}");
        assert!(cx > 0.0 && cy > 0.0 && (cx.hypot(cy) - fy).abs() < 1e-3, "{cx} {cy}");

        // Un clic ne presse pas l'écran immobile : l'œil recule, au creux de `tap` 50 ms après.
        let clicked = plan(&scene, parked(0.55, vec![1.45]));
        assert_eq!((clicked.zoom_rotation, clicked.zoom_rotation_dyn), ([0.0; 3], [0.0; 3]));
        let pose = clicked.camera.expect("caméra");
        assert!(pose.press < -0.9, "{pose:?}");
        let pushed = clicked.screen_tilt(s_px).expect("caméra");
        assert!(pushed.half_extents_px().0 < 0.98 * qr.half_extents_px().0);
        let off = Scene::from_json(&json.replace(r#","clickImpact":true"#, "")).expect("scène");
        assert_eq!(plan(&off, parked(0.55, vec![1.45])).camera.expect("caméra").press, 0.0);

        let hidden = Scene::from_json(&json.replace(r#""show":true"#, r#""show":false"#)).expect("scène");
        let front = plan(&hidden, parked(0.55, vec![])).camera.expect("caméra au repos");
        assert!((front.aim[0] - 0.5).abs() < 1e-4 && (front.aim[1] - 0.5).abs() < 1e-4, "{:?}", front.aim);
        assert!((front.orbit[0] - 0.5).abs() < 1e-4 && (front.orbit[1] - 0.5).abs() < 1e-4, "{:?}", front.orbit);
    }

    /// Sous un préset 3D, le masque est le quad du contenu, warpé comme le mode 8 le dessine.
    #[test]
    fn a_privacy_mask_follows_the_tilted_content() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let g = plan_frame(&golden_input(&tilted_golden_scene(), &cfg));
        assert!(!crate::regions::is_identity_rotation(g.zoom_rotation), "garde : iso doit incliner");
        let a = blur_annotation("");
        let render = [1170.0, 658.0];
        let m = g.privacy_mask(&a, render).expect("masque");
        let warp = m.warp.expect("un écran incliné demande un masque warpé");

        // Le même quad et le même centre que le dessin du mode 8 (`compose_frame`).
        let s_px = [g.s_dst[2] * render[0], g.s_dst[3] * render[1]];
        let quad = g.screen_tilt(s_px).expect("iso incline");
        let centre = [
            (g.s_dst[0] + g.s_dst[2] * 0.5) * render[0],
            (g.s_dst[1] + g.s_dst[3] * 0.5) * render[1],
        ];
        let drawn = |fx: f32, fy: f32| {
            let (px, py) = quad.point_px(fx, fy);
            [centre[0] + px, centre[1] + py]
        };
        let content = [(a.x, a.y), (a.x + a.w, a.y), (a.x + a.w, a.y + a.h), (a.x, a.y + a.h)];
        let mid = drawn(a.x + a.w * 0.5, a.y + a.h * 0.5);
        let from_mid = |p: [f32; 2]| (p[0] - mid[0]).hypot(p[1] - mid[1]);
        let origin = [m.dst[0] * render[0], m.dst[1] * render[1]];
        for (k, &(fx, fy)) in content.iter().enumerate() {
            let want = drawn(fx, fy);
            let got = [origin[0] + warp[k][0], origin[1] + warp[k][1]];
            let gap = (got[0] - want[0]).hypot(got[1] - want[1]);
            // La marge vaut deux pixels de la boîte zoomée par axe, projetés : au plus ~3 px
            // en diagonale.
            assert!(gap > 0.5 && gap < 3.5, "coin {k} : {got:?} à {gap} px du contenu {want:?}");
            // Côté sur-masquage : le coin du masque est plus loin du centre que celui du contenu.
            assert!(from_mid(got) > from_mid(want), "coin {k} rentré dans le contenu");
            assert!(got[0] >= origin[0] - 1e-3 && got[0] <= origin[0] + m.quad_px[0] + 1e-3);
            assert!(got[1] >= origin[1] - 1e-3 && got[1] <= origin[1] + m.quad_px[1] + 1e-3);
        }
        // L'ancien rect droit ne couvrait pas le centre du contenu incliné.
        let old = g.annotation_dst(a.x, a.y, a.w, a.h);
        assert!(
            !inside(old, mid[0] / render[0], mid[1] / render[1]),
            "garde : sous ce préset l'ancien rect devrait rater le contenu"
        );
        assert!(m.strength >= 1.0);
    }

    /// Pendant une rampe de zoom, le flou de mouvement du mode 0 étale le contenu jusqu'à sa
    /// position de la frame précédente : le masque couvre les deux.
    #[test]
    fn a_privacy_mask_covers_the_motion_blur_trail() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let scene = zoomed_golden_scene();
        let a = blur_annotation("");
        let render = [1170.0, 658.0];
        let moving = (0..400)
            .map(|k| {
                let mut input = golden_input(&scene, &cfg);
                input.timeline_t_override = Some(k as f32 * 0.02 - 1.0);
                plan_frame(&input)
            })
            .find(|g| g.s_dst != g.s_dst_prev)
            .expect("garde : la rampe de zoom doit déplacer la boîte d'une frame à l'autre");
        assert!(moving.mb_taps >= 2.0 && moving.mb_amount > 0.001, "garde : flou de mouvement actif");
        let m = moving.privacy_mask(&a, render).expect("masque");
        // Élargi, le masque ne peut plus être un ovale inscrit : il retombe sur le rect.
        assert!(!m.oval_ok, "un masque élargi à la trace doit refuser l'ovale");
        for anchor in [moving.s_dst, moving.s_dst_prev] {
            let r = annotation_dst_in(anchor, a.x, a.y, a.w, a.h);
            for (x, y) in [(r[0], r[1]), (r[0] + r[2], r[1] + r[3])] {
                assert!(inside(m.dst, x, y), "({x}, {y}) hors du masque {:?}", m.dst);
            }
        }
    }

    /// Une entrée mesurée sur le cadre de sortie n'est pas concernée par le zoom.
    #[test]
    fn a_privacy_mask_in_frame_space_ignores_the_zoom() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let g = plan_frame(&golden_input(&tilted_golden_scene(), &cfg));
        let a = blur_annotation(r#","space":"frame""#);
        let m = g.privacy_mask(&a, [1170.0, 658.0]).expect("masque");
        assert_eq!(m.warp, None);
        assert_eq!(m.strength, 1.0);
        assert!(inside(m.dst, a.x, a.y) && inside(m.dst, a.x + a.w, a.y + a.h));
    }

    /// **Le golden iso-render.**
    ///
    /// Les deux backends ne peuvent pas tourner sur la même machine, donc « iso avec
    /// D3D » ne peut pas être mesuré en comparant deux images rendues. Ce qui PEUT l'être,
    /// et qui est la couche où la divergence s'est effectivement produite, c'est la
    /// géométrie : `plan_frame` est le MÊME code des deux côtés, et ce test épingle ses 15
    /// sorties au bit près. Il tourne dans le job macOS ET dans le job Windows, donc si un
    /// jour les deux plateformes calculent des placements différents, l'un des deux vire au
    /// rouge — ce qui est exactement la garantie qu'on cherche.
    ///
    /// Ce que ce test ne couvre PAS, et qu'il ne faut pas lui faire dire : la rastérisation.
    /// D3D11 et Metal ne rendront jamais bit-à-bit identique (la PR #162 a mesuré 93-95 %
    /// de canaux identiques, écart max 3/255, entre deux backends sur la MÊME machine).
    /// La parité des shaders est tenue séparément, par le fait que `shaders.metal` et
    /// `shaders.hlsl` ont été diffés ligne à ligne sur les 14 modes.
    #[test]
    fn plan_frame_is_pinned_bit_for_bit() {
        let scene = golden_scene();
        let cfg = crate::config::all().pop().expect("au moins une config");
        let g = plan_frame(&golden_input(&scene, &cfg));
        let got = [
            g.s_dst[0], g.s_dst[1], g.s_dst[2], g.s_dst[3],
            g.w_dst[0], g.w_dst[1], g.w_dst[2], g.w_dst[3],
            g.cut[0], g.cut[1], g.cut[2], g.cut[3],
            g.s_radius, g.w_radius, g.w_px[0], g.w_px[1],
            g.frame_min_px, g.padding_scale, g.shape_fade, g.mb_taps, g.source_t,
            g.programme_t,
        ];
        // Mesuré sur ce code, pas deviné : toute dérive est une divergence à expliquer,
        // pas un seuil à relâcher. Ordre : s_dst[4], w_dst[4], cut[4], s_radius, w_radius,
        // w_px[2], frame_min_px, padding_scale, shape_fade, mb_taps, source_t, programme_t.
        // `programme_t` ajouté avec l'horloge programme : c'est une recopie de l'entrée, les
        // 21 valeurs d'avant n'ont pas bougé d'un bit.
        let want: [f32; 22] = [
            0.10207555, 0.102, 0.7958489, 0.796,
            0.9058473, 0.8325926, 0.0733194, 0.13037036,
            0.0, 0.0, 0.61, 0.6055147,
            16.779, 42.89185, 85.7837, 85.7837,
            658.0, 0.796, 1.0, 6.25, 1.5,
            2.25,
        ];
        for (i, (a, b)) in got.iter().zip(want.iter()).enumerate() {
            assert_eq!(
                a.to_bits(),
                b.to_bits(),
                "sortie #{i} de plan_frame : {a} != {b}",
            );
        }
    }

    /// En preview, la même image arrive avec deux compteurs `frame` différents selon qu'on y
    /// vient en lecture (`idx` incrémenté) ou par un seek (`idx` dérivé du temps). Le temps
    /// programme ne doit dépendre que de l'instant fourni, jamais de ce compteur.
    #[test]
    fn programme_time_ignores_the_frame_counter() {
        let scene = golden_scene();
        let cfg = crate::config::all().pop().expect("au moins une config");
        let mut played = golden_input(&scene, &cfg);
        played.frame = 7.0;
        let mut sought = golden_input(&scene, &cfg);
        sought.frame = 90.0;
        assert_eq!(
            plan_frame(&played).programme_t.to_bits(),
            plan_frame(&sought).programme_t.to_bits()
        );
        // Sans horloge programme (bench/fixture), repli sur le compteur comme `source_t`.
        sought.programme_time = None;
        assert_eq!(plan_frame(&sought).programme_t, 90.0 / FPS);
    }

    /// Sans mouvement, les emplacements restent les zéros d'avant (dégradé inchangé) ; avec,
    /// le temps est replié sur la période commune et l'indice suit l'ordre du shader.
    #[test]
    fn gradient_motion_slots_are_zero_when_still_and_wrap_the_clock() {
        use crate::scene::GradientMotion as M;
        assert_eq!(gradient_motion_slots(M::None, 37.5, 16.0 / 9.0), ([0.0, 0.0], [0.0; 4]));
        let (fx, mb) = gradient_motion_slots(M::Drift, 125.0, 2.0);
        assert_eq!(fx, [5.0, 1.0]);
        assert_eq!(mb, [2.0, 0.0, 0.0, 0.0]);
        assert_eq!(gradient_motion_slots(M::Aurora, 0.0, 1.0).0[1], 2.0);
        assert_eq!(gradient_motion_slots(M::Waves, 240.0, 1.0).0, [0.0, 3.0]);
        // Chaque période du shader divise la période de repli : pas de raccord au bouclage.
        for p in [20.0, 24.0, 30.0, 40.0, 12.0, 120.0] {
            assert_eq!(GRADIENT_MOTION_PERIOD_S % p, 0.0, "période {p}");
        }
    }

    /// Le contrat cross-backend, verrouillé octet par octet. Un shader qui lit un champ
    /// décalé ne lève rien : il rend faux, en silence.
    #[test]
    fn layer_cb_matches_the_shader_constant_buffer() {
        use std::mem::{align_of, offset_of, size_of};
        assert_eq!(size_of::<LayerCB>(), 128);
        assert_eq!(align_of::<LayerCB>(), 16);
        for (name, got, want) in [
            ("dst", offset_of!(LayerCB, dst), 0),
            ("src", offset_of!(LayerCB, src), 16),
            ("quad_px", offset_of!(LayerCB, quad_px), 32),
            ("radius_px", offset_of!(LayerCB, radius_px), 40),
            ("mode", offset_of!(LayerCB, mode), 44),
            ("color", offset_of!(LayerCB, color), 48),
            ("fx", offset_of!(LayerCB, fx), 64),
            ("src_prev", offset_of!(LayerCB, src_prev), 80),
            ("dst_prev", offset_of!(LayerCB, dst_prev), 96),
            ("mb", offset_of!(LayerCB, mb), 112),
        ] {
            assert_eq!(got, want, "offset de `{name}`");
        }
    }

    /// Le pivot doit rester collé à `center` quand le sprite grandit — c'est exactement ce qui
    /// était cassé (ancrage centré en dur : la pointe s'éloignait proportionnellement à la
    /// taille). On dessine la même flèche à deux tailles et on vérifie que le point désigné
    /// ne bouge pas.
    #[test]
    fn sprite_hotspot_stays_on_target_at_any_size() {
        let center = [0.4, 0.6];
        let hotspot = [0.119, 0.0874]; // flèche intégrée : la pointe, près du coin haut-gauche

        for (w, h) in [(0.02, 0.04), (0.08, 0.16)] {
            let dst = cursor_sprite_dst(center, w, h, hotspot);
            let pivot = [dst[0] + dst[2] * hotspot[0], dst[1] + dst[3] * hotspot[1]];
            assert!((pivot[0] - center[0]).abs() < 1e-6, "x drifted at {w}x{h}: {pivot:?}");
            assert!((pivot[1] - center[1]).abs() < 1e-6, "y drifted at {w}x{h}: {pivot:?}");
            assert_eq!([dst[2], dst[3]], [w, h], "taille altérée");
        }

        // Et un pivot centré reste bien l'ancien comportement, pour les sprites qui le veulent
        // (viseur, I-beam, poignées de redimensionnement).
        assert_eq!(cursor_sprite_dst([0.5, 0.5], 0.2, 0.2, [0.5, 0.5]), [0.4, 0.4, 0.2, 0.2]);
    }
    fn assert_rect(actual: [f32; 4], expected: [f32; 4]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-6, "actual={actual}, expected={expected}");
        }
    }

    #[test]
    fn decodes_a_base64_data_uri() {
        // "Hi!" -> SGkh
        assert_eq!(decode_data_uri("data:image/png;base64,SGkh").unwrap(), b"Hi!".to_vec());
    }

    /// L'inspector stocke les couleurs de caption comme `couleur_hex` + `opacité` puis la
    /// bridge JS recombine en `rgba(r, g, b, a)` pour la preview. Le natif doit rendre la même
    /// plaque (couleur et opacité) — sinon le calque disparaît silencieusement et la caption
    /// n'apparaît qu'en texte brut dans l'export. C'était exactement le bug de l'issue #178.
    #[test]
    fn parse_hex_understands_rgba_caption_backgrounds() {
        let parsed = parse_hex("rgba(0, 0, 0, 0.55)").expect("rgba doit parser");
        assert!((parsed[3] - 0.55).abs() < 1e-6, "alpha 0.55 transmise, pas tombée à 0");
        assert_eq!([parsed[0], parsed[1], parsed[2]], [0.0, 0.0, 0.0]);
    }

    /// `rgb(...)` sans alpha est sémantiquement `rgba(..., 1)` — il faut le supporter pour
    /// qu'un inspector qui n'expose pas d'opacité n'écrive pas un fond invisible.
    #[test]
    fn parse_hex_treats_rgb_as_opaque() {
        let parsed = parse_hex("rgb(255, 128, 0)").expect("rgb doit parser");
        assert_eq!(parsed, [1.0, 128.0 / 255.0, 0.0, 1.0]);
    }

    /// Le cas "transparent" est documenté dans le code d'appel : on garde la sémantique
    /// historique (alpha 0) — la plaque est sautée côté rastérisation, ce qui est exactement ce
    /// que veut le CSS. Le nouveau parseur ne doit pas le casser.
    #[test]
    fn parse_hex_keeps_transparent_at_alpha_zero() {
        assert_eq!(parse_hex("transparent"), Some([0.0, 0.0, 0.0, 0.0]));
        // La casse ne doit pas non plus casser : CSS autorise `TRANSPARENT` en théorie, et
        // refuse une chaîne qui ressemble à un rgba mal formé.
        assert_eq!(parse_hex("Transparent"), Some([0.0, 0.0, 0.0, 0.0]));
        assert_eq!(parse_hex("rgba(0, 0, 0, 0)"), Some([0.0, 0.0, 0.0, 0.0]));
    }

    /// Le contrat historique `#rrggbb` / `rrggbb` ne doit pas régresser : les annotations
    /// normales (saisies via `ColorField`) ne passent que par ce chemin, et leurs snapshots
    /// ne pardonneraient pas un changement d'alpha implicite.
    #[test]
    fn parse_hex_still_understands_hex_colours() {
        assert_eq!(parse_hex("#fff"), Some([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(parse_hex("#000000"), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(
            parse_hex("ff8800"),
            Some([1.0, 136.0 / 255.0, 0.0, 1.0])
        );
    }

    /// Hors-format (channel > 255, chaîne vide, named color) → None → l'appelant retombe sur
    /// son fallback. C'est la même politique qu'avant l'ajout du parseur rgba, on la garde
    /// explicite pour qu'elle ne dérive pas.
    #[test]
    fn parse_hex_rejects_malformed_colours() {
        assert_eq!(parse_hex(""), None);
        assert_eq!(parse_hex("not-a-color"), None);
        assert_eq!(parse_hex("rgba(256, 0, 0, 1)"), None); // canal >255
        assert_eq!(parse_hex("rgba(0, 0, 0, 1.5)"), None); // alpha >1
        assert_eq!(parse_hex("rgba(0, 0, 0, 0.5, 1)"), None); // 5 composantes
        assert_eq!(parse_hex("rgb(0, 0)"), None); // 2 composantes
    }

    /// CSS Color 4 : `rgb()` et `rgba()` sont synonymes, les deux prennent 3 ou 4 composantes.
    /// Une couleur bien formée ne doit pas finir sur le fallback de l'appelant — pour un fond
    /// c'est alpha 0, donc une plaque invisible, soit très exactement le symptôme de #178.
    #[test]
    fn parse_hex_accepts_both_arities_on_both_names() {
        assert_eq!(parse_hex("rgba(0, 0, 0)"), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(parse_hex("rgb(0, 0, 0, 0.5)"), Some([0.0, 0.0, 0.0, 0.5]));
    }

    /// Une couleur non-ASCII doit être refusée, pas paniquer : `strip_color_fn` découpait
    /// `s[..3]` / `s[..4]` sans vérifier la frontière de caractère, donc `#ab€cd` (le `€` occupe
    /// les octets 3..6) tuait le process au lieu de retomber sur le fallback. `parseWallpaper`
    /// laisse passer n'importe quelle chaîne préfixée `#` jusqu'ici, une panique côté natif
    /// traverserait le pont N-API et emporterait l'export.
    #[test]
    fn parse_hex_refuses_non_ascii_without_panicking() {
        assert_eq!(parse_hex("#ab€cd"), None);
        assert_eq!(parse_hex("rg€(0, 0, 0)"), None);
        assert_eq!(parse_hex("é"), None);
        assert_eq!(parse_hex("🎨🎨"), None);
        // Le chemin hex découpe par octet sur les longueurs 3 et 6 : `éa` fait 3 octets et
        // `€€` en fait 6, donc les deux tombaient pile sur une découpe intra-caractère.
        assert_eq!(parse_hex("éa"), None);
        assert_eq!(parse_hex("€€"), None);
    }

    #[test]
    fn ignores_padding_and_line_breaks_inside_the_payload() {
        // Un URI replié ou paddé doit décoder à l'identique : les caractères hors alphabet sont
        // sautés, donc ils ne peuvent pas décaler le flux.
        let folded = "data:image/png;base64,SGkh
==";
        assert_eq!(decode_data_uri(folded).unwrap(), b"Hi!".to_vec());
    }

    #[test]
    fn a_plain_path_is_not_a_data_uri() {
        // Le repli lecture-disque des wallpapers en dépend.
        assert!(decode_data_uri("/wallpapers/x.jpg").is_none());
        assert!(decode_data_uri("C:/img/y.png").is_none());
    }

    #[test]
    fn a_non_base64_data_uri_is_refused() {
        // `data:image/svg+xml,<svg…>` n'est pas du base64 : mieux vaut échouer que décoder du
        // texte comme des octets.
        assert!(decode_data_uri("data:image/svg+xml,<svg/>").is_none());
    }

    #[test]
    fn crop_maps_visible_frame_fractions_to_texture_uvs() {
        let crop = SceneCrop { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
        assert_rect(screen_source_rect(0.8, 0.9, None, 1.0, [0.2, 0.7]), [0.0, 0.0, 0.8, 0.9]);
        assert_rect(screen_source_rect(0.8, 0.9, Some(crop), 1.0, [0.5, 0.5]), [0.2, 0.09, 0.6, 0.63]);
    }

    #[test]
    fn zoom_focus_is_applied_inside_the_crop() {
        let crop = SceneCrop { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
        assert_rect(screen_source_rect(0.8, 0.9, Some(crop), 2.0, [0.5, 0.5]), [0.3, 0.225, 0.5, 0.495]);
        assert_rect(screen_source_rect(0.8, 0.9, Some(crop), 2.0, [1.0, 1.0]), [0.4, 0.36, 0.6, 0.63]);
    }

    // --- le zoom rendu à la boîte (issue #179) ------------------------------
    // Le zoom déplace et agrandit la boîte au lieu de rétrécir la coupe. Deux choses à
    // figer, et elles tirent en sens inverse : la boîte DOIT déborder le padding (l'issue),
    // et le mapping image→écran ne doit PAS bouger (tout le reste du compositeur en
    // dépend). Une version antérieure de ce correctif protégeait si bien le second qu'elle
    // annulait le premier dès que le focus n'était pas centré — d'où le balayage sur des
    // focus décentrés dans les deux tests.

    /// Boîte paddée (padding 50 % → `scale_frame` 0.8) dans une sortie carrée : le cas
    /// plein cadre de l'issue.
    const PADDED: [f32; 4] = [0.1, 0.1, 0.8, 0.8];

    /// Les zooms d'un preset (`ZOOM_DEPTH_SCALES`, TS) et des focus réalistes — dont des
    /// focus très décentrés, que le suivi de curseur produit en permanence.
    const ZOOMS: [f32; 6] = [1.0, 1.25, 1.5, 1.8, 2.2, 3.5];
    const FOCUSES: [[f32; 2]; 6] = [
        [0.5, 0.5],
        [0.3, 0.5],
        [0.5, 0.8],
        [0.15, 0.9],
        [0.85, 0.2],
        [0.0, 1.0],
    ];

    /// Le couple (boîte, coupe) réellement envoyé au GPU. `u_max`/`v_max` à 1 et pas de
    /// crop : la coupe est donc directement en fractions d'image.
    fn drawn(base: [f32; 4], zoom: f32, focus: [f32; 2]) -> ([f32; 4], [f32; 4]) {
        let cut_ref = screen_source_rect(1.0, 1.0, None, zoom, focus);
        let cut = screen_source_rect(1.0, 1.0, None, 1.0, focus);
        (remap_box(base, cut_ref, cut), cut)
    }

    /// Où un point de l'image atterrit à l'écran, en fraction du CADRE.
    fn on_screen(base: [f32; 4], zoom: f32, focus: [f32; 2], point: [f32; 2]) -> [f32; 2] {
        let (dst, src) = drawn(base, zoom, focus);
        let at = |f: f32, s0: f32, s1: f32, d0: f32, dw: f32| d0 + dw * (f - s0) / (s1 - s0);
        [
            at(point[0], src[0], src[2], dst[0], dst[2]),
            at(point[1], src[1], src[3], dst[1], dst[3]),
        ]
    }

    /// Le mapping d'avant : la coupe zoomée remplissait la boîte paddée, sans la bouger.
    fn on_screen_before(base: [f32; 4], zoom: f32, focus: [f32; 2], point: [f32; 2]) -> [f32; 2] {
        let src = screen_source_rect(1.0, 1.0, None, zoom, focus);
        let at = |f: f32, s0: f32, s1: f32, d0: f32, dw: f32| d0 + dw * (f - s0) / (s1 - s0);
        [
            at(point[0], src[0], src[2], base[0], base[2]),
            at(point[1], src[1], src[3], base[1], base[3]),
        ]
    }

    /// L'invariant : rendre le zoom à la boîte ne déplace AUCUN point de l'image — même
    /// grossissement, même cadrage. Seule l'étendue dessinée change.
    #[test]
    fn handing_the_zoom_to_the_box_moves_no_pixel() {
        for &zoom in &ZOOMS {
            for &focus in &FOCUSES {
                for &point in &[[0.5, 0.5], [0.0, 0.0], [1.0, 1.0], [0.25, 0.75]] {
                    let (was, now) = (
                        on_screen_before(PADDED, zoom, focus, point),
                        on_screen(PADDED, zoom, focus, point),
                    );
                    assert!(
                        (was[0] - now[0]).abs() < 1e-4 && (was[1] - now[1]).abs() < 1e-4,
                        "point {point:?} déplacé (zoom {zoom}, focus {focus:?}) : {was:?} → {now:?}"
                    );
                }
            }
        }
    }

    /// Ce que l'issue demande, et la régression que le testeur a vue : dès qu'on zoome, la
    /// boîte doit déborder le rect paddé — y compris (surtout) avec un focus décentré.
    #[test]
    fn any_zoom_overflows_the_padding() {
        for &zoom in &ZOOMS {
            for &focus in &FOCUSES {
                let (dst, _) = drawn(PADDED, zoom, focus);
                let grew = dst[2] / PADDED[2];
                assert!(
                    (grew - zoom).abs() < 1e-4,
                    "la boîte n'a pas pris le zoom (zoom {zoom}, focus {focus:?}) : ×{grew}"
                );
                if zoom > 1.0 {
                    // Elle dépasse le rect paddé d'au moins un bord, donc mange du padding.
                    assert!(
                        dst[0] < PADDED[0] - 1e-6 || dst[0] + dst[2] > PADDED[0] + PADDED[2] + 1e-6,
                        "boîte encore dans le padding (zoom {zoom}, focus {focus:?}) : {dst:?}"
                    );
                }
            }
        }
        // Focus centré : le padding disparaît des QUATRE côtés dès que le zoom suffit à
        // couvrir le cadre (ici 1/0.8 = 1.25).
        let (dst, _) = drawn(PADDED, 1.25, [0.5, 0.5]);
        assert_rect(dst, [0.0, 0.0, 1.0, 1.0]);
        // Sans padding il n'y a rien à déborder, mais la boîte porte quand même le zoom.
        let (dst, _) = drawn([0.0, 0.0, 1.0, 1.0], 2.0, [0.5, 0.5]);
        assert_rect(dst, [-0.5, -0.5, 2.0, 2.0]);
    }

    // --- cover_crop_uv : la caméra n'est jamais étirée --------------------
    // Le ratio de la coupe source, ramené en pixels d'image, doit TOUJOURS égaler
    // celui de la boîte : c'est la définition de « pas de déformation ».

    /// Ratio largeur/hauteur de la coupe, exprimé en pixels de l'image source.
    fn crop_aspect(uv: (f32, f32, f32, f32), tex: [f32; 2]) -> f32 {
        ((uv.2 - uv.0) * tex[0]) / ((uv.3 - uv.1) * tex[1])
    }

    /// L'invariant, balayé sur des boîtes très diverses — dont le slot en colonne
    /// du preset side-by-side, qui est précisément le cas qui étirait la caméra.
    #[test]
    fn cover_crop_never_distorts_whatever_the_destination_box() {
        let tex = [1024.0, 1024.0];
        for &cam in &[[1280.0, 720.0], [960.0, 720.0], [640.0, 480.0]] {
            for &box_ar in &[0.35, 0.5, 0.75, 1.0, 16.0 / 9.0, 2.4] {
                let uv = cover_crop_uv(cam, tex, box_ar);
                let got = crop_aspect(uv, tex);
                assert!(
                    (got - box_ar).abs() < 1e-3,
                    "cam {cam:?} boite {box_ar} → coupe de ratio {got}, attendu {box_ar}",
                );
            }
        }
    }

    /// La coupe reste DANS l'image visible et centrée — on ne va jamais chercher
    /// le padding décodeur au-delà de `visible`, qui contient des pixels indéfinis.
    #[test]
    fn cover_crop_stays_inside_the_visible_frame_and_is_centred() {
        let (cam, tex) = ([1280.0, 720.0], [2048.0, 1024.0]);
        for &box_ar in &[0.35, 1.0, 2.4] {
            let (u0, v0, u1, v1) = cover_crop_uv(cam, tex, box_ar);
            assert!(u0 >= 0.0 && v0 >= 0.0, "coupe hors image: {u0},{v0}");
            assert!(u1 <= cam[0] / tex[0] + 1e-6, "u1 {u1} deborde la largeur visible");
            assert!(v1 <= cam[1] / tex[1] + 1e-6, "v1 {v1} deborde la hauteur visible");
            let (mx, my) = (u0 + u1, v0 + v1);
            assert!((mx - cam[0] / tex[0]).abs() < 1e-6, "pas centre en x");
            assert!((my - cam[1] / tex[1]).abs() < 1e-6, "pas centre en y");
        }
    }

    /// L'écran en layout bloc : le cover s'applique au rect DÉJÀ réduit par le crop
    /// et le zoom. Quel que soit ce rect de départ, ce qui atterrit dans la boîte a
    /// le ratio de la boîte — c'est ce qui empêche l'étirement.
    #[test]
    fn cover_uv_rect_gives_the_box_aspect_whatever_the_crop_and_zoom_left() {
        let tex = [2048.0, 1024.0];
        // rects source plausibles : plein cadre, bande verticale (crop portrait), zoom serré
        for &uv in &[
            [0.0, 0.0, 0.9375, 0.7031],
            [0.41, 0.04, 0.55, 0.67],
            [0.30, 0.20, 0.55, 0.45],
        ] {
            for &box_ar in &[0.4, 0.75, 1.0, 1.9, 3.2] {
                let out = cover_uv_rect(uv, tex, box_ar);
                let got = ((out[2] - out[0]) * tex[0]) / ((out[3] - out[1]) * tex[1]);
                assert!(
                    (got - box_ar).abs() / box_ar < 1e-3,
                    "uv {uv:?} boite {box_ar} -> ratio {got}",
                );
                // le cover RÉDUIT : il ne va jamais chercher des pixels hors du rect source
                assert!(out[0] >= uv[0] - 1e-6 && out[1] >= uv[1] - 1e-6, "deborde en haut/gauche");
                assert!(out[2] <= uv[2] + 1e-6 && out[3] <= uv[3] + 1e-6, "deborde en bas/droite");
            }
        }
    }

    /// Propriété de sûreté : quand la boîte a DÉJÀ le ratio de la source (tous les
    /// placements qui étaient corrects — PiP par défaut, vertical-stack, et le
    /// center-crop carré de square/circle), la coupe est la frame entière. Le
    /// correctif ne peut donc pas déplacer un pixel de ces cas-là.
    #[test]
    fn cover_crop_is_the_whole_frame_when_the_box_already_matches() {
        let (cam, tex) = ([1280.0, 720.0], [2048.0, 1024.0]);
        let uv = cover_crop_uv(cam, tex, cam[0] / cam[1]);
        assert!((uv.0).abs() < 1e-6 && (uv.1).abs() < 1e-6);
        assert!((uv.2 - cam[0] / tex[0]).abs() < 1e-6);
        assert!((uv.3 - cam[1] / tex[1]).abs() < 1e-6);
        // et une boîte carrée sur une source 4:3 redonne bien le center-crop carré
        // que l'ancien branchement `is_square_shape` codait à la main.
        let (su0, _, su1, _) = cover_crop_uv([960.0, 720.0], tex, 1.0);
        assert!((su0 - (960.0 - 720.0) * 0.5 / tex[0]).abs() < 1e-6);
        assert!((su1 - (960.0 + 720.0) * 0.5 / tex[0]).abs() < 1e-6);
    }

    #[test]
    fn webcam_crop_identity_keeps_the_full_visible_frame() {
        let uv = webcam_source_rect([1280.0, 720.0], [2048.0, 1024.0], None, 16.0 / 9.0);
        assert_rect(uv, [0.0, 0.0, 1280.0 / 2048.0, 720.0 / 1024.0]);
    }

    #[test]
    fn webcam_crop_applies_authored_zoom_and_pan_before_layout_cover() {
        let crop = SceneCrop {
            x: 0.25,
            y: 0.20,
            width: 0.50,
            height: 0.60,
        };
        let uv = webcam_source_rect([100.0, 100.0], [100.0, 100.0], Some(crop), 0.50 / 0.60);
        assert_rect(uv, [0.25, 0.20, 0.75, 0.80]);
    }

    #[test]
    fn cursor_tap_weight_sums_to_one_and_is_monotonically_increasing() {
        assert_eq!(cursor_tap_weight(0, 1), 1.0);

        for taps in [2, 4, 8, 11, 16] {
            let mut sum = 0.0;
            let mut prev_w = 0.0;
            for k in 0..taps {
                let w = cursor_tap_weight(k, taps);
                assert!(w > 0.0, "poids positif");
                if k > 0 {
                    assert!(w > prev_w, "tête plus marquée que la queue : {w} > {prev_w}");
                }
                prev_w = w;
                sum += w;
            }
            assert!((sum - 1.0).abs() < 1e-5, "somme des poids = 1.0 pour taps={taps}, got {sum}");
        }
    }

    /// Écran droit plein cadre, sans zoom : le curseur y tombe toujours dans le rect source.
    fn full_frame_geometry() -> FrameGeometry {
        FrameGeometry {
            scene_preset: None,
            mb_taps: 1.0,
            mb_amount: 0.0,
            source_t: 0.0,
            programme_t: 0.0,
            zoom_rotation: [0.0, 0.0, 0.0],
            zoom_rotation_dyn: [0.0, 0.0, 0.0],
            camera: None,
            padding_scale: 1.0,
            cut: [0.0, 0.0, 1.0, 1.0],
            focus_plane: [0.5, 0.5],
            depth_of_field: false,
            s_dst: [0.0, 0.0, 1.0, 1.0],
            s_dst_prev: [0.0, 0.0, 1.0, 1.0],
            s_ann: [0.0, 0.0, 1.0, 1.0],
            s_radius: 0.0,
            frame_min_px: 1080.0,
            w_dst: [0.0, 0.0, 0.0, 0.0],
            w_dst_prev: [0.0, 0.0, 0.0, 0.0],
            w_px: [0.0, 0.0],
            w_radius: 0.0,
            shape_fade: 0.0,
            window_frame: None,
        }
    }

    #[test]
    fn plan_cursor_motion_blur_adaptive_and_stationary() {
        let cfg = crate::config::all().pop().expect("cfg");
        let track_immobile = crate::cursor::CursorTrack::new(
            vec![(0.0, 0.5, 0.5), (2.0, 0.5, 0.5)],
            vec![],
            vec![],
        );
        let track_moving = crate::cursor::CursorTrack::new(
            vec![(0.0, 0.1, 0.1), (1.0, 0.9, 0.9)],
            vec![],
            vec![],
        );
        let scene = zoomed_golden_scene();
        let fg = full_frame_geometry();

        // 1. Curseur immobile avec blur actif -> taps = 1
        let live_with_blur = LiveParams {
            cursor_motion_blur: 0.8,
            ..LiveParams::default()
        };
        let input_immobile = CursorPlanInput {
            render_px: [1920.0, 1080.0],
            u_max: 1.0,
            v_max: 1.0,
            cfg: &cfg,
            live: live_with_blur,
            scene: Some(&scene),
            track: &track_immobile,
            t: 0.5,
        };
        let plan = plan_cursor(&fg, &input_immobile).expect("plan cursor");
        assert_eq!(plan.taps, 1, "curseur immobile doit rester à 1 tap");

        // 2. Curseur avec blur = 0 -> taps = 1
        let live_no_blur = LiveParams {
            cursor_motion_blur: 0.0,
            ..LiveParams::default()
        };
        let input_no_blur = CursorPlanInput {
            render_px: [1920.0, 1080.0],
            u_max: 1.0,
            v_max: 1.0,
            cfg: &cfg,
            live: live_no_blur,
            scene: Some(&scene),
            track: &track_moving,
            t: 0.5,
        };
        let plan = plan_cursor(&fg, &input_no_blur).expect("plan cursor");
        assert_eq!(plan.taps, 1, "blur=0 doit donner taps = 1");

        // 3. Curseur en mouvement rapide avec blur -> taps adaptatifs entre 2 et 16
        let input_moving = CursorPlanInput {
            render_px: [1920.0, 1080.0],
            u_max: 1.0,
            v_max: 1.0,
            cfg: &cfg,
            live: live_with_blur,
            scene: Some(&scene),
            track: &track_moving,
            t: 0.5,
        };
        let plan = plan_cursor(&fg, &input_moving).expect("plan cursor");
        assert!(plan.taps >= 2 && plan.taps <= 16, "taps adaptatifs dans [2, 16], got {}", plan.taps);
    }

    /// clickBounce au maximum du slider (5) : le creux de la pression donnerait 1 - 0.24 * 5 < 0.
    /// La taille ne doit jamais devenir négative ; au creux, rien n'est dessiné.
    #[test]
    fn plan_cursor_never_yields_a_negative_size_at_max_bounce() {
        let cfg = crate::config::all().pop().expect("cfg");
        let scene = zoomed_golden_scene();
        let fg = full_frame_geometry();
        let track = crate::cursor::CursorTrack::new(
            vec![(0.0, 0.5, 0.5), (2.0, 0.5, 0.5)],
            vec![0.5],
            vec![],
        );
        let plan_at = |t: f32| {
            plan_cursor(
                &fg,
                &CursorPlanInput {
                    render_px: [1920.0, 1080.0],
                    u_max: 1.0,
                    v_max: 1.0,
                    cfg: &cfg,
                    live: LiveParams { cursor_bounce_scale: 5.0, ..LiveParams::default() },
                    scene: Some(&scene),
                    track: &track,
                    t,
                },
            )
        };

        for ms in 450..=800 {
            let t = ms as f32 / 1000.0;
            if let Some(plan) = plan_at(t) {
                assert!(plan.size_px > 0.0, "taille {} à t = {t}", plan.size_px);
            }
        }
        let rest = plan_at(0.45).expect("hors fenêtre de clic").size_px;
        assert!(plan_at(0.5 + 0.0494).is_none(), "au creux, le sprite est réduit à rien");
        let peak = plan_at(0.5 + 0.1794).expect("au pic").size_px;
        assert!((peak / rest - 1.8).abs() < 1e-3, "pic = 1 + 0.16 * 5, got {}", peak / rest);
    }

    /// Un plan de curseur immobile sous la rotation `rot`, coupe fixe.
    fn plan_with(rot: [f32; 3]) -> CursorPlan {
        let cfg = crate::config::all().pop().expect("cfg");
        let scene = zoomed_golden_scene();
        let fg = FrameGeometry { zoom_rotation: rot, ..full_frame_geometry() };
        let track =
            crate::cursor::CursorTrack::new(vec![(0.0, 0.4, 0.6), (2.0, 0.4, 0.6)], vec![], vec![]);
        plan_cursor(
            &fg,
            &CursorPlanInput {
                render_px: [1920.0, 1080.0],
                u_max: 1.0,
                v_max: 1.0,
                cfg: &cfg,
                live: LiveParams::default(),
                scene: Some(&scene),
                track: &track,
                t: 0.5,
            },
        )
        .expect("plan cursor")
    }

    const ISO: [f32; 3] = [-12.0, -18.0, -2.0];
    const LEFT: [f32; 3] = [-8.0, -16.0, -1.0];

    /// Le `LayerCB` du sprite incliné est, octet pour octet, celui que chaque backend construisait
    /// avant de le partager. La référence est le corps d'origine de `draw_cursor_sprite`.
    #[test]
    fn cursor_sprite_cb_is_byte_identical_to_the_flat_sprite() {
        fn before(
            p: CursorPlacement,
            pw: f32,
            ph: f32,
            hotspot: [f32; 2],
            a: f32,
            clip: [f32; 4],
        ) -> LayerCB {
            let CursorPlacement::Tilted { plane_pt, quad, center_px, screen_px, render_px } = p
            else {
                unreachable!()
            };
            let (wf, hf) = (pw / screen_px[0], ph / screen_px[1]);
            let x0 = plane_pt[0] - hotspot[0] * wf;
            let y0 = plane_pt[1] - hotspot[1] * hf;
            let corners =
                [(x0, y0), (x0 + wf, y0), (x0 + wf, y0 + hf), (x0, y0 + hf)].map(|(fx, fy)| {
                    let (px, py) = quad.point_px(fx, fy);
                    (center_px[0] + px, center_px[1] + py)
                });
            let (min_x, max_x) = corners
                .iter()
                .fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
            let (min_y, max_y) = corners
                .iter()
                .fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
            let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
            let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
            let [tl0, tl1] = local(corners[0]);
            let [tr0, tr1] = local(corners[1]);
            let [br0, br1] = local(corners[2]);
            let [bl0, bl1] = local(corners[3]);
            let (rw, rh) = (render_px[0], render_px[1]);
            LayerCB {
                dst: [min_x / rw, min_y / rh, bw / rw, bh / rh],
                quad_px: [bw, bh],
                mode: 13.0,
                color: [1.0, 1.0, 1.0, a],
                fx: [tl0, tl1, tr0, tr1],
                src_prev: [br0, br1, bl0, bl1],
                dst_prev: clip,
                ..Default::default()
            }
        }
        let bytes = |cb: &LayerCB| -> Vec<u8> {
            // SAFETY: `LayerCB` est `repr(C)`, 128 octets de f32 sans padding (test d'offsets).
            unsafe { std::slice::from_raw_parts(cb as *const LayerCB as *const u8, 128) }.to_vec()
        };
        for rot in [ISO, LEFT, [-8.0, 16.0, 1.0]] {
            let plan = plan_with(rot);
            let clip = [0.1, 0.2, 0.7, 0.6];
            let got = cursor_sprite_cb(
                plan.placement,
                [30.0, 34.0],
                [0.2, 0.1],
                0.8,
                clip,
                [1920.0, 1080.0],
            );
            let want = before(plan.placement, 30.0, 34.0, [0.2, 0.1], 0.8, clip);
            assert_eq!(bytes(&got), bytes(&want), "rotation {rot:?}");
        }
    }

    // ---- Curseur modélisé (mode 15) ----

    /// Les seize états du thème par défaut et leurs hotspots (`DEFAULT_CURSOR_SPRITES`,
    /// `src/lib/cursor/cursorThemes.ts`).
    const DEFAULT_SPRITES: [(&str, [f32; 2]); 16] = [
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

    /// Les états qu'on fait passer par les tests géométriques : pointeurs, centrés, entre deux.
    const MODEL_STATES: [&str; 8] =
        ["arrow", "pointer", "up-arrow", "open-hand", "text", "resize-ew", "not-allowed", "closed-hand"];

    fn hotspot_of(key: &str) -> [f32; 2] {
        DEFAULT_SPRITES.iter().find(|(k, _)| *k == key).expect("état connu").1
    }

    fn sprite_path(key: &str) -> String {
        format!("{}/../../public/cursors/default/{key}.png", env!("CARGO_MANIFEST_DIR")).replace('\\', "/")
    }

    /// Le champ du sprite livré et sa forme, hotspot de la scène posé.
    fn sprite_model(key: &str) -> (crate::cursor_sdf::CursorSdf, SpriteShape) {
        let sdf = crate::cursor_sdf::CursorSdf::load(&sprite_path(key)).expect("sprite livré");
        let shape = SpriteShape { hotspot: hotspot_of(key), ..sdf.shape };
        (sdf, shape)
    }

    /// Miroir CPU de `sd_sprite2` des shaders : le champ dans le rect du sprite, la borne le long
    /// de la normale hors de lui.
    fn sd2(sdf: &crate::cursor_sdf::CursorSdf, shape: SpriteShape, p: [f32; 2]) -> f32 {
        let [x0, y0] = shape.origin();
        let c = [p[0].clamp(x0, x0 + shape.size[0]), p[1].clamp(y0, y0 + shape.size[1])];
        let d = sdf.sample([(c[0] - x0) / shape.size[0], (c[1] - y0) / shape.size[1]]);
        let o = (p[0] - c[0]).hypot(p[1] - c[1]);
        if o > 0.0 { o.hypot(d.max(0.0)) } else { d }
    }

    /// Miroir CPU de `sd_model`, écrasé à `squash`.
    fn sd_model(sdf: &crate::cursor_sdf::CursorSdf, shape: SpriteShape, squash: f32, p: [f32; 3]) -> f32 {
        let half_t = MODEL_THICK * squash * 0.5;
        let w = [sd2(sdf, shape, [p[0], p[1]]) + MODEL_BEVEL, (p[2] + half_t).abs() - (half_t - MODEL_BEVEL)];
        w[0].max(w[1]).min(0.0) + w[0].max(0.0).hypot(w[1].max(0.0)) - MODEL_BEVEL
    }

    /// Repère du plan → modèle (vecteurs) : l'inverse de `ModelView::model_to_plane`.
    fn plane_to_model(v: [f32; 3], pose: CursorPose) -> [f32; 3] {
        let (cp, sp) = (pose.pitch.cos(), pose.pitch.sin());
        let (cy, sy) = (pose.yaw.cos(), pose.yaw.sin());
        let (x, y) = (v[0] * cy + v[1] * sy, -v[0] * sy + v[1] * cy);
        [x, y * cp + v[2] * sp, -y * sp + v[2] * cp]
    }

    /// Miroir CPU de l'ombre du mode 15 en un point `g` du plan (px du plan) : opacité 0..1.
    fn model_shadow_at(view: &ModelView, sdf: &crate::cursor_sdf::CursorSdf, g: [f32; 2]) -> f32 {
        let (pose, shape) = (view.pose, view.shape);
        let q = plane_to_model(
            [(g[0] - view.tip[0]) / view.unit, (g[1] - view.tip[1]) / view.unit, -view.tip[2] / view.unit],
            pose,
        );
        let l = plane_to_model(view.light(), pose);
        let (lo, hi) = shape.model_box(pose.squash);
        let (mut t0, mut t1) = (f32::MIN, f32::MAX);
        for k in 0..3 {
            let inv = 1.0 / if l[k].abs() > 1e-6 { l[k] } else { 1e-6 };
            let (a, b) = ((lo[k] - MODEL_SHADOW_PAD - q[k]) * inv, (hi[k] + MODEL_SHADOW_PAD - q[k]) * inv);
            t0 = t0.max(a.min(b));
            t1 = t1.min(a.max(b));
        }
        let mut lit = 1.0f32;
        if t0 < t1 && t1 > 0.0 {
            let mut t = t0.max(0.004);
            for _ in 0..32 {
                let d = sd_model(sdf, shape, pose.squash, [q[0] + l[0] * t, q[1] + l[1] * t, q[2] + l[2] * t]);
                lit = lit.min(MODEL_SOFTNESS * d / t);
                if lit < 0.002 || t > t1 {
                    break;
                }
                t += d.clamp(0.01, 0.2);
            }
            let r = lit.clamp(0.0, 1.0);
            lit = r * r * (3.0 - 2.0 * r);
        }
        let u = (sd_model(sdf, shape, pose.squash, q) / MODEL_CONTACT_RADIUS).clamp(0.0, 1.0);
        let contact = 1.0 - u * u * (3.0 - 2.0 * u);
        ((1.0 - lit) * 0.5).max(contact * 0.5)
    }

    /// Le point le plus bas du modèle posé, en unités au-dessus du plan. Pour un tangage ≥ 0, le
    /// plus bas d'une colonne (x, y) pleine est le bas de sa colonne : l'épaisseur sous le plat
    /// du dessous, relevé sur le chanfrein (`sd_model`, résolu en z).
    fn lowest_point(view: &ModelView, sdf: &crate::cursor_sdf::CursorSdf) -> f32 {
        let shape = view.shape;
        let [x0, y0] = shape.origin();
        let n = 400;
        let mut lowest = f32::MAX;
        for i in 0..=n {
            for j in 0..=n {
                let (x, y) = (x0 + shape.size[0] * i as f32 / n as f32, y0 + shape.size[1] * j as f32 / n as f32);
                let s = sd2(sdf, shape, [x, y]);
                if s >= 0.0 {
                    continue;
                }
                let wx = (s + MODEL_BEVEL).max(0.0);
                let z = -MODEL_THICK * view.pose.squash + MODEL_BEVEL - (MODEL_BEVEL * MODEL_BEVEL - wx * wx).sqrt();
                lowest = lowest.min(view.model_to_plane([x, y, z])[2]);
            }
        }
        lowest / view.unit
    }

    /// La scène dorée, thème par défaut, avec les seize sprites livrés.
    fn model_scene() -> Scene {
        let mut scene = zoomed_golden_scene();
        scene.cursor.theme = "default".into();
        for (key, [hx, hy]) in DEFAULT_SPRITES {
            scene.cursor.cursor_sprites.insert(
                key.into(),
                crate::scene::SceneCursorSprite { path: sprite_path(key), hotspot_x: hx, hotspot_y: hy },
            );
        }
        scene
    }

    fn model_plan(
        rot: [f32; 3],
        scene: &Scene,
        track: &crate::cursor::CursorTrack,
        t: f32,
        model3d: bool,
    ) -> Option<CursorPlan> {
        let cfg = crate::config::all().pop().expect("cfg");
        let fg = FrameGeometry { zoom_rotation: rot, ..full_frame_geometry() };
        plan_cursor(
            &fg,
            &CursorPlanInput {
                render_px: [1920.0, 1080.0],
                u_max: 1.0,
                v_max: 1.0,
                cfg: &cfg,
                live: LiveParams {
                    cursor_model3d: model3d,
                    cursor_bounce_scale: 2.5,
                    ..LiveParams::default()
                },
                scene: Some(scene),
                track,
                t,
            },
        )
    }

    /// Immobile en (0.4, 0.6), dans l'état `kind` (`None` = la flèche), avec ces clics.
    fn still_track_as(kind: Option<&str>, clicks: Vec<f32>) -> crate::cursor::CursorTrack {
        let types = kind.map(|k| vec![(0.0, k.to_string())]).unwrap_or_default();
        crate::cursor::CursorTrack::new(vec![(0.0, 0.4, 0.6), (4.0, 0.4, 0.6)], clicks, types)
    }

    fn still_track(clicks: Vec<f32>) -> crate::cursor::CursorTrack {
        still_track_as(None, clicks)
    }

    /// Le creux de `tap` : le contact que le modèle partage avec le rebond et l'impact du clic.
    const CONTACT_S: f32 = 0.0495;

    #[test]
    fn the_model_pose_is_a_pure_function_of_time() {
        let track = crate::cursor::CursorTrack::new(
            vec![(0.0, 0.2, 0.5), (0.9, 0.3, 0.5), (1.0, 0.7, 0.4), (3.0, 0.7, 0.4)],
            vec![1.05, 1.4],
            vec![],
        );
        let times: Vec<f32> = (0..400).map(|k| k as f32 * 0.00731).collect();
        let forward: Vec<CursorPose> = times.iter().map(|&t| cursor_pose(&track, t, 2.5, 1.0)).collect();
        let backward: Vec<CursorPose> =
            times.iter().rev().map(|&t| cursor_pose(&track.clone(), t, 2.5, 1.0)).collect();
        assert!(forward.iter().eq(backward.iter().rev()), "l'ordre d'évaluation change la pose");
        // Continue : pas de saut d'une milliseconde à l'autre, même autour des clics.
        for k in 0..2999 {
            let (a, b) = (k as f32 * 0.001, (k + 1) as f32 * 0.001);
            let (p, q) = (cursor_pose(&track, a, 2.5, 1.0), cursor_pose(&track, b, 2.5, 1.0));
            assert!((p.yaw - q.yaw).abs() < 0.02, "lacet discontinu en {a} : {} -> {}", p.yaw, q.yaw);
            assert!((p.clearance - q.clearance).abs() < 0.03, "hauteur discontinue en {a}");
        }
    }

    #[test]
    fn the_model_touches_the_plane_on_the_click_contact() {
        let track = still_track(vec![0.5]);
        let rest = cursor_pose(&track, 0.45, 2.5, 1.0);
        assert_eq!(rest.clearance, MODEL_HOVER);
        assert!((rest.pitch - MODEL_PITCH_IDLE_DEG.to_radians()).abs() < 1e-6);
        assert_eq!(rest.yaw, 0.0, "immobile : pas de lacet");
        // Au clic même, rien n'a encore bougé ; au creux, le modèle est posé, plus penché.
        assert_eq!(cursor_pose(&track, 0.5, 2.5, 1.0).clearance, MODEL_HOVER);
        let down = cursor_pose(&track, 0.5 + CONTACT_S, 2.5, 1.0);
        assert_eq!(down.clearance, 0.0, "au creux du contact, le modèle touche le plan");
        assert!(down.pitch > rest.pitch + 5f32.to_radians(), "la pression penche le modèle");
        // Posé assez longtemps pour qu'au moins une image le montre, même à 24 i/s…
        for ms in 30..=70 {
            assert_eq!(cursor_pose(&track, 0.5 + ms as f32 / 1000.0, 2.5, 1.0).clearance, 0.0, "{ms} ms");
        }
        // …au même instant que la pression du rebond d'échelle, et relevé à la fin de la fenêtre.
        let press = (0..260).min_by(|&a, &b| {
            track.bounce(0.5 + a as f32 / 1000.0).total_cmp(&track.bounce(0.5 + b as f32 / 1000.0))
        });
        let press_ms = press.expect("un creux") as f32;
        assert_eq!(cursor_pose(&track, 0.5 + press_ms / 1000.0, 2.5, 1.0).clearance, 0.0);
        assert_eq!(cursor_pose(&track, 0.5 + crate::regions::CLICK_IMPACT_WINDOW_S, 2.5, 1.0), rest);
        // clickBounce règle la pression, pas le contact.
        let soft = cursor_pose(&track, 0.5 + CONTACT_S, 0.0, 1.0);
        assert_eq!(soft.clearance, 0.0);
        assert!((soft.pitch - rest.pitch).abs() < 1e-6);
    }

    /// « Posé » veut dire posé, pour chaque état : au repos le point le plus bas du modèle est à
    /// la garde au sol (jamais sous le plan), au contact il affleure le plan à 2 % de l'unité.
    #[test]
    fn every_state_rests_above_the_plane_and_touches_it_on_click() {
        let scene = model_scene();
        for key in MODEL_STATES {
            let (sdf, shape) = sprite_model(key);
            for rot in [[0.0; 3], [-12.0, -18.0, -2.0]] {
                let track = still_track_as(Some(key), vec![0.5]);
                for (t, want) in [(0.3, MODEL_HOVER), (0.5 + CONTACT_S, 0.0)] {
                    let plan = model_plan(rot, &scene, &track, t, true).expect("plan");
                    let pose = plan.model.expect("modèle");
                    let view = ModelView::new(plan.placement, plan.size_px, pose, shape).expect("vue");
                    let gap = lowest_point(&view, &sdf) - want;
                    println!("{key} {rot:?} t={t}: point le plus bas à {want} + {gap:.4} u");
                    assert!((-0.002..0.02).contains(&gap), "{key} {rot:?} t={t}: écart {gap} u");
                }
            }
        }
    }

    #[test]
    fn the_model_leans_towards_its_motion_and_its_click_target() {
        let still = still_track(vec![]);
        assert_eq!(cursor_pose(&still, 1.0, 2.5, 1.0).yaw, 0.0);
        let right = crate::cursor::CursorTrack::new(vec![(0.0, 0.1, 0.5), (2.0, 0.9, 0.5)], vec![], vec![]);
        let left = crate::cursor::CursorTrack::new(vec![(0.0, 0.9, 0.5), (2.0, 0.1, 0.5)], vec![], vec![]);
        let (r, l) = (cursor_pose(&right, 1.0, 2.5, 1.0).yaw, cursor_pose(&left, 1.0, 2.5, 1.0).yaw);
        assert!(r > 5f32.to_radians() && (r + l).abs() < 1e-5, "droite {r}, gauche {l}");
        let fast = crate::cursor::CursorTrack::new(vec![(0.0, 0.0, 0.5), (0.2, 1.0, 0.5)], vec![], vec![]);
        let y = cursor_pose(&fast, 0.1, 2.5, 1.0).yaw;
        assert!(y <= MODEL_YAW_MAX_DEG.to_radians() + 1e-6 && y > 20f32.to_radians(), "{y}");
        // Arrivée sur une cible à droite puis clic : juste avant, le modèle se tourne vers elle
        // plus que la même arrivée sans clic ; au repos, longtemps après, le lacet revient à 0.
        // Échantillonnée à 30 Hz comme la télémétrie : la piste de suivi lissée n'interpole pas
        // à travers des trous de plusieurs secondes.
        let samples: Vec<(f32, f32, f32)> = (0..120)
            .map(|k| {
                let t = k as f32 / 30.0;
                (t, if t < 0.9 { 0.3 } else { 0.3 + 0.4 * ((t - 0.9) / 0.1).min(1.0) }, 0.5)
            })
            .collect();
        let clicked = crate::cursor::CursorTrack::new(samples.clone(), vec![1.1], vec![]);
        let quiet = crate::cursor::CursorTrack::new(samples, vec![], vec![]);
        assert!(cursor_pose(&clicked, 1.05, 2.5, 1.0).yaw > cursor_pose(&quiet, 1.05, 2.5, 1.0).yaw + 1e-3);
        assert!(cursor_pose(&clicked, 3.5, 2.5, 1.0).yaw.abs() < 1e-3);
    }

    /// Les pointeurs penchent et tournent comme la flèche ; les curseurs centrés restent à plat et
    /// de face, mais montent et descendent pareil.
    #[test]
    fn pointing_states_lean_and_centred_states_stay_level() {
        for (key, hotspot) in DEFAULT_SPRITES {
            let f = pointing_factor(hotspot);
            match key {
                "arrow" | "pointer" | "help" | "app-starting" | "up-arrow" => assert_eq!(f, 1.0, "{key}"),
                "open-hand" => assert!(f > 0.5 && f < 1.0, "{key}: {f}"),
                _ => assert_eq!(f, 0.0, "{key}"),
            }
        }
        let moving = crate::cursor::CursorTrack::new(
            vec![(0.0, 0.1, 0.5), (2.0, 0.9, 0.5)],
            vec![1.0 - CONTACT_S],
            vec![],
        );
        let (full, level) = (cursor_pose(&moving, 1.0, 2.5, 1.0), cursor_pose(&moving, 1.0, 2.5, 0.0));
        assert!(full.pitch > 0.3 && full.yaw > 0.05, "{full:?}");
        assert_eq!((level.pitch, level.yaw), (0.0, 0.0));
        assert_eq!(level.clearance, full.clearance);
        let half = cursor_pose(&moving, 1.0, 2.5, 0.5);
        assert!((half.pitch - full.pitch * 0.5).abs() < 1e-6 && (half.yaw - full.yaw * 0.5).abs() < 1e-6);
        // À plat, le lift est l'épaisseur : toute la face du dessous est au sol.
        let (_, text) = sprite_model("text");
        assert_eq!(text.contact_lift(0.0, 1.0), MODEL_THICK);
    }

    #[test]
    fn every_default_state_is_modelled() {
        let scene = model_scene();
        let track = still_track(vec![0.5]);
        let off = model_plan([0.0; 3], &scene, &track, 0.3, false).expect("plan");
        assert!(off.model.is_none());
        assert!(matches!(off.placement, CursorPlacement::Upright { .. }), "réglage éteint : mode 7");
        let on = model_plan([0.0; 3], &scene, &track, 0.3, true).expect("plan");
        assert_eq!(on.model, Some(cursor_pose(&track, 0.3, 2.5, 1.0)));
        let CursorPlacement::Tilted { quad, .. } = on.placement else { panic!("écran droit : plan identité") };
        assert_eq!((quad.scale, quad.rot), (1.0, [0.0; 3]));
        // Pas de rebond d'échelle en 3D : la taille au creux du clic est celle du repos.
        let press = model_plan([0.0; 3], &scene, &track, 0.5 + CONTACT_S, true).expect("plan");
        assert_eq!(press.size_px, on.size_px);
        let flat_press = model_plan([0.0; 3], &scene, &track, 0.5 + CONTACT_S, false).expect("plan");
        assert!(flat_press.size_px < off.size_px, "le sprite plat garde son rebond");

        // Chaque état du thème, avec la pose de son hotspot.
        for (key, hotspot) in DEFAULT_SPRITES {
            let typed = still_track_as(Some(key), vec![]);
            let plan = model_plan([0.0; 3], &scene, &typed, 0.3, true).expect("plan");
            assert_eq!(plan.model, Some(cursor_pose(&typed, 0.3, 2.5, pointing_factor(hotspot))), "{key}");
            assert_eq!(plan.cursor_type.as_deref(), Some(key));
        }
        // Un état sans sprite retombe sur la flèche, donc sur sa pose.
        let unknown = still_track_as(Some("zoom-in"), vec![]);
        assert_eq!(
            model_plan([0.0; 3], &scene, &unknown, 0.3, true).expect("plan").model,
            Some(cursor_pose(&unknown, 0.3, 2.5, 1.0))
        );
        // Un autre thème, ou pas de sprite du tout : le sprite plat.
        let mut themed = model_scene();
        themed.cursor.theme = "black-pixel".into();
        assert!(model_plan([0.0; 3], &themed, &track, 0.3, true).expect("plan").model.is_none());
        let bare = zoomed_golden_scene();
        assert!(model_plan([0.0; 3], &bare, &track, 0.3, true).expect("plan").model.is_none());
    }

    const LEFT_ROT: [f32; 3] = [-8.0, -16.0, -1.0];
    const ISO_ROT: [f32; 3] = [-12.0, -18.0, -2.0];

    /// Les poses d'essai, pour chaque état de `MODEL_STATES` : au repos, posé, tourné.
    fn model_cases() -> Vec<(String, CursorPlan, SpriteShape, crate::cursor_sdf::CursorSdf)> {
        let scene = model_scene();
        let mut out = Vec::new();
        for key in MODEL_STATES {
            let clicked = still_track_as(Some(key), vec![0.5]);
            let moving = crate::cursor::CursorTrack::new(
                vec![(0.0, 0.1, 0.6), (2.0, 0.9, 0.6)],
                vec![],
                vec![(0.0, key.to_string())],
            );
            for (name, rot) in [("flat", [0.0; 3]), ("iso", ISO_ROT), ("left", LEFT_ROT), ("right", [-8.0, 16.0, 1.0])] {
                for (pose, track, t) in [("hover", &clicked, 0.3), ("touch", &clicked, 0.5 + CONTACT_S), ("yaw", &moving, 1.0)] {
                    let plan = model_plan(rot, &scene, track, t, true).expect("plan");
                    let (sdf, shape) = sprite_model(key);
                    out.push((format!("{key}/{name}/{pose}"), plan, shape, sdf));
                }
            }
        }
        out
    }

    #[test]
    fn the_modelled_hotspot_lands_on_the_content_pixel() {
        for (name, plan, shape, _) in model_cases() {
            let pose = plan.model.expect("modèle");
            let view = ModelView::new(plan.placement, plan.size_px, pose, shape).expect("vue");
            let CursorPlacement::Tilted { plane_pt, quad, center_px, .. } = plan.placement else {
                unreachable!()
            };
            let (bx, by) = quad.point_px(plane_pt[0], plane_pt[1]);
            let want = [center_px[0] + bx, center_px[1] + by];
            let got = view.project(view.model_to_plane([0.0; 3])).expect("projection");
            assert!(
                (got[0] - want[0]).abs() < 0.02 && (got[1] - want[1]).abs() < 0.02,
                "{name}: hotspot en {got:?}, contenu en {want:?}"
            );
            // Le cbuffer rend au shader le même rayon : `local + src.xy` au pixel du hotspot est
            // la projection EXACTE du hotspot, ancrage ôté.
            let cb = cursor_model_cb(plan.placement, plan.size_px, pose, shape, 1.0, [0.0; 4]).expect("cb");
            assert_eq!(cb.mode, 15.0);
            let local = [want[0] - cb.dst[0] * 1920.0, want[1] - cb.dst[1] * 1080.0];
            let w = crate::regions::rotate_point(view.tip, view.rot);
            let f = view.perspective / (view.perspective - w[2]);
            assert!(
                (local[0] + cb.src[0] - w[0] * f).abs() < 0.05 && (local[1] + cb.src[1] - w[1] * f).abs() < 0.05,
                "{name}: le rayon du shader ne passe pas par le hotspot"
            );
            assert_eq!([cb.src[2], cb.src[3]], [view.perspective, view.unit]);
            assert_eq!(view.unit, plan.size_px * quad.scale, "{name}: l'unité est le côté du curseur");
            assert_eq!(cb.src_prev, [view.tip[0], view.tip[1], view.tip[2], pose.yaw]);
            assert_eq!(cb.fx[3], pose.pitch);
            assert!((cb.dst[2] * 1920.0 - cb.quad_px[0]).abs() < 1e-2);
            // Le rect du sprite : sa taille se déduit de `radius_px` (w/h, plus grand côté = 1),
            // comme `sprite_size()` dans les shaders, et `(p - color.rg) / taille` vaut le hotspot
            // à l'origine. `mb.zw` porte la translation du plan, nulle sous un angle fixe.
            let a = cb.radius_px;
            let size = [a.min(1.0), (1.0 / a).min(1.0)];
            let [x0, y0] = [cb.color[0], cb.color[1]];
            let hotspot = [-x0 / size[0], -y0 / size[1]];
            assert!((hotspot[0] - shape.hotspot[0]).abs() < 1e-6 && (hotspot[1] - shape.hotspot[1]).abs() < 1e-6);
            assert!((size[0] - shape.size[0]).abs() < 1e-6 && (size[1] - shape.size[1]).abs() < 1e-6);
            assert_eq!(cb.color[2], pose.squash, "{name}: écrasement");
            assert_eq!([cb.mb[2], cb.mb[3]], view.offset, "{name}: translation du plan");
            assert!(shape.size[0].max(shape.size[1]) == 1.0, "{name}: {:?}", shape.size);
        }
    }

    /// Le pointeur file de `from` vers `to` à `speed` (écrans par seconde), s'y arrête `dwell` s
    /// avant et après le clic `tc`, puis repart vers `away`. Échantillonné à 30 Hz comme la
    /// télémétrie, plus l'échantillon du clic. Sans arrêt, la piste brute dérive déjà pendant le
    /// contact.
    fn approach_track(from: [f32; 2], to: [f32; 2], away: [f32; 2], speed: f32, dwell: f32, tc: f32) -> crate::cursor::CursorTrack {
        let mix = |a: [f32; 2], b: [f32; 2], f: f32| (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
        let dist = |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).hypot(a[1] - b[1]);
        let arrive = tc - dwell;
        let start = arrive - dist(from, to) / speed;
        let (leave, end) = (tc + dwell, tc + dwell + dist(to, away) / speed);
        let pos = |t: f32| {
            if t < start {
                (from[0], from[1])
            } else if t < arrive {
                mix(from, to, (t - start) / (arrive - start))
            } else if t < leave {
                (to[0], to[1])
            } else {
                mix(to, away, ((t - leave) / (end - leave)).min(1.0))
            }
        };
        let mut samples: Vec<(f32, f32, f32)> = (0..=120)
            .map(|k| k as f32 / 30.0)
            .filter(|&t| (t - tc).abs() > 1e-4)
            .map(|t| (t, pos(t).0, pos(t).1))
            .collect();
        samples.push((tc, to[0], to[1]));
        samples.sort_by(|a, b| a.0.total_cmp(&b.0));
        crate::cursor::CursorTrack::new(samples, vec![tc], vec![])
    }

    /// Le curseur modélisé et son écran à `t`, par le chemin du rendu : `plan_frame` puis
    /// `plan_cursor`, scène dorée (recadrée, zoomée) sous `rotation`.
    fn model_frame(
        rotation: &str,
        blur: f32,
        track: &'static crate::cursor::CursorTrack,
        t: f32,
    ) -> (FrameGeometry, Option<CursorPlan>) {
        let cfg = crate::config::all().pop().expect("cfg");
        let json = zoomed_golden_scene_json().replace(r#""rotation":"none""#, rotation);
        let mut scene = Scene::from_json(&json).expect("scène");
        scene.cursor.theme = "default".into();
        scene.cursor.cursor_sprites = model_scene().cursor.cursor_sprites;
        let live = LiveParams {
            cursor_model3d: true,
            cursor_bounce_scale: 2.5,
            cursor_motion_blur: blur,
            ..live_params_from_scene(&scene)
        };
        let g = plan_frame(&FrameGeometryInput {
            cursor: Some(track),
            timeline_t_override: Some(t),
            frame: t * FPS,
            live,
            ..golden_input(&scene, &cfg)
        });
        let plan = plan_cursor(
            &g,
            &CursorPlanInput {
                render_px: [1170.0, 658.0],
                u_max: 1.0,
                v_max: 1080.0 / 1088.0,
                cfg: &cfg,
                live,
                scene: Some(&scene),
                track,
                t,
            },
        );
        (g, plan)
    }

    /// Le pixel où l'écran dessine la position `p` du contenu, sans passer par le curseur : la
    /// coupe, puis le rect de l'écran droit ou le quad incliné (bilinéaire ou projectif).
    fn content_px(g: &FrameGeometry, p: (f32, f32)) -> [f32; 2] {
        let render = [1170.0, 658.0];
        let [fx, fy] = cursor_plane_point(g.cut, [1.0, 1080.0 / 1088.0], p).expect("clic dans la coupe");
        let s_px = [g.s_dst[2] * render[0], g.s_dst[3] * render[1]];
        match g.screen_tilt(s_px) {
            None => [(g.s_dst[0] + fx * g.s_dst[2]) * render[0], (g.s_dst[1] + fy * g.s_dst[3]) * render[1]],
            Some(quad) => {
                let (x, y) = quad.point_px(fx, fy);
                [(g.s_dst[0] + g.s_dst[2] * 0.5) * render[0] + x, (g.s_dst[1] + g.s_dst[3] * 0.5) * render[1] + y]
            }
        }
    }

    /// Au contact, la pointe du curseur modélisé tombe sur le pixel du clic BRUT, à 0,5 px près :
    /// quel que soit le lissage (le ressort traîne derrière la souris), la vitesse d'arrivée, un
    /// départ immédiat, l'angle fixe (impact du plan compris), la caméra réelle, et la traînée de
    /// flou (repliée sur la tête pendant le contact).
    #[test]
    fn the_modelled_tip_touches_the_raw_click_pixel() {
        const TC: f32 = 1.5;
        let presets = [
            ("flat", r#""rotation":"none""#),
            ("iso", r#""rotation":"iso","clickImpact":true"#),
            ("left", r#""rotation":"left","clickImpact":true"#),
            ("right", r#""rotation":"right","clickImpact":true"#),
            ("follow", r#""rotation":"follow-cursor""#),
        ];
        let (to, from, away) = ([0.3, 0.18], [0.08, 0.05], [0.45, 0.32]);
        let mut worst = 0.0f32;
        for (name, rotation) in presets {
            for smoothing in [0.0, 0.25, 0.5, 1.0] {
                for speed in [0.5, 2.0] {
                    for dwell in [0.0, 0.15] {
                        let raw = approach_track(from, to, away, speed, dwell, TC);
                        let track: &'static crate::cursor::CursorTrack = Box::leak(Box::new(raw.smoothed(smoothing)));
                        let mut contacts = 0;
                        let mut case_worst = 0.0f32;
                        for key in ["arrow", "pointer"] {
                            let (_, shape) = sprite_model(key);
                            let shape = SpriteShape { hotspot: hotspot_of(key), ..shape };
                            for k in 0..=15 {
                                let t = TC + 0.02 + k as f32 * 0.004;
                                let (g, plan) = model_frame(rotation, 1.0, track, t);
                                let plan = plan.expect("curseur visible au contact");
                                let pose = plan.model.expect("modèle");
                                if pose.clearance > 0.0 {
                                    continue;
                                }
                                contacts += 1;
                                let view = ModelView::new(plan.placement, plan.size_px, pose, shape).expect("vue");
                                let tip = view.project(view.model_to_plane([0.0; 3])).expect("pointe");
                                let want = content_px(&g, (to[0], to[1]));
                                let off = (tip[0] - want[0]).hypot(tip[1] - want[1]);
                                case_worst = case_worst.max(off);
                                assert_eq!(plan.taps, 1, "{name} lissage {smoothing} : traînée au contact");
                            }
                        }
                        println!("{name} lissage {smoothing} vitesse {speed} arrêt {dwell} : {case_worst:.3} px");
                        assert!(contacts >= 16, "{name}: {contacts} images au contact");
                        assert!(case_worst < 0.5, "{name} lissage {smoothing} vitesse {speed} arrêt {dwell} : {case_worst} px");
                        worst = worst.max(case_worst);
                    }
                }
            }
        }
        println!("pire écart au contact : {worst:.4} px");
    }

    /// L'impact : seulement sous le curseur modélisé, après un clic et à `clickBounce` non nul ;
    /// il démarre au contact, dure 0,4 s, et son carré est centré sur le pixel du clic brut, posé
    /// sur le plan (il penche avec lui).
    #[test]
    fn the_click_impact_rings_around_the_raw_click_pixel() {
        const TC: f32 = 1.5;
        let raw = approach_track([0.08, 0.05], [0.3, 0.18], [0.45, 0.32], 2.0, 0.0, TC);
        let track: &'static crate::cursor::CursorTrack = Box::leak(Box::new(raw.smoothed(0.5)));
        let quiet: &'static crate::cursor::CursorTrack =
            Box::leak(Box::new(crate::cursor::CursorTrack::new(vec![(0.0, 0.3, 0.18), (4.0, 0.3, 0.18)], vec![], vec![])));
        for rotation in [r#""rotation":"none""#, r#""rotation":"iso""#, r#""rotation":"follow-cursor""#] {
            let impacts = |track, t| model_frame(rotation, 0.0, track, t).1.expect("curseur").impacts;
            assert!(impacts(quiet, TC + 0.1).is_empty(), "{rotation}: pas de clic, pas d'impact");
            assert!(impacts(track, TC + 0.04).is_empty(), "{rotation}: avant le contact");
            assert!(impacts(track, TC + IMPACT_DELAY_S + IMPACT_S + 0.001).is_empty(), "{rotation}: après");
            for age in [0.06, 0.1, 0.2, 0.4] {
                let (g, plan) = model_frame(rotation, 0.0, track, TC + age);
                let cb = &plan.expect("curseur").impacts;
                assert_eq!(cb.len(), 1, "{rotation} +{age}");
                let cb = cb[0];
                assert_eq!(cb.mode, 16.0);
                // Le centre du carré (s = t = 0,5) : l'inverse du quad dans le shader.
                let c = |i: usize| -> [f32; 2] {
                    let v = [cb.fx[0], cb.fx[1], cb.fx[2], cb.fx[3], cb.src_prev[0], cb.src_prev[1], cb.src_prev[2], cb.src_prev[3]];
                    [v[2 * i] + cb.dst[0] * 1170.0, v[2 * i + 1] + cb.dst[1] * 658.0]
                };
                let (tl, tr, br, bl) = (c(0), c(1), c(2), c(3));
                let center = if cb.mb[0] > 0.5 {
                    let q = crate::regions::square_to_quad(&[(tl[0], tl[1]), (tr[0], tr[1]), (br[0], br[1]), (bl[0], bl[1])], 0.5, 0.5);
                    [q.0, q.1]
                } else {
                    [(tl[0] + tr[0] + br[0] + bl[0]) / 4.0, (tl[1] + tr[1] + br[1] + bl[1]) / 4.0]
                };
                let want = content_px(&g, (0.3, 0.18));
                assert!(
                    (center[0] - want[0]).abs() < 0.05 && (center[1] - want[1]).abs() < 0.05,
                    "{rotation} +{age}: impact en {center:?}, clic en {want:?}"
                );
                assert!(cb.src[0] > 0.0 && cb.src[0] <= 0.8 && cb.src[2] > 0.0, "{rotation} +{age}: {:?}", cb.src);
            }
            // L'anneau grandit et s'éteint.
            let ring = |age: f32| impact_at(age, 1.0).expect("dans la fenêtre");
            assert!(ring(0.1).ring_r < ring(0.3).ring_r && ring(0.1).ring_a > ring(0.3).ring_a);
            assert!(ring(0.08).spot_a > 0.2 && ring(0.3).spot_a == 0.0);
        }
        // Réglage éteint, ou `clickBounce` nul : rien.
        let cfg = crate::config::all().pop().expect("cfg");
        let scene = model_scene();
        let fg = full_frame_geometry();
        let plan = |model3d: bool, bounce: f32| {
            plan_cursor(
                &fg,
                &CursorPlanInput {
                    render_px: [1920.0, 1080.0],
                    u_max: 1.0,
                    v_max: 1.0,
                    cfg: &cfg,
                    live: LiveParams { cursor_model3d: model3d, cursor_bounce_scale: bounce, ..LiveParams::default() },
                    scene: Some(&scene),
                    track,
                    t: TC + 0.1,
                },
            )
            .expect("plan")
            .impacts
            .len()
        };
        assert_eq!((plan(true, 2.5), plan(false, 2.5), plan(true, 0.0)), (1, 0, 0));
    }

    /// L'écrasement suit le contact : neutre au repos, l'épaisseur au plus bas au creux, un léger
    /// rebond ensuite, et rien à `clickBounce` nul.
    #[test]
    fn the_model_squashes_on_the_click() {
        let track = still_track(vec![0.5]);
        assert_eq!(cursor_pose(&track, 0.45, 2.5, 1.0).squash, 1.0);
        let down = cursor_pose(&track, 0.5 + CONTACT_S, 2.5, 1.0);
        assert!((down.squash - (1.0 - MODEL_SQUASH)).abs() < 1e-3, "{down:?}");
        let rebound = cursor_pose(&track, 0.5 + 0.165, 2.5, 1.0);
        assert!(rebound.squash > 1.0 && rebound.squash < 1.06, "{rebound:?}");
        assert_eq!(cursor_pose(&track, 0.5 + CONTACT_S, 0.0, 1.0).squash, 1.0);
        assert!(cursor_pose(&track, 0.5 + CONTACT_S, 5.0, 1.0).squash >= MODEL_SQUASH_MIN);
    }

    #[test]
    fn the_model_box_holds_the_model_and_its_shadow() {
        for (name, plan, shape, sdf) in model_cases() {
            let pose = plan.model.expect("modèle");
            let view = ModelView::new(plan.placement, plan.size_px, pose, shape).expect("vue");
            let cb = cursor_model_cb(plan.placement, plan.size_px, pose, shape, 1.0, [0.0; 4]).expect("cb");
            let (x0, y0) = (cb.dst[0] * 1920.0, cb.dst[1] * 1080.0);
            let (x1, y1) = (x0 + cb.quad_px[0], y0 + cb.quad_px[1]);
            let inside = |p: [f32; 2]| p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
            let (lo, hi) = shape.model_box(pose.squash);
            let mut solid = 0;
            for i in 0..=20 {
                for j in 0..=30 {
                    for k in 0..=6 {
                        let q = [
                            lo[0] + (hi[0] - lo[0]) * i as f32 / 20.0,
                            lo[1] + (hi[1] - lo[1]) * j as f32 / 30.0,
                            lo[2] + (hi[2] - lo[2]) * k as f32 / 6.0,
                        ];
                        if sd_model(&sdf, shape, pose.squash, q) > 0.0 {
                            continue;
                        }
                        solid += 1;
                        let p = view.project(view.model_to_plane(q)).expect("projection");
                        assert!(inside(p), "{name}: le point {q:?} du modèle tombe hors de la boîte");
                    }
                }
            }
            assert!(solid > 100, "{name}: le modèle échantillonné est vide");
            // L'ombre : tout point du plan qu'elle assombrit d'au moins 1/255 est dans la boîte.
            let (step, reach) = (view.unit / 12.0, 3.0 * view.unit);
            let mut shaded = 0;
            for i in 0..=72 {
                for j in 0..=72 {
                    let g = [view.tip[0] - reach + i as f32 * step, view.tip[1] - reach + j as f32 * step];
                    if model_shadow_at(&view, &sdf, g) < 0.5 / 255.0 {
                        continue;
                    }
                    shaded += 1;
                    let p = view.project([g[0], g[1], 0.0]).expect("projection");
                    assert!(inside(p), "{name}: l'ombre en {g:?} déborde de la boîte ({p:?})");
                }
            }
            assert!(shaded > 50, "{name}: pas d'ombre échantillonnée");
        }
    }

    /// Le backend logiciel ne dessine que la tête du curseur modélisé ; le GPU et le sprite plat
    /// gardent leur traînée.
    #[test]
    fn the_software_backend_draws_the_modelled_head_only() {
        let scene = model_scene();
        let fast = crate::cursor::CursorTrack::new(vec![(0.0, 0.1, 0.6), (0.5, 0.9, 0.6)], vec![], vec![]);
        let cfg = crate::config::all().pop().expect("cfg");
        let fg = full_frame_geometry();
        let plan = |model3d: bool| {
            plan_cursor(
                &fg,
                &CursorPlanInput {
                    render_px: [1920.0, 1080.0],
                    u_max: 1.0,
                    v_max: 1.0,
                    cfg: &cfg,
                    live: LiveParams {
                        cursor_model3d: model3d,
                        cursor_motion_blur: 1.0,
                        ..LiveParams::default()
                    },
                    scene: Some(&scene),
                    track: &fast,
                    t: 0.25,
                },
            )
            .expect("plan")
        };
        let taps = plan(true).taps;
        assert!(taps > 1, "le geste rapide doit donner une traînée");
        assert_eq!(plan(true).for_backend(false).taps, taps, "GPU : traînée gardée");
        let cpu = plan(true).for_backend(true);
        assert_eq!(cpu.taps, 1);
        assert_eq!(cpu.prev_placement.upright_center(), cpu.placement.upright_center());
        assert_eq!(plan(false).for_backend(true).taps, plan(false).taps, "le sprite plat garde sa traînée");
    }
}
