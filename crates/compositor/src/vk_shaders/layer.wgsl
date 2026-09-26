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
    trail_a: vec4<f32>,   // mode 8 : coins TL, TR du plan a la frame precedente (px locaux, comme fx)
    trail_b: vec4<f32>,   // mode 8 : coins BR, BL du plan a la frame precedente (comme src_prev)
    trail_mb: vec4<f32>,  // mode 8 : x = taps, y = force du flou de mouvement (ceux du mode 0) ; 0 ailleurs
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

// `sample_yuv` à LOD explicite : utilisable hors du flot uniforme (mode 18).
fn sample_yuv_level(uv: vec2<f32>) -> vec3<f32> {
    let y = textureSampleLevel(texY, samp, uv, 0.0).r;
    let cbcr = vec2<f32>(
        textureSampleLevel(texU, samp, uv, 0.0).r,
        textureSampleLevel(texV, samp, uv, 0.0).r,
    );
    return yuv709_limited(y, cbcr);
}

// Mode 18 -- l'ecran CADRE (ombre, cadre, metrage, appareil) floute comme UN objet rigide
// (`FrameGeometry::screen_trail`), port 1:1 du HLSL. Binding 4 = son rendu isole, premultiplie,
// a la taille de la sortie ; sa boite va de `dst_prev` (frame precedente) a `fx` (courante).
// Chaque tap relit, dans le rendu courant, le point de l'objet qui couvrait ce pixel plus tot sur
// la trajectoire. Hors de la sortie rien n'a ete rendu : dans l'ouverture arrondie de l'ecran
// (`quad_px`, `radius_px`, 2 px en retrait) on relit le metrage (`src` = la coupe), ailleurs le
// tap est ecarte.
fn screen_trail(pout: vec2<f32>) -> vec4<f32> {
    let taps = i32(layer.mb.x);
    var acc = vec4<f32>(0.0);
    var n = 0.0;
    for (var k: i32 = 0; k < 16; k = k + 1) {
        if k >= taps { break; }
        let a = clamp(layer.mb.y, 0.0, 1.0) * (1.0 - f32(k) / f32(taps - 1));
        let r = mix(layer.fx, layer.dst_prev, a);
        let f = (pout - r.xy) / r.zw;
        let q = layer.fx.xy + f * layer.fx.zw;
        let rendered = all(q >= vec2<f32>(0.0)) && all(q <= vec2<f32>(1.0));
        // Un `if`, pas un `select` : `select` evalue ses deux branches, soit trois lectures du
        // metrage et une SDF par tap pour rien. Parite HLSL / MSL.
        if rendered {
            acc = acc + textureSampleLevel(texMask, samp, q, 0.0);
            n = n + 1.0;
        } else {
            let hs = layer.quad_px * 0.5;
            if sd_round_rect(f * layer.quad_px - hs, hs, layer.radius_px) < -2.0 {
                acc = acc + vec4<f32>(sample_yuv_level(mix(layer.src.xy, layer.src.zw, f)), 1.0);
                n = n + 1.0;
            }
        }
    }
    return acc / max(n, 1.0);
}

