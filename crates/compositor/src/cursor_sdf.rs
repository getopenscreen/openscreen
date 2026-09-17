//! Champ de distance signé d'un sprite de curseur, pour le curseur modélisé (mode 15).
//!
//! Le mode 15 extrude la silhouette du sprite de l'état courant : il lui faut sa distance signée
//! en tout point. On la tire UNE fois, au chargement, de l'alpha du PNG :
//!
//! 1. l'alpha antialiasé est suréchantillonné ×`SDF_UPSAMPLE` (bilinéaire, bord du sprite
//!    prolongé comme le sampler du mode 7, transparent au-delà) puis seuillé à 0,5 ;
//! 2. transformée de distance euclidienne EXACTE (Felzenszwalb & Huttenlocher, colonnes puis
//!    lignes), vers le dedans et vers le dehors ;
//! 3. distance signée entre centres de texels, moins un demi-texel (le bord passe entre deux
//!    texels), convertie en unités du modèle : le plus grand côté du sprite vaut 1 ;
//! 4. flou de rayon `SDF_SMOOTH` texels fins. Le seuil laisse un bord en escalier d'un texel
//!    fin, dont le gradient hésite entre l'horizontale et la diagonale : les normales du mode 15
//!    en tiraient des stries sur les flancs. Le flou efface l'escalier ; il laisse en place un bord
//!    droit (le champ y est affine) et n'arrondit un coin que d'un demi-texel source.
//!
//! La texture (R16F, même rect que le sprite) garde les distances telles quelles : un demi-flottant
//! est exact au millième près autour de zéro, là où la silhouette se joue, et il est filtrable sur
//! les trois backends (D3D11, Metal, wgpu), contrairement au R32F.

use anyhow::{anyhow, Result};

use crate::frame_geometry::SpriteShape;

/// Suréchantillonnage de l'alpha avant le seuil : la silhouette tombe à un quart de texel près.
pub const SDF_UPSAMPLE: usize = 4;
/// Rayon du flou du champ (deux boîtes successives), en texels fins.
const SDF_SMOOTH: usize = 2;

/// Le champ d'un sprite, prêt à téléverser.
pub struct CursorSdf {
    /// Taille de la texture : celle du sprite × `SDF_UPSAMPLE`.
    pub width: u32,
    pub height: u32,
    /// Distances signées (unités du modèle, négatives dedans), ligne par ligne, texels centrés
    /// comme ceux du sprite : la texture couvre exactement son rect.
    pub texels: Vec<f32>,
    /// La forme, hotspot nul : l'appelant pose celui de la scène.
    pub shape: SpriteShape,
}

impl CursorSdf {
    /// Décode `path` (chemin ou data URI, comme les sprites) et en tire le champ.
    pub fn load(path: &str) -> Result<CursorSdf> {
        let img = if let Some(bytes) = crate::frame_geometry::decode_data_uri(path) {
            image::load_from_memory(&bytes)
        } else {
            image::open(path)
        }
        .map_err(|e| anyhow!("sprite {path} : {e}"))?
        .to_rgba8();
        let (w, h) = img.dimensions();
        Ok(CursorSdf::from_rgba(img.as_raw(), w, h))
    }

