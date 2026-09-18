// Tranche verticale WP3 — port 1:1 des modes 0 (vidéo NV12) et 1 (couleur pleine)
// du `ps_main` HLSL (`crates/compositor/src/shaders.hlsl`). Le mode 2 (ombre
// portée) partage la même SDF et le même feather que les autres modes, donc on
// l'inclut aussi pour parité.
//
// Les constantes YUV (BT.709 limited) sont reprises à l'identique du HLSL :
//   Yf  = (Y  * 255 − 16) / 219
//   Cb  = (UV.x * 255 − 128) / 224
//   Cr  = (UV.y * 255 − 128) / 224
//   R   = Yf + 1.5748 · Cr
//   G   = Yf − 0.1873 · Cb − 0.4681 · Cr
//   B   = Yf + 1.8556 · Cb
// Mesuré en S1 (cf. doc §7 E1). Une déviation > 0/255 entre HLSL et WGSL ici
// indiquerait une différence de précision fp32 ; IEEE-754 round-to-nearest est
// identique sur les deux backends.
//
// Le rendu est en alpha PRÉMULTIPLIÉ (cf. commentaire HLSL), convention qu'on
// retrouve dans tous les autres modes du compositeur (texte, curseur, ombre).

struct Layer {
    dst: vec4<f32>,       // x,y,w,h sortie 0..1 (origine haut-gauche)
    src: vec4<f32>,       // u0,v0,u1,v1 source 0..1 ; mode 14 : .x = 1 si warp projectif ; modes 15 et 17 : (decalage px du rayon, P, unite du modele px)
    quad_px: vec2<f32>,   // taille du quad en px de sortie (pour la SDF isotrope)
    radius_px: f32,       // mode 15 : rapport w/h du sprite (son plus grand cote vaut 1 unite) ; mode 17 : rayon exterieur des coins HAUTS du corps (unites du modele)
    mode: f32,            // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre, 8 = écran tilté, 9 = flèche, 10 = flou/mosaïque, 12 = ombre du quad tilté, 13 = curseur tilté, 14 = cadre de fenetre, 15 = curseur modelise, 16 = impact du clic (emplacements : `cursor_impact_cb`), 17 = cadre d'appareil modelise (`device_frame_cb`)
    color: vec4<f32>,     // mode 8 (camera reelle) : .xy = gradient d'eclairage ; mode 14 : fond de la barre de titre ; mode 15 : .rg = coin du sprite (unites du modele), .b = ecrasement de l'epaisseur, .a = opacite ; mode 17 : .r = l'appareil (1 portable, 2 telephone, 3 moniteur), .g = 1 si theme sombre, .b = rayon exterieur des coins BAS du corps (unites du modele), .a = opacite
    fx: vec4<f32>,        // mode 2 : spread ombre en px ; mode 5 : (direction xy, temps programme replie, mouvement 0..3) ; modes 8/12/13/14 : coins TL,TR du quad projeté ; mode 9 : hampe de la flèche ; mode 10 : (flou?, rayon/bloc px, ovale?, teinté?) ; mode 15 : (rotation du plan X, Y, Z en rad, tangage) ; mode 17 : (rotation du plan X, Y, Z en rad, epaisseur du corps)
    src_prev: vec4<f32>,  // modes 8/12/13/14 : coins BR,BL du quad projeté ; mode 9 : barbe 1 ; mode 10 incliné : coins BR,BL du masque ; mode 15 : (hotspot du dessus, repere du plan en px ; lacet) ; mode 17 : marges du corps (gauche, haut, droite, bas ; unites du modele)
    dst_prev: vec4<f32>,  // mode 8 : .xy = taille du plan en px AVANT projection (le rayon y vit), .z = 1 si coins hauts carres (sous un cadre), .w = 1 si warp projectif ; mode 14 : .xy = taille du plan du cadre, .z = hauteur de la barre, .w = epaisseur du filet (px du plan) ; modes 13 et 15 : rect de clip ; mode 9 : barbe 2 ; mode 10 incliné : coins TL,TR du masque ; mode 17 : (angle du socle depuis le plan en rad, rayon de l'ouverture et recouvrement de la lunette en unites du modele, penombre de l'ombre ou 0)
    mb: vec4<f32>,        // mode 8 : [gx, gy, z_focus, k], profondeur du plan et flou (texels source) par px d'ecart, k = 0 coupe ; mode 0 : .x taps, .y force du flou, .w = 1 si coins hauts carres (sous un cadre) ; mode 5 : mb.x = aspect w/h de la sortie (fond anime) ; mode 12 : mb.y = spread de la pénombre en px ; mode 9 : mb.y = demi-épaisseur du trait en px ; mode 10 : mb.z = 1 si masque incliné, mb.w = 1 si son warp est projectif ; mode 13 : mb.x = 1 si warp projectif ; mode 14 : couleur du filet (alpha droit) ; modes 15 et 17 : .xy = demi-taille du plan dans son repere (px pour le 15, unites pour le 17), .zw = translation du plan (repere camera, px)
}

@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var texY:  texture_2d<f32>;   // R8Unorm, sample .r ; modes 7, 13 et 15 : le sprite RGBA
@group(0) @binding(2) var texU:  texture_2d<f32>;   // R8Unorm, sample .r ; mode 15 : le champ R16F du sprite
@group(0) @binding(3) var samp:  sampler;
// Masque de segmentation du sujet webcam, R8. Une vue 1x1 est liee quand aucun masque
// n'existe : la branche n'est de toute facon prise que si layer.fx.z > 0.5.
// Mode 8 : ce binding porte a la place la pyramide RGBA de profondeur de champ (jamais le
// binding 1, qui porte la luma).
@group(0) @binding(4) var texMask: texture_2d<f32>;

// Plafond de la profondeur de champ du mode 8, en niveau de la pyramide demi-resolution.
// Meme valeur que `DOF_MAX_LOD` du HLSL.
const DOF_MAX_LOD: f32 = 1.5;
// V est en binding 5 et pas 3 : les bindings 0-4 etaient deja pris quand le plan
// de chroma a ete dedouble, et renumeroter aurait touche tous les bind groups
// pour un gain nul.
@group(0) @binding(5) var texV:  texture_2d<f32>;   // R8Unorm, sample .r

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,     // UV d'échantillonnage source
    @location(1) local: vec2<f32>,  // pixel local dans le quad (SDF)
    @location(2) pout: vec2<f32>,   // position 0..1 sortie
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // strip 4 vertices : (0,0)(1,0)(0,1)(1,1)
    let c = vec2<f32>(f32(vid & 1u), f32((vid >> 1u) & 1u));
    let p = layer.dst.xy + c * layer.dst.zw;
    let ndc = vec2<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    var o: VsOut;
    o.pos = vec4<f32>(ndc, 0.0, 1.0);
    o.uv = layer.src.xy + c * (layer.src.zw - layer.src.xy);
    o.local = c * layer.quad_px;
    o.pout = p;
    return o;
}