// SDF rectangle à coins arrondis (< 0 dedans). Identique au HLSL.
//
// Coins CONTINUS : le quart de coin est une superellipse d'exposant n, pas un arc de cercle.
// Un arc rejoint le bord droit sans angle, mais sa courbure y saute d'un coup de 0 à 1/r, et
// l'œil lit ce saut comme une cassure ; ici elle monte en douceur depuis zéro (les coins
// « continus » d'Apple). `r` garde son sens : l'étendue E = K(n)·r creuse le coin à 45° autant
// qu'un cercle de rayon r, donc un réglage arrondit autant qu'avant, et deux contours
// concentriques (r, et r + b autour) gardent une bordure d'épaisseur b à 2 % près. L'exposant
// revient à 2 quand r approche le demi-petit-côté : à fond, un carré est un cercle et un
// rectangle une pilule. La distance est divisée par la pente de la norme, donc l'antialiasing
// garde sa largeur tout autour du coin. r <= 0 : le rectangle vif d'avant, à l'identique.
fn sd_round_rect(p: vec2<f32>, halfsz: vec2<f32>, r: f32) -> f32 {
    let hmin = min(halfsz.x, halfsz.y);
    if (r <= 0.0 || hmin <= 0.0) {
        let q0 = abs(p) - halfsz;
        return length(max(q0, vec2<f32>(0.0))) + min(max(q0.x, q0.y), 0.0);
    }
    let n = 3.0 - smoothstep(0.5, 1.0, r / hmin);
    let e = min(r * 0.29289322 / (1.0 - exp2(-1.0 / n)), hmin);
    let q = abs(p) - halfsz + vec2<f32>(e);
    let m = max(q, vec2<f32>(0.0));
    if (m.x > 0.0 && m.y > 0.0) {
        let len = pow(pow(m.x, n) + pow(m.y, n), 1.0 / n);
        let g = pow(m / len, vec2<f32>(n - 1.0));
        return (len - e) / length(g);
    }
    return max(m.x, m.y) + min(max(q.x, q.y), 0.0) - e;
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

// Warp inverse d'un calque pose sur le plan : projectif (`projective` = 1, que tout ecran incline
// porte), bilineaire sinon.
fn quad_inverse(P: vec2<f32>, c00: vec2<f32>, c10: vec2<f32>, c11: vec2<f32>, c01: vec2<f32>, projective: f32) -> vec3<f32> {
    if projective > 0.5 {
        return quad_inverse_projective(P, c00, c10, c11, c01);
    }
    return quad_inverse_bilinear(P, c00, c10, c11, c01);
}

// Un echantillon de l'ecran incline (mode 8) : la video nette, fondue vers la pyramide de
// profondeur de champ (binding 4, a la place du masque webcam) au-dela d'un demi-texel de cercle
// de confusion `coc`. Sous ce seuil, l'echantillon net d'avant, a l'octet. Miroir de
// `tilted_sample` (HLSL). LOD explicite : pas de derivees dans cette branche.
fn tilted_sample(uv: vec2<f32>, coc: f32) -> vec3<f32> {
    var rgb = sample_yuv(uv);
    if coc > 0.5 {
        let lod = clamp(log2(coc) - 1.0, 0.0, DOF_MAX_LOD);
        let far_rgb = textureSampleLevel(texMask, samp, uv, lod).rgb;
        rgb = mix(rgb, far_rgb, clamp((coc - 0.5) / 1.5, 0.0, 1.0));
    }
    return rgb;
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

// Rampe du mode 5 a quatre noeuds. Miroir de `ramp4` cote HLSL (commentaires complets la-bas).
fn ramp4(t: f32, k0: vec4<f32>, k1: vec4<f32>, k2: vec4<f32>, k3: vec4<f32>) -> vec3<f32> {
    var c = k0.rgb;
    c = mix(c, k1.rgb, clamp((t - k0.w) / max(k1.w - k0.w, 1e-5), 0.0, 1.0));
    c = mix(c, k2.rgb, clamp((t - k1.w) / max(k2.w - k1.w, 1e-5), 0.0, 1.0));
    c = mix(c, k3.rgb, clamp((t - k2.w) / max(k3.w - k2.w, 1e-5), 0.0, 1.0));
    return c;
}

// Mouvements 2 (aurore) et 3 (vagues) du mode 5. Miroir ligne pour ligne de
// `gradient_motion` cote HLSL (commentaires complets la-bas).
fn gradient_motion(gp: vec2<f32>, dir: vec2<f32>, denom: f32, k0: vec4<f32>, k1: vec4<f32>,
                   k2: vec4<f32>, k3: vec4<f32>, time: f32, motion: f32, aspect: f32) -> vec3<f32> {
    let TAU = 6.2831853;
    let u = dot(gp - vec2<f32>(0.5), dir) / denom; // position le long de l'axe, -0.5..0.5
    if motion < 2.5 {
        // Aurore : rampe perturbee par un bruit lent, puis trois nappes gaussiennes.
        let p = vec2<f32>((gp.x - 0.5) * aspect, gp.y - 0.5);
        let ph = TAU * time / 120.0;
        let n = value_noise(p * 2.5 + 1.5 * vec2<f32>(cos(ph), sin(ph)));
        var g = ramp4(clamp(0.5 + u + 0.3 * (n - 0.5), 0.0, 1.0), k0, k1, k2, k3);
        let b0 = vec2<f32>(0.35 * aspect * sin(TAU * time / 20.0), 0.25 * sin(TAU * time / 30.0 + 1.0));
        let b1 = vec2<f32>(0.30 * aspect * sin(TAU * time / 24.0 + 2.0), 0.22 * cos(TAU * time / 40.0));
        let b2 = vec2<f32>(0.25 * aspect * cos(TAU * time / 30.0 + 4.0), 0.28 * sin(TAU * time / 24.0 + 3.0));
        g = mix(g, k3.rgb, 0.45 * exp(-dot(p - b0, p - b0) / 0.08));
        g = mix(g, k0.rgb, 0.45 * exp(-dot(p - b1, p - b1) / 0.06));
        g = mix(g, k3.rgb, 0.35 * exp(-dot(p - b2, p - b2) / 0.05));
        return g;
    }
    // Vagues : trois bandes sinus perpendiculaires a l'axe (12 s), ondulees (20 s).
    let v = dot(gp - vec2<f32>(0.5), vec2<f32>(-dir.y, dir.x)) / denom;
    let w = sin(TAU * (3.0 * u + 0.04 * sin(TAU * (1.5 * v + time / 20.0)) - time / 12.0));
    return ramp4(clamp(0.5 + u + 0.07 * w, 0.0, 1.0), k0, k1, k2, k3);
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
// Port ligne pour ligne de `cursor_model` (HLSL), dont les commentaires font foi : un curseur
// SCULPTE (`trail_a.x` > 0, la fleche ou la main d'un des cinq themes d'origine modelee en
// volumes), sinon le sprite de l'etat courant extrude ; eclaire par une lampe proche, avec ombres
// propres et occlusion, et qui porte une ombre douce et une ombre de contact sur le plan de
// l'ecran. Constantes : miroir exact de `frame_geometry.rs` (MODEL_*) et de `sculpt.rs`
// (SCULPT_*), emplacements du cbuffer : `cursor_model_cb`.
// Textures : le sprite RGBA (alpha droit) au binding 1 (`texY`, comme aux modes 7 et 13), son
// champ R16F au binding 2 (`texU`), sur le meme rect ; `color.rg` = coin du sprite dans le repere
// du modele, `sprite_size()` = sa taille (w/h dans `radius_px`), `color.b` = l'ecrasement au clic.
const MODEL_BEVEL: f32 = 0.045;
const MODEL_LIGHT = vec3<f32>(-0.4194, -0.5792, 0.6990);
const MODEL_FILL = vec3<f32>(0.7557, 0.2519, 0.6046);
// Ambiance et diffus de l'appareil modele (mode 17), qui garde son eclairage d'origine.
const MODEL_AMBIENT: f32 = 0.36;
const MODEL_DIFFUSE: f32 = 0.75;
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

// Epaisseur sous z = 0 (`SpriteShape::thick`), ecrasee au clic de `color.b`.
fn model_thick() -> f32 {
    return layer.trail_a.y * layer.color.b;
}

// Le curseur sculpte de ce dessin (`SpriteShape::sculpt`), 0 = le sprite extrude.
fn sculpt_id() -> i32 {
    return i32(layer.trail_a.x + 0.5);
}

// ---- Curseurs sculptes ---- (repere du PROTOTYPE : hauteur 1, y vers le haut, ecran en z = 0)
const SCULPT_SCALE: f32 = 0.85;
const SCULPT_HOVER: f32 = 0.05;
const SCULPT_VOX: f32 = 0.0625;
const SCULPT_AR_ROUND: f32 = 0.03;
const SCULPT_HAND_ZC: f32 = 0.185;
const SCULPT_ZREF_ARROW: f32 = 0.2;
const SCULPT_ZREF_HAND: f32 = 0.185;
const SCULPT_LAMP_DIST: f32 = 1.9;
const SCULPT_SCREEN = vec3<f32>(0.32, 0.32, 0.32);

fn s_lin(r: f32, g: f32, b: f32) -> vec3<f32> {
    return pow(vec3<f32>(r, g, b), vec3<f32>(2.2));
}

fn s_smin(a: f32, b: f32, k: f32) -> f32 {
    let h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

fn s_opu(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return select(b, a, a.x < b.x);
}

fn s_capsule(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, r: f32) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = saturate(dot(pa, ba) / dot(ba, ba));
    return length(pa - ba * h) - r;
}

fn s_round_box(p: vec3<f32>, b: vec3<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec3<f32>(r);
    return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn s_ellipsoid(p: vec3<f32>, r: vec3<f32>) -> f32 {
    let k0 = length(p / r);
    let k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}

// Extrusion d'une distance 2D a aretes arrondies : demi-hauteur h, rayon r.
fn s_extrude(d2: f32, z: f32, h: f32, r: f32) -> f32 {
    let w = vec2<f32>(d2 + r, abs(z) - h + r);
    return min(max(w.x, w.y), 0.0) + length(max(w, vec2<f32>(0.0))) - r;
}

fn s_rot(v: vec2<f32>, a: f32) -> vec2<f32> {
    let c = cos(a);
    let s = sin(a);
    return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

const SCULPT_ARROW = array<vec2<f32>, 7>(
    vec2<f32>(0.0, 0.0), vec2<f32>(0.0, -0.86), vec2<f32>(0.215, -0.665), vec2<f32>(0.37, -1.0),
    vec2<f32>(0.53, -0.93), vec2<f32>(0.38, -0.60), vec2<f32>(0.64, -0.60)
);

fn s_arrow2(p: vec2<f32>) -> f32 {
    var d = dot(p - SCULPT_ARROW[0], p - SCULPT_ARROW[0]);
    var s = 1.0;
    var j = 6;
    for (var i = 0; i < 7; i++) {
        let e = SCULPT_ARROW[j] - SCULPT_ARROW[i];
        let w = p - SCULPT_ARROW[i];
        let b = w - e * saturate(dot(w, e) / dot(e, e));
        d = min(d, dot(b, b));
        let c0 = p.y >= SCULPT_ARROW[i].y;
        let c1 = p.y < SCULPT_ARROW[j].y;
        let c2 = e.x * w.y > e.y * w.x;
        if (c0 && c1 && c2) || (!c0 && !c1 && !c2) {
            s = -s;
        }
        j = i;
    }
    return s * sqrt(d);
}

fn s_star5(p0: vec2<f32>, r: f32, rf: f32) -> f32 {
    let k1 = vec2<f32>(0.809016994375, -0.587785252292);
    let k2 = vec2<f32>(-0.809016994375, -0.587785252292);
    var p = vec2<f32>(abs(p0.x), p0.y);
    p = p - 2.0 * max(dot(k1, p), 0.0) * k1;
    p = p - 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y = p.y - r;
    let ba = rf * vec2<f32>(-k1.y, k1.x) - vec2<f32>(0.0, 1.0);
    let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

fn s_arrow_solid(p: vec3<f32>, h: f32, re: f32, dome: f32) -> f32 {
    let d2 = s_arrow2(p.xy) - SCULPT_AR_ROUND;
    let hh = h + dome * smoothstep(0.0, 0.07, -d2);
    return s_extrude(d2, p.z - (SCULPT_HOVER + h + dome), hh, re);
}

fn s_piping(p: vec3<f32>, ztop: f32) -> f32 {
    let d2 = s_arrow2(p.xy) - SCULPT_AR_ROUND;
    return length(vec2<f32>(d2 + 0.075, p.z - ztop)) - 0.017;
}

fn s_glove(p: vec3<f32>, zc: f32) -> f32 {
    let index = s_capsule(p, vec3<f32>(0.0, -0.10, zc), vec3<f32>(0.0, -0.52, zc), 0.098);
    let palm = s_round_box(p - vec3<f32>(0.185, -0.70, zc), vec3<f32>(0.255, 0.19, 0.105), 0.1);
    let f1 = s_capsule(p, vec3<f32>(0.17, -0.57, zc + 0.012), vec3<f32>(0.17, -0.41, zc + 0.045), 0.086);
    let f2 = s_capsule(p, vec3<f32>(0.31, -0.59, zc + 0.01), vec3<f32>(0.31, -0.45, zc + 0.04), 0.08);
    let f3 = s_capsule(p, vec3<f32>(0.435, -0.625, zc + 0.005), vec3<f32>(0.435, -0.52, zc + 0.03), 0.07);
    let thumb = s_capsule(p, vec3<f32>(0.03, -0.77, zc + 0.03), vec3<f32>(-0.165, -0.60, zc + 0.065), 0.082);
    var d = s_smin(palm, min(f1, min(f2, f3)), 0.035);
    d = s_smin(d, index, 0.05);
    return s_smin(d, thumb, 0.05);
}

fn s_cuff(p: vec3<f32>, zc: f32) -> f32 {
    let q = p - vec3<f32>(0.185, -0.925, zc);
    let ab = vec2<f32>(0.272, 0.12);
    let e = (length(q.xz / ab) - 1.0) * min(ab.x, ab.y);
    return s_extrude(e, q.y, 0.07, 0.06);
}

fn s_sprout(p: vec3<f32>, c: vec3<f32>) -> vec2<f32> {
    let q = p - c;
    let st2 = s_star5(q.xy, 0.125, 0.52) - 0.022;
    var r = vec2<f32>(s_extrude(st2, q.z, 0.038, 0.034), 3.0);
    let e = vec3<f32>(abs(q.x) - 0.032, q.y + 0.005, q.z - 0.036);
    r = s_opu(r, vec2<f32>(length(e) - 0.0135, 5.0));
    let l1 = vec3<f32>(s_rot(q.xy - vec2<f32>(-0.04, 0.15), -0.6), q.z);
    let l2 = vec3<f32>(s_rot(q.xy - vec2<f32>(0.045, 0.155), 0.7), q.z);
    let leaves = min(s_ellipsoid(l1, vec3<f32>(0.03, 0.058, 0.02)), s_ellipsoid(l2, vec3<f32>(0.03, 0.058, 0.02)));
    return s_opu(r, vec2<f32>(leaves, 4.0));
}

// Pixel Candy : une ligne par entier, bit c = colonne c (cf. HLSL et `sculpt.rs`).
const SCULPT_ARROWPIX = array<i32, 16>(0, 1, 3, 7, 31, 63, 127, 255, 511, 63, 55, 115, 113, 224, 224, 64);
const SCULPT_ARROWBACK = array<i32, 18>(
    3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 255, 511, 511, 999, 995, 960, 192
);
const SCULPT_HANDPIX = array<i32, 15>(4, 14, 14, 14, 110, 878, 7022, 7022, 8190, 8191, 8191, 8191, 8190, 4092, 4092);
const SCULPT_HANDBACK = array<i32, 17>(
    28, 62, 62, 62, 510, 4094, 32766, 32766, 32766, 32767, 32767, 32767, 32767, 32767, 32766, 16380, 16380
);
const SCULPT_HANDSPAN = array<vec2<f32>, 17>(
    vec2<f32>(2.0, 4.0), vec2<f32>(1.0, 5.0), vec2<f32>(1.0, 5.0), vec2<f32>(1.0, 5.0), vec2<f32>(1.0, 8.0),
    vec2<f32>(1.0, 11.0), vec2<f32>(1.0, 14.0), vec2<f32>(1.0, 14.0), vec2<f32>(1.0, 14.0), vec2<f32>(0.0, 14.0),
    vec2<f32>(0.0, 14.0), vec2<f32>(0.0, 14.0), vec2<f32>(0.0, 14.0), vec2<f32>(0.0, 14.0), vec2<f32>(1.0, 14.0),
    vec2<f32>(2.0, 13.0), vec2<f32>(2.0, 13.0)
);

fn s_grid_origin(shape: i32) -> vec2<f32> {
    return select(vec2<f32>(-2.5 * SCULPT_VOX, 0.0), vec2<f32>(0.0), shape == 0);
}

fn s_bit(row: i32, r: i32, c: i32, rows: i32, cols: i32) -> bool {
    return r >= 0 && r < rows && c >= 0 && c < cols && ((row >> u32(clamp(c, 0, 31))) & 1) == 1;
}

fn s_occ(id: vec2<f32>, shape: i32) -> bool {
    let c = i32(id.x);
    let r = -i32(id.y) - 1;
    if shape == 0 {
        return s_bit(SCULPT_ARROWPIX[clamp(r, 0, 15)], r, c, 16, 16);
    }
    return s_bit(SCULPT_HANDPIX[clamp(r, 0, 14)], r, c, 15, 13);
}

fn s_occ_back(id: vec2<f32>, shape: i32) -> bool {
    let c = i32(id.x) + 1;
    let r = -i32(id.y);
    if shape == 0 {
        return s_bit(SCULPT_ARROWBACK[clamp(r, 0, 17)], r, c, 18, 17);
    }
    return s_bit(SCULPT_HANDBACK[clamp(r, 0, 16)], r, c, 17, 15);
}

fn s_voxels(p: vec3<f32>, shape: i32) -> vec2<f32> {
    let o = s_grid_origin(shape);
    let cell = floor((p.xy - o) / SCULPT_VOX);
    let bc = select(vec2<f32>(0.25, -0.47), vec2<f32>(0.33, -0.5), shape == 0);
    let bh = select(vec2<f32>(0.48, 0.55), vec2<f32>(0.44, 0.61), shape == 0);
    let bq = max(abs(p.xy - bc) - bh, vec2<f32>(0.0));
    let bz = max(abs(p.z - (SCULPT_HOVER + 0.07)) - 0.07, 0.0);
    let far = max(SCULPT_VOX, sqrt(dot(bq, bq) + bz * bz));
    var dF = far;
    var dB = far;
    let half_cell = vec3<f32>(0.5 * SCULPT_VOX, 0.5 * SCULPT_VOX, 0.04);
    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            let id = cell + vec2<f32>(f32(i), f32(j));
            let q = vec3<f32>(p.xy - (o + (id + vec2<f32>(0.5)) * SCULPT_VOX), p.z);
            if s_occ(id, shape) {
                dF = min(dF, s_round_box(q - vec3<f32>(0.0, 0.0, SCULPT_HOVER + 0.1), half_cell, 0.009));
            }
            if s_occ_back(id, shape) {
                dB = min(dB, s_round_box(q - vec3<f32>(0.0, 0.0, SCULPT_HOVER + 0.04), half_cell, 0.009));
            }
        }
    }
    return select(vec2<f32>(dB, 7.0), vec2<f32>(dF, 6.0), dF < dB);
}

fn s_pixel_hand_dist(p: vec2<f32>) -> f32 {
    var d = 1e9;
    for (var r = 0; r < 17; r++) {
        let x = (SCULPT_HANDSPAN[r] + vec2<f32>(-3.5, -2.5)) * SCULPT_VOX;
        let y = vec2<f32>(-f32(r), 1.0 - f32(r)) * SCULPT_VOX;
        let q = max(max(vec2<f32>(x.x, y.x) - p, p - vec2<f32>(x.y, y.y)), vec2<f32>(0.0));
        d = min(d, length(q));
    }
    return d;
}

fn s_gem_edge(p: vec3<f32>, a: vec2<f32>, b: vec2<f32>, z0: f32) -> f32 {
    let e = b - a;
    let len = length(e);
    let d = e / len;
    let q = p.xy - a;
    let dist = dot(q, vec2<f32>(-d.y, d.x));
    let along = abs(dot(q, d) - 0.5 * len);
    let z = p.z - z0;
    let girdle = (z - 0.035 - 2.2 * dist) * 0.4138;
    let crown = (z - 0.07 - 0.6 * dist + 0.18 * along) * 0.8438;
    return max(-dist, max(girdle, crown));
}

fn s_gem_arrow(p: vec3<f32>) -> f32 {
    let z0 = SCULPT_HOVER + 0.03;
    let slab = max(p.z - z0 - 0.2, z0 - 0.03 - p.z);
    let head = max(slab, max(s_gem_edge(p, vec2<f32>(-0.02, 0.03), vec2<f32>(-0.02, -0.88), z0),
                         max(s_gem_edge(p, vec2<f32>(-0.02, -0.88), vec2<f32>(0.66, -0.61), z0),
                             s_gem_edge(p, vec2<f32>(0.66, -0.61), vec2<f32>(-0.02, 0.03), z0))));
    let tail = max(slab, max(max(s_gem_edge(p, vec2<f32>(0.215, -0.665), vec2<f32>(0.37, -1.0), z0),
                                 s_gem_edge(p, vec2<f32>(0.37, -1.0), vec2<f32>(0.53, -0.93), z0)),
                             max(s_gem_edge(p, vec2<f32>(0.53, -0.93), vec2<f32>(0.38, -0.60), z0),
                                 s_gem_edge(p, vec2<f32>(0.38, -0.60), vec2<f32>(0.215, -0.665), z0))));
    return min(head, tail);
}

fn s_facet_capsule(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, r: f32, spin: f32) -> f32 {
    let u = normalize(b - a);
    let v = normalize(cross(u, vec3<f32>(0.0, 0.0, 1.0)));
    let w = cross(u, v);
    let q = p - b;
    let h = dot(q, u);
    let rad = vec2<f32>(dot(q, v), dot(q, w));
    var d = max(h - r, -dot(p - a, u) - r);
    for (var k = 0; k < 6; k++) {
        let an = spin + f32(k) * 1.0471976;
        let s = dot(rad, vec2<f32>(cos(an), sin(an)));
        d = max(d, s - r);
        d = max(d, dot(rad, vec2<f32>(cos(an + 0.5236), sin(an + 0.5236))) * 0.8660 + h * 0.5 - r);
        d = max(d, s * 0.5 + h * 0.8660 - r);
    }
    return d;
}

const SCULPT_FACETS = array<vec3<f32>, 10>(
    vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(0.7071, 0.7071, 0.0), vec3<f32>(0.7071, 0.0, 0.7071), vec3<f32>(0.0, 0.7071, 0.7071),
    vec3<f32>(0.5774, 0.5774, 0.5774), vec3<f32>(0.4472, 0.0, 0.8944), vec3<f32>(0.0, 0.4472, 0.8944),
    vec3<f32>(0.3015, 0.3015, 0.9045)
);

fn s_facet_ellipsoid(p: vec3<f32>, r: vec3<f32>) -> f32 {
    let q = abs(p);
    var d = -1e9;
    for (var i = 0; i < 10; i++) {
        d = max(d, dot(q, SCULPT_FACETS[i]) - length(r * SCULPT_FACETS[i]));
    }
    return d;
}

fn s_crystal_hand(p: vec3<f32>) -> f32 {
    let zc = SCULPT_HAND_ZC;
    var d = s_facet_ellipsoid(p - vec3<f32>(0.185, -0.70, zc), vec3<f32>(0.3, 0.235, 0.125));
    d = min(d, s_facet_capsule(p, vec3<f32>(0.0, -0.52, zc), vec3<f32>(0.0, -0.10, zc), 0.098, 0.3));
    d = min(d, s_facet_capsule(p, vec3<f32>(0.17, -0.57, zc + 0.012), vec3<f32>(0.17, -0.41, zc + 0.045), 0.086, 0.1));
    d = min(d, s_facet_capsule(p, vec3<f32>(0.31, -0.59, zc + 0.01), vec3<f32>(0.31, -0.45, zc + 0.04), 0.08, 0.5));
    d = min(d, s_facet_capsule(p, vec3<f32>(0.435, -0.625, zc + 0.005), vec3<f32>(0.435, -0.52, zc + 0.03), 0.07, 0.2));
    return min(d, s_facet_capsule(p, vec3<f32>(0.03, -0.77, zc + 0.03), vec3<f32>(-0.165, -0.60, zc + 0.065), 0.082, 0.7));
}

fn sculpt_proto(p: vec3<f32>, theme: i32, shape: i32) -> vec2<f32> {
    if theme == 3 {
        return s_voxels(p, shape);
    }
    if theme == 1 {
        return vec2<f32>(select(s_crystal_hand(p), s_gem_arrow(p), shape == 0), 8.0);
    }
    var body: vec2<f32>;
    var star: vec3<f32>;
    if shape == 0 {
        var h = 0.075;
        var re = 0.03;
        var dome = 0.0;
        if theme == 2 {
            h = 0.07;
            re = 0.06;
            dome = 0.035;
        }
        if theme == 4 {
            h = 0.07;
            re = 0.055;
            dome = 0.025;
        }
        body = vec2<f32>(s_arrow_solid(p, h, re, dome), 1.0);
        if theme == 0 {
            body = s_opu(body, vec2<f32>(s_piping(p, SCULPT_HOVER + 2.0 * h - 0.004), 2.0));
        }
        star = vec3<f32>(0.57, -0.86, SCULPT_HOVER + 2.0 * h + dome);
    } else {
        body = s_opu(vec2<f32>(s_glove(p, SCULPT_HAND_ZC), 1.0), vec2<f32>(s_cuff(p, SCULPT_HAND_ZC), 2.0));
        star = vec3<f32>(0.185, -0.93, SCULPT_HAND_ZC + 0.15);
    }
    if theme == 4 {
        return s_opu(body, s_sprout(p, star));
    }
    return body;
}

fn sculpt_point(q: vec3<f32>) -> vec3<f32> {
    let zref = select(SCULPT_ZREF_HAND, SCULPT_ZREF_ARROW, (sculpt_id() - 1) % 2 == 0);
    return vec3<f32>(q.x, -q.y, q.z / max(layer.color.b, 1e-3)) / SCULPT_SCALE + vec3<f32>(0.0, 0.0, zref);
}

fn sculpt_units() -> f32 {
    return SCULPT_SCALE * min(layer.color.b, 1.0);
}

fn sculpt_eval(q: vec3<f32>, occ: bool) -> vec2<f32> {
    let id = sculpt_id() - 1;
    let theme = id / 2;
    let shape = id % 2;
    let p = sculpt_point(q);
    var r: vec2<f32>;
    if occ && theme == 3 {
        let d2 = select(s_pixel_hand_dist(p.xy), s_arrow2(p.xy) - 1.2 * SCULPT_VOX, shape == 0);
        let dz = abs(p.z - (SCULPT_HOVER + 0.07)) - 0.07;
        r = vec2<f32>(length(max(vec2<f32>(d2, dz), vec2<f32>(0.0))) + min(max(d2, dz), 0.0), 7.0);
    } else {
        r = sculpt_proto(p, select(theme, 2, occ && theme == 1), shape);
    }
    return vec2<f32>(r.x * sculpt_units(), r.y);
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

fn model_eval(p: vec3<f32>, occ: bool) -> vec2<f32> {
    if sculpt_id() > 0 {
        return sculpt_eval(p, occ);
    }
    let half_t = model_thick() * 0.5;
    let w = vec2<f32>(sd_sprite2(p.xy) + MODEL_BEVEL, abs(p.z + half_t) - (half_t - MODEL_BEVEL));
    return vec2<f32>(min(max(w.x, w.y), 0.0) + length(max(w, vec2<f32>(0.0))) - MODEL_BEVEL, 0.0);
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

fn model_albedo(p: vec2<f32>) -> vec3<f32> {
    let texel = sprite_texel();
    let e = 0.25 * texel;
    let g = vec2<f32>(sd_sprite2(p + vec2<f32>(e, 0.0)) - sd_sprite2(p - vec2<f32>(e, 0.0)),
                      sd_sprite2(p + vec2<f32>(0.0, e)) - sd_sprite2(p - vec2<f32>(0.0, e)));
    let q = p - g / max(length(g), 1e-6) * max(sd_sprite2(p) + MODEL_RIM_INSET * texel, 0.0);
    return textureSampleLevel(texY, samp, (q - layer.color.rg) / sprite_size(), 0.0).rgb;
}

struct SculptMat {
    alb: vec3<f32>,
    rough: f32,
    spec: f32,
    sss: f32,
    refl: f32,
}

fn s_pixel_colour(p: vec3<f32>, shape: i32) -> vec3<f32> {
    let id = floor((p.xy - s_grid_origin(shape)) / SCULPT_VOX);
    if !s_occ(id + vec2<f32>(-1.0, 0.0), shape) || !s_occ(id + vec2<f32>(0.0, -1.0), shape) {
        return s_lin(0.52, 0.91, 0.77);
    }
    if !s_occ(id + vec2<f32>(1.0, 0.0), shape) || !s_occ(id + vec2<f32>(0.0, 1.0), shape) {
        return s_lin(1.0, 0.78, 0.87);
    }
    return s_lin(1.0, 0.50, 0.71);
}

fn sculpt_material(mat: f32, p: vec3<f32>, theme: i32, shape: i32) -> SculptMat {
    let primary = mat < 1.5;
    if theme == 0 {
        if shape == 0 && primary {
            return SculptMat(s_lin(0.10, 0.10, 0.115), 0.3, 0.2, 0.0, 0.9);
        }
        if shape == 0 {
            return SculptMat(s_lin(0.94, 0.91, 0.84), 0.45, 0.4, 0.2, 0.3);
        }
        if primary {
            return SculptMat(s_lin(0.95, 0.92, 0.85), 0.55, 0.35, 0.35, 0.25);
        }
        return SculptMat(s_lin(0.17, 0.18, 0.22), 0.35, 0.6, 0.0, 0.6);
    }
    if theme == 2 {
        if shape == 0 {
            return SculptMat(s_lin(1.0, 0.40, 0.30), 0.5, 0.45, 0.4, 0.25);
        }
        if primary {
            return SculptMat(s_lin(1.0, 0.79, 0.16), 0.5, 0.45, 0.4, 0.25);
        }
        return SculptMat(s_lin(0.18, 0.20, 0.29), 0.4, 0.5, 0.0, 0.4);
    }
    if theme == 4 {
        if primary && shape == 0 {
            return SculptMat(s_lin(0.62, 0.91, 0.78), 0.22, 0.8, 0.25, 0.6);
        }
        if primary {
            return SculptMat(s_lin(0.96, 0.94, 0.88), 0.5, 0.35, 0.35, 0.25);
        }
        if mat < 2.5 {
            return SculptMat(s_lin(0.62, 0.91, 0.78), 0.25, 0.7, 0.25, 0.5);
        }
        if mat < 3.5 {
            return SculptMat(s_lin(1.0, 0.80, 0.20), 0.3, 0.6, 0.3, 0.4);
        }
        if mat < 4.5 {
            return SculptMat(s_lin(0.38, 0.80, 0.55), 0.35, 0.5, 0.35, 0.3);
        }
        return SculptMat(s_lin(0.16, 0.12, 0.10), 0.2, 0.8, 0.0, 0.5);
    }
    if mat < 6.5 {
        return SculptMat(s_pixel_colour(p, shape), 0.45, 0.35, 0.15, 0.2);
    }
    return SculptMat(s_lin(0.36, 0.18, 0.54), 0.45, 0.35, 0.1, 0.2);
}

fn model_env(d: vec3<f32>, rough: f32, l: vec3<f32>, fill: vec3<f32>) -> vec3<f32> {
    var col = mix(SCULPT_SCREEN * 0.9, s_lin(0.82, 0.85, 0.92) * 0.55, smoothstep(-0.15, 0.35, d.z));
    let w = rough * 0.3;
    let k = 1.0 - rough * 0.6;
    col = col + s_lin(1.0, 0.97, 0.92) * 5.0 * k * smoothstep(0.90 - w, 0.97, dot(d, l));
    col = col + s_lin(0.85, 0.9, 1.0) * 1.6 * k * smoothstep(0.93 - w, 0.98, dot(d, fill));
    return col;
}

fn s_gem(k0: f32) -> vec3<f32> {
    let k = saturate(k0) * 3.0;
    let a = s_lin(0.20, 0.95, 1.0);
    let b = s_lin(0.15, 0.42, 1.0);
    let c = s_lin(0.45, 0.25, 0.95);
    let d = s_lin(0.88, 0.50, 1.0);
    if k < 1.0 {
        return mix(a, b, k);
    }
    if k < 2.0 {
        return mix(b, c, k - 1.0);
    }
    return mix(c, d, k - 2.0);
}

fn model_shade_crystal(n: vec3<f32>, rd: vec3<f32>, L: vec3<f32>, fall: f32, l: vec3<f32>, fill: vec3<f32>) -> vec3<f32> {
    let cosi = saturate(dot(-rd, n));
    let F = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
    let t = refract(rd, n, 1.0 / 1.6);
    let k = 0.42 + 0.9 * dot(vec2<f32>(n.x, -n.y), vec2<f32>(0.7557, -0.6549))
          + 0.6 * dot(vec2<f32>(t.x, -t.y), vec2<f32>(0.6, -0.8));
    let body = vec3<f32>(s_gem(k - 0.08).r, s_gem(k).g, s_gem(k + 0.08).b);
    var col = body * (0.1 + 1.8 * fall * pow(max(dot(n, L), 0.0), 2.5));
    col = col + body * model_env(reflect(t, vec3<f32>(0.0, 0.0, 1.0)) * vec3<f32>(1.0, 1.0, -1.0), 0.15, l, fill) * 0.5;
    col = col + vec3<f32>(pow(max(dot(reflect(rd, n), L), 0.0), 30.0) * 2.0);
    col = col + model_env(reflect(rd, n), 0.05, l, fill) * F;
    col = col + s_lin(0.5, 0.9, 1.0) * pow(1.0 - cosi, 4.0) * 0.6;
    return col;
}

fn model_tonemap(c0: vec3<f32>) -> vec3<f32> {
    let start = 0.76;
    let x = min(c0.r, min(c0.g, c0.b));
    var c = c0 - vec3<f32>(select(0.04, x - 6.25 * x * x, x < 0.08));
    let peak = max(c.r, max(c.g, c.b));
    if peak >= start {
        let d = 1.0 - start;
        let np = 1.0 - d * d / (peak + d - start);
        c = c * (np / peak);
        let g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
        c = mix(c, vec3<f32>(np), g);
    }
    return pow(saturate(c), vec3<f32>(1.0 / 2.2));
}

fn model_shade(q: vec3<f32>, n: vec3<f32>, rd: vec3<f32>, L: vec3<f32>, fall: f32, sh: f32, ao: f32, mat: f32,
               l: vec3<f32>, fill: vec3<f32>) -> vec3<f32> {
    let id = sculpt_id();
    if id > 0 && (id - 1) / 2 == 1 {
        return model_tonemap(model_shade_crystal(n, rd, L, fall, l, fill));
    }
    var m: SculptMat;
    var gloss = 1.0;
    if id > 0 {
        let p = sculpt_point(q) - vec3<f32>(n.x, -n.y, n.z) * 0.01;
        m = sculpt_material(mat, p, (id - 1) / 2, (id - 1) % 2);
    } else {
        m = SculptMat(pow(model_albedo(q.xy), vec3<f32>(2.2)), 0.45, 0.35, 0.2, 0.3);
        gloss = 1.0 - smoothstep(0.97, 0.995, abs(n.z));
    }
    let key = s_lin(1.0, 0.97, 0.93) * 2.1 * fall;
    let ndl = dot(n, L);
    let wrap = 0.5 * m.sss;
    let dif = saturate((ndl + wrap) / (1.0 + wrap)) * mix(sh, 1.0, 0.15 * m.sss);
    let ndh = saturate(dot(n, normalize(L - rd)));
    let shin = exp2(10.0 * (1.0 - m.rough) + 1.0);
    let spe = (pow(ndh, shin) * (shin + 8.0) / 25.0 + 0.15 * pow(ndh, 8.0)) * sh * saturate(ndl * 4.0);
    let fre = pow(1.0 - saturate(dot(n, -rd)), 5.0);
    let amb = mix(SCULPT_SCREEN * 0.12, s_lin(0.88, 0.92, 1.0) * 0.22, 0.5 + 0.5 * n.z);
    let fl = s_lin(0.85, 0.9, 1.0) * saturate(dot(n, fill)) * 0.12;
    var col = m.alb * (key * dif + (amb + fl) * ao * mix(vec3<f32>(1.0), m.alb, 0.5));
    col = col + key * spe * m.spec * gloss;
    col = col + model_env(reflect(rd, n), m.rough, l, fill) * m.refl * (0.04 + 0.96 * fre) * ao * gloss;
    col = col + s_lin(0.9, 0.95, 1.0) * fre * 0.08 * ao * sh;
    return model_tonemap(col);
}

// Les passes de la boucle unique de `cursor_model` (cf. HLSL : un seul appel de `model_eval`).
const STAGE_MARCH: i32 = 0;
const STAGE_NORMAL: i32 = 1;
const STAGE_AO: i32 = 2;
const STAGE_SELF: i32 = 3;
const STAGE_PLANE: i32 = 4;
const STAGE_DONE: i32 = 5;

fn model_tetra(k: i32) -> vec3<f32> {
    let b = vec3<f32>(f32(((k + 3) >> 1u) & 1), f32((k >> 1u) & 1), f32(k & 1));
    return 0.5773 * (2.0 * b - vec3<f32>(1.0));
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
    let hi = vec3<f32>(layer.color.rg + sprite_size(), layer.trail_a.z);

    let dw = vec3<f32>(local + layer.src.xy, -persp);
    let dlen = length(dw);
    // Plan translate de mb.zw dans le repere camera (camera reelle ; 0 sous un angle fixe).
    let ro = plane_to_model((world_to_plane(vec3<f32>(-layer.mb.z, -layer.mb.w, persp), f) - tip) / unit, f);
    let rd = plane_to_model(world_to_plane(dw / dlen, f), f);
    let l = plane_to_model(world_to_plane(MODEL_LIGHT, f), f);
    let fill = plane_to_model(world_to_plane(MODEL_FILL, f), f);
    let nz = plane_to_model(vec3<f32>(0.0, 0.0, 1.0), f);
    let hz = -tip.z / unit;
    let stride = select(1.0, 0.85, sculpt_id() > 0);
    let lamp = vec3<f32>(layer.color.rg + sprite_size() * 0.5, 0.0) + l * SCULPT_LAMP_DIST;

    let tb = ray_box(ro, rd, lo - vec3<f32>(0.02), hi + vec3<f32>(0.02));
    var stage = select(STAGE_DONE, STAGE_MARCH, tb.x < tb.y && tb.y > 0.0);
    var plane_next = stage == STAGE_DONE;
    var k = 0;
    var t = max(tb.x, 0.0);
    var best = 1e9;
    var t_best = t;
    var mat = 0.0;
    var cov = 0.0;
    var q = vec3<f32>(0.0);
    var n = vec3<f32>(0.0);
    var L = vec3<f32>(0.0);
    var ao = 1.0;
    var sh = 1.0;
    var ts = vec2<f32>(0.0);
    var res = 1.0;
    var g = vec3<f32>(0.0);
    var inside = 0.0;
    var contact = 0.0;
    var dropped = 0.0;
    for (var it = 0; it < 180; it++) {
        if plane_next {
            plane_next = false;
            stage = STAGE_DONE;
            let denom = dot(rd, nz);
            if cov < 1.0 && denom < -1e-4 {
                g = ro + rd * ((hz - dot(ro, nz)) / denom);
                let gp = tip + unit * model_to_plane(g, f);
                inside = saturate(min(layer.mb.x - abs(gp.x), layer.mb.y - abs(gp.y)) + 0.5);
                if inside > 0.0 {
                    stage = STAGE_PLANE;
                    k = 0;
                    ts = vec2<f32>(0.0);
                }
            }
        }
        var pos: vec3<f32>;
        if stage == STAGE_MARCH {
            pos = ro + rd * t;
        } else if stage == STAGE_NORMAL {
            pos = q + 0.002 * model_tetra(k);
        } else if stage == STAGE_AO {
            pos = q + (0.01 + 0.0175 * f32(k)) * SCULPT_SCALE * n;
        } else if stage == STAGE_SELF {
            pos = q + n * 0.003 + L * ts.x;
        } else if stage == STAGE_PLANE {
            pos = g + l * ts.x;
        } else {
            break;
        }
        let m = model_eval(pos, stage == STAGE_PLANE);
        let d = m.x;
        if stage == STAGE_MARCH {
            let fp = t / dlen;
            let hit = d < 0.1 * fp;
            if hit || d / fp < best {
                best = select(d / fp, 0.0, hit);
                t_best = t;
                mat = m.y;
            }
            t = t + d * stride;
            k++;
            if hit || t > tb.y || k == 96 {
                cov = saturate(1.0 - best);
                if cov > 0.0 {
                    q = ro + rd * t_best;
                    stage = STAGE_NORMAL;
                    k = 0;
                } else {
                    plane_next = true;
                }
            }
        } else if stage == STAGE_NORMAL {
            n = n + model_tetra(k) * d;
            k++;
            if k == 4 {
                n = normalize(n);
                stage = STAGE_AO;
                k = 0;
                ao = 0.0;
            }
        } else if stage == STAGE_AO {
            ao = ao + ((0.01 + 0.0175 * f32(k)) * SCULPT_SCALE - d) * pow(0.85, f32(k));
            k++;
            if k == 5 {
                ao = saturate(1.0 - 3.5 * ao / SCULPT_SCALE);
                L = normalize(lamp - q);
                let tbs = ray_box(q + n * 0.003, L, lo - vec3<f32>(MODEL_SHADOW_PAD), hi + vec3<f32>(MODEL_SHADOW_PAD));
                if tbs.x < tbs.y && tbs.y > 0.0 {
                    stage = STAGE_SELF;
                    k = 0;
                    ts = vec2<f32>(max(tbs.x, 0.004), tbs.y);
                    res = 1.0;
                } else {
                    plane_next = true;
                }
            }
        } else if stage == STAGE_SELF {
            res = min(res, MODEL_SOFTNESS * d / ts.x);
            ts.x = ts.x + clamp(d, 0.01, 0.2);
            k++;
            if res < 0.002 || ts.x > ts.y || k == 32 {
                res = saturate(res);
                sh = res * res * (3.0 - 2.0 * res);
                plane_next = true;
            }
        } else if k == 0 {
            contact = 1.0 - smoothstep(0.0, MODEL_CONTACT_RADIUS, d);
            let tbp = ray_box(g, l, lo - vec3<f32>(MODEL_SHADOW_PAD), hi + vec3<f32>(MODEL_SHADOW_PAD));
            ts = vec2<f32>(max(tbp.x, 0.004), tbp.y);
            res = 1.0;
            k = 1;
            if !(tbp.x < tbp.y && tbp.y > 0.0) {
                stage = STAGE_DONE;
            }
        } else {
            res = min(res, MODEL_SOFTNESS * d / ts.x);
            ts.x = ts.x + clamp(d, 0.01, 0.2);
            k++;
            if res < 0.002 || ts.x > ts.y || k == 33 {
                res = saturate(res);
                dropped = 1.0 - res * res * (3.0 - 2.0 * res);
                stage = STAGE_DONE;
            }
        }
    }

    var rgb = vec3<f32>(0.0);
    if cov > 0.0 {
        let tl = lamp - q;
        let fall = SCULPT_LAMP_DIST * SCULPT_LAMP_DIST / dot(tl, tl);
        rgb = model_shade(q, n, rd, normalize(tl), fall, sh, ao, mat, l, fill);
    }
    let shadow = inside * max(dropped * MODEL_SHADOW_ALPHA, contact * MODEL_CONTACT_ALPHA);
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
        // Mode 5 -- gradient lineaire jusqu'a 4 stops : noeuds `rgb + position` dans color,
        // src_prev, dst_prev, src (cf. `ramp4`), le long de la direction fx.xy (sin, -cos de
        // l'angle). Parite avec le HLSL/MSL.
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
        rgb = ramp4(t, layer.color, layer.src_prev, layer.dst_prev, layer.src);
        if layer.fx.w > 1.5 {
            rgb = gradient_motion(gp, dir, denom, layer.color, layer.src_prev, layer.dst_prev,
                                  layer.src, layer.fx.z, layer.fx.w, layer.mb.x);
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
        // remonte au (s,t) du plan par warp inverse : projectif exact (dst_prev.w = 1, tout ecran
        // incline), bilineaire sinon ; la camera reelle eclaire aussi le plan (color.xy).
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
        // Slot d'un layout en bloc (`color.w` = rayon de ses coins, px ; 0 ailleurs, sans effet) :
        // `dst` EST le slot, dont le rect arrondi rogne le plan (`ScreenMask`, cf. HLSL).
        let tilt_a = (1.0 - smoothstep(0.0, 1.5, d))
            * quad_round_alpha(i.local, layer.quad_px, layer.color.w);
        // Profondeur de champ (cf. HLSL) : net sous un demi-texel de flou, l'echantillon
        // d'avant a l'octet ; au-dela, fondu vers la pyramide demi-resolution liee en binding 4
        // (a la place du masque webcam, que ce mode ne lit pas), au niveau `log2(coc) - 1`,
        // plafonne. LOD explicite : pas de derivees dans cette branche (`tilted_sample`).
        let rs = clamp(vec2<f32>(r.x, r.y), vec2<f32>(0.0), vec2<f32>(1.0));
        let z = (rs.x - 0.5) * layer.mb.x + (rs.y - 0.5) * layer.mb.y;
        let coc = layer.mb.w * abs(z - layer.mb.z);
        var tilt_rgb = tilted_sample(uv, coc);
        // Flou de mouvement, celui du mode 0 (cf. HLSL) : l'UV que CE pixel montrait a la frame
        // precedente, par le meme warp inverse sur les coins d'avant (`trail_a`/`trail_b`), puis
        // `taps` echantillons de celui-la a celui-ci, raccourcis de la force. Borne a une frame.
        let trail_taps = i32(layer.trail_mb.x);
        if trail_taps > 1 && layer.trail_mb.y > 0.001 {
            let rp = quad_inverse(
                i.local, layer.trail_a.xy, layer.trail_a.zw, layer.trail_b.xy, layer.trail_b.zw, layer.dst_prev.w,
            );
            let uv_prev = vec2<f32>(
                mix(layer.src.x, layer.src.z, rp.x),
                mix(layer.src.y, layer.src.w, rp.y),
            );
            let duv = (uv - uv_prev) * clamp(layer.trail_mb.y, 0.0, 1.0);
            if dot(duv, duv) >= 1e-9 {
                var acc = vec3<f32>(0.0);
                let step = 1.0 / f32(trail_taps - 1);
                for (var k: i32 = 0; k < 16; k = k + 1) {
                    if k >= trail_taps { break; }
                    acc = acc + tilted_sample(uv - duv * (1.0 - f32(k) * step), coc);
                }
                tilt_rgb = acc / f32(trail_taps);
            }
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
        var d = sd_convex_quad(i.local, v0, v1, v2, v3) - r;
        // Slot d'un layout en bloc (`dst_prev` = le slot en px locaux, `mb.w` = son rayon ; nul
        // ailleurs) : l'ombre est celle de ce qu'on voit, le plan rogne par le slot (cf. HLSL).
        if layer.dst_prev.z > layer.dst_prev.x {
            let h = (layer.dst_prev.zw - layer.dst_prev.xy) * 0.5;
            d = max(d, sd_round_rect(i.local - layer.dst_prev.xy - h, h, layer.mb.w));
        }
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
    } else if layer.mode > 17.5 {
        // Mode 18 -- ecran cadre floute en bloc (`screen_trail`).
        return screen_trail(i.pout);
    } else {
        // Mode 2 — ombre portée (SDF d'un quad arrondi élargi de `fx.x`).
        let spread = layer.fx.x;
        let halfsz = layer.quad_px * 0.5 - vec2<f32>(spread);
        let p = i.local - layer.quad_px * 0.5;
        let d = sd_round_rect(p, halfsz, layer.radius_px);
        let a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return vec4<f32>(layer.color.rgb * a, a);
    }

    // Le mode 5 range la POSITION de son premier stop dans color.a (`gradient_layer`), pas une
    // opacite : un degrade est opaque, comme dans le HLSL et le MSL, qui ne lisent pas color.a.
    // Le lire ici rendait transparent tout degrade dont le premier stop est a 0.
    var base_alpha = layer.color.a;
    if layer.mode > 4.5 && layer.mode < 5.5 {
        base_alpha = 1.0;
    }
    alpha = base_alpha * alpha_mask;

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