    /// `rgba` : `w`×`h` texels RGBA8, alpha droit.
    pub fn from_rgba(rgba: &[u8], w: u32, h: u32) -> CursorSdf {
        const K: usize = SDF_UPSAMPLE;
        // Une marge de texels transparents : un texel intérieur collé au bord du sprite trouve
        // ainsi son voisin extérieur, qui n'existe pas dans le rect.
        const PAD: usize = 2;
        let (w, h) = (w.max(1) as usize, h.max(1) as usize);
        let alpha = |x: isize, y: isize| {
            let (x, y) = (x.clamp(0, w as isize - 1) as usize, y.clamp(0, h as isize - 1) as usize);
            rgba[(y * w + x) * 4 + 3] as f32 / 255.0
        };
        let (fw, fh) = (w * K, h * K);
        let (gw, gh) = (fw + 2 * PAD, fh + 2 * PAD);
        let mut inside = vec![false; gw * gh];
        for fy in 0..fh {
            // Centre du texel fin, en texels source (leurs centres sont aux entiers).
            let sy = (fy as f32 + 0.5) / K as f32 - 0.5;
            let (y0, ty) = (sy.floor(), sy - sy.floor());
            for fx in 0..fw {
                let sx = (fx as f32 + 0.5) / K as f32 - 0.5;
                let (x0, tx) = (sx.floor(), sx - sx.floor());
                let (x0, y0) = (x0 as isize, y0 as isize);
                let top = alpha(x0, y0) * (1.0 - tx) + alpha(x0 + 1, y0) * tx;
                let bottom = alpha(x0, y0 + 1) * (1.0 - tx) + alpha(x0 + 1, y0 + 1) * tx;
                inside[(fy + PAD) * gw + fx + PAD] = top * (1.0 - ty) + bottom * ty >= 0.5;
            }
        }
        let to_inside = squared_edt(&inside, gw, gh);
        let outside: Vec<bool> = inside.iter().map(|&i| !i).collect();
        let to_outside = squared_edt(&outside, gw, gh);

        let scale = 1.0 / (K * w.max(h)) as f32;
        let mut texels = Vec::with_capacity(fw * fh);
        let mut top_row = fh;
        for fy in 0..fh {
            for fx in 0..fw {
                let g = (fy + PAD) * gw + fx + PAD;
                let d = if inside[g] {
                    top_row = top_row.min(fy);
                    0.5 - to_outside[g].sqrt()
                } else {
                    // Aucun texel intérieur (sprite vide) : loin de tout, sans infini.
                    to_inside[g].sqrt().min((gw + gh) as f64) - 0.5
                };
                texels.push(d as f32 * scale);
            }
        }
        for _ in 0..2 {
            box_blur(&mut texels, fw, fh, SDF_SMOOTH);
        }
        let long = w.max(h) as f32;
        CursorSdf {
            width: fw as u32,
            height: fh as u32,
            texels,
            shape: SpriteShape {
                size: [w as f32 / long, h as f32 / long],
                hotspot: [0.0; 2],
                top: top_row as f32 / fh as f32,
            },
        }
    }

    /// Les texels en demi-flottants petit-boutistes, pour une texture R16F.
    pub fn f16_bytes(&self) -> Vec<u8> {
        self.texels.iter().flat_map(|&d| f16_bits(d).to_le_bytes()).collect()
    }

    /// Le champ en `uv` (0..1 sur le rect du sprite), filtré comme le sampler des shaders :
    /// bilinéaire, bord prolongé. Miroir CPU de l'échantillonnage du mode 15.
    #[cfg(test)]
    pub(crate) fn sample(&self, uv: [f32; 2]) -> f32 {
        let (w, h) = (self.width as usize, self.height as usize);
        let at = |x: isize, y: isize| {
            let (x, y) = (x.clamp(0, w as isize - 1) as usize, y.clamp(0, h as isize - 1) as usize);
            self.texels[y * w + x]
        };
        let (sx, sy) = (uv[0] * w as f32 - 0.5, uv[1] * h as f32 - 0.5);
        let (x0, y0) = (sx.floor(), sy.floor());
        let (tx, ty) = (sx - x0, sy - y0);
        let (x0, y0) = (x0 as isize, y0 as isize);
        let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1, y0) * tx;
        let bottom = at(x0, y0 + 1) * (1.0 - tx) + at(x0 + 1, y0 + 1) * tx;
        top * (1.0 - ty) + bottom * ty
    }
}