fn yuv709_limited(y: f32, cbcr: vec2<f32>) -> vec3<f32> {
    let Yf = (y * 255.0 - 16.0) / 219.0;
    let Cb = (cbcr.x * 255.0 - 128.0) / 224.0;
    let Cr = (cbcr.y * 255.0 - 128.0) / 224.0;
    return clamp(vec3<f32>(
        Yf + 1.5748 * Cr,
        Yf - 0.1873 * Cb - 0.4681 * Cr,
        Yf + 1.8556 * Cb,
    ), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn sample_yuv(uv: vec2<f32>) -> vec3<f32> {
    let y = textureSample(texY, samp, uv).r;
    let cbcr = vec2<f32>(
        textureSample(texU, samp, uv).r,
        textureSample(texV, samp, uv).r,
    );
    return yuv709_limited(y, cbcr);
}

// SDF rectangle à coins arrondis (< 0 dedans). Identique au HLSL.
fn sd_round_rect(p: vec2<f32>, halfsz: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - halfsz + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// L'ecran sous le chrome de FENETRE (modes 0 et 8) : coins HAUTS carres, rognes par l'arc du
// cadre quand le rayon depasse la barre. Port de `sd_screen_under_bar` (HLSL), qui fait foi.
fn sd_screen_under_bar(p: vec2<f32>, halfsz: vec2<f32>, r: f32, lift: f32) -> f32 {
    let own = sd_round_rect(p, halfsz, select(r, 0.0, p.y < 0.0));
    let up = vec2<f32>(0.0, lift * 0.5);
    return max(own, sd_round_rect(p + up, halfsz + up, r));
}

// Couverture du quad avec coins arrondis, pour le mode 6 qui retourne AVANT la queue de
// `fs_main`. Il s'en passait tant qu'il ne servait qu'au fond plein cadre, qui n'a pas de
// rayon ; depuis que la bulle webcam peut porter une image, sans ca le fond deborde en carre
// opaque sur les coins arrondis de la bulle et mange l'ombre. Renvoie 1.0 quand aucun rayon
// n'est demande -- le fond plein cadre est donc inchange.
fn quad_round_alpha(local: vec2<f32>, quad_px: vec2<f32>, radius_px: f32) -> f32 {
    if radius_px <= 0.0 || quad_px.x <= 0.0 || quad_px.y <= 0.0 {
        return 1.0;
    }
    let halfsz = quad_px * 0.5;
    let d = sd_round_rect(local - halfsz, halfsz, radius_px);
    return 1.0 - smoothstep(0.0, 1.5, d); // meme feather ~1.5px que la queue
}

// ---- Primitives du tilt 3D (modes 8 et 12), portees de `shaders.metal` ----

// SDF segment a bouts ronds.
fn sd_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// Intersection de deux droites donnees par (normale, offset) : n.x = d. Cramer.
fn line_cross(n1: vec2<f32>, d1: f32, n2: vec2<f32>, d2: f32) -> vec2<f32> {
    let det = n1.x * n2.y - n1.y * n2.x;
    if abs(det) < 1e-6 {
        return vec2<f32>(0.0, 0.0);
    }
    return vec2<f32>(d1 * n2.y - d2 * n1.y, d2 * n1.x - d1 * n2.x) / det;
}

// Contribution d'une arete a la SDF du quad : .x = distance signee au demi-plan
// porte par l'arete (>0 dehors), .y = distance au SEGMENT.
fn quad_edge(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    let e = b - a;
    // Division par la longueur plutot que `normalize` : une arete degeneree
    // donnerait un NaN qui effacerait le calque entier.
    let n = vec2<f32>(e.y, -e.x) / max(length(e), 1e-6);
    return vec2<f32>(dot(p - a, n), sd_segment(p, a, b));
}

// Distance signee EXACTE a un quadrilatere convexe (<0 dedans). La boucle `k`
// du MSL est deroulee : elle indexait un tableau local avec un indice runtime,
// ce que naga 24 traduit en SPIR-V invalide (cf. `blur.wgsl`).
fn sd_convex_quad(p: vec2<f32>, v0: vec2<f32>, v1: vec2<f32>, v2: vec2<f32>, v3: vec2<f32>) -> f32 {
    let e0 = quad_edge(p, v0, v1);
    let e1 = quad_edge(p, v1, v2);
    let e2 = quad_edge(p, v2, v3);
    let e3 = quad_edge(p, v3, v0);
    let inside = max(max(e0.x, e1.x), max(e2.x, e3.x));
    let border = min(min(e0.y, e1.y), min(e2.y, e3.y));
    if inside < 0.0 {
        return -border;
    }
    return border;
}

// Coin d'un quad rentre de `r` : intersection des deux aretes adjacentes,
// chacune decalee de `r` vers l'interieur. Meme deroulement que ci-dessus.
fn inset_corner(prev: vec2<f32>, cur: vec2<f32>, next: vec2<f32>, r: f32) -> vec2<f32> {
    let ep = cur - prev;
    let ec = next - cur;
    // TL->TR->BR->BL tourne dans le sens horaire en y-bas, donc (e.y, -e.x) sort du quad.
    let np = vec2<f32>(ep.y, -ep.x) / max(length(ep), 1e-6);
    let nc = vec2<f32>(ec.y, -ec.x) / max(length(ec), 1e-6);
    return line_cross(np, dot(prev, np) - r, nc, dot(cur, nc) - r);
}

// (s, t, ok) du warp inverse du mode 8 pour une racine `t` donnee.
fn quad_st_for_root(t: f32, e: vec2<f32>, f: vec2<f32>, g: vec2<f32>, h: vec2<f32>) -> vec3<f32> {
    let denom_x = e.x + g.x * t;
    let denom_y = e.y + g.y * t;
    var s: f32;
    if abs(denom_x) > abs(denom_y) {
        s = (h.x - f.x * t) / denom_x;
    } else {
        s = (h.y - f.y * t) / denom_y;
    }
    // Tolerance de 2 % reprise telle quelle du MSL : sans elle une rangee de
    // pixels du bord tombe hors du quad par arrondi et l'ecran se liseree.
    var ok = 0.0;
    if s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02 {
        ok = 1.0;
    }
    return vec3<f32>(s, t, ok);
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 : le warp bilineaire INVERSE.
fn quad_inverse_bilinear(P: vec2<f32>, c00: vec2<f32>, c10: vec2<f32>, c11: vec2<f32>, c01: vec2<f32>) -> vec3<f32> {
    let e = c10 - c00;
    let f = c01 - c00;
    let g = c00 - c10 - c01 + c11;
    let h = P - c00;
    let k2 = g.x * f.y - g.y * f.x;
    let k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    let k0 = h.x * e.y - h.y * e.x;
    // Quad quasi affine (rotation Y pure, p.ex.) : le terme quadratique s'evanouit
    // et resoudre la quadratique diviserait par ~0.
    if abs(k2) < 1e-5 * abs(k1) {
        var t = 0.0;
        if abs(k1) >= 1e-6 {
            t = -k0 / k1;
        }
        return quad_st_for_root(t, e, f, g, h);
    }
    let disc = k1 * k1 - 4.0 * k2 * k0;
    if disc < 0.0 {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    // Forme stable de la quadratique : additionner deux termes de meme signe evite
    // l'annulation catastrophique que `(-k1 +- sqrt(disc)) / (2 k2)` produit quand
    // `disc` approche `k1^2`. `sign()` de WGSL rend 0 en 0, la ou le ternaire MSL
    // rend +1 : d'ou le signe explicite.
    var sgn = 1.0;
    if k1 < 0.0 {
        sgn = -1.0;
    }
    let q = -0.5 * (k1 + sgn * sqrt(disc));
    let r0 = quad_st_for_root(q / k2, e, f, g, h);
    var t1 = q / k2;
    if abs(q) > 0.0 {
        t1 = k0 / q;
    }
    let r1 = quad_st_for_root(t1, e, f, g, h);
    if r0.z > 0.5 {
        return r0;
    }
    return r1;
}

// (s, t, ok) du point `P` par l'homographie EXACTE du carre unite sur le quad (forme de Heckbert,
// relative a c00), resolue a l'envers par Cramer : la projection d'un plan par la camera reelle.
// Miroir du HLSL et de `regions::square_to_quad`.
fn quad_inverse_projective(P: vec2<f32>, c00: vec2<f32>, c10: vec2<f32>, c11: vec2<f32>, c01: vec2<f32>) -> vec3<f32> {
    let p1 = c10 - c00;
    let p2 = c11 - c00;
    let p3 = c01 - c00;
    let d1 = p1 - p2;
    let d2 = p3 - p2;
    let d3 = p2 - p1 - p3;
    let den = d1.x * d2.y - d2.x * d1.y;
    let g = (d3.x * d2.y - d2.x * d3.y) / den;
    let h = (d1.x * d3.y - d3.x * d1.y) / den;
    let q = P - c00;
    let m00 = p1.x * (1.0 + g) - g * q.x;
    let m01 = p3.x * (1.0 + h) - h * q.x;
    let m10 = p1.y * (1.0 + g) - g * q.y;
    let m11 = p3.y * (1.0 + h) - h * q.y;
    let det = m00 * m11 - m01 * m10;
    let s = (q.x * m11 - m01 * q.y) / det;
    let t = (m00 * q.y - q.x * m10) / det;
    var ok = 0.0;
    if s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02 {
        ok = 1.0;
    }
    return vec3<f32>(s, t, ok);
}

// Warp inverse d'un calque pose sur le plan : projectif sous la camera reelle (`projective` = 1),
// bilineaire sous un angle fixe, inchange.
fn quad_inverse(P: vec2<f32>, c00: vec2<f32>, c10: vec2<f32>, c11: vec2<f32>, c01: vec2<f32>, projective: f32) -> vec3<f32> {
    if projective > 0.5 {
        return quad_inverse_projective(P, c00, c10, c11, c01);
    }
    return quad_inverse_bilinear(P, c00, c10, c11, c01);
}

// Hash 2D -> [0,1) sans sin(). Miroir de `hash12` cote HLSL.
fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33)));
    return fract((p3.x + p3.y) * p3.z);
}

// Bruit de valeur lisse (hermite), sans texture. Miroir de `value_noise` cote HLSL.
fn value_noise(q: vec2<f32>) -> f32 {
    let i = floor(q);
    let f = fract(q);
    let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
    let a = hash12(i);
    let b = hash12(i + vec2<f32>(1.0, 0.0));
    let c = hash12(i + vec2<f32>(0.0, 1.0));
    let d = hash12(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Mouvements 2 (aurore) et 3 (vagues) du mode 5. Miroir ligne pour ligne de
// `gradient_motion` cote HLSL (commentaires complets la-bas).
fn gradient_motion(gp: vec2<f32>, dir: vec2<f32>, denom: f32, c0: vec3<f32>, c1: vec3<f32>,
                   time: f32, motion: f32, aspect: f32) -> vec3<f32> {
    let TAU = 6.2831853;
    let u = dot(gp - vec2<f32>(0.5), dir) / denom; // position le long de l'axe, -0.5..0.5
    if motion < 2.5 {
        // Aurore : rampe perturbee par un bruit lent, puis trois nappes gaussiennes.
        let p = vec2<f32>((gp.x - 0.5) * aspect, gp.y - 0.5);
        let ph = TAU * time / 120.0;
        let n = value_noise(p * 2.5 + 1.5 * vec2<f32>(cos(ph), sin(ph)));
        var g = mix(c0, c1, clamp(0.5 + u + 0.3 * (n - 0.5), 0.0, 1.0));
        let b0 = vec2<f32>(0.35 * aspect * sin(TAU * time / 20.0), 0.25 * sin(TAU * time / 30.0 + 1.0));
        let b1 = vec2<f32>(0.30 * aspect * sin(TAU * time / 24.0 + 2.0), 0.22 * cos(TAU * time / 40.0));
        let b2 = vec2<f32>(0.25 * aspect * cos(TAU * time / 30.0 + 4.0), 0.28 * sin(TAU * time / 24.0 + 3.0));
        g = mix(g, c1, 0.45 * exp(-dot(p - b0, p - b0) / 0.08));
        g = mix(g, c0, 0.45 * exp(-dot(p - b1, p - b1) / 0.06));
        g = mix(g, c1, 0.35 * exp(-dot(p - b2, p - b2) / 0.05));
        return g;
    }
    // Vagues : trois bandes sinus perpendiculaires a l'axe (12 s), ondulees (20 s).
    let v = dot(gp - vec2<f32>(0.5), vec2<f32>(-dir.y, dir.x)) / denom;
    let w = sin(TAU * (3.0 * u + 0.04 * sin(TAU * (1.5 * v + time / 20.0)) - time / 12.0));
    return mix(c0, c1, clamp(0.5 + u + 0.07 * w, 0.0, 1.0));
}

// Couverture d'une pastille (disque) adoucie sur ~1.5 px, pour la barre de titre du mode 14.
fn disc_cov(p: vec2<f32>, c: vec2<f32>, r: f32) -> f32 {
    return 1.0 - smoothstep(r - 0.75, r + 0.75, length(p - c));
}

// Couverture d'un trait centre sur `x = 0`, de demi-epaisseur `half_w`, sur ~1 px.
fn band_cov(x: f32, half_w: f32) -> f32 {
    return clamp(half_w + 0.5 - abs(x), 0.0, 1.0);
}

// Fond flouté pour le mode "blur" de la webcam.
// Disque de Vogel (spirale à angle d'or) à 21 échantillons avec pondération gaussienne et
// rotation par pixel via Interleaved Gradient Noise (IGN) pour un bokeh photographique doux, isotrope et rapide.
const VOGEL_TAPS = array<vec3<f32>, 21>(
    vec3<f32>( 0.154303,  0.000000, 0.942213),
    vec3<f32>(-0.197070,  0.180532, 0.836464),
    vec3<f32>( 0.030165, -0.343712, 0.742584),
    vec3<f32>( 0.248394,  0.323986, 0.659241),
    vec3<f32>(-0.455834, -0.080631, 0.585251),
    vec3<f32>( 0.431806, -0.274679, 0.519566),
    vec3<f32>(-0.144431,  0.537274, 0.461253),
    vec3<f32>(-0.275445, -0.530352, 0.409484),
    vec3<f32>( 0.597605,  0.218244, 0.363526),
    vec3<f32>(-0.621708,  0.256632, 0.322726),
    vec3<f32>( 0.299704, -0.640451, 0.286505),
    vec3<f32>( 0.221474,  0.706094, 0.254349),
    vec3<f32>(-0.667525, -0.386844, 0.225802),
    vec3<f32>( 0.783083, -0.172159, 0.200460),
    vec3<f32>(-0.477903,  0.679768, 0.177961),
    vec3<f32>(-0.110407, -0.852001, 0.157988),
    vec3<f32>( 0.677789,  0.571241, 0.140256),
    vec3<f32>(-0.912091,  0.037718, 0.124514),
    vec3<f32>( 0.665301, -0.662063, 0.110540),
    vec3<f32>(-0.044511,  0.962596, 0.098133),
    vec3<f32>(-0.633036, -0.758588, 0.087119)
);

fn blur_webcam_bg(uv: vec2<f32>, intensity: f32, qpx: vec2<f32>, local_px: vec2<f32>) -> vec3<f32> {
    let max_r_px = max(intensity, 0.0) * 22.0 + 1.5;
    let step = max_r_px / max(qpx, vec2<f32>(1.0));
    let noise = fract(52.9829189 * fract(0.06711056 * local_px.x + 0.00583715 * local_px.y));
    let angle = noise * 6.2831853;
    let s = sin(angle);
    let c = cos(angle);
    var sum = vec3<f32>(0.0);
    var total = 0.0;
    for (var k: i32 = 0; k < 21; k = k + 1) {
        let p = VOGEL_TAPS[k].xy;
        let w = VOGEL_TAPS[k].z;
        let rot_p = vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
        sum = sum + sample_yuv(clamp(uv + rot_p * step, vec2<f32>(0.0), vec2<f32>(1.0))) * w;
        total = total + w;
    }
    return sum / max(total, 1e-4);
}

// ---- Curseur MODELISE (mode 15) ----
// Port ligne pour ligne de `cursor_model` (HLSL), dont les commentaires font foi : le sprite de
// l'etat courant en objet 3D, sa silhouette (champ de distance signe tire de son alpha) extrudee,
// lancee de rayons par pixel, eclairee, et qui porte une ombre douce et une ombre de contact sur
// le plan de l'ecran. Constantes : miroir exact de `frame_geometry.rs` (MODEL_*), emplacements du
// cbuffer : `cursor_model_cb`.
// Textures : le sprite RGBA (alpha droit) au binding 1 (`texY`, comme aux modes 7 et 13), son
// champ R16F au binding 2 (`texU`), sur le meme rect ; `color.rg` = coin du sprite dans le repere
// du modele, `sprite_size()` = sa taille (w/h dans `radius_px`), `color.b` = un texel du sprite (unites
// du modele).
const MODEL_THICK: f32 = 0.19;
const MODEL_BEVEL: f32 = 0.045;
const MODEL_LIGHT = vec3<f32>(-0.4194, -0.5792, 0.6990);
const MODEL_AMBIENT: f32 = 0.36;
const MODEL_DIFFUSE: f32 = 0.75;
const MODEL_SPECULAR: f32 = 0.45;
const MODEL_RIM_INSET: f32 = 1.5;
const MODEL_SOFTNESS: f32 = 6.0;
const MODEL_SHADOW_PAD: f32 = 0.45;
const MODEL_SHADOW_ALPHA: f32 = 0.5;
const MODEL_CONTACT_RADIUS: f32 = 0.12;
const MODEL_CONTACT_ALPHA: f32 = 0.5;

// Taille du sprite, repere du modele : son plus grand cote vaut 1, `radius_px` porte w/h.
fn sprite_size() -> vec2<f32> {
    return vec2<f32>(min(layer.radius_px, 1.0), min(1.0 / layer.radius_px, 1.0));
}

// Un texel du sprite, en unites du modele : le champ est le sprite surechantillonne x4.
const CURSOR_SDF_UPSAMPLE: f32 = 4.0;
fn sprite_texel() -> f32 {
    let d = vec2<f32>(textureDimensions(texU));
    return CURSOR_SDF_UPSAMPLE / max(d.x, d.y);
}

// Epaisseur du modele, ecrase au clic de `color.b`.
fn model_thick() -> f32 {
    return MODEL_THICK * layer.color.b;
}

fn sd_sprite2(p: vec2<f32>) -> f32 {
    let lo = layer.color.rg;
    let c = clamp(p, lo, lo + sprite_size());
    // Niveau 0 explicite : la marche est une boucle a sortie anticipee (pas de derivees).
    let d = textureSampleLevel(texU, samp, (c - lo) / sprite_size(), 0.0).r;
    let o = p - c;
    let out2 = dot(o, o);
    let e = max(d, 0.0);
    return select(d, sqrt(out2 + e * e), out2 > 0.0);
}

fn sd_model(p: vec3<f32>) -> f32 {
    let half_t = model_thick() * 0.5;
    let w = vec2<f32>(sd_sprite2(p.xy) + MODEL_BEVEL, abs(p.z + half_t) - (half_t - MODEL_BEVEL));
    return min(max(w.x, w.y), 0.0) + length(max(w, vec2<f32>(0.0))) - MODEL_BEVEL;
}

fn model_normal(p: vec3<f32>) -> vec3<f32> {
    let e = 0.002;
    let ka = vec3<f32>(1.0, -1.0, -1.0);
    let kb = vec3<f32>(-1.0, -1.0, 1.0);
    let kc = vec3<f32>(-1.0, 1.0, -1.0);
    let kd = vec3<f32>(1.0, 1.0, 1.0);
    return normalize(ka * sd_model(p + ka * e) + kb * sd_model(p + kb * e) +
                     kc * sd_model(p + kc * e) + kd * sd_model(p + kd * e));
}

fn ray_box(o: vec3<f32>, d: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> vec2<f32> {
    let inv = vec3<f32>(1.0) / select(vec3<f32>(1e-6), d, abs(d) > vec3<f32>(1e-6));
    let t0 = (lo - o) * inv;
    let t1 = (hi - o) * inv;
    let tn = min(t0, t1);
    let tf = max(t0, t1);
    return vec2<f32>(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

struct ModelFrame {
    c: vec3<f32>,
    s: vec3<f32>,
    cp: f32,
    sp: f32,
    cy: f32,
    sy: f32,
}

fn world_to_plane(v: vec3<f32>, f: ModelFrame) -> vec3<f32> {
    let y = v.y * f.c.x + v.z * f.s.x;
    var z = -v.y * f.s.x + v.z * f.c.x;
    let x = v.x * f.c.y - z * f.s.y;
    z = v.x * f.s.y + z * f.c.y;
    return vec3<f32>(x * f.c.z + y * f.s.z, -x * f.s.z + y * f.c.z, z);
}

fn model_to_plane(v: vec3<f32>, f: ModelFrame) -> vec3<f32> {
    let y = v.y * f.cp - v.z * f.sp;
    let z = v.y * f.sp + v.z * f.cp;
    return vec3<f32>(v.x * f.cy - y * f.sy, v.x * f.sy + y * f.cy, z);
}

fn plane_to_model(v: vec3<f32>, f: ModelFrame) -> vec3<f32> {
    let x = v.x * f.cy + v.y * f.sy;
    let y = -v.x * f.sy + v.y * f.cy;
    return vec3<f32>(x, y * f.cp + v.z * f.sp, -y * f.sp + v.z * f.cp);
}

fn model_soft_shadow(o: vec3<f32>, l: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> f32 {
    let tb = ray_box(o, l, lo - vec3<f32>(MODEL_SHADOW_PAD), hi + vec3<f32>(MODEL_SHADOW_PAD));
    if tb.x >= tb.y || tb.y <= 0.0 {
        return 1.0;
    }
    var res = 1.0;
    var t = max(tb.x, 0.004);
    for (var k = 0; k < 32; k = k + 1) {
        let d = sd_model(o + l * t);
        res = min(res, MODEL_SOFTNESS * d / t);
        if res < 0.002 || t > tb.y {
            break;
        }
        t = t + clamp(d, 0.01, 0.2);
    }
    res = clamp(res, 0.0, 1.0);
    return res * res * (3.0 - 2.0 * res);
}

fn model_albedo(p: vec2<f32>) -> vec3<f32> {
    let texel = sprite_texel();
    let e = 0.25 * texel;
    let g = vec2<f32>(sd_sprite2(p + vec2<f32>(e, 0.0)) - sd_sprite2(p - vec2<f32>(e, 0.0)),
                      sd_sprite2(p + vec2<f32>(0.0, e)) - sd_sprite2(p - vec2<f32>(0.0, e)));
    let q = p - g / max(length(g), 1e-6) * max(sd_sprite2(p) + MODEL_RIM_INSET * texel, 0.0);
    return textureSampleLevel(texY, samp, (q - layer.color.rg) / sprite_size(), 0.0).rgb;
}

fn model_shade(q: vec3<f32>, rd: vec3<f32>, l: vec3<f32>) -> vec3<f32> {
    let n = model_normal(q);
    let albedo = model_albedo(q.xy);
    let diffuse = clamp(dot(n, l), 0.0, 1.0);
    let gloss = 1.0 - smoothstep(0.97, 0.995, abs(n.z));
    let spec = gloss * pow(clamp(dot(n, normalize(l - rd)), 0.0, 1.0), 110.0);
    return albedo * (MODEL_AMBIENT + MODEL_DIFFUSE * diffuse) + MODEL_SPECULAR * spec;
}

fn cursor_model(local: vec2<f32>) -> vec4<f32> {
    var f: ModelFrame;
    f.c = cos(layer.fx.xyz);
    f.s = sin(layer.fx.xyz);
    f.cp = cos(layer.fx.w);
    f.sp = sin(layer.fx.w);
    f.cy = cos(layer.src_prev.w);
    f.sy = sin(layer.src_prev.w);
    let persp = layer.src.z;
    let unit = layer.src.w;
    let tip = layer.src_prev.xyz;
    let lo = vec3<f32>(layer.color.rg, -model_thick());
    let hi = vec3<f32>(layer.color.rg + sprite_size(), 0.0);

    let dw = vec3<f32>(local + layer.src.xy, -persp);
    let dlen = length(dw);
    // Plan translate de mb.zw dans le repere camera (camera reelle ; 0 sous un angle fixe).
    let ro = plane_to_model((world_to_plane(vec3<f32>(-layer.mb.z, -layer.mb.w, persp), f) - tip) / unit, f);
    let rd = plane_to_model(world_to_plane(dw / dlen, f), f);
    let l = plane_to_model(world_to_plane(MODEL_LIGHT, f), f);
    let nz = plane_to_model(vec3<f32>(0.0, 0.0, 1.0), f);
    let hz = -tip.z / unit;

    var cov = 0.0;
    var rgb = vec3<f32>(0.0);
    let tb = ray_box(ro, rd, lo - vec3<f32>(0.02), hi + vec3<f32>(0.02));
    if tb.x < tb.y && tb.y > 0.0 {
        var t = max(tb.x, 0.0);
        var best = 1e9;
        var t_best = t;
        var hit = false;
        for (var k = 0; k < 64; k = k + 1) {
            let d = sd_model(ro + rd * t);
            let fp = t / dlen;
            if d < 0.1 * fp {
                hit = true;
                t_best = t;
                break;
            }
            if d / fp < best {
                best = d / fp;
                t_best = t;
            }
            t = t + d;
            if t > tb.y {
                break;
            }
        }
        cov = select(clamp(1.0 - best, 0.0, 1.0), 1.0, hit);
        if cov > 0.0 {
            rgb = model_shade(ro + rd * t_best, rd, l);
        }
    }

    var shadow = 0.0;
    let denom = dot(rd, nz);
    if cov < 1.0 && denom < -1e-4 {
        let g = ro + rd * ((hz - dot(ro, nz)) / denom);
        let gp = tip + unit * model_to_plane(g, f);
        let inside = clamp(min(layer.mb.x - abs(gp.x), layer.mb.y - abs(gp.y)) + 0.5, 0.0, 1.0);
        if inside > 0.0 {
            let dropped = 1.0 - model_soft_shadow(g, l, lo, hi);
            let contact = 1.0 - smoothstep(0.0, MODEL_CONTACT_RADIUS, sd_model(g));
            shadow = inside * max(dropped * MODEL_SHADOW_ALPHA, contact * MODEL_CONTACT_ALPHA);
        }
    }

    let a = cov * layer.color.a;
    return vec4<f32>(rgb * a, a + (1.0 - a) * shadow * layer.color.a); // premultiplie, ombre noire
}

// ---- Impact du clic (mode 16) ----
// Port ligne pour ligne de `cursor_impact` (HLSL), dont les commentaires font foi.
fn cursor_impact(local: vec2<f32>) -> vec4<f32> {
    let r = quad_inverse(local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.mb.x);
    let pf = layer.dst_prev.xy + r.xy * layer.dst_prev.zw;
    if r.z < 0.5 || any(pf < vec2<f32>(0.0)) || any(pf > vec2<f32>(1.0)) {
        return vec4<f32>(0.0);
    }
    let d = length(r.xy * 2.0 - vec2<f32>(1.0));
    let x = abs(d - layer.src.x);
    let aa = layer.radius_px;
    let ring = layer.src.z * (1.0 - smoothstep(layer.src.y - aa, layer.src.y + aa, x));
    let halo = layer.src.w * exp(-x * x / (6.0 * layer.src.y * layer.src.y + aa * aa));
    let spot = layer.mb.z * exp(-d * d / max(layer.mb.y * layer.mb.y, 1e-6));
    let shade = clamp(halo + spot, 0.0, 1.0);
    let a = ring + (1.0 - ring) * shade;
    return vec4<f32>(layer.color.rgb * ring, a) * layer.color.a; // premultiplie, ombre noire
}

// ---- Cadre d'APPAREIL modelise (mode 17) ----
// Port ligne pour ligne de `device_frame` (HLSL), dont les commentaires font foi : un portable,
// un telephone ou un moniteur modeles en vraie 3D autour du metrage, lances de rayons dans la
// MEME camera que le plan, la face ecran exactement sur le plan du metrage (mode 8), qui continue
// de le dessiner dans l'ouverture. Aluminium mat et verre noir, micro-chanfrein et filet de
// lumiere peint : un produit, pas un jouet gonfle. Formes neutres dessinees ici, aucune marque.
// Constantes : miroir de `frame_geometry.rs` (DEV_*), en unites du modele — l'unite du cadre
// (`frame_unit_px`), la meme quel que soit le ratio du clip ; emplacements du cbuffer :
// `frame_geometry::device_frame_cb`, resume au-dessus de `device_frame` dans le HLSL. Les deux
// rayons du corps y sont CONCENTRIQUES a celui de l'ouverture (`concentric_radius`).
const DEV_CHAMFER: f32 = 0.0021;
// Distance minimale de l'oeil du relief (`DEV_EYE_MIN`).
const DEV_EYE_MIN: f32 = 9.6;
// Le plan proche du modele (`device_near_plane`) et l'objectif des presets (1,6 petit cote).
const DEV_NEAR: f32 = 0.16;
const DEV_NEAR_BAND: f32 = 0.1;
const DEV_LENS: f32 = 1.6;
// Le socle a la largeur de la coque ; tout le reste de ce qui depasse est fixe.
const DEV_DECK_LEN: f32 = 1.30;
// Liseré d'aluminium, rayon de la semelle, encoche du socle (cf. HLSL).
const DEV_RIM: f32 = 0.0053;
const DEV_FOOT_R: f32 = 0.0365;
const DEV_SCOOP_W: f32 = 0.14;
const DEV_SCOOP_D: f32 = 0.0372;
const DEV_SCOOP_H: f32 = 0.0112;
const DEV_DECK_THICK: f32 = 0.0446;
const DEV_DECK_THICK_FRONT: f32 = 0.0391;
const DEV_DECK_GAP: f32 = 0.0093;
const DEV_NECK_W: f32 = 0.255;
const DEV_NECK_LEN: f32 = 0.177;
const DEV_FOOT_W: f32 = 0.456;
const DEV_FOOT_H: f32 = 0.0456;
const DEV_STAND_Z: f32 = 0.0219;
const DEV_FOOT_Z: f32 = 0.195;
const DEV_SHELL_LIGHT = vec3<f32>(0.800, 0.806, 0.812);
const DEV_SHELL_LIGHT_BACK = vec3<f32>(0.600, 0.610, 0.622);
const DEV_GLASS_LIGHT = vec3<f32>(0.031, 0.034, 0.040);
const DEV_SHELL_GRAPHITE = vec3<f32>(0.255, 0.263, 0.278);
const DEV_SHELL_GRAPHITE_BACK = vec3<f32>(0.153, 0.161, 0.176);
const DEV_GLASS_GRAPHITE = vec3<f32>(0.043, 0.047, 0.055);
const DEV_SHEEN: f32 = 0.11;

fn dev_dark() -> bool {
    return layer.color.g > 0.5;
}

fn dev_shell() -> vec3<f32> {
    return select(DEV_SHELL_LIGHT, DEV_SHELL_GRAPHITE, dev_dark());
}

fn dev_shell_back() -> vec3<f32> {
    return select(DEV_SHELL_LIGHT_BACK, DEV_SHELL_GRAPHITE_BACK, dev_dark());
}

fn dev_glass() -> vec3<f32> {
    return select(DEV_GLASS_LIGHT, DEV_GLASS_GRAPHITE, dev_dark());
}

fn dev_body_c() -> vec2<f32> {
    return vec2<f32>((layer.src_prev.z - layer.src_prev.x) * 0.5, (layer.src_prev.w - layer.src_prev.y) * 0.5);
}

fn dev_body_h() -> vec2<f32> {
    return layer.mb.xy + vec2<f32>((layer.src_prev.x + layer.src_prev.z) * 0.5,
                                   (layer.src_prev.y + layer.src_prev.w) * 0.5);
}

fn dev_chamfer() -> f32 {
    return min(DEV_CHAMFER, layer.fx.w * 0.3);
}

// La hauteur du PLAN PROCHE devant l'ecran (unites), pour la camera REELLE en `eye` (repere du
// plan, unites) qui regarde le long de `axis` (cf. HLSL ; miroir de `device_near_plane`).
fn dev_near_plane(eye: vec3<f32>, axis: vec3<f32>) -> f32 {
    let dist = eye.z / max(-axis.z, 1e-3);
    return DEV_NEAR * DEV_EYE_MIN * dist / max(DEV_LENS * 2.0 * min(layer.mb.x, layer.mb.y), 1e-4);
}

// Ce qui reste d'un point `q` du modele sous le plan proche `h_near` : un fondu, jamais une coupe.
fn dev_near_fade(q: vec3<f32>, h_near: f32) -> f32 {
    return 1.0 - smoothstep(h_near * (1.0 - DEV_NEAR_BAND), h_near, q.z);
}

fn dev_deck_angle() -> f32 {
    return layer.dst_prev.x;
}

// L'appareil : 1 = portable, 2 = telephone, 3 = moniteur (`device_kind_id`).
fn dev_is(k: f32) -> bool {
    return abs(layer.color.r - k) < 0.5;
}

fn sd_dev_box(p: vec3<f32>, h: vec3<f32>, r: f32) -> f32 {
    let q = abs(p) - h + vec3<f32>(r);
    return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn sd_dev_outline(p: vec2<f32>) -> f32 {
    // Coins hauts `radius_px`, coins bas `color.b` (cf. HLSL).
    let q = p - dev_body_c();
    return sd_round_rect(q, dev_body_h(), select(layer.color.b, layer.radius_px, q.y < 0.0));
}

// Ellipsoide (borne de distance) : l'encoche du socle.
fn sd_dev_ellipsoid(p: vec3<f32>, r: vec3<f32>) -> f32 {
    let k0 = length(p / r);
    let k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

// La dalle PLEINE du corps, sans le creux de l'ecran : la silhouette qui porte l'ombre.
fn sd_dev_slab(p: vec3<f32>) -> f32 {
    let t = layer.fx.w;
    let ch = dev_chamfer();
    let w = vec2<f32>(sd_dev_outline(p.xy) + ch, abs(p.z + t * 0.5) - (t * 0.5 - ch));
    return min(max(w.x, w.y), 0.0) + length(max(w, vec2<f32>(0.0))) - ch;
}

// L'OUVERTURE (<0 dedans) : le contour du metrage (rayon `dst_prev.y`) rentre du recouvrement
// `dst_prev.z` comme un decalage -- memes centres d'arc, rayon diminue d'autant -- : la lunette
// mord le metrage de la meme largeur aux coins que le long des bords (cf. HLSL).
fn sd_dev_aperture(p: vec2<f32>) -> f32 {
    let ah = layer.mb.xy - vec2<f32>(layer.dst_prev.z);
    return sd_round_rect(p, ah, clamp(layer.dst_prev.y - layer.dst_prev.z, 0.0, min(ah.x, ah.y)));
}

fn sd_dev_body(p: vec3<f32>) -> f32 {
    let hole = max(sd_dev_aperture(p.xy), -p.z - layer.fx.w * 0.55);
    return max(sd_dev_slab(p), -hole);
}

fn dev_deck_local(p: vec3<f32>) -> vec3<f32> {
    let c = dev_body_c();
    let h = dev_body_h();
    let d = p - vec3<f32>(0.0, c.y + h.y, -layer.fx.w * 0.5);
    let ca = cos(dev_deck_angle());
    let sa = sin(dev_deck_angle());
    return vec3<f32>(d.x, d.y * ca + d.z * sa, -d.y * sa + d.z * ca);
}

fn sd_dev_deck(p: vec3<f32>) -> f32 {
    let q = dev_deck_local(p);
    let y0 = DEV_DECK_GAP;
    let y1 = y0 + DEV_DECK_LEN;
    let tb = DEV_DECK_THICK;
    let slab = sd_dev_box(q - vec3<f32>(0.0, (y0 + y1) * 0.5, -tb * 0.5),
                          vec3<f32>(dev_body_h().x, (y1 - y0) * 0.5, tb * 0.5),
                          DEV_CHAMFER * 2.0);
    // Le dessous remonte vers l'avant : le profil en coin.
    let k = (DEV_DECK_THICK - DEV_DECK_THICK_FRONT) / DEV_DECK_LEN;
    let under = (-tb + k * (q.y - y0) - q.z) * inverseSqrt(1.0 + k * k);
    // L'encoche au milieu de l'arete avant (cf. HLSL).
    let scoop = sd_dev_ellipsoid(q - vec3<f32>(0.0, y1, 0.0), vec3<f32>(DEV_SCOOP_W, DEV_SCOOP_D, DEV_SCOOP_H));
    return max(max(slab, under), -scoop);
}

// Entree ANALYTIQUE du rayon dans le coin du socle, 1e9 s'il le manque (cf. HLSL, qui fait foi).
fn dev_deck_hit(ro: vec3<f32>, rd: vec3<f32>) -> f32 {
    let q0 = dev_deck_local(ro);
    let qd = dev_deck_local(ro + rd) - q0;
    let hw = dev_body_h().x;
    let y0 = DEV_DECK_GAP;
    let len = DEV_DECK_LEN;
    let tb = DEV_DECK_THICK;
    var tt = ray_box(q0, qd, vec3<f32>(-hw, y0, -tb), vec3<f32>(hw, y0 + len, 0.0));
    let k = (DEV_DECK_THICK - DEV_DECK_THICK_FRONT) / len;
    let g0 = -tb + k * (q0.y - y0) - q0.z;
    let gd = k * qd.y - qd.z;
    if abs(gd) > 1e-9 {
        let tg = -g0 / gd;
        if gd > 0.0 {
            tt.y = min(tt.y, tg);
        } else {
            tt.x = max(tt.x, tg);
        }
    } else if g0 > 0.0 {
        return 1e9;
    }
    if tt.x > tt.y || tt.y <= 0.0 {
        return 1e9;
    }
    // Entre par l'encoche, le rayon touche la matiere a sa sortie de l'ellipsoide.
    var t_in = max(tt.x, 0.0);
    let sr = vec3<f32>(DEV_SCOOP_W, DEV_SCOOP_D, DEV_SCOOP_H);
    let o = (q0 - vec3<f32>(0.0, y0 + len, 0.0)) / sr;
    let e = qd / sr;
    let ea = dot(e, e);
    let eb = dot(o, e);
    let disc = eb * eb - ea * (dot(o, o) - 1.0);
    if disc > 0.0 {
        let s = sqrt(disc);
        if t_in >= (-eb - s) / ea && t_in < (-eb + s) / ea {
            t_in = (-eb + s) / ea;
        }
    }
    if t_in <= tt.y {
        return t_in;
    }
    return 1e9;
}

fn sd_dev_stand(p: vec3<f32>) -> f32 {
    let y0 = dev_body_c().y + dev_body_h().y;
    let zc = -layer.fx.w * 0.5;
    let neck = sd_dev_box(p - vec3<f32>(0.0, y0 + DEV_NECK_LEN * 0.5 - 0.01, zc - DEV_STAND_Z * 0.5),
                          vec3<f32>(DEV_NECK_W, DEV_NECK_LEN * 0.5 + 0.01, DEV_STAND_Z * 0.5),
                          DEV_CHAMFER * 2.0);
    // La semelle : une plaque plate, coins arrondis dans son plan (xz), flancs droits.
    let f = p - vec3<f32>(0.0, y0 + DEV_NECK_LEN + DEV_FOOT_H * 0.5, zc - DEV_FOOT_Z * 0.5);
    let fd = vec2<f32>(sd_round_rect(f.xz, vec2<f32>(DEV_FOOT_W, DEV_FOOT_Z * 0.5), DEV_FOOT_R),
                       abs(f.y) - DEV_FOOT_H * 0.5);
    let foot = min(max(fd.x, fd.y), 0.0) + length(max(fd, vec2<f32>(0.0)));
    return min(neck, foot);
}

fn sd_dev_extra(p: vec3<f32>) -> f32 {
    if dev_is(1.0) {
        return sd_dev_deck(p);
    }
    if dev_is(3.0) {
        return sd_dev_stand(p);
    }
    return 1e9;
}

fn sd_device(p: vec3<f32>) -> f32 {
    return min(sd_dev_body(p), sd_dev_extra(p));
}

// Le modele PLEIN, ecran compris : ce que l'ombre voit.
fn sd_dev_solid(p: vec3<f32>) -> f32 {
    return min(sd_dev_slab(p), sd_dev_extra(p));
}

fn device_normal(p: vec3<f32>) -> vec3<f32> {
    let e = 0.0006;
    let ka = vec3<f32>(1.0, -1.0, -1.0);
    let kb = vec3<f32>(-1.0, -1.0, 1.0);
    let kc = vec3<f32>(-1.0, 1.0, -1.0);
    let kd = vec3<f32>(1.0, 1.0, 1.0);
    return normalize(ka * sd_device(p + ka * e) + kb * sd_device(p + kb * e) +
                     kc * sd_device(p + kc * e) + kd * sd_device(p + kd * e));
}

fn dev_cov(d: f32, aa: f32) -> f32 {
    return clamp(0.5 - d / max(aa, 1e-6), 0.0, 1.0);
}

// Filet de lumiere d'un pixel, peint juste a l'interieur d'un contour `d2` (<0 dedans).
fn dev_hairline(d2: f32, aa: f32) -> f32 {
    return dev_cov(abs(d2 + aa) - aa * 0.55, aa);
}

fn device_albedo(p: vec3<f32>, n: vec3<f32>, aa: f32) -> vec4<f32> {
    let metal = dev_shell();
    let back = dev_shell_back();
    if sd_dev_body(p) > sd_dev_extra(p) {
        if !dev_is(1.0) {
            // Le pied du moniteur : de l'aluminium, un degrade vertical doux.
            let v = clamp((p.y - dev_body_c().y - dev_body_h().y) / (DEV_NECK_LEN + DEV_FOOT_H), 0.0, 1.0);
            return vec4<f32>(mix(metal, back, 0.15 + 0.45 * v), 1.0);
        }
        let q = dev_deck_local(p);
        let hw = dev_body_h().x;
        let y0 = DEV_DECK_GAP;
        let len = DEV_DECK_LEN;
        // La tranche AVANT : une barre d'argent qui fonce doucement vers son arete basse.
        if q.y > y0 + len - DEV_CHAMFER * 3.0 {
            let s = clamp(-q.z / DEV_DECK_THICK_FRONT, 0.0, 1.0);
            return vec4<f32>(mix(metal, back, smoothstep(0.35, 1.0, s) * 0.8), 1.0);
        }
        if q.z < -DEV_DECK_THICK * 0.25 {
            return vec4<f32>(back, 1.0);
        }
        var top = metal;
        let key = sd_round_rect(q.xy - vec2<f32>(0.0, y0 + len * 0.33),
                                vec2<f32>(hw * 0.75, len * 0.23), len * 0.02);
        top = mix(top, metal * 0.52, dev_cov(key, aa));
        top = mix(top, metal * 1.06, dev_hairline(key, aa));
        let pad = sd_round_rect(q.xy - vec2<f32>(0.0, y0 + len * 0.76),
                                vec2<f32>(hw * 0.26, len * 0.14), len * 0.015);
        top = mix(top, metal * 0.88, dev_cov(pad, aa));
        top = mix(top, metal * 1.04, dev_hairline(pad, aa));
        return vec4<f32>(top, 1.0);
    }
    let shell = mix(back, metal, clamp(n.z * 0.8 + 0.5, 0.0, 1.0));
    // Le quart avant du corps seulement (cf. HLSL) : la colonne du moniteur n'est pas du verre.
    let front = select(smoothstep(0.30, 0.80, n.z), 0.0, p.z < -layer.fx.w * 0.25);
    if front <= 0.0 {
        return vec4<f32>(shell, 1.0);
    }
    // Le lisere d'aluminium qui borde la face avant, et le filet de lumiere sur son arete.
    let edge = sd_dev_outline(p.xy);
    let band = 1.0 - dev_cov(edge + DEV_RIM, aa);
    let rim = dev_hairline(edge, aa);
    var c = dev_glass();
    if dev_is(2.0) {
        // Telephone : un oeil de camera, rien d'autre, au milieu de la lunette du HAUT DU
        // TELEPHONE. Une ouverture paysage est un telephone COUCHE, son haut vers la gauche. Sa
        // taille est fixe, comme l'epaisseur du corps.
        let upright = layer.mb.y >= layer.mb.x;
        let e = select(vec2<f32>(-p.y, p.x), p.xy, upright);
        let hh = select(vec2<f32>(layer.mb.y, layer.mb.x), layer.mb.xy, upright);
        let bez = select(layer.src_prev.x, layer.src_prev.y, upright) - DEV_RIM;
        c = mix(c, vec3<f32>(0.086, 0.102, 0.133), dev_cov(length(e - vec2<f32>(0.0, -hh.y - bez * 0.5)) - 0.003, aa));
    } else {
        // Portable et moniteur : un oeil de camera centre dans la lunette du haut, pas d'encoche.
        let bez = layer.src_prev.y - DEV_RIM;
        c = mix(c, vec3<f32>(0.120, 0.133, 0.161), dev_cov(length(p.xy - vec2<f32>(0.0, -layer.mb.y - bez * 0.5)) - 0.2 * bez, aa));
    }
    c = mix(c, metal, band);
    c = mix(c, min(metal * 1.12, vec3<f32>(1.0)), rim);
    return vec4<f32>(mix(shell, c, front), max(band, rim));
}

// L'OMBRE portee de l'appareil (`dst_prev.w` = penombre en px) : la silhouette reelle du modele,
// socle et pied compris. Cf. `device_shadow` (HLSL), qui fait foi. Ce que le plan proche `h_near`
// efface de l'appareil, il l'efface de son ombre.
fn device_shadow(ro: vec3<f32>, rd: vec3<f32>, fpk: f32, lo: vec3<f32>, hi: vec3<f32>, h_near: f32) -> vec4<f32> {
    let spread = layer.dst_prev.w;
    let m = vec3<f32>(2.0 * spread / layer.src.w);
    let tb = ray_box(ro, rd, lo - m, hi + m);
    if tb.x >= tb.y || tb.y <= 0.0 {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    // Dans la silhouette pleine, a coup sur : le rayon perce la face avant ou le socle.
    if rd.z < -1e-5 && sd_dev_outline((ro + rd * (-ro.z / rd.z)).xy) < 0.0 {
        return vec4<f32>(0.0, 0.0, 0.0, layer.color.a);
    }
    var t_deck = 1e9;
    if dev_is(1.0) {
        t_deck = dev_deck_hit(ro, rd);
    }
    if t_deck < 1e9 {
        return vec4<f32>(0.0, 0.0, 0.0, layer.color.a * dev_near_fade(ro + rd * t_deck, h_near));
    }
    var t = max(tb.x, 0.0);
    var best = 1e9;
    var t_best = t;
    for (var k = 0; k < 96; k = k + 1) {
        let d = sd_dev_solid(ro + rd * t);
        let fp = t * fpk;
        if max(d, 0.0) / fp < best {
            best = max(d, 0.0) / fp;
            t_best = t;
        }
        if d < 0.08 * fp || t > tb.y {
            break;
        }
        t = t + max(d, fp);
    }
    let a = layer.color.a * (1.0 - smoothstep(0.0, spread, best)) * dev_near_fade(ro + rd * t_best, h_near);
    return vec4<f32>(0.0, 0.0, 0.0, a); // noir premultiplie
}

fn device_frame(local: vec2<f32>) -> vec4<f32> {
    var f: ModelFrame;
    f.c = cos(layer.fx.xyz);
    f.s = sin(layer.fx.xyz);
    f.cp = 1.0;
    f.sp = 0.0;
    f.cy = 1.0;
    f.sy = 0.0;
    let persp = layer.src.z;
    let unit = layer.src.w;

    let dw = vec3<f32>(local + layer.src.xy, -persp);
    let dlen = length(dw);
    let ro0 = world_to_plane(vec3<f32>(-layer.mb.z, -layer.mb.w, persp), f) / unit;
    let rd0 = world_to_plane(dw / dlen, f);
    let l = world_to_plane(MODEL_LIGHT, f);

    // Le plan proche (`DeviceView::near_plane`) : tire de la camera REELLE, avant qu'on la recule.
    let h_near = dev_near_plane(ro0, world_to_plane(vec3<f32>(0.0, 0.0, -1.0), f));

    // L'OEIL DU MODELE (`DeviceView::model_eye`, cf. HLSL) : recule sur sa droite a au moins
    // `DEV_EYE_MIN`, et jamais plus bas que la ligne du centre de l'ecran -- d'en dessous, le socle
    // montrait sa face inferieure et couvrait le bas du metrage. Chaque rayon passe par le MEME
    // point du plan.
    var ro = ro0;
    var rd = rd0;
    var fpk = 1.0 / dlen;
    if rd.z < -1e-5 {
        let ts = -ro.z / rd.z;
        let e0 = vec3<f32>(ro.x, min(ro.y, 0.0), ro.z);
        let eye = e0 * max(1.0, DEV_EYE_MIN / max(length(e0), 1e-3));
        let v = ro + rd * ts - eye;
        let lv = length(v);
        fpk = ts / dlen / lv;
        ro = eye;
        rd = v / lv;
    }

    // La boite du modele, miroir de `DeviceView::model_points`.
    let bc = dev_body_c();
    let bh = dev_body_h();
    var lo = vec3<f32>(bc - bh, -layer.fx.w);
    var hi = vec3<f32>(bc + bh, 0.0);
    if dev_is(1.0) {
        // Les quatre coins du profil du socle, de la charniere au bord avant, dessus et dessous.
        let ca = cos(dev_deck_angle());
        let sa = sin(dev_deck_angle());
        let hinge = vec2<f32>(bc.y + bh.y, -layer.fx.w * 0.5);
        let qy = vec2<f32>(DEV_DECK_GAP, DEV_DECK_GAP + DEV_DECK_LEN);
        let qz = vec2<f32>(0.0, -DEV_DECK_THICK);
        for (var j = 0; j < 4; j = j + 1) {
            let a = qy[j & 1];
            let b = qz[j >> 1u];
            let yz = hinge + vec2<f32>(a * ca - b * sa, a * sa + b * ca);
            lo = vec3<f32>(lo.x, min(lo.yz, yz));
            hi = vec3<f32>(hi.x, max(hi.yz, yz));
        }
    } else if dev_is(3.0) {
        lo = vec3<f32>(min(lo.x, -DEV_FOOT_W), lo.y, lo.z - DEV_FOOT_Z);
        hi = vec3<f32>(max(hi.x, DEV_FOOT_W), hi.y + DEV_NECK_LEN + DEV_FOOT_H, hi.z);
    }

    if layer.dst_prev.w > 0.0 {
        return device_shadow(ro, rd, fpk, lo, hi, h_near);
    }

    // Le plan du metrage occulte tout ce qui est derriere lui DANS l'ouverture ARRONDIE : entre
    // l'arc et le coin carre, c'est de la lunette.
    // Hors de l'ouverture, le meme point du plan dit si le rayon perce la FACE AVANT ; le socle a
    // son entree analytique. La marche ne sert qu'a ce qui les precede et a l'antialiasing.
    var t_max = 1e9;
    var t_solid = 1e9;
    if rd.z < -1e-5 {
        let ts = -ro.z / rd.z;
        let qp = ro.xy + rd.xy * ts;
        if ts > 0.0 && sd_dev_aperture(qp) < 0.0 {
            t_max = ts;
        } else if ts > 0.0 && sd_dev_outline(qp) < 0.0 {
            t_solid = ts;
        }
    }
    if dev_is(1.0) {
        t_solid = min(t_solid, dev_deck_hit(ro, rd));
    }
    let solid = t_solid < t_max;

    let tb = ray_box(ro, rd, lo - vec3<f32>(0.01), hi + vec3<f32>(0.01));
    let t1 = min(min(tb.y, t_max), t_solid);
    if !solid && (tb.x >= t1 || t1 <= 0.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    var t = max(tb.x, 0.0);
    var best = 1e9;
    var t_best = t;
    var hit = false;
    for (var k = 0; k < 80; k = k + 1) {
        let d = sd_device(ro + rd * t);
        let fp = t * fpk;
        if d < 0.08 * fp {
            hit = true;
            t_best = t;
            break;
        }
        if d / fp < best {
            best = d / fp;
            t_best = t;
        }
        t = t + max(d, 0.25 * fp);
        if t > t1 {
            break;
        }
    }
    if !hit && solid {
        hit = true;
        t_best = t_solid;
    }
    let cov = select(clamp(1.0 - best, 0.0, 1.0), 1.0, hit);
    if cov <= 0.0 {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    let q = ro + rd * t_best;
    let n = device_normal(q);
    let mat = device_albedo(q, n, t_best * fpk);
    let diffuse = clamp(dot(n, l), 0.0, 1.0);
    // Aucun lobe speculaire large : rien qu'un voile directionnel etroit sur le metal.
    let sheen = DEV_SHEEN * mat.a * pow(diffuse, 4.0);
    let rgb = mat.rgb * (MODEL_AMBIENT + MODEL_DIFFUSE * diffuse) + vec3<f32>(sheen);
    // Au-dela du plan proche, l'appareil s'efface (le socle, quand la camera en orbite avance).
    let a = cov * layer.color.a * dev_near_fade(q, h_near);
    return vec4<f32>(rgb * a, a); // premultiplie
}

@fragment
fn fs_main(i: VsOut) -> @location(0) vec4<f32> {
    var rgb: vec3<f32>;
    var alpha: f32;
    // 1 sauf en detourage, ou il porte le masque du sujet. Cf. la branche fx.z plus bas.
    var alpha_mask = 1.0;

    if layer.mode < 0.5 {
        // Mode 0 — vidéo NV12 + flou de mouvement par vélocité (§8), port 1:1 du
        // HLSL/MSL. Pour CE pixel de sortie, l'UV qu'il occupait à la frame
        // précédente se retrouve en le remappant par (dst_prev, src_prev) : on
        // floute le long de ce segment, ce qui capture la translation ET le zoom
        // du calque sans avoir à transporter un champ de vitesse.
        let taps = i32(layer.mb.x);
        let mb_scale = clamp(layer.mb.y, 0.0, 1.0);
        // `taps` d'abord : un draw qui a oublié `dst_prev` le laisse à zéro, et
        // la division par `dst_prev.zw` produirait des UV infinis. Dégrader vers
        // le chemin net est le seul échec acceptable pour un effet cosmétique.
        if taps <= 1 || mb_scale <= 0.001 || layer.dst_prev.z <= 0.0 || layer.dst_prev.w <= 0.0 {
            rgb = sample_yuv(i.uv);
        } else {
            let localp = (i.pout - layer.dst_prev.xy) / layer.dst_prev.zw;
            let uv_prev = layer.src_prev.xy + localp * (layer.src_prev.zw - layer.src_prev.xy);
            let duv = i.uv - uv_prev;
            let duv_blur = duv * mb_scale;
            if dot(duv_blur, duv_blur) < 1e-9 {
                rgb = sample_yuv(i.uv);
            } else {
                // Borne 16 en dur, identique au HLSL et au MSL : `taps` vient d'un
                // uniform et une boucle sans borne statique ne se déroule pas.
                // L'échelle de l'inspector s'arrête pile à 16 (1 + 15·blur), donc
                // c'est `taps` qui coupe, jamais la borne.
                var acc = vec3<f32>(0.0);
                let step = 1.0 / f32(taps - 1);
                for (var k: i32 = 0; k < 16; k = k + 1) {
                    if k >= taps { break; }
                    acc = acc + sample_yuv(i.uv - duv_blur * (1.0 - f32(k) * step));
                }
                rgb = acc / f32(taps);
            }
        }

        // Effet d'arriere-plan webcam. Miroir exact des branches HLSL et MSL : fx.z porte le
        // mode (1 = detourage, 2 = flou, 3 = fond plat), fx.w l'intensite du flou, fx.xy
        // l'etendue valide de la texture webcam pour ramener uv dans l'espace du masque.
        let effect = layer.fx.z;
        if effect > 0.5 {
            let mask_uv = i.uv / max(layer.fx.xy, vec2<f32>(1e-6));
            let person = clamp(textureSample(texMask, samp, mask_uv).r, 0.0, 1.0);
            if effect > 2.5 {
                rgb = mix(layer.color.rgb, rgb, person);
            } else if effect > 1.5 {
                rgb = mix(blur_webcam_bg(i.uv, layer.fx.w, layer.quad_px, i.local), rgb, person);
            } else {
                alpha_mask = person;
            }
        }
    } else if layer.mode < 1.5 {
        // Mode 1 — couleur pleine.
        rgb = layer.color.rgb;
    } else if layer.mode > 4.5 && layer.mode < 5.5 {
        // Mode 5 -- gradient lineaire : color (c0) -> src.rgb (c1) le long de
        // la direction fx.xy (sin, -cos de l'angle). Parite avec le HLSL/MSL.
        // `denom` : HLSL et MSL normalisent coin-a-coin (|dx|+|dy|) pour couvrir toute la
        // diagonale. Il manquait ici, donc le meme degrade ne rendait pas pareil sur Linux.
        // Fond anime : fx.z = temps programme (s, replie sur 120), fx.w = mouvement (0 immobile,
        // 1 derive, 2 aurore, 3 vagues), mb.x = aspect w/h. 0 rend le degrade d'avant a l'octet.
        var dir = layer.fx.xy;
        if layer.fx.w > 0.5 && layer.fx.w < 1.5 {
            // Derive : l'axe respire de +-15 deg (0.2617994 rad) en 20 s.
            let da = 0.2617994 * sin(6.2831853 * layer.fx.z / 20.0);
            let sa = sin(da);
            let ca = cos(da);
            dir = vec2<f32>(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
        }
        let denom = max(abs(dir.x) + abs(dir.y), 1e-4);
        // Parametre sur le QUAD des qu'il en a un (la bulle webcam), sinon sur la sortie. Pour
        // le fond plein cadre les deux coincident ; pour une bulle dans un coin, `pout` ne
        // montrerait que la tranche du degrade plein cadre qui passe dessous.
        var gp = i.pout;
        if layer.quad_px.x > 0.0 && layer.quad_px.y > 0.0 {
            gp = i.local / layer.quad_px;
        }
        let t = clamp(0.5 + dot(gp - vec2<f32>(0.5), dir) / denom, 0.0, 1.0);
        rgb = mix(layer.color.rgb, layer.src.rgb, t);
        if layer.fx.w > 1.5 {
            rgb = gradient_motion(gp, dir, denom, layer.color.rgb, layer.src.rgb, layer.fx.z,
                                  layer.fx.w, layer.mb.x);
        }
    } else if layer.mode > 10.5 && layer.mode < 11.5 {
        // Mode 11 : texte. texY est l'atlas R8 (couverture alpha au canal .r,
        // produit par text_cosmic::TextRasterizer), teinte par layer.color.
        // Sortie en alpha premultiplie, comme les autres modes.
        let cov = textureSample(texY, samp, i.uv).r;
        let a = layer.color.a * cov;
        return vec4<f32>(layer.color.rgb * a, a);
    } else if layer.mode > 8.5 && layer.mode < 9.5 {
        // Mode 9 -- annotation « figure » : une fleche. Parite EXACTE avec
        // `ArrowSvgs.tsx`, dont chaque direction est un trace de trois segments a
        // bouts ronds dans un viewBox 0..100 : une hampe et deux barbes. Trois
        // `sd_segment` et un `min` reproduisent la forme telle quelle, pas une
        // approximation. Les extremites arrivent deja converties en px locaux du
        // quad par `regions::arrow_local_geometry` (echelle uniforme centree,
        // comme le `preserveAspectRatio` par defaut du SVG), donc ce shader n'a
        // aucune geometrie a deviner.
        //
        // fx = hampe (a.xy, b.xy), src_prev = barbe 1, dst_prev = barbe 2 ;
        // mb.y = demi-epaisseur en px.
        var d = sd_segment(i.local, layer.fx.xy, layer.fx.zw);
        d = min(d, sd_segment(i.local, layer.src_prev.xy, layer.src_prev.zw));
        d = min(d, sd_segment(i.local, layer.dst_prev.xy, layer.dst_prev.zw));
        // Couverture sur ~1 px : le trait reste net sans crenelage, et une fleche
        // fine ne disparait pas quand la demi-epaisseur descend sous le pixel.
        let a = clamp(layer.mb.y - d + 0.5, 0.0, 1.0) * layer.color.a;
        return vec4<f32>(layer.color.rgb * a, a);
    } else if layer.mode > 9.5 && layer.mode < 10.5 {
        // Mode 10 -- annotation « flou » : masque la zone en reutilisant l'image
        // DEJA composee, qui arrive sur texY (recopie mipmappee du render target
        // -- on ne peut pas echantillonner la cible sur laquelle on dessine).
        // `i.pout` donne directement l'UV de sortie, donc aucun mapping a refaire.
        //
        // fx.x = 0 mosaique / 1 flou ; fx.y = taille de bloc px (mosaique) ou
        // rayon px (flou) ; fx.z = 0 rectangle / 1 ovale ; fx.w = 1 si teinte ;
        // mb.z = 1 si le masque est un quad incline (coins TL, TR dans dst_prev,
        // BR, BL dans src_prev) ; mb.w = 1 si son warp est projectif.
        var n = i.local / max(layer.quad_px, vec2<f32>(1e-6));
        // Ecran incline : le masque est warpe comme le contenu qu'il cache
        // (`FrameGeometry::privacy_mask`), par le meme inverse que le mode 8.
        // Bord net, marge de 2 % comprise : un fondu rendrait le masque en
        // partie transparent SUR la zone a cacher.
        if layer.mb.z > 0.5 {
            let wq = quad_inverse(i.local, layer.dst_prev.xy, layer.dst_prev.zw,
                                  layer.src_prev.xy, layer.src_prev.zw, layer.mb.w);
            if wq.z < 0.5 {
                return vec4<f32>(0.0, 0.0, 0.0, 0.0);
            }
            n = wq.xy;
        }
        var cov = 1.0;
        if layer.fx.z > 0.5 {
            // Ovale inscrit : distance au centre en unites de demi-axes, adoucie
            // sur ~1px. Le fondu tombe HORS de l'ellipse : dedans, le masque
            // reste plein.
            let dc = (n - vec2<f32>(0.5)) * 2.0;
            let r = length(dc);
            let aa = 2.0 / max(min(layer.quad_px.x, layer.quad_px.y), 1.0);
            cov = 1.0 - smoothstep(1.0, 1.0 + aa, r);
        }
        if cov <= 0.0 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        var masked: vec3<f32>;
        if layer.fx.x > 0.5 {
            // Flou : on echantillonne un niveau de mip de l'image composee.
            // `log2(rayon)` donne le niveau dont un texel couvre a peu pres le
            // rayon demande, et le filtrage trilineaire lisse la transition entre
            // deux niveaux quand le rayon varie.
            //
            // Un noyau de quelques taps espaces du rayon ne floute PAS : il
            // superpose autant de copies decalees, ce qui se voit comme du texte
            // fantome. Atteindre un vrai lissage par taps demanderait un tap par
            // pixel de rayon ; la pyramide de mips donne le meme resultat a cout
            // constant, et c'est le GPU qui l'a construite.
            let lod = log2(max(layer.fx.y, 1.0));
            masked = textureSampleLevel(texY, samp, i.pout, lod).rgb;
        } else {
            // Mosaique : on quantifie l'UV sur une grille de `fx.y` px, alignee
            // sur le quad pour que les blocs ne rampent pas quand l'annotation
            // bouge.
            let px_uv = layer.dst.zw / max(layer.quad_px, vec2<f32>(1e-6));
            let block = max(layer.fx.y, 1.0) * px_uv;
            let origin = layer.dst.xy;
            let q = origin + (floor((i.pout - origin) / block) + vec2<f32>(0.5)) * block;
            // Niveau 0 explicite : l'UV quantifie est une marche d'escalier, donc
            // ses derivees explosent en bord de bloc et le choix automatique de
            // mip ramollirait justement les aretes qui font la mosaique.
            masked = textureSampleLevel(texY, samp, q, 0.0).rgb;
        }
        if layer.fx.w > 0.5 {
            // Teinte blanc/noir : la couleur choisie, melee a moitie, garde la
            // forme lisible sans effacer completement ce qu'il y a dessous.
            masked = mix(masked, layer.color.rgb, 0.5);
        }
        let a = cov * layer.color.a;
        return vec4<f32>(masked * a, a);
    } else if layer.mode > 6.5 && layer.mode < 7.5 {
        // Mode 7 -- sprite curseur (PNG RGBA, alpha droite) echantillonne sur
        // texY (comme le mode 11 y lie son atlas). `fx` = rect de clip "Clip to
        // canvas" [x,y,w,h] en sortie 0..1 (= s_dst si actif, sinon un rect
        // englobant : sans effet). Sortie en alpha premultiplie.
        if i.pout.x < layer.fx.x || i.pout.x > layer.fx.x + layer.fx.z
            || i.pout.y < layer.fx.y || i.pout.y > layer.fx.y + layer.fx.w {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        let s = textureSample(texY, samp, i.uv);
        let ca = s.a * layer.color.a;
        return vec4<f32>(s.rgb * ca, ca);
    } else if layer.mode > 5.5 && layer.mode < 6.5 {
        // Mode 6 -- fond image (wallpaper RGBA) cover-fit, echantillonne sur
        // texY. `src` porte le rect UV cover-fit (calcule cote Rust). Opaque :
        // le fond couvre tout le cadre.
        let bg_a = quad_round_alpha(i.local, layer.quad_px, layer.radius_px);
        return vec4<f32>(textureSample(texY, samp, i.uv).rgb * bg_a, bg_a); // premultiplie
    } else if layer.mode > 7.5 && layer.mode < 8.5 {
        // Mode 8 -- ecran tilte (rotation 3D des zoom regions). Le quad projete est
        // dessine dans sa BBOX (le VS ne sait tracer qu'un rect) et chaque fragment
        // remonte au (s,t) du plan par warp inverse : bilineaire sous un angle fixe, projectif exact
        // sous la camera reelle (dst_prev.w = 1), qui eclaire aussi le plan (color.xy).
        //
        // PAS de test de clip sur `dst_prev` : en mode 8 `dst_prev.xy` porte
        // `plane_px`, la taille du plan en PIXELS (~1600), la ou `i.pout` vit dans
        // [0,1]. Un clip la-dessus serait vrai partout et n'afficherait rien.
        let r = quad_inverse(
            i.local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.dst_prev.w,
        );
        if r.z < 0.5 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0); // hors du quad projete
        }
        // La coupe source s'applique ICI : `r` est une position DANS le plan (0..1),
        // pas une coordonnee de texture. Echantillonner `r` directement ignorerait le
        // crop utilisateur et le zoom.
        let uv = vec2<f32>(
            mix(layer.src.x, layer.src.z, clamp(r.x, 0.0, 1.0)),
            mix(layer.src.y, layer.src.w, clamp(r.y, 0.0, 1.0)),
        );
        // Coins arrondis DANS LE REPERE DU PLAN : le rayon reste constant le long du
        // bord, la ou un arrondi calcule dans la bbox s'etirerait avec la perspective.
        // Inconditionnel, rayon 0 compris -- `sd_round_rect` degenere en SDF de
        // rectangle et le feather de 1,5 px subsiste, ce qui fait lire une arete
        // inclinee COMME une arete plutot que comme un escalier.
        // dst_prev.z = 1 : ecran sous le chrome de fenetre, coins HAUTS carres et rognes par
        // l'arc du cadre (`sd_screen_under_bar`, `color.z` = la remontee, px du plan).
        let plane_px = layer.dst_prev.xy;
        let p = vec2<f32>(r.x, r.y) * plane_px - plane_px * 0.5;
        let rad = max(layer.radius_px, 0.0);
        let d = select(sd_round_rect(p, plane_px * 0.5, rad),
                       sd_screen_under_bar(p, plane_px * 0.5, rad, layer.color.z),
                       layer.dst_prev.z > 0.5);
        let tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        // Profondeur de champ (cf. HLSL) : net sous un demi-texel de flou, l'echantillon
        // d'avant a l'octet ; au-dela, fondu vers la pyramide demi-resolution liee en binding 4
        // (a la place du masque webcam, que ce mode ne lit pas), au niveau `log2(coc) - 1`,
        // plafonne. LOD explicite : pas de derivees dans cette branche.
        var tilt_rgb = sample_yuv(uv);
        let rs = clamp(vec2<f32>(r.x, r.y), vec2<f32>(0.0), vec2<f32>(1.0));
        let z = (rs.x - 0.5) * layer.mb.x + (rs.y - 0.5) * layer.mb.y;
        let coc = layer.mb.w * abs(z - layer.mb.z);
        if coc > 0.5 {
            let lod = clamp(log2(coc) - 1.0, 0.0, DOF_MAX_LOD);
            let far_rgb = textureSampleLevel(texMask, samp, uv, lod).rgb;
            tilt_rgb = mix(tilt_rgb, far_rgb, clamp((coc - 0.5) / 1.5, 0.0, 1.0));
        }
        if layer.dst_prev.w > 0.5 {
            // La lampe de la camera reelle : le cote proche un peu plus clair.
            let shade = 1.0 + layer.color.x * (rs.x - 0.5) + layer.color.y * (rs.y - 0.5);
            tilt_rgb = clamp(tilt_rgb * shade, vec3<f32>(0.0), vec3<f32>(1.0));
        }
        // L'alpha est cette couverture, pas `color.a` : les draws du mode 8 laissent
        // `color` a zero, donc s'en servir rendrait un plan totalement transparent.
        return vec4<f32>(tilt_rgb * tilt_a, tilt_a);
    } else if layer.mode > 11.5 && layer.mode < 12.5 {
        // Mode 12 -- ombre du quad projete. La penombre suit le QUADRILATERE, pas son
        // rect englobant : un rect droit derriere un ecran incline se lit comme une
        // seconde surface, pas comme son ombre.
        //
        // `fx`/`src_prev` portent les COINS (en px locaux a la bbox, comme `i.local`),
        // et le spread vit dans `mb.y` -- pas dans `fx.x` comme au mode 2.
        let tl = layer.fx.xy;
        let tr = layer.fx.zw;
        let br = layer.src_prev.xy;
        let bl = layer.src_prev.zw;
        // Coins arrondis du meme rayon que le plan : une ombre a coins vifs derriere un
        // ecran arrondi depasse en pointe a chaque coin, d'autant plus que le rayon monte.
        let r = max(layer.radius_px, 0.0);
        let v0 = inset_corner(bl, tl, tr, r);
        let v1 = inset_corner(tl, tr, br, r);
        let v2 = inset_corner(tr, br, bl, r);
        let v3 = inset_corner(br, bl, tl, r);
        let d = sd_convex_quad(i.local, v0, v1, v2, v3) - r;
        let spread = max(layer.mb.y, 1e-3);
        let a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return vec4<f32>(layer.color.rgb * a, a);
    } else if layer.mode > 12.5 && layer.mode < 13.5 {
        // Mode 13 -- sprite de curseur POSE sur l'ecran incline : ses quatre coins
        // ont traverse la meme projection que la video, et le fragment remonte a sa
        // position dans le sprite par le meme warp inverse que le mode 8.
        //
        // Le rect de clip « Clip to canvas » est ici dans `dst_prev` (en sortie
        // 0..1, [x,y,w,h]) et NON dans `fx` comme au mode 7 : `fx` porte les coins.
        if i.pout.x < layer.dst_prev.x || i.pout.x > layer.dst_prev.x + layer.dst_prev.z
            || i.pout.y < layer.dst_prev.y || i.pout.y > layer.dst_prev.y + layer.dst_prev.w {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        // mb.x = 1 : warp projectif (camera reelle).
        let r = quad_inverse(
            i.local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.mb.x,
        );
        if r.z < 0.5 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        // Sprite RGBA a alpha DROITE sur texY (comme le mode 7 y lie le sien) :
        // on premultiplie ici.
        let s = textureSample(texY, samp, clamp(vec2<f32>(r.x, r.y), vec2<f32>(0.0), vec2<f32>(1.0)));
        let ca = s.a * layer.color.a;
        return vec4<f32>(s.rgb * ca, ca);
    } else if layer.mode > 13.5 && layer.mode < 14.5 {
        // Mode 14 -- CADRE DE FENETRE autour de l'ecran (barre de titre, trois pastilles,
        // filet), dessine SOUS lui. Meme warp que le mode 8 : le cadre est le quad de l'ecran
        // prolonge, il penche donc avec lui ; a plat le quad est un rect et le warp l'identite.
        // src.x = 1 : warp projectif (camera reelle).
        let r = quad_inverse(
            i.local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.src.x,
        );
        if r.z < 0.5 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0); // hors du cadre projete
        }
        let plane_px = layer.dst_prev.xy;
        let bar = layer.dst_prev.z;
        let line_w = layer.dst_prev.w;
        let q = vec2<f32>(r.x, r.y) * plane_px; // px du plan depuis le coin haut-gauche
        let p = q - plane_px * 0.5;
        // Le MEME rayon aux quatre coins : le metrage est arrondi partout, donc le cadre aussi
        // (cf. le commentaire du HLSL, et `plan_frame` section « Le rayon des coins »).
        let rad = max(layer.radius_px, 0.0);
        let d = sd_round_rect(p, plane_px * 0.5, rad);
        let cov = 1.0 - smoothstep(0.0, 1.5, d);
        // Filet interieur le long du contour, et separation entre la barre et le contenu.
        let stroke = max(band_cov(-d - line_w * 0.5, line_w * 0.5),
                         band_cov(q.y - (bar - line_w * 0.5), line_w * 0.5));
        var frame_rgb = mix(layer.color.rgb, layer.mb.rgb, stroke * layer.mb.a);
        // Pastilles : proportions d'une barre de 28 px (rayon 6, pas de 20). Deroulees a la
        // main, comme `sd_convex_quad` : pas de tableau local indexe.
        // Leur bloc est repousse du coin d'au moins le rayon PLUS leur propre rayon et une marge :
        // sans ca, l'arrondi mordait la premiere des que Roundness montait.
        let dr = bar * 0.214;
        let dx = bar * 0.714;
        let x0 = max(dx, rad + dr + bar * 0.18);
        frame_rgb = mix(frame_rgb, vec3<f32>(1.000, 0.373, 0.341), disc_cov(q, vec2<f32>(x0, bar * 0.5), dr));
        frame_rgb = mix(frame_rgb, vec3<f32>(0.996, 0.737, 0.180), disc_cov(q, vec2<f32>(x0 + dx, bar * 0.5), dr));
        frame_rgb = mix(frame_rgb, vec3<f32>(0.157, 0.784, 0.251), disc_cov(q, vec2<f32>(x0 + 2.0 * dx, bar * 0.5), dr));
        let fa = cov * layer.color.a;
        return vec4<f32>(frame_rgb * fa, fa); // premultiplie
    } else if layer.mode > 14.5 && layer.mode < 15.5 {
        // Mode 15 -- curseur modelise (`cursor_model`). Clip « Clip to canvas » dans
        // `dst_prev`, comme au mode 13.
        if i.pout.x < layer.dst_prev.x || i.pout.x > layer.dst_prev.x + layer.dst_prev.z
            || i.pout.y < layer.dst_prev.y || i.pout.y > layer.dst_prev.y + layer.dst_prev.w {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        return cursor_model(i.local);
    } else if layer.mode > 15.5 && layer.mode < 16.5 {
        // Mode 16 -- impact du clic sous le curseur modelise (`cursor_impact`).
        return cursor_impact(i.local);
    } else if layer.mode > 16.5 && layer.mode < 17.5 {
        // Mode 17 -- cadre d'appareil modelise (`device_frame`).
        return device_frame(i.local);
    } else {
        // Mode 2 — ombre portée (SDF d'un quad arrondi élargi de `fx.x`).
        let spread = layer.fx.x;
        let halfsz = layer.quad_px * 0.5 - vec2<f32>(spread);
        let p = i.local - layer.quad_px * 0.5;
        let d = sd_round_rect(p, halfsz, layer.radius_px);
        let a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return vec4<f32>(layer.color.rgb * a, a);
    }

    alpha = layer.color.a * alpha_mask;

    if layer.radius_px > 0.0 {
        // Feather ~1.5 px sur le bord du quad — parité exacte avec le HLSL
        // (`smoothstep(0.0, 1.5, d)`). Le shader HLSL inclut `quad_px` en px de
        // SORTIE ; on reproduit la même chose ici.
        // mb.w = 1 : ecran sous le chrome de fenetre, coins HAUTS carres et rognes par l'arc du
        // cadre (`sd_screen_under_bar`, `mb.z` = la remontee du contour interieur, px).
        let halfsz = layer.quad_px * 0.5;
        let p = i.local - layer.quad_px * 0.5;
        let d = select(sd_round_rect(p, halfsz, layer.radius_px),
                       sd_screen_under_bar(p, halfsz, layer.radius_px, layer.mb.z),
                       layer.mb.w > 0.5);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d);
    }

    return vec4<f32>(rgb * alpha, alpha); // alpha prémultiplié
}