/// Demi-flottant IEEE 754 de `v`, tronqué. Les distances n'ont ni NaN ni infini ; sous 2⁻¹⁵ elles
/// valent zéro, et c'est sans effet à cette échelle.
fn f16_bits(v: f32) -> u16 {
    let b = v.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let e = ((b >> 23) & 0xff) as i32 - 127 + 15;
    if e <= 0 {
        return sign;
    }
    if e >= 31 {
        return sign | 0x7c00;
    }
    sign | ((e as u16) << 10) | ((b >> 13) & 0x3ff) as u16
}

/// Flou boîte séparable de rayon `r`, bord prolongé.
fn box_blur(v: &mut [f32], w: usize, h: usize, r: usize) {
    let mut line = vec![0.0f32; w.max(h)];
    let n = (2 * r + 1) as f32;
    let pass = |line: &mut [f32], get: &dyn Fn(usize) -> f32, len: usize| {
        for (i, out) in line[..len].iter_mut().enumerate() {
            let sum: f32 = (0..2 * r + 1).map(|k| get((i + k).saturating_sub(r).min(len - 1))).sum();
            *out = sum / n;
        }
    };
    for y in 0..h {
        pass(&mut line, &|x| v[y * w + x], w);
        v[y * w..(y + 1) * w].copy_from_slice(&line[..w]);
    }
    for x in 0..w {
        pass(&mut line, &|y| v[y * w + x], h);
        for y in 0..h {
            v[y * w + x] = line[y];
        }
    }
}

/// Carré de la distance de chaque texel au texel `seed` le plus proche (entre centres), infini
/// s'il n'y en a aucun.
fn squared_edt(seed: &[bool], w: usize, h: usize) -> Vec<f64> {
    let mut grid: Vec<f64> = seed.iter().map(|&s| if s { 0.0 } else { f64::INFINITY }).collect();
    let n = w.max(h);
    let (mut f, mut d) = (vec![0.0; n], vec![0.0; n]);
    let (mut v, mut z) = (vec![0usize; n], vec![0.0; n]);
    for x in 0..w {
        for y in 0..h {
            f[y] = grid[y * w + x];
        }
        edt_1d(&f[..h], &mut d[..h], &mut v, &mut z);
        for y in 0..h {
            grid[y * w + x] = d[y];
        }
    }
    for y in 0..h {
        let row = &mut grid[y * w..(y + 1) * w];
        f[..w].copy_from_slice(row);
        edt_1d(&f[..w], &mut d[..w], &mut v, &mut z);
        row.copy_from_slice(&d[..w]);
    }
    grid
}

/// Enveloppe inférieure des paraboles `(q - p)² + f[p]` (les `f[p]` infinis n'en font pas
/// partie) : `d[q]` = son minimum en `q`. `v` = sommets de l'enveloppe, `z[i]` = abscisse à partir
/// de laquelle la parabole `v[i]` domine.
fn edt_1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let mut k: Option<usize> = None;
    for q in 0..f.len() {
        if f[q].is_infinite() {
            continue;
        }
        let Some(mut top) = k else {
            v[0] = q;
            z[0] = f64::NEG_INFINITY;
            k = Some(0);
            continue;
        };
        let fq = f[q] + (q * q) as f64;
        loop {
            let p = v[top];
            let s = (fq - f[p] - (p * p) as f64) / (2 * (q - p)) as f64;
            // z[0] vaut -inf : on ne dépile jamais le premier sommet.
            if s <= z[top] {
                top -= 1;
                continue;
            }
            top += 1;
            v[top] = q;
            z[top] = s;
            break;
        }
        k = Some(top);
    }
    let Some(k) = k else {
        d.fill(f64::INFINITY);
        return;
    };
    let mut j = 0;
    for (q, out) in d.iter_mut().enumerate() {
        while j < k && z[j + 1] < q as f64 {
            j += 1;
        }
        let p = v[j];
        *out = (q as f64 - p as f64).powi(2) + f[p];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats_encode_the_usual_values() {
        for (v, bits) in [(0.0, 0x0000), (1.0, 0x3c00), (-2.0, 0xc000), (0.5, 0x3800), (-0.25, 0xb400)] {
            assert_eq!(f16_bits(v), bits, "{v}");
        }
        // 0.1 : exposant -4, mantisse tronquée à 10 bits.
        assert_eq!(f16_bits(0.1), 0x2e66);
        assert_eq!(f16_bits(1e9), 0x7c00);
    }

    #[test]
    fn the_distance_transform_is_exact() {
        // Un masque pseudo-aléatoire, contre la force brute.
        let (w, h) = (23usize, 17usize);
        let seed: Vec<bool> = (0..w * h).map(|i| (i * 7919 + 13) % 29 == 0).collect();
        let got = squared_edt(&seed, w, h);
        for y in 0..h {
            for x in 0..w {
                let mut best = f64::INFINITY;
                for sy in 0..h {
                    for sx in 0..w {
                        if seed[sy * w + sx] {
                            let (dx, dy) = (x as f64 - sx as f64, y as f64 - sy as f64);
                            best = best.min(dx * dx + dy * dy);
                        }
                    }
                }
                assert_eq!(got[y * w + x], best, "({x}, {y})");
            }
        }
        assert!(squared_edt(&[false; 6], 3, 2).iter().all(|d| d.is_infinite()));
    }

    /// Un sprite `w`×`h` dont chaque texel a pour alpha sa couverture par `inside` (16×16
    /// sous-échantillons) ; son champ doit suivre `exact` (texels source) à un demi-texel près
    /// dans la bande de 3 texels autour du bord, celle où se jouent la silhouette, le chanfrein,
    /// la couleur du bord et l'ombre de contact. Plus loin, le flou arrondit les crêtes (l'axe
    /// médian) : un texel près.
    fn check_sprite(w: u32, h: u32, inside: impl Fn(f32, f32) -> bool, exact: impl Fn(f32, f32) -> f32) {
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let n = (0..256)
                    .filter(|k| {
                        let (sx, sy) = ((k % 16) as f32 / 16.0 + 1.0 / 32.0, (k / 16) as f32 / 16.0 + 1.0 / 32.0);
                        inside(x as f32 + sx, y as f32 + sy)
                    })
                    .count();
                rgba[((y * w + x) * 4 + 3) as usize] = ((n as f32 / 256.0) * 255.0).round() as u8;
            }
        }
        let sdf = CursorSdf::from_rgba(&rgba, w, h);
        assert_eq!((sdf.width, sdf.height), (w * 4, h * 4));
        let long = w.max(h) as f32;
        let (mut worst, mut worst_far) = (0.0f32, 0.0f32);
        for fy in 0..sdf.height {
            for fx in 0..sdf.width {
                let (x, y) = ((fx as f32 + 0.5) / 4.0, (fy as f32 + 0.5) / 4.0);
                let want = exact(x, y);
                let got = sdf.texels[(fy * sdf.width + fx) as usize] * long;
                if want.abs() <= 3.0 {
                    worst = worst.max((got - want).abs());
                } else {
                    worst_far = worst_far.max((got - want).abs());
                }
                if want.abs() > 0.5 {
                    assert_eq!(got < 0.0, want < 0.0, "signe faux en ({x}, {y}) : {got} pour {want}");
                }
            }
        }
        println!("écart maximal {worst} texel source près du bord, {worst_far} au-delà");
        assert!(worst < 0.5, "écart maximal {worst} texel source près du bord");
        assert!(worst_far < 1.0, "écart maximal {worst_far} texel source loin du bord");
        // Au centre d'un texel fin, le filtrage rend le texel.
        let (fx, fy) = (sdf.width / 3, sdf.height / 2);
        let uv = [(fx as f32 + 0.5) / sdf.width as f32, (fy as f32 + 0.5) / sdf.height as f32];
        assert!((sdf.sample(uv) - sdf.texels[(fy * sdf.width + fx) as usize]).abs() < 1e-6);
    }

    #[test]
    fn a_disc_gets_its_exact_distance() {
        let (cx, cy, r) = (21.3f32, 18.6f32, 12.4f32);
        check_sprite(44, 38, |x, y| (x - cx).hypot(y - cy) < r, |x, y| (x - cx).hypot(y - cy) - r);
    }

    #[test]
    fn a_rectangle_gets_its_exact_distance() {
        let (x0, y0, x1, y1) = (6.3f32, 9.2f32, 30.6f32, 25.7f32);
        check_sprite(
            40,
            34,
            |x, y| x > x0 && x < x1 && y > y0 && y < y1,
            |x, y| {
                let (dx, dy) = ((x0 - x).max(x - x1), (y0 - y).max(y - y1));
                dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0)
            },
        );
    }

    #[test]
    fn a_shape_touching_the_sprite_edge_is_closed_by_it() {
        // Plein partout : le bord du sprite est la silhouette, à un demi-texel fin près.
        let rgba = vec![255u8; 6 * 5 * 4];
        let sdf = CursorSdf::from_rgba(&rgba, 6, 5);
        assert!(sdf.texels.iter().all(|&d| d < 0.0));
        // Au coin, sous le flou : entre un demi et trois texels fins de profondeur.
        let corner = sdf.texels[0] * 6.0 * 4.0;
        assert!((-3.0..-0.5).contains(&corner), "coin : {corner} texels fins");
        assert_eq!(sdf.shape.top, 0.0);
        assert_eq!(sdf.shape.size, [1.0, 5.0 / 6.0]);
        // Le texel du sprite que les shaders tirent de la taille du champ.
        assert_eq!(SDF_UPSAMPLE as f32 / sdf.width.max(sdf.height) as f32, 1.0 / 6.0);
    }

    /// Pour chaque sprite livré, le signe du champ EST la silhouette de l'alpha (seuil 0,5), à la
    /// frange près : vu de face, le modèle a la forme du sprite.
    #[test]
    fn every_shipped_sprite_keeps_its_silhouette() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/cursors/default");
        let mut n = 0;
        for entry in std::fs::read_dir(dir).expect("sprites livrés") {
            let path = entry.expect("entrée").path();
            let img = image::open(&path).expect("png").to_rgba8();
            let sdf = CursorSdf::load(path.to_str().expect("chemin")).expect("champ");
            let (w, h) = img.dimensions();
            let (mut inter, mut union) = (0, 0);
            for y in 0..h {
                for x in 0..w {
                    let a = img.get_pixel(x, y)[3];
                    // La frange antialiasée n'a pas de côté.
                    if (64..192).contains(&a) {
                        continue;
                    }
                    let uv = [(x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32];
                    let (alpha_in, field_in) = (a >= 128, sdf.sample(uv) < 0.0);
                    inter += (alpha_in && field_in) as u32;
                    union += (alpha_in || field_in) as u32;
                }
            }
            let iou = inter as f32 / union.max(1) as f32;
            println!("{}: IoU {iou:.4}", path.display());
            assert!(iou > 0.995, "{}: IoU {iou}", path.display());
            n += 1;
        }
        assert_eq!(n, 16, "les seize états du thème par défaut");
    }

    #[test]
    fn the_shipped_arrow_loads() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/cursors/default/arrow.png");
        let sdf = CursorSdf::load(path).expect("arrow.png");
        assert_eq!((sdf.width, sdf.height), (42 * 4, 70 * 4));
        assert_eq!(sdf.shape.size, [0.6, 1.0]);
        assert!(sdf.shape.top < 0.02, "haut de la silhouette : {}", sdf.shape.top);
        // Le hotspot (0.119, 0.0874) est la pointe de l'incrustation, dans la silhouette.
        assert!(sdf.sample([0.119, 0.0874]) < 0.0);
        assert!(sdf.sample([0.9, 0.1]) > 0.0);
        assert_eq!(sdf.f16_bytes().len(), sdf.texels.len() * 2);
    }
}
