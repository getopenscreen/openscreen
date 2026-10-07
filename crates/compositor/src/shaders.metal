// Compositeur — un draw par calque (quad). NV12->RGB maison (E1), coins arrondis SDF (E2).
// Port MSL strict de `crates/compositor/src/shaders.hlsl`. Le shape du constant buffer,
// les noms d'entry points, et les contrats d'interface doivent rester identiques d'un
// backend à l'autre — c'est ce qui permet à `compositor.rs::new_inner` (Windows) et à
// `compositor_macos.rs::new_sized` (macOS) de partager le même ensemble d'effets.
//
// HLSL → MSL différences notables :
//   - `cbuffer X : register(b0)` → `constant X & [[buffer(0)]]`
//   - `Texture2D<float> T : register(tN)` → `texture2d<float, access::sample> T [[texture(N)]]`
//   - `SamplerState S : register(sN)` → `sampler S [[sampler(N)]]`
//   - `SV_VertexID` → `[[vertex_id]]`, `SV_Position` (sortie) → `[[position]]`
//   - `TEXCOORDn` → champ libre de struct (MSL n'a pas de qualificateur ; on les
//     regroupe dans des structs `VSOut`/`FSOut` comme en HLSL)
//   - `T.Sample(samp, uv)` → `T.sample(samp, uv)` (sampler sur l'instance, pas en arg)
//   - `SV_Target` (sortie) → `[[color(0)]]` (ou aucun qualificateur — Metal utilise
//     l'attachement 0 par défaut, qui est ce qu'on veut pour ces 9 entry points)
//   - `saturate(x)` → `clamp(x, 0.0, 1.0)` (Metal 2.0 ; `saturate` existe en 2.4+ mais
//     on reste portable)
//   - `[unroll]` → `[[unroll]]` (sur le `for`)
//
// DIFFÉRENCE STRUCTURELLE, et c'est la seule qui n'est pas cosmétique : HLSL déclare
// `cbuffer`, `Texture2D` et `SamplerState` en portée GLOBALE, MSL ne le permet pas.
// « 'texture' attribute only applies to parameters » et « program scope variable must
// reside in constant address space » : les ressources doivent être des PARAMÈTRES de
// chaque entry point, et les helpers qui les lisent doivent les recevoir en argument.
// Un port ligne-pour-ligne des globales HLSL ne compile donc pas du tout — d'où les
// signatures ci-dessous, qui sont la seule liberté prise avec le fichier d'origine.
// (Les `constexpr sampler` restent légaux en portée globale : ils sont immuables et
// résolus à la compilation.)
//
// IMPORTANT : ce fichier est inclus via `include_str!("shaders.metal")` côté Rust et
// compilé à l'exécution via `MTLDevice.makeLibrary(source:options:)`. Le test
// `compositor_macos::tests::every_shader_entry_point_compiles` le compile sur le device
// système au `cargo test`, pour qu'une faute de syntaxe MSL ne se découvre pas à
// l'ouverture de l'éditeur chez un utilisateur.
//
// Il est compilé DEUX fois (`compositor_macos.rs::new_sized`) : tel quel pour tous les calques,
// et avec `LAYER_MODELS` défini pour les seuls modèles 3D (modes 15 à 17,
// `LayerCB::needs_models`). Un shader alloue à chaque draw les registres de sa branche la plus
// lourde, et ce sont ces modèles ray-tracés : le même `ps_main` les portait pour le fond,
// l'ombre et la vidéo, qui couvrent toute la sortie (cf. le haut de `shaders.hlsl`).

#include <metal_stdlib>
using namespace metal;

// =================================================================================
// Constant buffer — symétrique de `cbuffer Layer : register(b0)` côté HLSL.
// =================================================================================
//
// Le moteur côté CPU upload ce buffer via `setVertexBytes` (vertex stage) et
// `setFragmentBytes` (fragment stage) avant chaque draw — la copie est de 192 octets,
// ce qui est sous le seuil d'alignement 4K de Metal pour le mode « immediate ».

struct Layer
{
    float4 dst;       // x,y,w,h dans l'espace sortie 0..1 (origine haut-gauche)
    float4 src;       // u0,v0,u1,v1 dans l'espace source 0..1 ; modes 15 et 17 : décalage px du rayon, P, U
    float2 quad_px;   // taille du quad en pixels (pour les SDF)
    float  radius_px; // rayon des coins arrondis en px (0 = aucun) ; mode 17 : rayon des coins hauts du corps (unités du modèle)
    float  mode;      // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre portée, ..., 15 = curseur 3D, 16 = impact du clic, 17 = appareil modelé, 18 = écran cadré flouté en bloc
    float4 color;     // couleur pleine / teinte (ombre : rgb + opacité dans a) ; mode 15 : coin du sprite, texel, opacité ; mode 17 : .r = l'appareil (1 portable, 2 téléphone, 3 moniteur), .g = thème sombre, .b = rayon des coins bas du corps, .a = opacité
    float4 fx;        // fx.x = spread ombre (px), fx.y,fx.z libres ; mode 15 : rotation du plan (rad), tangage ; mode 17 : rotation du plan (rad), épaisseur
    float4 src_prev;  // src à la frame précédente (flou de mouvement par vélocité) ; mode 15 : hotspot, lacet ; mode 17 : marges du corps (unités du modèle)
    float4 dst_prev;  // dst à la frame précédente ; modes 13 et 15 : rect de clip ; mode 17 : angle du socle, rayon et recouvrement de l'ouverture, pénombre de l'ombre
    float4 mb;        // mb.x = nombre de taps de motion blur (1 = désactivé) ; modes 15 et 17 : demi-taille du plan, translation ; mode 18 : .z = 1 si le plan est incliné, .w = 1 si son warp est projectif
    float4 trail_a;   // mode 8 : coins TL, TR du plan à la frame précédente (px locaux, comme fx) ; mode 18 incliné : en fractions de sortie
    float4 trail_b;   // mode 8 : coins BR, BL du plan à la frame précédente (comme src_prev) ; mode 18 incliné : en fractions de sortie
    float4 trail_mb;  // mode 8 : x = taps, y = force du flou de mouvement (ceux du mode 0) ; 0 ailleurs
    float4 cover;     // x = desk-view cover 0..1, y = blur radius (quad px), z = dim, w unused
};
// Mode 15 (curseur modélisé) : le détail des emplacements est dans `frame_geometry.rs`, en tête
// de la section « Curseur modélisé » (`cursor_model_cb`). Mode 17 (appareil modelé) : en tête de
// « Appareils modelés » (`device_frame_cb`), et résumé au-dessus de `device_frame` dans le HLSL.

// `layer` est passé en `constant Layer& [[buffer(0)]]` à chaque entry point qui le lit
// (cf. la note « DIFFÉRENCE STRUCTURELLE » en tête de fichier). Côté Rust, il est lié par
// `set_vertex_bytes(0, …)` ET `set_fragment_bytes(0, …)` : `vs_main` le lit autant que
// `ps_main`.

// =================================================================================
// Vertex stage : quads à partir de `SV_VertexID`, fullscreen triangle pour fs pass.
// =================================================================================

struct VSOut
{
    float4 pos   [[position]];
    float2 uv    [[user(TEXCOORD0)]]; // coords d'échantillonnage source
    float2 local [[user(TEXCOORD1)]]; // coords pixel dans le quad (pour SDF)
    float2 pout  [[user(TEXCOORD2)]]; // position 0..1 sortie (pour la vélocité par pixel)
};

vertex VSOut vs_main(uint vid [[vertex_id]],
                     constant Layer &layer [[buffer(0)]])
{
    float2 c = float2(vid & 1, (vid >> 1) & 1); // strip: (0,0)(1,0)(0,1)(1,1)
    float2 p = layer.dst.xy + c * layer.dst.zw; // 0..1 sortie
    float2 ndc = float2(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    VSOut o;
    o.pos = float4(ndc, 0.0, 1.0);
    o.uv = layer.src.xy + c * (layer.src.zw - layer.src.xy);
    o.local = c * layer.quad_px;
    o.pout = p;
    return o;
}

// =================================================================================
// Textures et samplers.
// =================================================================================

// `mip_filter::linear` n'est PAS décoratif : sans lui MSL retombe sur `mip_filter::none`,
// et `sample(..., level(lod))` rend le mip 0 quel que soit `lod`. Le masque « flou »
// d'annotation (mode 10) échantillonne la pyramide de mips de la copie du RT — sans ce
// filtre il ne floute rien, alors que la mosaïque, qui demande explicitement `level(0)`,
// marche par accident. Équivalent de `D3D11_FILTER_MIN_MAG_MIP_LINEAR` côté Windows.
constexpr sampler samp(filter::linear, mip_filter::linear, address::clamp_to_edge);
constexpr sampler sampNV(filter::linear, address::clamp_to_edge);

// Plafond de la profondeur de champ du mode 8, en niveau de la pyramide demi-résolution.
// Même valeur que `DOF_MAX_LOD` du HLSL.
constant float DOF_MAX_LOD = 1.5;

// Slots de texture, tenus par les paramètres des entry points :
//   ps_main      : 0 = texY (Y, R8), 1 = texUV (CbCr, RG8), 2 = texImg (RGBA), 3 = texMask (R8),
//                  4 = texSdf (champ du sprite de curseur, R16F, mode 15),
//                  5 = texDof (pyramide de profondeur de champ, RGBA, modes 8 et 18)
//   ps_fs_*      : 0 = rgbTex (RGBA)

// =================================================================================
// Helpers : conversions couleur, primitives SDF.
// =================================================================================

// BT.709 limited -> RGB (§7 E1), matrice en dur, range mesuré en S1.
inline float3 yuv709_limited(float y, float2 cbcr)
{
    float Yf = (y * 255.0 - 16.0) / 219.0;
    float Cb = (cbcr.x * 255.0 - 128.0) / 224.0;
    float Cr = (cbcr.y * 255.0 - 128.0) / 224.0;
    float3 rgb;
    rgb.r = Yf + 1.5748 * Cr;
    rgb.g = Yf - 0.1873 * Cb - 0.4681 * Cr;
    rgb.b = Yf + 1.8556 * Cb;
    return clamp(rgb, 0.0, 1.0);
}

// `texture2d<float>::sample` rend TOUJOURS un `float4` en MSL, là où le HLSL
// `Texture2D<float>` rend un scalaire : d'où les `.r` / `.rg` que le port d'origine
// n'avait pas (et qui ne compilaient pas).
inline float3 sample_yuv(float2 uv,
                         texture2d<float, access::sample> texY,
                         texture2d<float, access::sample> texUV)
{
    float y = texY.sample(samp, uv).r;
    float2 cbcr = texUV.sample(samp, uv).rg;
    return yuv709_limited(y, cbcr);
}

// SDF segment à bouts ronds — la primitive des flèches d'annotation.
inline float sd_segment(float2 p, float2 a, float2 b)
{
    float2 pa = p - a;
    float2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// SDF rectangle à coins arrondis (§7 E2) : <0 dedans.
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
inline float sd_round_rect(float2 p, float2 halfsz, float r)
{
    float hmin = min(halfsz.x, halfsz.y);
    float2 q0 = abs(p) - halfsz;
    // Hors des coins, la distance est celle du rectangle vif quel que soit l'exposant : un seul
    // axe déborde de l'étendue E, qui s'y ajoute puis s'en retranche. E ne dépasse pas 1,42 r
    // (n = 3) : sous 1,5 r du bord sur un axe, on rend la boîte sans calculer `n` ni E, deux
    // transcendantes de moins sur presque tous les pixels d'un calque arrondi.
    if (r <= 0.0 || hmin <= 0.0 || min(q0.x, q0.y) <= -min(1.5 * r, hmin))
    {
        return length(max(q0, 0.0)) + min(max(q0.x, q0.y), 0.0);
    }
    float n = 3.0 - smoothstep(0.5, 1.0, r / hmin);
    float e = min(r * 0.29289322 / (1.0 - exp2(-1.0 / n)), hmin);
    float2 q = abs(p) - halfsz + e;
    float2 m = max(q, 0.0);
    if (m.x > 0.0 && m.y > 0.0)
    {
        float len = pow(pow(m.x, n) + pow(m.y, n), 1.0 / n);
        float2 g = pow(m / len, float2(n - 1.0));
        return (len - e) / length(g);
    }
    return max(m.x, m.y) + min(max(q.x, q.y), 0.0) - e;
}

// L'écran sous le chrome de FENÊTRE (modes 0 et 8) : coins HAUTS carrés, rognés par l'arc du
// cadre quand le rayon dépasse la barre. Port de `sd_screen_under_bar` (HLSL), qui fait foi.
inline float sd_screen_under_bar(float2 p, float2 halfsz, float r, float lift)
{
    float own = sd_round_rect(p, halfsz, (p.y < 0.0) ? 0.0 : r);
    float2 up = float2(0.0, lift * 0.5);
    return max(own, sd_round_rect(p + up, halfsz + up, r));
}

// Couverture du quad avec coins arrondis, pour les modes qui retournent AVANT la queue de
// `ps_main` (5 gradient, 6 image). Ils s'en passaient tant qu'ils ne servaient qu'au fond plein
// cadre, qui n'a pas de rayon ; depuis que la bulle webcam peut porter un dégradé ou une image,
// sans ça le fond déborde en carré opaque sur les coins arrondis de la bulle et mange l'ombre.
// Renvoie 1.0 quand aucun rayon n'est demandé — le fond plein cadre est donc inchangé.
inline float quad_round_alpha(float2 local, float2 quad_px, float radius_px)
{
    if (radius_px <= 0.0 || quad_px.x <= 0.0 || quad_px.y <= 0.0)
    {
        return 1.0;
    }
    float2 halfsz = quad_px * 0.5;
    float d = sd_round_rect(local - halfsz, halfsz, radius_px);
    return 1.0 - smoothstep(0.0, 1.5, d); // même feather ~1.5px que la queue
}

// Le slot d'un layout en bloc, qui rogne le plan incliné (mode 8, cf. HLSL). Négatif : coins
// HAUTS carrés, sous la barre de la fenêtre qui le contient.
inline float slot_alpha(float2 local, float2 quad_px, float r)
{
    if (r >= 0.0)
    {
        return quad_round_alpha(local, quad_px, r);
    }
    float2 halfsz = quad_px * 0.5;
    float2 p = local - halfsz;
    return 1.0 - smoothstep(0.0, 1.5, sd_round_rect(p, halfsz, (p.y < 0.0) ? 0.0 : -r));
}

// Intersection de deux droites données par (normale, offset) : n·x = d. Cramer.
inline float2 line_cross(float2 n1, float d1, float2 n2, float d2)
{
    float det = n1.x * n2.y - n1.y * n2.x;
    if (abs(det) < 1e-6) return float2(0.0, 0.0);
    return float2(d1 * n2.y - d2 * n1.y, d2 * n1.x - d1 * n2.x) / det;
}

// Distance signée EXACTE à un quadrilatère convexe (<0 dedans).
inline float sd_convex_quad(float2 p, float2 v0, float2 v1, float2 v2, float2 v3)
{
    float2 v0n = v0, v1n = v1, v2n = v2, v3n = v3, v4n = v0;
    float inside = -1e9;
    float border = 1e9;
    for (int k = 0; k < 4; k++)
    {
        float2 a;
        float2 e_next;
        if (k == 0) { a = v0n; e_next = v1n; }
        else if (k == 1) { a = v1n; e_next = v2n; }
        else if (k == 2) { a = v2n; e_next = v3n; }
        else { a = v3n; e_next = v4n; }
        float2 e = e_next - a;
        float2 n = float2(e.y, -e.x) / max(length(e), 1e-6);
        inside = max(inside, dot(p - a, n));
        border = min(border, sd_segment(p, a, e_next));
    }
    return (inside < 0.0) ? -border : border;
}

// (s, t, ok) du warp inverse du mode 8 pour une racine `t` donnée.
inline float3 quad_st_for_root(float t, float2 e, float2 f, float2 g, float2 h)
{
    float denomX = e.x + g.x * t;
    float denomY = e.y + g.y * t;
    float s = (abs(denomX) > abs(denomY)) ? (h.x - f.x * t) / denomX : (h.y - f.y * t) / denomY;
    float ok = (s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02) ? 1.0 : 0.0;
    return float3(s, t, ok);
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 : le warp bilinéaire INVERSE.
// `ok` = −1 quand `P` n'a AUCUN antécédent (au-delà du pli du warp) : (s, t) n'y veut rien dire,
// et ce n'est pas l'origine du plan (cf. HLSL, qui fait foi).
inline float3 quad_inverse_bilinear(float2 P, float2 c00, float2 c10, float2 c11, float2 c01)
{
    float2 e = c10 - c00;
    float2 f = c01 - c00;
    float2 g = c00 - c10 - c01 + c11;
    float2 h = P - c00;
    float k2 = g.x * f.y - g.y * f.x;
    float k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    float k0 = h.x * e.y - h.y * e.x;
    if (abs(k2) < 1e-5 * abs(k1))
    {
        // k1 nul aussi : l'équation ne fixe plus `t`, aucun point à rendre.
        if (abs(k1) < 1e-6) return float3(0.0, 0.0, -1.0);
        return quad_st_for_root(-k0 / k1, e, f, g, h);
    }
    float disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) return float3(0.0, 0.0, -1.0);
    float q = -0.5 * (k1 + (k1 >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
    float3 r0 = quad_st_for_root(q / k2, e, f, g, h);
    float3 r1 = quad_st_for_root(abs(q) > 0.0 ? k0 / q : q / k2, e, f, g, h);
    return (r0.z > 0.5) ? r0 : r1;
}

// (s, t, ok) du point `P` par l'homographie EXACTE du carré unité sur le quad (forme de Heckbert,
// relative à c00), résolue à l'envers par Cramer : la projection d'un plan par la caméra réelle.
// Cf. commentaires HLSL.
inline float3 quad_inverse_projective(float2 P, float2 c00, float2 c10, float2 c11, float2 c01)
{
    float2 p1 = c10 - c00;
    float2 p2 = c11 - c00;
    float2 p3 = c01 - c00;
    float2 d1 = p1 - p2;
    float2 d2 = p3 - p2;
    float2 d3 = p2 - p1 - p3;
    float den = d1.x * d2.y - d2.x * d1.y;
    float g = (d3.x * d2.y - d2.x * d3.y) / den;
    float h = (d1.x * d3.y - d3.x * d1.y) / den;
    float2 q = P - c00;
    float m00 = p1.x * (1.0 + g) - g * q.x;
    float m01 = p3.x * (1.0 + h) - h * q.x;
    float m10 = p1.y * (1.0 + g) - g * q.y;
    float m11 = p3.y * (1.0 + h) - h * q.y;
    float det = m00 * m11 - m01 * m10;
    float s = (q.x * m11 - m01 * q.y) / det;
    float t = (m00 * q.y - q.x * m10) / det;
    float ok = (s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02) ? 1.0 : 0.0;
    return float3(s, t, ok);
}

// Warp inverse d'un calque posé sur le plan : projectif sous la caméra réelle ou un appareil
// (`projective` = 1), bilinéaire sous un angle fixe, inchangé.
// `ok` : 1 dans le quad, 0 dehors, −1 sans antécédent (`quad_inverse_bilinear`).
inline float3 quad_inverse(float2 P, float2 c00, float2 c10, float2 c11, float2 c01, float projective)
{
    if (projective > 0.5)
    {
        return quad_inverse_projective(P, c00, c10, c11, c01);
    }
    return quad_inverse_bilinear(P, c00, c10, c11, c01);
}

// Le point (s, t) du plan dans le quad : le warp de `quad_inverse` dans le sens direct, prolongé
// hors du carré unité. Miroir du HLSL et de `TiltedQuad::point_px`.
inline float2 quad_forward(float2 st, float2 c00, float2 c10, float2 c11, float2 c01, float projective)
{
    if (projective > 0.5)
    {
        float2 p1 = c10 - c00;
        float2 p2 = c11 - c00;
        float2 p3 = c01 - c00;
        float2 d1 = p1 - p2;
        float2 d2 = p3 - p2;
        float2 d3 = p2 - p1 - p3;
        float den = d1.x * d2.y - d2.x * d1.y;
        float g = (d3.x * d2.y - d2.x * d3.y) / den;
        float h = (d1.x * d3.y - d3.x * d1.y) / den;
        return c00 + (p1 * (1.0 + g) * st.x + p3 * (1.0 + h) * st.y) / (g * st.x + h * st.y + 1.0);
    }
    return c00 + st.x * (c10 - c00) + st.y * (c01 - c00) + st.x * st.y * (c00 - c10 - c01 + c11);
}

// Un échantillon de l'écran incliné (mode 8) : la vidéo nette, fondue vers la pyramide de
// profondeur de champ (texture(5)) au-delà d'un demi-texel de cercle de confusion `coc`. Sous ce
// seuil, l'échantillon net d'avant, à l'octet. Miroir de `tilted_sample` (HLSL).
inline float3 tilted_sample(float2 uv, float coc,
                            texture2d<float, access::sample> texY,
                            texture2d<float, access::sample> texUV,
                            texture2d<float, access::sample> texDof)
{
    float3 rgb = sample_yuv(uv, texY, texUV);
    if (coc > 0.5)
    {
        float lod = clamp(log2(coc) - 1.0, 0.0, DOF_MAX_LOD);
        float3 far_rgb = texDof.sample(samp, uv, level(lod)).rgb;
        rgb = mix(rgb, far_rgb, clamp((coc - 0.5) / 1.5, 0.0, 1.0));
    }
    return rgb;
}

// Couverture d'une pastille (disque) adoucie sur ~1.5 px, pour la barre de titre du mode 14.
inline float disc_cov(float2 p, float2 c, float r)
{
    return 1.0 - smoothstep(r - 0.75, r + 0.75, length(p - c));
}

// Couverture d'un trait centré sur `x = 0`, de demi-épaisseur `half_w`, sur ~1 px.
inline float band_cov(float x, float half_w)
{
    return clamp(half_w + 0.5 - abs(x), 0.0, 1.0);
}

// =================================================================================
// Pixel shader principal : un seul `ps_main` qui gère 15 modes via `layer.mode`.
// Identique à `ps_main` côté HLSL ligne pour ligne (à la syntaxe MSL près).
// =================================================================================

// Fond floute du mode "blur" webcam. Miroir de `blur_webcam_bg` cote HLSL : memes 25 taps,
// memes poids, meme rayon — les deux back-ends doivent rendre le meme pixel.
// Fond flouté pour le mode "blur" de la webcam.
// Disque de Vogel (spirale à angle d'or) à 21 échantillons avec pondération gaussienne et
// rotation par pixel via Interleaved Gradient Noise (IGN) pour un bokeh photographique doux, isotrope et rapide.
constant float3 VOGEL_TAPS[21] = {
    float3( 0.154303,  0.000000, 0.942213),
    float3(-0.197070,  0.180532, 0.836464),
    float3( 0.030165, -0.343712, 0.742584),
    float3( 0.248394,  0.323986, 0.659241),
    float3(-0.455834, -0.080631, 0.585251),
    float3( 0.431806, -0.274679, 0.519566),
    float3(-0.144431,  0.537274, 0.461253),
    float3(-0.275445, -0.530352, 0.409484),
    float3( 0.597605,  0.218244, 0.363526),
    float3(-0.621708,  0.256632, 0.322726),
    float3( 0.299704, -0.640451, 0.286505),
    float3( 0.221474,  0.706094, 0.254349),
    float3(-0.667525, -0.386844, 0.225802),
    float3( 0.783083, -0.172159, 0.200460),
    float3(-0.477903,  0.679768, 0.177961),
    float3(-0.110407, -0.852001, 0.157988),
    float3( 0.677789,  0.571241, 0.140256),
    float3(-0.912091,  0.037718, 0.124514),
    float3( 0.665301, -0.662063, 0.110540),
    float3(-0.044511,  0.962596, 0.098133),
    float3(-0.633036, -0.758588, 0.087119)
};

// Vogel-disc blur of the camera texture at a radius in quad pixels. `valid` is the part of the
// texture the picture fills (fx.xy): decoders allocate aligned textures (a 1080-line camera in a
// 1088-line texture), so each tap is clamped half a chroma texel inside it, never into padding.
inline float3 blur_webcam_radius(float2 uv, float max_r_px, float2 qpx, float2 local_px,
                                 float2 valid,
                                 texture2d<float, access::sample> texY,
                                 texture2d<float, access::sample> texUV)
{
    float2 step = max_r_px / max(qpx, float2(1.0));
    float2 chroma = max(float2(float(texUV.get_width()), float(texUV.get_height())), float2(1.0));
    float2 hi = max(valid - 0.5 / chroma, float2(0.0));
    float noise = fract(52.9829189 * fract(0.06711056 * local_px.x + 0.00583715 * local_px.y));
    float angle = noise * 6.2831853;
    float s = sin(angle);
    float c = cos(angle);
    float3 sum = float3(0.0);
    float total = 0.0;
    for (int k = 0; k < 21; k++)
    {
        float2 p = VOGEL_TAPS[k].xy;
        float w = VOGEL_TAPS[k].z;
        float2 rot_p = float2(p.x * c - p.y * s, p.x * s + p.y * c);
        sum += sample_yuv(clamp(uv + rot_p * step, float2(0.0), hi), texY, texUV) * w;
        total += w;
    }
    return sum / max(total, 1e-4);
}

inline float3 blur_webcam_bg(float2 uv, float intensity, float2 qpx, float2 local_px,
                             float2 valid,
                             texture2d<float, access::sample> texY,
                             texture2d<float, access::sample> texUV)
{
    return blur_webcam_radius(uv, max(intensity, 0.0) * 22.0 + 1.5, qpx, local_px, valid, texY,
                              texUV);
}

// Hash 2D -> [0,1) sans sin(). Miroir de `hash12` côté HLSL.
inline float hash12(float2 p)
{
    float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Bruit de valeur lissé (hermite), sans texture. Miroir de `value_noise` côté HLSL.
inline float value_noise(float2 q)
{
    float2 i = floor(q);
    float2 f = fract(q);
    float2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + float2(1.0, 0.0));
    float c = hash12(i + float2(0.0, 1.0));
    float d = hash12(i + float2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Rampe du mode 5 à quatre nœuds. Miroir de `ramp4` côté HLSL (commentaires complets là-bas).
inline float3 ramp4(float t, float4 k0, float4 k1, float4 k2, float4 k3)
{
    float3 c = k0.rgb;
    c = mix(c, k1.rgb, clamp((t - k0.w) / max(k1.w - k0.w, 1e-5), 0.0, 1.0));
    c = mix(c, k2.rgb, clamp((t - k1.w) / max(k2.w - k1.w, 1e-5), 0.0, 1.0));
    c = mix(c, k3.rgb, clamp((t - k2.w) / max(k3.w - k2.w, 1e-5), 0.0, 1.0));
    return c;
}

// Éclaircit vers le blanc (k > 0) ou assombrit vers le noir (k < 0) d'une fraction |k|.
inline float3 lighten(float3 c, float k)
{
    return k > 0.0 ? c + (1.0 - c) * k : c * (1.0 + k);
}

// Les trois nappes de l'aurore. Miroir de `aurora_blobs` côté HLSL.
inline float3 aurora_blobs(float2 p, float time, float aspect)
{
    const float TAU = 6.2831853;
    float2 b0 = float2(0.35 * aspect * sin(TAU * time / 10.0), 0.25 * sin(TAU * time / 15.0 + 1.0));
    float2 b1 = float2(0.30 * aspect * sin(TAU * time / 12.0 + 2.0), 0.22 * cos(TAU * time / 20.0));
    float2 b2 = float2(0.25 * aspect * cos(TAU * time / 15.0 + 4.0), 0.28 * sin(TAU * time / 12.0 + 3.0));
    return float3(exp(-dot(p - b0, p - b0) / 0.176), exp(-dot(p - b1, p - b1) / 0.132),
                  exp(-dot(p - b2, p - b2) / 0.11));
}

// Mouvements 2 (aurore) et 3 (vagues) du mode 5. Miroir ligne pour ligne de
// `gradient_motion` côté HLSL (commentaires complets là-bas).
inline float3 gradient_motion(float2 gp, float2 dir, float denom, float4 k0, float4 k1,
                              float4 k2, float4 k3, float time, float motion, float aspect)
{
    const float TAU = 6.2831853;
    float u = dot(gp - 0.5, dir) / denom; // position le long de l'axe, -0.5..0.5
    if (motion < 2.5)
    {
        // Aurore : rampe perturbée par un bruit, puis trois larges nappes gaussiennes.
        float2 p = float2((gp.x - 0.5) * aspect, gp.y - 0.5);
        float ph = TAU * time / 30.0;
        float n = value_noise(p * 1.8 + 1.5 * float2(cos(ph), sin(ph)));
        float3 g = ramp4(clamp(0.5 + u + 0.6 * (n - 0.5), 0.0, 1.0), k0, k1, k2, k3);
        float3 blobs = aurora_blobs(p, time, aspect);
        float3 light = lighten(k3.rgb, 0.15);
        g = mix(g, light, 0.7 * blobs.x);
        g = mix(g, lighten(k0.rgb, -0.15), 0.7 * blobs.y);
        g = mix(g, light, 0.6 * blobs.z);
        return g;
    }
    // Vagues : trois bandes sinus perpendiculaires à l'axe (6 s), ondulées (10 s), crêtes éclairées.
    float v = dot(gp - 0.5, float2(-dir.y, dir.x)) / denom;
    float w = sin(TAU * (3.0 * u + 0.04 * sin(TAU * (1.5 * v + time / 10.0)) - time / 6.0));
    return lighten(ramp4(clamp(0.5 + u + 0.18 * w, 0.0, 1.0), k0, k1, k2, k3), 0.07 * w);
}

// Les mêmes mouvements sur une image (mode 6). Miroir ligne pour ligne de `image_motion` côté
// HLSL (commentaires complets là-bas) : rend `q` déplacé (xy) et l'éclairage (z).
inline float3 image_motion(float2 q, float time, float motion, float aspect)
{
    const float TAU = 6.2831853;
    if (motion < 1.5)
    {
        // Dérive : zoom lent entre 8 et 22 % (20 s), panoramique dans sa marge (15 et 24 s).
        float z = 1.15 + 0.07 * sin(TAU * time / 20.0);
        float m = 0.375 * (1.0 - 1.0 / z);
        return float3(q / z + m * float2(sin(TAU * time / 15.0), cos(TAU * time / 24.0)), 0.0);
    }
    if (motion < 2.5)
    {
        // Aurore : écoulement sous un bruit de ±3 %, éclairé par les nappes.
        float2 p = float2(q.x * aspect, q.y);
        float ph = TAU * time / 30.0;
        float2 c = p * 1.6 + 1.5 * float2(cos(ph), sin(ph));
        float2 flow = float2(value_noise(c), value_noise(c + float2(5.2, 1.3))) - 0.5;
        float3 blobs = aurora_blobs(p, time, aspect);
        return float3(q / 1.08 + 0.06 * flow, 0.12 * (blobs.x - blobs.y + 0.85 * blobs.z));
    }
    // Vagues : bandes à 135° qui ondulent l'image de ±0,85 % et éclairent leurs crêtes.
    float2 d = float2(0.7071068, 0.7071068);
    float u = dot(q, d) / 1.4142136;
    float v = dot(q, float2(-d.y, d.x)) / 1.4142136;
    float w = sin(TAU * (3.0 * u + 0.04 * sin(TAU * (1.5 * v + time / 10.0)) - time / 6.0));
    return float3(q / 1.06 + 0.012 * w * d, 0.07 * w);
}

// ============ Curseur MODÉLISÉ (mode 15) ============
// Port ligne pour ligne de `cursor_model` (HLSL), dont les commentaires font foi ; seules
// différences : `layer` et les textures arrivent en paramètres (le sprite en texture(2), son
// champ R16F en texture(4), la copie de l'image composée en texture(5) pour le cristal de Prism
// Glow),
// `lerp` s'écrit `mix`, `SampleLevel` s'écrit `sample(…, level(0.0))`, un `out` s'écrit `thread &`,
// et `pow` veut un exposant du type de sa base.
// Constantes : miroir exact de `frame_geometry.rs` (MODEL_*) et de `sculpt.rs` (SCULPT_*).
constant float MODEL_BEVEL = 0.045;
constant float3 MODEL_LIGHT = float3(-0.4194, -0.5792, 0.6990);
constant float3 MODEL_FILL = float3(0.7557, 0.2519, 0.6046);
// Ambiance et diffus de l'appareil modelé (mode 17), qui garde son éclairage d'origine.
constant float MODEL_AMBIENT = 0.36;
constant float MODEL_DIFFUSE = 0.75;
constant float MODEL_RIM_INSET = 1.5;
constant float MODEL_SOFTNESS = 6.0;
constant float MODEL_SHADOW_PAD = 0.45;
constant float MODEL_SHADOW_ALPHA = 0.5;
constant float MODEL_CONTACT_RADIUS = 0.12;
constant float MODEL_CONTACT_ALPHA = 0.5;

// Taille du sprite, repère du modèle : son plus grand côté vaut 1, `radius_px` porte w/h.
inline float2 sprite_size(constant Layer &layer)
{
    return float2(min(layer.radius_px, 1.0), min(1.0 / layer.radius_px, 1.0));
}

// Un texel du sprite, en unités du modèle : le champ est le sprite suréchantillonné ×4.
constant float CURSOR_SDF_UPSAMPLE = 4.0;
inline float sprite_texel(texture2d<float, access::sample> texSdf)
{
    return CURSOR_SDF_UPSAMPLE / float(max(texSdf.get_width(), texSdf.get_height()));
}

// Épaisseur sous z = 0 (`SpriteShape::thick`), écrasée au clic de `color.b`.
inline float model_thick(constant Layer &layer)
{
    return layer.trail_a.y * layer.color.b;
}

// Le curseur sculpté de ce dessin (`SpriteShape::sculpt`), 0 = le sprite extrudé.
inline int sculpt_id(constant Layer &layer)
{
    return int(layer.trail_a.x + 0.5);
}

// ---- Curseurs sculptés ---- (repère du PROTOTYPE : hauteur 1, y vers le haut, écran en z = 0)
constant float SCULPT_SCALE = 0.85;
constant float SCULPT_HOVER = 0.05;
constant float SCULPT_VOX = 0.0625;
constant float SCULPT_ZREF_ARROW = 0.2;
constant float SCULPT_ZREF_HAND = 0.185;
constant float SCULPT_LAMP_DIST = 1.9;
constant float3 SCULPT_SCREEN = float3(0.32, 0.32, 0.32);

inline float3 s_lin(float r, float g, float b)
{
    return pow(float3(r, g, b), float3(2.2));
}

inline float s_smin(float a, float b, float k)
{
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}

inline float2 s_opu(float2 a, float2 b)
{
    return a.x < b.x ? a : b;
}

static float s_round_box(float3 p, float3 b, float r)
{
    float3 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

static float s_ellipsoid(float3 p, float3 r)
{
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / k1;
}

// Extrusion d'une distance 2D à arêtes arrondies : demi-hauteur h, rayon r.
static float s_extrude(float d2, float z, float h, float r)
{
    float2 w = float2(d2 + r, abs(z) - h + r);
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - r;
}

inline float2 s_rot(float2 v, float a)
{
    float c = cos(a), s = sin(a);
    return float2(c * v.x - s * v.y, s * v.x + c * v.y);
}

static float s_star5(float2 p, float r, float rf)
{
    const float2 k1 = float2(0.809016994375, -0.587785252292);
    const float2 k2 = float2(-0.809016994375, -0.587785252292);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    float2 ba = rf * float2(-k1.y, k1.x) - float2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

static float s_vesica(float2 p, float r, float d)
{
    p = abs(p);
    float b = sqrt(r * r - d * d);
    return (p.y - b) * d > p.x * b ? length(p - float2(0.0, b)) : length(p + float2(d, 0.0)) - r;
}

// Curseurs cercles (cf. HLSL) : Studio Ink, Pop Coral, Star Sprout.
constant float2 RIM_POLY[28] = {
    float2(0.0, -0.06), float2(0.0, -0.7712), float2(0.165, -0.6325), float2(0.313, -0.9318),
    float2(0.4234, -0.8557), float2(0.2672, -0.5686), float2(0.456, -0.5393),
    float2(-0.173, -0.5237), float2(-0.016, -0.75), float2(0.329, -0.75), float2(0.411, -0.592),
    float2(0.411, -0.43), float2(0.19, -0.435), float2(-0.03, -0.44),
    float2(-0.1825, -0.6215), float2(0.0037, -0.9195), float2(0.3462, -0.9195), float2(0.467, -0.6906),
    float2(0.467, -0.49), float2(0.2, -0.49), float2(-0.03, -0.49),
    float2(-0.1807, -0.5534), float2(0.0194, -0.872), float2(0.3485, -0.872), float2(0.47, -0.6795),
    float2(0.47, -0.49), float2(0.2, -0.49), float2(-0.03, -0.49)
};

constant float4 RIM_GLOVE[27] = {
    float4(0.0, -0.1077, 0.0, -0.6), float4(0.1493, -0.3279, 0.1493, -0.6),
    float4(0.2863, -0.3654, 0.2863, -0.6), float4(0.4193, -0.4043, 0.4193, -0.6),
    float4(-0.2, -0.478, -0.075, -0.625), float4(0.0788, -0.25, 0.0788, -0.3992),
    float4(0.2188, -0.3, 0.2188, -0.4234), float4(0.3552, -0.33, 0.3552, -0.4534),
    float4(-0.0845, -0.5386, 0.762, 0.648),
    float4(0.0, -0.1186, 0.0, -0.65), float4(0.1614, -0.3838, 0.1614, -0.65),
    float4(0.3177, -0.427, 0.3177, -0.65), float4(0.4645, -0.4848, 0.4645, -0.65),
    float4(-0.215, -0.535, -0.1208, -0.6864), float4(0.0832, -0.3, 0.0832, -0.48),
    float4(0.2414, -0.35, 0.2414, -0.482), float4(0.3959, -0.41, 0.3959, -0.533),
    float4(-0.122, -0.5718, 0.867, 0.498),
    float4(0.0, -0.122, 0.0, -0.65), float4(0.172, -0.387, 0.172, -0.65),
    float4(0.3267, -0.427, 0.3267, -0.65), float4(0.4727, -0.4867, 0.4727, -0.65),
    float4(-0.199, -0.483, -0.102, -0.645), float4(0.0927, -0.3, 0.0927, -0.476),
    float4(0.2493, -0.35, 0.2493, -0.478), float4(0.402, -0.41, 0.402, -0.52),
    float4(-0.0993, -0.5267, 0.858, 0.514)
};

constant float4 RIM_GLOVE_R[9] = {
    float4(0.0552, 0.047, 0.045, 0.0375), float4(0.052, 0.0235, 0.0225, 0.0225), float4(0.0552, -0.548, 0.0525, 0.0),
    float4(0.064, 0.0585, 0.0585, 0.0515), float4(0.06, 0.0197, 0.0178, 0.0172), float4(0.0648, -0.6, 0.058, 0.0),
    float4(0.066, 0.0553, 0.0553, 0.0507), float4(0.063, 0.024, 0.022, 0.02), float4(0.0647, -0.555, 0.056, 0.0)
};

static float s_rim_poly(float2 p, int base)
{
    float d = dot(p - RIM_POLY[base], p - RIM_POLY[base]);
    float s = 1.0;
    int j = base + 6;
    for (int i = base; i < base + 7; i++)
    {
        float2 e = RIM_POLY[j] - RIM_POLY[i];
        float2 w = p - RIM_POLY[i];
        float2 b = w - e * saturate(dot(w, e) / dot(e, e));
        d = min(d, dot(b, b));
        bool c0 = p.y >= RIM_POLY[i].y;
        bool c1 = p.y < RIM_POLY[j].y;
        bool c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2))
        {
            s = -s;
        }
        j = i;
    }
    return s * sqrt(d);
}

static float2 s_rim_glove(float2 p, int g, float palm)
{
    float4 r0 = RIM_GLOVE_R[3 * g];
    float4 r1 = RIM_GLOVE_R[3 * g + 1];
    float4 r2 = RIM_GLOVE_R[3 * g + 2];
    int i = 9 * g;
    float f = min(sd_segment(p, RIM_GLOVE[i].xy, RIM_GLOVE[i].zw) - r0.x,
                  sd_segment(p, RIM_GLOVE[i + 1].xy, RIM_GLOVE[i + 1].zw) - r0.y);
    f = min(f, sd_segment(p, RIM_GLOVE[i + 2].xy, RIM_GLOVE[i + 2].zw) - r0.z);
    f = min(f, sd_segment(p, RIM_GLOVE[i + 3].xy, RIM_GLOVE[i + 3].zw) - r0.w);
    f = min(f, sd_segment(p, RIM_GLOVE[i + 4].xy, RIM_GLOVE[i + 4].zw) - r1.x);
    float grooves = min(sd_segment(p, RIM_GLOVE[i + 5].xy, RIM_GLOVE[i + 5].zw) - r1.y,
                        sd_segment(p, RIM_GLOVE[i + 6].xy, RIM_GLOVE[i + 6].zw) - r1.z);
    grooves = min(grooves, sd_segment(p, RIM_GLOVE[i + 7].xy, RIM_GLOVE[i + 7].zw) - r1.w);
    float sil = s_smin(palm, f, 0.03);
    float4 v = RIM_GLOVE[i + 8];
    float wedge = max(max(-dot(p - v.xy, v.zw), p.x + r2.x), r2.y - p.y);
    return float2(sil, max(sil, -min(grooves, wedge)));
}

static float2 s_piece(float d, float dc, float sil, float z, float w, float zt, float h, float bump, float mat)
{
    float tray = s_extrude(sil - w, z - 0.5 * (SCULPT_HOVER + zt), 0.5 * (zt - SCULPT_HOVER), 0.012);
    float bead = length(float2(d - 0.5 * w, z - zt)) - 0.5 * w;
    float u = saturate(-dc / 0.045);
    float cushion = 0.8 * s_extrude(dc, z - zt, h + 0.022 * u * (2.0 - u) + bump, 0.75 * h);
    return s_opu(float2(min(tray, bead), 5.0), float2(cushion, mat));
}

static float2 s_paper(float d, float sil, float z, float w)
{
    float navy = s_extrude(sil - w, z - 0.5 * (SCULPT_HOVER + 0.15), 0.5 * (0.15 - SCULPT_HOVER), 0.006);
    float sheet = s_extrude(d, z - 0.16, 0.01, 0.004);
    return s_opu(float2(navy, 5.0), float2(sheet, 1.0));
}

inline float s_bump(float2 p, float2 c, float r)
{
    float k = saturate(1.0 - dot(p - c, p - c) / (r * r));
    return k * k;
}

static float s_dash(float2 p, float2 a, float2 b, float ra, float rb)
{
    p -= a;
    b -= a;
    float hb = dot(b, b);
    float2 q = float2(abs(dot(p, float2(b.y, -b.x))), dot(p, b)) / hb;
    float2 c = float2(sqrt(hb - (ra - rb) * (ra - rb)), ra - rb);
    float k = c.x * q.y - c.y * q.x;
    if (k < 0.0)
    {
        return sqrt(hb * dot(q, q)) - ra;
    }
    if (k > c.x)
    {
        return sqrt(hb * (dot(q, q) + 1.0 - 2.0 * q.y)) - rb;
    }
    return dot(c, q) - ra;
}

static float2 s_rimmed(float3 p, int theme, int shape)
{
    bool arrow = shape == 0;
    int g = theme == 4 ? 0 : (theme == 0 ? 1 : 2);
    float poly = s_rim_poly(p.xy, arrow ? 0 : 7 * g + 7);
    float2 body = float2(poly, poly);
    float w = 0.06, zt = 0.17, h = 0.03;
    float bump = 0.022 * s_bump(p.xy, float2(0.15, -0.45), 0.3);
    float back = 1e9;
    if (!arrow)
    {
        w = RIM_GLOVE_R[3 * g + 2].z;
        for (int i = 0; i < 2; i++)
        {
            float2 q = p.xy + (i == 1 ? float2(0.03, 0.04) : float2(0.0, 0.0));
            float2 v = s_rim_glove(q, g, (i == 1 ? s_rim_poly(q, 7 * g + 7) : poly) - 0.05);
            if (i == 1)
            {
                back = v.x - w;
            }
            else
            {
                body = v;
                if (theme != 2 || v.x - w <= 0.0)
                {
                    break;
                }
            }
        }
        zt = 0.185;
        h = 0.028;
        bump = 0.03 * s_bump(p.xy, float2(0.19, -0.62), 0.28);
    }
    float dc = body.y;
    if (arrow && theme == 0)
    {
        body -= 0.015;
        w = 0.045;
        dc = 1.0;
    }
    float2 r = theme == 2 ? s_paper(body.y, body.x, p.z, w)
                          : s_piece(body.y, dc, body.x, p.z, w, zt, h, bump, 1.0);
    if (theme == 0)
    {
        if (arrow)
        {
            float band = s_extrude(abs(poly + 0.0075) - 0.0225, p.z - zt, 0.028, 0.012);
            r = s_opu(r, float2(band, 2.0));
        }
        return r;
    }
    if (theme == 2)
    {
        float dash;
        if (arrow)
        {
            float back = s_rim_poly(p.xy + float2(0.025, 0.05), 0) - 0.06;
            r = s_opu(r, float2(s_extrude(back, p.z - 0.08, 0.03, 0.006), 2.0));
            dash = min(s_dash(p.xy, float2(-0.1179, -0.1374), float2(-0.1799, -0.0443), 0.028, 0.045),
                       s_dash(p.xy, float2(-0.1347, -0.2493), float2(-0.248, -0.2056), 0.026, 0.042));
        }
        else
        {
            r = s_opu(r, float2(s_extrude(back, p.z - 0.08, 0.03, 0.006), 3.0));
            dash = min(s_dash(p.xy, float2(0.216, -0.1695), float2(0.2593, -0.0685), 0.028, 0.042),
                       s_dash(p.xy, float2(0.3054, -0.2339), float2(0.3949, -0.1652), 0.0275, 0.041));
        }
        return s_opu(r, float2(s_extrude(dash, p.z - 0.11, 0.06, 0.006), 3.0));
    }
    if (!arrow)
    {
        float2 cq = p.xy - float2(0.1541, -0.9047);
        float2 bq = abs(float2(cq.x, cq.y - 0.2066 * cq.x * cq.x)) - float2(0.214, 0.0361);
        float cuff = length(max(bq, 0.0)) + min(max(bq.x, bq.y), 0.0) - 0.03;
        r = s_opu(r, s_piece(cuff, cuff, cuff, p.z, 0.0477, 0.225, 0.025, 0.0, 2.0));
    }
    float2 c = arrow ? float2(0.6118, -0.8079) : float2(0.15, -0.885);
    float rs = arrow ? 0.1678 : 0.128;
    float zs = arrow ? 0.23 : 0.285;
    float2 q = s_rot(p.xy - c, arrow ? 0.2443 : 0.0) / rs;
    float star = (s_star5(q, 0.82, 0.55) - 0.18) * rs;
    float leaves = min(s_vesica(s_rot(q - float2(-0.33, 1.38), -0.925), 0.4296, 0.2626),
                       s_vesica(s_rot(q - float2(0.53, 1.37), 0.873), 0.4296, 0.2626)) * rs;
    r = s_opu(r, s_piece(leaves, leaves, leaves, p.z, 0.038, zs - 0.02, 0.018, 0.0, 4.0));
    r = s_opu(r, s_piece(star, star, star, p.z, 0.038, zs, 0.022, 0.018 * s_bump(q, float2(0.0), 1.0), 3.0));
    float3 e = float3(abs(q.x) - 0.25, q.y - 0.08, (p.z - zs - 0.056) / rs);
    return s_opu(r, float2(s_ellipsoid(e, float3(0.075, 0.13, 0.1)) * rs, 5.0));
}

// Pixel Candy : tables générées par scripts/generate-pixel-candy-voxels.mjs (cf. HLSL).
// <pixel-candy-voxels>
constant int PIX_BODY[32] = { 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 127, 247, 243, 480, 192, 48, 120, 120, 120, 504, 4088, 32760, 65534, 65535, 65535, 65534, 32766, 32764, 16380, 16376, 16376 };
constant int PIX_LINE[32] = { 1, 3, 5, 9, 17, 33, 65, 129, 257, 513, 1985, 73, 149, 147, 288, 192, 48, 72, 72, 72, 456, 3656, 29256, 37454, 32777, 32769, 32770, 16386, 16388, 8196, 8200, 16376 };
constant int PIX_HI[32] = { 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 18, 34, 32, 64, 0, 0, 16, 16, 16, 16, 16, 16, 16, 22, 18, 4, 4, 8, 8, 16, 0 };
constant int PIX_SHADE[32] = { 0, 0, 0, 4, 8, 16, 32, 64, 128, 448, 40, 36, 64, 64, 128, 0, 0, 32, 32, 32, 32, 288, 2336, 18720, 16384, 16384, 16384, 8192, 8192, 4096, 8160, 0 };
constant int PIX_RECT_N[3] = { 0, 17, 29 };
constant int4 PIX_GRID[2] = {
    int4(11, 16, 0, 0),
    int4(16, 16, 16, 0)
};
constant float2 PIX_ORIGIN[2] = {
    float2(0.0, 0.0),
    float2(-0.3125, 0.0)
};
constant float4 PIX_BOX[2] = {
    float4(0.3438, -0.5, 0.3438, 0.5),
    float4(0.1875, -0.5, 0.5, 0.5)
};
constant float4 PIX_RECT[29] = {
    float4(0.0313, -0.0313, 0.0313, 0.0313),
    float4(0.0625, -0.0938, 0.0625, 0.0313),
    float4(0.0938, -0.1563, 0.0938, 0.0313),
    float4(0.125, -0.2188, 0.125, 0.0313),
    float4(0.1563, -0.2813, 0.1563, 0.0313),
    float4(0.1875, -0.3438, 0.1875, 0.0313),
    float4(0.2188, -0.4063, 0.2188, 0.0313),
    float4(0.25, -0.4688, 0.25, 0.0313),
    float4(0.2813, -0.5313, 0.2813, 0.0313),
    float4(0.3125, -0.5938, 0.3125, 0.0313),
    float4(0.3438, -0.6563, 0.3438, 0.0313),
    float4(0.2188, -0.7188, 0.2188, 0.0313),
    float4(0.0938, -0.7813, 0.0938, 0.0313),
    float4(0.375, -0.8125, 0.125, 0.0625),
    float4(0.0625, -0.8438, 0.0625, 0.0313),
    float4(0.4375, -0.9063, 0.125, 0.0313),
    float4(0.4375, -0.9688, 0.0625, 0.0313),
    float4(0.0, -0.0313, 0.0625, 0.0313),
    float4(0.0, -0.1563, 0.125, 0.0938),
    float4(0.0625, -0.2813, 0.1875, 0.0313),
    float4(0.1563, -0.3438, 0.2813, 0.0313),
    float4(0.25, -0.4063, 0.375, 0.0313),
    float4(0.2188, -0.4688, 0.4688, 0.0313),
    float4(0.1875, -0.5625, 0.5, 0.0625),
    float4(0.2188, -0.6563, 0.4688, 0.0313),
    float4(0.1875, -0.7188, 0.4375, 0.0313),
    float4(0.2188, -0.7813, 0.4063, 0.0313),
    float4(0.1875, -0.8438, 0.375, 0.0313),
    float4(0.2188, -0.9375, 0.3438, 0.0625)
};
// </pixel-candy-voxels>

inline bool s_pix_bit(int m, int c)
{
    return ((m >> clamp(c, 0, 31)) & 1) == 1;
}

static bool s_pix_body(int shape, int c, int r)
{
    int4 g = PIX_GRID[shape];
    return c >= 0 && c < g.x && r >= 0 && r < g.y && s_pix_bit(PIX_BODY[g.z + clamp(r, 0, g.y - 1)], c);
}

inline int2 s_pix_cell(float2 p, int shape)
{
    float2 o = PIX_ORIGIN[shape];
    return int2(int(floor((p.x - o.x) / SCULPT_VOX)), int(floor((o.y - p.y) / SCULPT_VOX)));
}

static float2 s_voxels(float3 p, int shape)
{
    float4 b = PIX_BOX[shape];
    float2 bq = max(abs(p.xy - b.xy) - b.zw, 0.0);
    float bz = max(abs(p.z - (SCULPT_HOVER + 0.07)) - 0.07, 0.0);
    float d = max(SCULPT_VOX, sqrt(dot(bq, bq) + bz * bz));
    float2 o = PIX_ORIGIN[shape];
    int2 cell = s_pix_cell(p.xy, shape);
    const float3 cube = float3(0.5 * SCULPT_VOX, 0.5 * SCULPT_VOX, 0.07);
    for (int j = -1; j <= 1; j++)
    {
        for (int i = -1; i <= 1; i++)
        {
            int c = cell.x + i;
            int r = cell.y + j;
            if (s_pix_body(shape, c, r))
            {
                float3 q = float3(p.x - o.x - (float(c) + 0.5) * SCULPT_VOX, p.y - o.y + (float(r) + 0.5) * SCULPT_VOX,
                                  p.z - SCULPT_HOVER - 0.07);
                d = min(d, s_round_box(q, cube, 0.006));
            }
        }
    }
    return float2(d, 6.0);
}

static float s_pixel_outline(float2 p, int shape)
{
    float d = 1e9;
    for (int i = PIX_RECT_N[shape]; i < PIX_RECT_N[shape + 1]; i++)
    {
        float2 q = abs(p - PIX_RECT[i].xy) - PIX_RECT[i].zw;
        d = min(d, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0));
    }
    return d;
}

// ---- Prism Glow : un cristal en MAILLAGE ---- (cf. HLSL)
// prism mesh: generated by design/cursors/prism-glow/model/export_compositor.py
constant int PRISM_TRI_START[2] = { 0, 31 };
constant int PRISM_TRI_COUNT[2] = { 31, 130 };
constant int PRISM_SIL_START[2] = { 0, 25 };
constant int PRISM_SIL_COUNT[2] = { 25, 42 };
constant int PRISM_OUT_START[2] = { 67, 76 };
constant int PRISM_OUT_COUNT[2] = { 9, 34 };
constant int PRISM_BOX_START[2] = { 0, 4 };
constant int PRISM_BOX_COUNT[2] = { 4, 18 };
constant float4 PRISM_TRIS[644] = {
    float4(0.252301, 0.266258, -0.042945, 11.0),
    float4(-0.221166, -0.203988, 0.0, 0.01033),
    float4(-0.221166, -0.203988, 0.042945, 0.045182),
    float4(0.677984, -0.735077, 0.0, 0.577584),
    float4(0.252301, 0.266258, -0.042945, 3.0),
    float4(-0.221166, -0.203988, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(0.677984, -0.735077, 0.0, 0.577584),
    float4(0.031135, 0.06227, -0.042945, 7.0),
    float4(0.004294, 0.419785, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(-0.999948, 0.01023, 0.0, 0.577584),
    float4(0.169632, 0.356442, 0.115951, 14.0),
    float4(0.082669, -0.090184, -0.115951, 0.590616),
    float4(-0.138497, -0.294172, -0.115951, 0.737911),
    float4(0.466385, -0.505659, 0.725806, 0.973449),
    float4(0.035429, 0.482055, 0.0, 14.0),
    float4(0.134202, -0.125614, 0.115951, 0.000305),
    float4(-0.004294, -0.419785, 0.0, 0.938689),
    float4(-0.650191, 0.006652, 0.759742, 0.854994),
    float4(0.031135, 0.06227, -0.042945, 9.0),
    float4(0.004294, 0.419785, 0.0, 0.01033),
    float4(0.004294, 0.419785, 0.042945, 0.045182),
    float4(-0.999948, 0.01023, 0.0, 0.577584),
    float4(0.169632, 0.356442, 0.115951, 14.0),
    float4(0.159969, 0.080521, -0.045092, 0.381323),
    float4(0.082669, -0.090184, -0.115951, 0.056123),
    float4(0.461407, -0.510214, 0.725799, 0.973449),
    float4(0.541104, 0.544325, -0.042945, 9.0),
    float4(-0.288804, -0.278068, 0.0, 0.01033),
    float4(-0.288804, -0.278068, 0.042945, 0.045182),
    float4(0.69359, -0.72037, 0.0, 0.577584),
    float4(0.329601, 0.436963, 0.070859, 14.0),
    float4(0.211503, 0.107362, -0.070859, 0.545724),
    float4(-0.077301, -0.170706, -0.070859, 0.064805),
    float4(0.49567, -0.514808, 0.699488, 0.973449),
    float4(0.268405, 0.533589, 0.081595, 14.0),
    float4(0.061196, -0.096626, -0.010736, 0.000916),
    float4(-0.098773, -0.177147, 0.034356, 0.046662),
    float4(0.247834, 0.049458, 0.967539, 0.904662),
    float4(0.541104, 0.544325, -0.042945, 7.0),
    float4(-0.288804, -0.278068, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(0.69359, -0.72037, 0.0, 0.577584),
    float4(0.199693, 0.595859, 0.0, 14.0),
    float4(0.068712, -0.06227, 0.081595, 0.0),
    float4(-0.030061, -0.239417, 0.115951, 0.01445),
    float4(-0.504461, 0.426837, 0.750553, 0.254154),
    float4(0.268405, 0.533589, 0.081595, 14.0),
    float4(0.272699, 0.010736, -0.081595, 0.0),
    float4(0.061196, -0.096626, -0.010736, 0.025193),
    float4(0.283244, 0.073137, 0.956255, 0.527108),
    float4(0.035429, 0.482055, 0.0, 14.0),
    float4(0.0, 0.258742, 0.0, 0.0),
    float4(0.134202, -0.125614, 0.115951, 0.473533),
    float4(-0.653777, 0.0, 0.756687, 0.964691),
    float4(0.359663, 0.559356, 0.0, 14.0),
    float4(0.181442, -0.015031, 0.0, 0.006043),
    float4(-0.091258, -0.025767, 0.081595, 0.076188),
    float4(0.076465, 0.923048, 0.37701, 0.964691),
    float4(0.035429, 0.482055, -0.042945, 3.0),
    float4(0.0, 0.258742, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(-1.0, 0.0, 0.0, 0.577584),
    float4(0.035429, 0.482055, -0.042945, 11.0),
    float4(0.0, 0.258742, 0.0, 0.01033),
    float4(0.0, 0.258742, 0.042945, 0.045182),
    float4(-1.0, 0.0, 0.0, 0.577584),
    float4(0.035429, 0.740798, -0.042945, 7.0),
    float4(0.164264, -0.144939, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(0.661622, 0.749838, 0.0, 0.577584),
    float4(0.035429, 0.740798, 0.0, 14.0),
    float4(0.164264, -0.144939, 0.0, 0.0),
    float4(0.134202, -0.384356, 0.115951, 0.010956),
    float4(0.332572, 0.376915, 0.864483, 0.215854),
    float4(0.035429, 0.740798, -0.042945, 11.0),
    float4(0.164264, -0.144939, 0.0, 0.01033),
    float4(0.164264, -0.144939, 0.042945, 0.045182),
    float4(0.661622, 0.749838, 0.0, 0.577584),
    float4(0.199693, 0.595859, -0.042945, 7.0),
    float4(0.105215, 0.22546, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(-0.906183, 0.422886, 0.0, 0.577584),
    float4(0.199693, 0.595859, 0.0, 14.0),
    float4(0.105215, 0.22546, 0.0, 0.0),
    float4(0.068712, -0.06227, 0.081595, 0.015991),
    float4(-0.613882, 0.286478, 0.735581, 0.473533),
    float4(0.199693, 0.595859, -0.042945, 11.0),
    float4(0.105215, 0.22546, 0.0, 0.01033),
    float4(0.105215, 0.22546, 0.042945, 0.045182),
    float4(-0.906183, 0.422886, 0.0, 0.577584),
    float4(0.304908, 0.821319, 0.0, 14.0),
    float4(0.128834, -0.067638, 0.0, 0.0),
    float4(-0.036503, -0.28773, 0.081595, 0.254154),
    float4(0.133686, 0.254641, 0.957751, 0.973449),
    float4(0.304908, 0.821319, -0.042945, 7.0),
    float4(0.128834, -0.067638, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(0.464834, 0.885398, 0.0, 0.577584),
    float4(0.433742, 0.753681, 0.0, 14.0),
    float4(-0.07408, -0.194325, 0.0, 0.0),
    float4(-0.165337, -0.220092, 0.081595, 0.964691),
    float4(0.683362, -0.260508, 0.682021, 0.964691),
    float4(0.433742, 0.753681, -0.042945, 11.0),
    float4(-0.07408, -0.194325, 0.0, 0.01033),
    float4(-0.07408, -0.194325, 0.042945, 0.045182),
    float4(0.934406, -0.35621, 0.0, 0.577584),
    float4(0.304908, 0.821319, -0.042945, 11.0),
    float4(0.128834, -0.067638, 0.0, 0.01033),
    float4(0.128834, -0.067638, 0.042945, 0.045182),
    float4(0.464834, 0.885398, 0.0, 0.577584),
    float4(0.433742, 0.753681, -0.042945, 7.0),
    float4(-0.07408, -0.194325, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(0.934406, -0.35621, 0.0, 0.577584),
    float4(0.359663, 0.559356, -0.042945, 7.0),
    float4(0.181442, -0.015031, 0.042945, 0.01033),
    float4(0.0, 0.0, 0.042945, 0.045182),
    float4(0.082557, 0.996586, 0.0, 0.577584),
    float4(0.359663, 0.559356, -0.042945, 11.0),
    float4(0.181442, -0.015031, 0.0, 0.01033),
    float4(0.181442, -0.015031, 0.042945, 0.045182),
    float4(0.082557, 0.996586, 0.0, 0.577584),
    float4(0.044345, 0.043263, -0.043263, 11.0),
    float4(-0.043263, -0.005408, 0.0, 0.01033),
    float4(-0.043263, -0.005408, 0.043263, 0.045182),
    float4(0.124035, -0.992278, 0.0, 0.577584),
    float4(0.044345, 0.043263, -0.043263, 7.0),
    float4(-0.043263, -0.005408, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.124035, -0.992278, 0.0, 0.577584),
    float4(0.001082, 0.037855, -0.043263, 7.0),
    float4(-0.044345, 0.040019, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.669964, -0.742393, 0.0, 0.577584),
    float4(0.044345, 0.043263, 0.0, 10.0),
    float4(-0.043263, -0.005408, 0.0, 0.000305),
    float4(-0.040019, 0.030284, 0.049753, 0.964691),
    float4(0.101434, -0.811469, 0.575525, 0.973449),
    float4(0.004326, 0.073548, 0.049753, 14.0),
    float4(-0.003245, -0.035692, -0.049753, 0.0),
    float4(-0.04759, 0.004326, -0.049753, 0.955978),
    float4(-0.580475, -0.643229, 0.499304, 0.896269),
    float4(0.001082, 0.037855, -0.043263, 11.0),
    float4(-0.044345, 0.040019, 0.0, 0.01033),
    float4(-0.044345, 0.040019, 0.043263, 0.045182),
    float4(-0.669964, -0.742393, 0.0, 0.577584),
    float4(-0.031366, 0.229295, 0.058405, 14.0),
    float4(0.035692, -0.155748, -0.008653, 0.000305),
    float4(-0.011897, -0.151422, -0.058405, 0.955978),
    float4(-0.716533, -0.20131, 0.667874, 0.904662),
    float4(-0.043263, 0.077874, -0.043263, 7.0),
    float4(-0.001082, 0.154666, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.999976, -0.006993, 0.0, 0.577584),
    float4(-0.031366, 0.229295, 0.058405, 14.0),
    float4(0.089771, -0.137361, -0.02055, 0.445197),
    float4(0.035692, -0.155748, -0.008653, 0.973449),
    float4(0.216369, -0.004654, 0.976301, 0.973449),
    float4(-0.031366, 0.229295, 0.058405, 14.0),
    float4(-0.011897, -0.151422, -0.058405, 0.000305),
    float4(-0.012979, 0.003245, -0.058405, 0.955978),
    float4(-0.976245, -0.006827, 0.216564, 0.904662),
    float4(-0.043263, 0.077874, -0.043263, 9.0),
    float4(-0.001082, 0.154666, 0.0, 0.01033),
    float4(-0.001082, 0.154666, 0.043263, 0.045182),
    float4(-0.999976, -0.006993, 0.0, 0.577584),
    float4(-0.045426, 0.564586, 0.052998, 14.0),
    float4(0.014061, -0.335291, 0.005408, 0.520989),
    float4(0.001082, -0.332046, -0.052998, 0.088655),
    float4(-0.975941, -0.037462, 0.214794, 0.973449),
    float4(-0.044345, 0.23254, 0.0, 3.0),
    float4(0.0, 0.0, -0.043263, 0.01033),
    float4(-0.001082, 0.332046, -0.043263, 0.045182),
    float4(-0.999995, -0.003257, 0.0, 0.577584),
    float4(-0.163319, 0.380717, -0.043263, 7.0),
    float4(-0.060569, 0.02704, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.407651, -0.913138, 0.0, 0.577584),
    float4(-0.094098, 0.431551, -0.043263, 11.0),
    float4(-0.069221, -0.050834, 0.0, 0.01033),
    float4(-0.069221, -0.050834, 0.043263, 0.045182),
    float4(0.591909, -0.806004, 0.0, 0.577584),
    float4(-0.163319, 0.380717, -0.043263, 11.0),
    float4(-0.060569, 0.02704, 0.0, 0.01033),
    float4(-0.060569, 0.02704, 0.043263, 0.045182),
    float4(-0.407651, -0.913138, 0.0, 0.577584),
    float4(0.075711, 0.08869, -0.043263, 11.0),
    float4(-0.031366, -0.045426, 0.0, 0.01033),
    float4(-0.031366, -0.045426, 0.043263, 0.045182),
    float4(0.822897, -0.568191, 0.0, 0.577584),
    float4(0.044345, 0.043263, 0.0, 6.0),
    float4(-0.040019, 0.030284, 0.049753, 0.000305),
    float4(0.014061, 0.048671, 0.037855, 0.964691),
    float4(0.365607, -0.634949, 0.680566, 0.973449),
    float4(0.075711, 0.08869, -0.043263, 7.0),
    float4(-0.031366, -0.045426, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.822897, -0.568191, 0.0, 0.577584),
    float4(0.058405, 0.091934, 0.037855, 14.0),
    float4(0.017305, -0.003245, -0.037855, 0.0),
    float4(-0.014061, -0.048671, -0.037855, 0.473533),
    float4(0.757369, -0.522945, 0.39105, 0.904662),
    float4(-0.031366, 0.229295, 0.058405, 14.0),
    float4(0.107077, -0.140606, -0.058405, 0.0),
    float4(0.089771, -0.137361, -0.02055, 0.376257),
    float4(0.812052, 0.481346, 0.329966, 0.830777),
    float4(0.077874, 0.407756, -0.043263, 11.0),
    float4(-0.002163, -0.319067, 0.0, 0.01033),
    float4(-0.002163, -0.319067, 0.043263, 0.045182),
    float4(0.999977, -0.006779, 0.0, 0.577584),
    float4(-0.031366, 0.229295, 0.058405, 14.0),
    float4(0.10924, 0.178461, -0.058405, 0.0),
    float4(0.107077, -0.140606, -0.058405, 0.376257),
    float4(0.475583, -0.003224, 0.879665, 0.830777),
    float4(0.147095, 0.272559, -0.043263, 7.0),
    float4(-0.035692, 0.034611, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.696146, -0.7179, 0.0, 0.577584),
    float4(0.147095, 0.272559, -0.043263, 11.0),
    float4(-0.035692, 0.034611, 0.0, 0.01033),
    float4(-0.035692, 0.034611, 0.043263, 0.045182),
    float4(-0.696146, -0.7179, 0.0, 0.577584),
    float4(0.144932, 0.307169, 0.049753, 14.0),
    float4(0.002163, -0.034611, -0.049753, 0.0),
    float4(-0.033529, 0.0, -0.049753, 0.9131),
    float4(-0.630237, -0.649931, 0.424725, 0.904662),
    float4(0.183869, 0.317985, 0.037855, 6.0),
    float4(-0.036774, -0.045426, -0.037855, 0.0),
    float4(-0.038937, -0.010816, 0.011897, 0.806958),
    float4(0.374433, -0.753477, 0.540438, 0.854994),
    float4(0.077874, 0.407756, -0.043263, 7.0),
    float4(-0.002163, -0.319067, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.999977, -0.006779, 0.0, 0.577584),
    float4(0.111403, 0.307169, -0.043263, 7.0),
    float4(-0.002163, 0.131953, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.999866, -0.016391, 0.0, 0.577584),
    float4(0.10924, 0.439122, 0.0, 6.0),
    float4(0.035692, -0.131953, 0.049753, 0.18117),
    float4(0.002163, -0.131953, 0.0, 0.955978),
    float4(-0.82919, -0.013593, 0.558802, 0.964691),
    float4(0.128708, 0.463999, 0.063813, 14.0),
    float4(0.055161, -0.146014, -0.025958, 0.246204),
    float4(0.016224, -0.156829, -0.014061, 0.964691),
    float4(0.305397, -0.053644, 0.950713, 0.973449),
    float4(0.111403, 0.307169, -0.043263, 11.0),
    float4(-0.002163, 0.131953, 0.0, 0.01033),
    float4(-0.002163, 0.131953, 0.043263, 0.045182),
    float4(-0.999866, -0.016391, 0.0, 0.577584),
    float4(0.189277, 0.28013, -0.043263, 11.0),
    float4(-0.042182, -0.007571, 0.0, 0.01033),
    float4(-0.042182, -0.007571, 0.043263, 0.045182),
    float4(0.176664, -0.984271, 0.0, 0.577584),
    float4(0.183869, 0.317985, 0.037855, 10.0),
    float4(0.005408, -0.037855, -0.037855, 0.0),
    float4(-0.036774, -0.045426, -0.037855, 0.806958),
    float4(0.124328, -0.692684, 0.710445, 0.854994),
    float4(0.189277, 0.28013, -0.043263, 7.0),
    float4(-0.042182, -0.007571, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.176664, -0.984271, 0.0, 0.577584),
    float4(0.183869, 0.317985, 0.037855, 14.0),
    float4(0.02704, -0.004326, -0.037855, 0.0),
    float4(0.005408, -0.037855, -0.037855, 0.514916),
    float4(0.70062, -0.452013, 0.552101, 0.846876),
    float4(0.210908, 0.313659, -0.043263, 11.0),
    float4(-0.021632, -0.033529, 0.0, 0.01033),
    float4(-0.021632, -0.033529, 0.043263, 0.045182),
    float4(0.840297, -0.542127, 0.0, 0.577584),
    float4(0.210908, 0.445612, 0.0, 10.0),
    float4(0.0, -0.131953, 0.0, 0.0),
    float4(-0.02704, -0.127627, 0.037855, 0.439658),
    float4(0.813734, 0.0, 0.581238, 0.871366),
    float4(0.210908, 0.313659, -0.043263, 7.0),
    float4(-0.021632, -0.033529, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.840297, -0.542127, 0.0, 0.577584),
    float4(0.210908, 0.445612, -0.043263, 11.0),
    float4(0.0, -0.131953, 0.0, 0.01033),
    float4(0.0, -0.131953, 0.043263, 0.045182),
    float4(1.0, 0.0, 0.0, 0.577584),
    float4(0.241193, 0.343943, -0.043263, 7.0),
    float4(-0.002163, 0.107077, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.999796, -0.020198, 0.0, 0.577584),
    float4(0.276885, 0.311496, -0.043263, 11.0),
    float4(-0.035692, 0.032447, 0.0, 0.01033),
    float4(-0.035692, 0.032447, 0.043263, 0.045182),
    float4(-0.672673, -0.73994, 0.0, 0.577584),
    float4(0.23903, 0.45102, 0.0, 14.0),
    float4(0.042182, -0.108158, 0.046508, 0.000305),
    float4(0.002163, -0.107077, 0.0, 0.846876),
    float4(-0.758098, -0.015315, 0.651961, 0.896269),
    float4(0.276885, 0.311496, -0.043263, 7.0),
    float4(-0.035692, 0.032447, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.672673, -0.73994, 0.0, 0.577584),
    float4(0.281211, 0.342862, 0.046508, 14.0),
    float4(-0.004326, -0.031366, -0.046508, 0.0),
    float4(-0.040019, 0.001082, -0.046508, 0.752941),
    float4(-0.58651, -0.645161, 0.489667, 0.846876),
    float4(0.246601, 0.459672, 0.06165, 14.0),
    float4(0.070303, -0.101669, -0.024876, 0.262257),
    float4(0.034611, -0.116811, -0.015142, 0.973449),
    float4(0.27928, -0.041605, 0.959308, 0.973449),
    float4(0.319067, 0.319067, -0.043263, 11.0),
    float4(-0.042182, -0.007571, 0.0, 0.01033),
    float4(-0.042182, -0.007571, 0.043263, 0.045182),
    float4(0.176664, -0.984271, 0.0, 0.577584),
    float4(0.319067, 0.319067, 0.0, 10.0),
    float4(-0.042182, -0.007571, 0.0, 0.0),
    float4(-0.037855, 0.023795, 0.046508, 0.896269),
    float4(0.1483, -0.826245, 0.54344, 0.896269),
    float4(0.319067, 0.319067, -0.043263, 7.0),
    float4(-0.042182, -0.007571, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.176664, -0.984271, 0.0, 0.577584),
    float4(0.319067, 0.319067, 0.0, 6.0),
    float4(-0.037855, 0.023795, 0.046508, 0.0),
    float4(-0.002163, 0.038937, 0.036774, 0.896269),
    float4(0.437906, -0.604311, 0.665618, 0.896269),
    float4(0.316904, 0.358004, 0.036774, 14.0),
    float4(0.024876, -0.004326, -0.036774, 0.0),
    float4(0.002163, -0.038937, -0.036774, 0.617212),
    float4(0.707338, -0.464191, 0.533104, 0.921584),
    float4(0.34178, 0.353677, -0.043263, 11.0),
    float4(-0.022713, -0.034611, 0.0, 0.01033),
    float4(-0.022713, -0.034611, 0.043263, 0.045182),
    float4(0.836048, -0.548657, 0.0, 0.577584),
    float4(0.340698, 0.474815, 0.0, 14.0),
    float4(0.001082, -0.121137, 0.0, 0.0),
    float4(-0.023795, -0.116811, 0.036774, 0.473533),
    float4(0.828664, 0.007399, 0.559697, 0.930114),
    float4(0.34178, 0.353677, -0.043263, 7.0),
    float4(-0.022713, -0.034611, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.836048, -0.548657, 0.0, 0.577584),
    float4(0.340698, 0.474815, -0.043263, 11.0),
    float4(0.001082, -0.121137, 0.0, 0.01033),
    float4(0.001082, -0.121137, 0.043263, 0.045182),
    float4(0.99996, 0.008928, 0.0, 0.577584),
    float4(0.411001, 0.351514, -0.043263, 11.0),
    float4(-0.034611, 0.030284, 0.0, 0.01033),
    float4(-0.034611, 0.030284, 0.043263, 0.045182),
    float4(-0.658505, -0.752577, 0.0, 0.577584),
    float4(0.411001, 0.351514, -0.043263, 7.0),
    float4(-0.034611, 0.030284, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.658505, -0.752577, 0.0, 0.577584),
    float4(0.412083, 0.38288, 0.043263, 14.0),
    float4(-0.001082, -0.031366, -0.043263, 0.0),
    float4(-0.035692, -0.001082, -0.043263, 0.745403),
    float4(-0.574039, -0.656045, 0.489984, 0.854994),
    float4(0.45102, 0.359085, -0.043263, 11.0),
    float4(-0.040019, -0.007571, 0.0, 0.01033),
    float4(-0.040019, -0.007571, 0.043263, 0.045182),
    float4(0.185892, -0.98257, 0.0, 0.577584),
    float4(0.45102, 0.359085, 0.0, 10.0),
    float4(-0.040019, -0.007571, 0.0, 0.000305),
    float4(-0.038937, 0.023795, 0.043263, 0.879622),
    float4(0.151736, -0.802035, 0.577682, 0.9131),
    float4(0.45102, 0.359085, -0.043263, 7.0),
    float4(-0.040019, -0.007571, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.185892, -0.98257, 0.0, 0.577584),
    float4(0.45102, 0.359085, 0.0, 6.0),
    float4(-0.038937, 0.023795, 0.043263, 0.000305),
    float4(0.003245, 0.0411, 0.032447, 0.879622),
    float4(0.417852, -0.583049, 0.696744, 0.9131),
    float4(0.473733, 0.391533, -0.043263, 11.0),
    float4(-0.022713, -0.032447, 0.0, 0.01033),
    float4(-0.022713, -0.032447, 0.043263, 0.045182),
    float4(0.819232, -0.573462, 0.0, 0.577584),
    float4(0.454264, 0.400185, 0.032447, 14.0),
    float4(0.019468, -0.008653, -0.032447, 0.0),
    float4(-0.003245, -0.0411, -0.032447, 0.527108),
    float4(0.688617, -0.482032, 0.541712, 0.887922),
    float4(0.473733, 0.391533, -0.043263, 7.0),
    float4(-0.022713, -0.032447, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.819232, -0.573462, 0.0, 0.577584),
    float4(-0.223888, 0.407756, -0.043263, 7.0),
    float4(0.002163, 0.06814, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.999496, 0.03173, 0.0, 0.577584),
    float4(-0.223888, 0.407756, -0.043263, 11.0),
    float4(0.002163, 0.06814, 0.0, 0.01033),
    float4(0.002163, 0.06814, 0.043263, 0.045182),
    float4(-0.999496, 0.03173, 0.0, 0.577584),
    float4(-0.167645, 0.416409, 0.046508, 14.0),
    float4(-0.056242, -0.008653, -0.046508, 0.000305),
    float4(-0.054079, 0.059487, -0.046508, 0.955978),
    float4(-0.638985, 0.020285, 0.768952, 0.973449),
    float4(-0.167645, 0.416409, 0.046508, 14.0),
    float4(0.004326, -0.035692, -0.046508, 0.000305),
    float4(-0.056242, -0.008653, -0.046508, 0.955978),
    float4(-0.339782, -0.761112, 0.552501, 0.973449),
    float4(-0.221724, 0.475896, 0.0, 14.0),
    float4(0.139524, 0.055161, 0.043263, 0.520989),
    float4(0.054079, -0.059487, 0.046508, 0.973449),
    float4(-0.39307, 0.317373, 0.863001, 0.973449),
    float4(-0.167645, 0.416409, 0.046508, 6.0),
    float4(0.073548, 0.015142, -0.046508, 0.0),
    float4(0.004326, -0.035692, -0.046508, 0.768154),
    float4(0.490917, -0.668482, 0.558688, 0.871366),
    float4(-0.094098, 0.431551, -0.043263, 7.0),
    float4(-0.069221, -0.050834, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.591909, -0.806004, 0.0, 0.577584),
    float4(-0.167645, 0.416409, 0.046508, 10.0),
    float4(0.085445, 0.114648, -0.003245, 0.0),
    float4(0.073548, 0.015142, -0.046508, 0.768154),
    float4(0.548356, -0.38771, 0.740936, 0.871366),
    float4(-0.0822, 0.531057, -0.043263, 11.0),
    float4(-0.011897, -0.099506, 0.0, 0.01033),
    float4(-0.011897, -0.099506, 0.043263, 0.045182),
    float4(0.992928, -0.11872, 0.0, 0.577584),
    float4(-0.044345, 0.23254, 0.0, 7.0),
    float4(-0.001082, 0.332046, -0.043263, 0.01033),
    float4(-0.001082, 0.332046, 0.052998, 0.045182),
    float4(-0.999995, -0.003257, 0.0, 0.577584),
    float4(-0.045426, 0.564586, 0.052998, 14.0),
    float4(0.1233, -0.156829, -0.052998, 0.520989),
    float4(0.014061, -0.335291, 0.005408, 0.088655),
    float4(0.429355, 0.032562, 0.902549, 0.973449),
    float4(0.10924, 0.439122, 0.0, 14.0),
    float4(-0.031366, -0.031366, 0.0, 0.132876),
    float4(-0.154666, 0.125464, 0.052998, 0.028428),
    float4(0.182761, -0.182761, 0.966021, 0.955978),
    float4(0.10924, 0.439122, -0.043263, 11.0),
    float4(-0.031366, -0.031366, 0.0, 0.01033),
    float4(-0.031366, -0.031366, 0.043263, 0.045182),
    float4(0.707107, -0.707107, 0.0, 0.577584),
    float4(0.10924, 0.439122, -0.043263, 7.0),
    float4(-0.031366, -0.031366, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.707107, -0.707107, 0.0, 0.577584),
    float4(0.10924, 0.439122, 0.0, 10.0),
    float4(0.019468, 0.024876, 0.063813, 0.18117),
    float4(0.035692, -0.131953, 0.049753, 0.955978),
    float4(-0.933936, -0.126584, 0.334276, 0.964691),
    float4(0.128708, 0.463999, 0.063813, 14.0),
    float4(0.050834, 0.002163, -0.005408, 0.0),
    float4(0.0822, -0.018387, -0.063813, 0.439658),
    float4(0.07859, -0.92643, 0.368172, 0.871366),
    float4(-0.221724, 0.475896, -0.043263, 7.0),
    float4(0.122219, 0.207664, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.861819, 0.507216, 0.0, 0.577584),
    float4(-0.221724, 0.475896, -0.043263, 9.0),
    float4(0.122219, 0.207664, 0.0, 0.01033),
    float4(0.122219, 0.207664, 0.043263, 0.045182),
    float4(-0.861819, 0.507216, 0.0, 0.577584),
    float4(-0.099506, 0.68356, 0.0, 14.0),
    float4(0.017305, -0.152503, 0.043263, 0.0),
    float4(-0.122219, -0.207664, 0.0, 0.723049),
    float4(-0.365879, 0.215335, 0.905408, 0.854994),
    float4(-0.0822, 0.531057, -0.043263, 7.0),
    float4(-0.011897, -0.099506, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.086527, 0.045182),
    float4(0.992928, -0.11872, 0.0, 0.577584),
    float4(-0.099506, 0.68356, 0.0, 14.0),
    float4(0.054079, -0.118974, 0.052998, 0.0),
    float4(0.017305, -0.152503, 0.043263, 0.514916),
    float4(-0.41958, 0.203352, 0.884647, 0.863157),
    float4(-0.099506, 0.68356, -0.043263, 3.0),
    float4(0.086527, 0.149258, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.86514, 0.501531, 0.0, 0.577584),
    float4(-0.045426, 0.564586, -0.043263, 11.0),
    float4(-0.036774, -0.033529, 0.0, 0.01033),
    float4(-0.036774, -0.033529, 0.086527, 0.045182),
    float4(0.673754, -0.738956, 0.0, 0.577584),
    float4(-0.045426, 0.564586, -0.043263, 7.0),
    float4(-0.036774, -0.033529, 0.086527, 0.01033),
    float4(0.0, 0.0, 0.096261, 0.045182),
    float4(0.673754, -0.738956, 0.0, 0.577584),
    float4(-0.099506, 0.68356, 0.0, 14.0),
    float4(0.086527, 0.149258, 0.0, 0.0),
    float4(0.054079, -0.118974, 0.052998, 0.262257),
    float4(-0.385563, 0.223515, 0.8952, 0.9131),
    float4(-0.099506, 0.68356, -0.043263, 11.0),
    float4(0.086527, 0.149258, 0.0, 0.01033),
    float4(0.086527, 0.149258, 0.043263, 0.045182),
    float4(-0.86514, 0.501531, 0.0, 0.577584),
    float4(-0.012979, 0.832818, 0.0, 14.0),
    float4(0.214153, -0.194685, 0.0822, 0.000305),
    float4(-0.032447, -0.268232, 0.052998, 0.930114),
    float4(-0.176863, 0.211325, 0.961281, 0.973449),
    float4(0.128708, 0.463999, 0.063813, 14.0),
    float4(-0.019468, -0.024876, -0.063813, 0.168276),
    float4(-0.174135, 0.100587, -0.010816, 0.038209),
    float4(-0.469238, -0.764881, 0.441331, 0.955978),
    float4(0.201174, 0.638133, 0.0822, 14.0),
    float4(-0.072466, -0.174135, -0.018387, 0.18117),
    float4(-0.246601, -0.073548, -0.029203, 0.082277),
    float4(-0.098561, -0.063844, 0.993081, 0.973449),
    float4(-0.012979, 0.832818, -0.043263, 7.0),
    float4(0.339617, -0.002163, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.006369, 0.99998, 0.0, 0.577584),
    float4(0.179543, 0.466162, 0.058405, 10.0),
    float4(-0.050834, -0.002163, 0.005408, 0.000305),
    float4(0.021632, 0.171972, 0.023795, 0.022171),
    float4(0.110896, -0.149888, 0.982464, 0.381323),
    float4(-0.012979, 0.832818, 0.0, 14.0),
    float4(0.339617, -0.002163, 0.0, 0.0),
    float4(0.214153, -0.194685, 0.0822, 0.027314),
    float4(0.002492, 0.391296, 0.920261, 0.49102),
    float4(0.183869, 0.317985, 0.037855, 10.0),
    float4(-0.055161, 0.146014, 0.025958, 0.0),
    float4(0.02704, 0.127627, -0.037855, 0.439658),
    float4(0.623841, 0.097823, 0.775405, 0.871366),
    float4(0.210908, 0.445612, -0.043263, 7.0),
    float4(0.0, -0.131953, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(1.0, 0.0, 0.0, 0.577584),
    float4(0.210908, 0.445612, 0.0, 10.0),
    float4(-0.031366, 0.02055, 0.058405, 0.000305),
    float4(0.035692, 0.014061, 0.06165, 0.022171),
    float4(-0.105864, -0.954447, 0.278971, 0.381323),
    float4(0.23903, 0.45102, -0.043263, 11.0),
    float4(-0.028121, -0.005408, 0.0, 0.01033),
    float4(-0.028121, -0.005408, 0.043263, 0.045182),
    float4(0.188847, -0.982006, 0.0, 0.577584),
    float4(0.23903, 0.45102, -0.043263, 7.0),
    float4(-0.028121, -0.005408, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.188847, -0.982006, 0.0, 0.577584),
    float4(0.246601, 0.459672, 0.06165, 11.0),
    float4(-0.007571, -0.008653, -0.06165, 0.000305),
    float4(-0.035692, -0.014061, -0.06165, 0.022171),
    float4(0.187618, -0.975617, 0.113888, 0.381323),
    float4(0.241193, 0.343943, -0.043263, 11.0),
    float4(-0.002163, 0.107077, 0.0, 0.01033),
    float4(-0.002163, 0.107077, 0.043263, 0.045182),
    float4(-0.999796, -0.020198, 0.0, 0.577584),
    float4(0.23903, 0.45102, 0.0, 15.0),
    float4(0.007571, 0.008653, 0.06165, 0.000305),
    float4(0.042182, -0.108158, 0.046508, 0.846876),
    float4(-0.94107, -0.299262, 0.157572, 0.896269),
    float4(0.316904, 0.358004, 0.036774, 14.0),
    float4(-0.070303, 0.101669, 0.024876, 0.0),
    float4(0.023795, 0.116811, -0.036774, 0.473533),
    float4(0.523424, 0.157027, 0.837478, 0.930114),
    float4(0.340698, 0.474815, -0.043263, 7.0),
    float4(0.001082, -0.121137, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.99996, 0.008928, 0.0, 0.577584),
    float4(0.376391, 0.381799, -0.043263, 11.0),
    float4(-0.001082, 0.107077, 0.0, 0.01033),
    float4(-0.001082, 0.107077, 0.043263, 0.045182),
    float4(-0.999949, -0.0101, 0.0, 0.577584),
    float4(0.376391, 0.381799, -0.043263, 7.0),
    float4(-0.001082, 0.107077, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(-0.999949, -0.0101, 0.0, 0.577584),
    float4(0.375309, 0.488875, 0.0, 14.0),
    float4(0.036774, -0.105995, 0.043263, 0.000305),
    float4(0.001082, -0.107077, 0.0, 0.879622),
    float4(-0.771254, -0.00779, 0.63648, 0.896269),
    float4(0.375309, 0.488875, 0.0, 14.0),
    float4(0.078955, -0.08869, 0.032447, 0.223224),
    float4(0.036774, -0.105995, 0.043263, 0.964691),
    float4(0.071225, 0.39802, 0.914608, 0.973449),
    float4(0.473733, 0.603523, 0.0, 14.0),
    float4(0.0, -0.21199, 0.0, 0.158953),
    float4(-0.019468, -0.203337, 0.032447, 0.030716),
    float4(0.857493, 0.0, 0.514496, 0.964691),
    float4(0.473733, 0.603523, -0.043263, 11.0),
    float4(0.0, -0.21199, 0.0, 0.01033),
    float4(0.0, -0.21199, 0.043263, 0.045182),
    float4(1.0, 0.0, 0.0, 0.577584),
    float4(0.276885, 0.484549, 0.058405, 10.0),
    float4(-0.030284, -0.024876, 0.003245, 0.000305),
    float4(-0.097342, -0.018387, 0.0, 0.022171),
    float4(-0.03153, 0.166923, 0.985466, 0.381323),
    float4(0.246601, 0.459672, 0.06165, 14.0),
    float4(0.030284, 0.024876, -0.003245, 0.0),
    float4(0.094098, 0.015142, -0.06165, 0.473533),
    float4(0.518869, -0.545855, 0.657888, 0.930114),
    float4(0.375309, 0.488875, -0.043263, 11.0),
    float4(-0.034611, -0.014061, 0.0, 0.01033),
    float4(-0.034611, -0.014061, 0.043263, 0.045182),
    float4(0.376377, -0.926467, 0.0, 0.577584),
    float4(0.340698, 0.474815, 0.0, 14.0),
    float4(-0.063813, 0.009734, 0.058405, 0.000305),
    float4(0.034611, 0.014061, 0.0, 0.022171),
    float4(0.3276, -0.806402, 0.492334, 0.381323),
    float4(0.375309, 0.488875, -0.043263, 7.0),
    float4(-0.034611, -0.014061, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.376377, -0.926467, 0.0, 0.577584),
    float4(0.454264, 0.400185, 0.032447, 12.0),
    float4(-0.078955, 0.08869, -0.032447, 0.158953),
    float4(0.019468, 0.203337, -0.032447, 0.030716),
    float4(-0.201684, 0.173144, 0.964025, 0.964691),
    float4(0.201174, 0.638133, 0.0822, 8.0),
    float4(0.075711, -0.153585, -0.023795, 0.000305),
    float4(-0.021632, -0.171972, -0.023795, 0.022171),
    float4(0.026497, -0.140281, 0.989757, 0.381323),
    float4(0.473733, 0.603523, -0.043263, 7.0),
    float4(0.0, -0.21199, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(1.0, 0.0, 0.0, 0.577584),
    float4(0.276885, 0.484549, 0.058405, 14.0),
    float4(-0.075711, 0.153585, 0.023795, 0.000305),
    float4(0.098424, 0.004326, -0.058405, 0.022171),
    float4(0.50316, 0.115345, 0.856461, 0.381323),
    float4(0.375309, 0.488875, 0.0, 10.0),
    float4(0.090853, 0.12979, 0.0, 0.158953),
    float4(0.098424, 0.114648, 0.0, 0.030716),
    float4(0.0, 0.0, 1.0, 0.964691),
    float4(0.466162, 0.618665, -0.043263, 11.0),
    float4(0.007571, -0.015142, 0.0, 0.01033),
    float4(0.007571, -0.015142, 0.043263, 0.045182),
    float4(0.894427, 0.447214, 0.0, 0.577584),
    float4(0.466162, 0.618665, -0.043263, 3.0),
    float4(0.007571, -0.015142, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.894427, 0.447214, 0.0, 0.577584),
    float4(0.326638, 0.830655, 0.0, 14.0),
    float4(0.139524, -0.21199, 0.0, 0.0),
    float4(0.048671, -0.34178, 0.0, 0.015213),
    float4(0.0, 0.0, 1.0, 0.428687),
    float4(0.326638, 0.830655, 0.0, 14.0),
    float4(0.048671, -0.34178, 0.0, 0.007492),
    float4(-0.125464, -0.192522, 0.0822, 0.054475),
    float4(0.472493, 0.067285, 0.878762, 0.964691),
    float4(0.326638, 0.830655, -0.043263, 9.0),
    float4(0.139524, -0.21199, 0.0, 0.01033),
    float4(0.139524, -0.21199, 0.043263, 0.045182),
    float4(0.835314, 0.549773, 0.0, 0.577584),
    float4(0.326638, 0.830655, -0.043263, 7.0),
    float4(0.139524, -0.21199, 0.043263, 0.01033),
    float4(0.0, 0.0, 0.043263, 0.045182),
    float4(0.835314, 0.549773, 0.0, 0.577584),
    float4(-0.012979, 0.832818, -0.043263, 11.0),
    float4(0.339617, -0.002163, 0.0, 0.01033),
    float4(0.339617, -0.002163, 0.043263, 0.045182),
    float4(0.006369, 0.99998, 0.0, 0.577584)
};
constant float4 PRISM_BOXES[44] = {
    float4(0.030135, 0.06127, -0.043945, 0.0),
    float4(0.330601, 0.483055, 0.116951, 7.0),
    float4(0.034429, 0.265258, -0.043945, 7.0),
    float4(0.542104, 0.741798, 0.116951, 8.0),
    float4(0.034429, 0.355442, -0.043945, 15.0),
    float4(0.305908, 0.822319, 0.116951, 8.0),
    float4(0.267405, 0.532589, -0.043945, 23.0),
    float4(0.542104, 0.822319, 0.082595, 8.0),
    float4(-0.045345, 0.036855, -0.044263, 31.0),
    float4(0.045345, 0.23354, 0.059405, 8.0),
    float4(-0.224888, 0.072548, -0.044263, 39.0),
    float4(0.059405, 0.565586, 0.059405, 8.0),
    float4(-0.032366, 0.042263, -0.044263, 47.0),
    float4(0.148095, 0.408756, 0.059405, 8.0),
    float4(0.074711, 0.08769, -0.044263, 55.0),
    float4(0.184869, 0.464999, 0.064813, 8.0),
    float4(0.146095, 0.271559, -0.044263, 63.0),
    float4(0.211908, 0.446612, 0.038855, 8.0),
    float4(0.23803, 0.310496, -0.044263, 71.0),
    float4(0.320067, 0.460672, 0.06265, 8.0),
    float4(0.275885, 0.310496, -0.044263, 79.0),
    float4(0.412001, 0.475815, 0.047508, 8.0),
    float4(0.375391, 0.350514, -0.044263, 87.0),
    float4(0.45202, 0.38388, 0.044263, 4.0),
    float4(0.410001, 0.350514, -0.044263, 91.0),
    float4(0.474733, 0.401185, 0.044263, 5.0),
    float4(-0.224888, 0.379717, -0.044263, 96.0),
    float4(-0.0812, 0.532057, 0.047508, 8.0),
    float4(-0.095098, 0.228295, -0.044263, 104.0),
    float4(0.211908, 0.565586, 0.064813, 8.0),
    float4(-0.222724, 0.430551, -0.044263, 112.0),
    float4(-0.011979, 0.833818, 0.053998, 8.0),
    float4(-0.100506, 0.438122, -0.044263, 120.0),
    float4(0.327638, 0.833818, 0.0832, 8.0),
    float4(0.127708, 0.312659, -0.044263, 128.0),
    float4(0.282211, 0.467162, 0.064813, 8.0),
    float4(0.245601, 0.352677, -0.044263, 136.0),
    float4(0.474733, 0.604523, 0.06265, 8.0),
    float4(0.178543, 0.390533, -0.044263, 144.0),
    float4(0.474733, 0.639133, 0.0832, 8.0),
    float4(0.200174, 0.483549, -0.044263, 152.0),
    float4(0.474733, 0.639133, 0.0832, 4.0),
    float4(-0.013979, 0.487875, -0.044263, 156.0),
    float4(0.467162, 0.833818, 0.0832, 5.0)
};
constant float2 PRISM_POLY[110] = {
    float2(0.006442, -0.002147),
    float2(-0.001074, 0.001074),
    float2(-0.004294, 0.007515),
    float2(-0.004294, 0.806288),
    float2(-0.001074, 0.809509),
    float2(0.004294, 0.809509),
    float2(0.022546, 0.796626),
    float2(0.185736, 0.655982),
    float2(0.281288, 0.86319),
    float2(0.286656, 0.870706),
    float2(0.293098, 0.871779),
    float2(0.465951, 0.781595),
    float2(0.478834, 0.773006),
    float2(0.478834, 0.763344),
    float2(0.407975, 0.592638),
    float2(0.45092, 0.586196),
    float2(0.601227, 0.573313),
    float2(0.606595, 0.569018),
    float2(0.606595, 0.564724),
    float2(0.601227, 0.556135),
    float2(0.50138, 0.453067),
    float2(0.425153, 0.37684),
    float2(0.289877, 0.246933),
    float2(0.081595, 0.057975),
    float2(0.013957, 0.0),
    float2(-0.011897, 0.0),
    float2(-0.055161, 0.037855),
    float2(-0.081119, 0.063813),
    float2(-0.083282, 0.06814),
    float2(-0.084363, 0.38288),
    float2(-0.089771, 0.38288),
    float2(-0.158993, 0.33529),
    float2(-0.166564, 0.336372),
    float2(-0.250927, 0.379635),
    float2(-0.261743, 0.388288),
    float2(-0.263906, 0.461836),
    float2(-0.262824, 0.486712),
    float2(-0.173053, 0.638133),
    float2(-0.044345, 0.860939),
    float2(-0.036774, 0.867429),
    float2(-0.024876, 0.871755),
    float2(0.33529, 0.871755),
    float2(0.349351, 0.867429),
    float2(0.363412, 0.853368),
    float2(0.513752, 0.619747),
    float2(0.513752, 0.379635),
    float2(0.466162, 0.322311),
    float2(0.461836, 0.320148),
    float2(0.399104, 0.311496),
    float2(0.393696, 0.313659),
    float2(0.374227, 0.332046),
    float2(0.343943, 0.288782),
    float2(0.336372, 0.282293),
    float2(0.269314, 0.271477),
    float2(0.263906, 0.27364),
    float2(0.243356, 0.292027),
    float2(0.21199, 0.244438),
    float2(0.207664, 0.241193),
    float2(0.149258, 0.231459),
    float2(0.138443, 0.231459),
    float2(0.118974, 0.248764),
    float2(0.116811, 0.222806),
    float2(0.117892, 0.162237),
    float2(0.115729, 0.076792),
    float2(0.06814, 0.011897),
    float2(0.062732, 0.007571),
    float2(0.005408, 0.0),
    float2(0.031135, 0.06227),
    float2(0.252301, 0.266258),
    float2(0.541104, 0.544325),
    float2(0.359663, 0.559356),
    float2(0.433742, 0.753681),
    float2(0.304908, 0.821319),
    float2(0.199693, 0.595859),
    float2(0.035429, 0.740798),
    float2(0.035429, 0.482055),
    float2(-0.043263, 0.077874),
    float2(0.001082, 0.037855),
    float2(0.044345, 0.043263),
    float2(0.075711, 0.08869),
    float2(0.077874, 0.407756),
    float2(0.10924, 0.439122),
    float2(0.111403, 0.307169),
    float2(0.147095, 0.272559),
    float2(0.189277, 0.28013),
    float2(0.210909, 0.313659),
    float2(0.210909, 0.445612),
    float2(0.23903, 0.45102),
    float2(0.241193, 0.343943),
    float2(0.276885, 0.311496),
    float2(0.319067, 0.319067),
    float2(0.34178, 0.353677),
    float2(0.340698, 0.474815),
    float2(0.375309, 0.488875),
    float2(0.376391, 0.381799),
    float2(0.411001, 0.351514),
    float2(0.45102, 0.359085),
    float2(0.473733, 0.391533),
    float2(0.473733, 0.603523),
    float2(0.466162, 0.618665),
    float2(0.326638, 0.830655),
    float2(-0.012979, 0.832818),
    float2(-0.099506, 0.68356),
    float2(-0.221724, 0.475896),
    float2(-0.223888, 0.407756),
    float2(-0.163319, 0.380717),
    float2(-0.094098, 0.431551),
    float2(-0.0822, 0.531057),
    float2(-0.045426, 0.564586),
    float2(-0.044345, 0.23254)
};
constant float PRISM_BEVEL = 0.012883;
// end of the prism mesh

constant float PRISM_IOR = 1.61;
constant float PRISM_DISPERSION = 0.035;
constant float PRISM_GLOW = 0.45;
constant float PRISM_FOLD = 0.35;
constant int PRISM_BOUNCES = 6;
constant float PRISM_MAT = 9.0;

inline int prism_shape(constant Layer &layer)
{
    int id = sculpt_id(layer);
    return id == 3 || id == 4 ? id - 3 : -1;
}

static float prism_poly_dist(float2 p, int i0, int n)
{
    float2 vj = PRISM_POLY[i0 + n - 1];
    float d = 1e9;
    float sgn = 1.0;
    for (int i = 0; i < n; i++)
    {
        float2 vi = PRISM_POLY[i0 + i];
        float2 e = vj - vi;
        float2 w = p - vi;
        float2 b = w - e * saturate(dot(w, e) / dot(e, e));
        d = min(d, dot(b, b));
        bool c0 = p.y >= vi.y;
        bool c1 = p.y < vj.y;
        bool c2 = e.x * w.y > e.y * w.x;
        if ((c0 && c1 && c2) || (!c0 && !c1 && !c2))
        {
            sgn = -sgn;
        }
        vj = vi;
    }
    return sgn * sqrt(d);
}

static float prism_rim(float3 p, int shape, constant Layer &layer)
{
    float half_t = model_thick(layer) * 0.5;
    float sil = prism_poly_dist(p.xy, PRISM_SIL_START[shape], PRISM_SIL_COUNT[shape]);
    float2 w = float2(sil + PRISM_BEVEL, abs(p.z + half_t) - (half_t - PRISM_BEVEL));
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - PRISM_BEVEL;
}

static float prism_tri(float3 ro, float3 rd, int k)
{
    float3 v0 = PRISM_TRIS[4 * k].xyz;
    float3 e1 = PRISM_TRIS[4 * k + 1].xyz;
    float3 e2 = PRISM_TRIS[4 * k + 2].xyz;
    float3 pv = cross(rd, e2);
    float det = dot(e1, pv);
    if (abs(det) < 1e-10)
    {
        return -1.0;
    }
    float inv = 1.0 / det;
    float3 sv = ro - v0;
    float u = dot(sv, pv) * inv;
    float3 qv = cross(sv, e1);
    float v = dot(rd, qv) * inv;
    if (u < -2e-4 || v < -2e-4 || u + v > 1.0004)
    {
        return -1.0;
    }
    return dot(e2, qv) * inv;
}

static float prism_trace(float3 ro, float3 rd, int shape, thread int &hit)
{
    float3 inv = 1.0 / select(float3(1e-6), rd, abs(rd) > 1e-6);
    int b0 = PRISM_BOX_START[shape];
    int nb = PRISM_BOX_COUNT[shape];
    float best = 1e9;
    hit = -1;
    for (int j = b0; j < b0 + nb; j++)
    {
        float4 lo = PRISM_BOXES[2 * j];
        float4 hi = PRISM_BOXES[2 * j + 1];
        float3 t0 = (lo.xyz - ro) * inv;
        float3 t1 = (hi.xyz - ro) * inv;
        float3 tn = min(t0, t1);
        float3 tf = max(t0, t1);
        float tmin = max(max(tn.x, tn.y), tn.z);
        float tmax = min(min(tf.x, tf.y), tf.z);
        if (tmax < max(tmin, 1e-5) || tmin > best)
        {
            continue;
        }
        int k0 = int(lo.w);
        int n = int(hi.w);
        for (int i = k0; i < k0 + n; i++)
        {
            float t = prism_tri(ro, rd, i);
            if (t > 1e-5 && t < best)
            {
                best = t;
                hit = i;
            }
        }
    }
    return best;
}

static float2 sculpt_proto(float3 p, int theme, int shape)
{
    if (theme == 3)
    {
        return s_voxels(p, shape);
    }
    return s_rimmed(p, theme, shape);
}

inline float3 sculpt_point(float3 q, constant Layer &layer)
{
    float zref = (sculpt_id(layer) - 1) % 2 == 0 ? SCULPT_ZREF_ARROW : SCULPT_ZREF_HAND;
    return float3(q.x, -q.y, q.z / max(layer.color.b, 1e-3)) / SCULPT_SCALE + float3(0.0, 0.0, zref);
}

inline float sculpt_units(constant Layer &layer)
{
    return SCULPT_SCALE * min(layer.color.b, 1.0);
}

static float2 sculpt_eval(float3 q, bool occ, constant Layer &layer)
{
    int id = sculpt_id(layer) - 1;
    int theme = id / 2, shape = id % 2;
    if (theme == 1)
    {
        return float2(prism_rim(q, shape, layer), 8.0);
    }
    float3 p = sculpt_point(q, layer);
    float2 r;
    if (occ && theme == 3)
    {
        float d2 = s_pixel_outline(p.xy, shape);
        float dz = abs(p.z - (SCULPT_HOVER + 0.07)) - 0.07;
        r = float2(length(max(float2(d2, dz), 0.0)) + min(max(d2, dz), 0.0), 7.0);
    }
    else
    {
        r = sculpt_proto(p, theme, shape);
    }
    return float2(r.x * sculpt_units(layer), r.y);
}

static float sd_sprite2(float2 p, constant Layer &layer, texture2d<float, access::sample> texSdf)
{
    float2 lo = layer.color.rg;
    float2 c = clamp(p, lo, lo + sprite_size(layer));
    float d = texSdf.sample(samp, (c - lo) / sprite_size(layer), level(0.0)).r;
    float2 o = p - c;
    float out2 = dot(o, o);
    float e = max(d, 0.0);
    return out2 > 0.0 ? sqrt(out2 + e * e) : d;
}

static float2 model_eval(float3 p, bool occ, constant Layer &layer, texture2d<float, access::sample> texSdf)
{
    if (sculpt_id(layer) > 0)
    {
        return sculpt_eval(p, occ, layer);
    }
    float half_t = model_thick(layer) * 0.5;
    float2 w = float2(sd_sprite2(p.xy, layer, texSdf) + MODEL_BEVEL,
                      abs(p.z + half_t) - (half_t - MODEL_BEVEL));
    return float2(min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - MODEL_BEVEL, 0.0);
}

static float2 ray_box(float3 o, float3 d, float3 lo, float3 hi)
{
    float3 inv = 1.0 / select(float3(1e-6), d, abs(d) > 1e-6);
    float3 t0 = (lo - o) * inv;
    float3 t1 = (hi - o) * inv;
    float3 tn = min(t0, t1);
    float3 tf = max(t0, t1);
    return float2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

struct ModelFrame
{
    float3 c;
    float3 s;
    float cp;
    float sp;
    float cy;
    float sy;
};

static float3 world_to_plane(float3 v, ModelFrame f)
{
    float y = v.y * f.c.x + v.z * f.s.x;
    float z = -v.y * f.s.x + v.z * f.c.x;
    float x = v.x * f.c.y - z * f.s.y;
    z = v.x * f.s.y + z * f.c.y;
    return float3(x * f.c.z + y * f.s.z, -x * f.s.z + y * f.c.z, z);
}

static float3 model_to_plane(float3 v, ModelFrame f)
{
    float y = v.y * f.cp - v.z * f.sp;
    float z = v.y * f.sp + v.z * f.cp;
    return float3(v.x * f.cy - y * f.sy, v.x * f.sy + y * f.cy, z);
}

static float3 plane_to_model(float3 v, ModelFrame f)
{
    float x = v.x * f.cy + v.y * f.sy;
    float y = -v.x * f.sy + v.y * f.cy;
    return float3(x, y * f.cp + v.z * f.sp, -y * f.sp + v.z * f.cp);
}

static float3 model_albedo(float2 p, constant Layer &layer, texture2d<float, access::sample> texSdf,
                           texture2d<float, access::sample> texImg)
{
    float texel = sprite_texel(texSdf);
    float e = 0.25 * texel;
    float2 g = float2(sd_sprite2(p + float2(e, 0.0), layer, texSdf) - sd_sprite2(p - float2(e, 0.0), layer, texSdf),
                      sd_sprite2(p + float2(0.0, e), layer, texSdf) - sd_sprite2(p - float2(0.0, e), layer, texSdf));
    float2 q = p - g / max(length(g), 1e-6) *
                       max(sd_sprite2(p, layer, texSdf) + MODEL_RIM_INSET * texel, 0.0);
    return texImg.sample(samp, (q - layer.color.rg) / sprite_size(layer), level(0.0)).rgb;
}

struct SculptMat
{
    float3 alb;
    float rough;
    float spec;
    float sss;
    float refl;
};

inline SculptMat s_mat(float3 alb, float rough, float spec, float sss, float refl)
{
    SculptMat m;
    m.alb = alb;
    m.rough = rough;
    m.spec = spec;
    m.sss = sss;
    m.refl = refl;
    return m;
}

static float3 s_pixel_colour(float3 p, int shape)
{
    int2 cell = s_pix_cell(p.xy, shape);
    int4 g = PIX_GRID[shape];
    int row = g.z + clamp(cell.y, 0, g.y - 1);
    if (s_pix_bit(PIX_LINE[row], cell.x)) return s_lin(0.29, 0.12, 0.36);
    if (s_pix_bit(PIX_HI[row], cell.x)) return s_lin(1.0, 0.78, 0.87);
    if (s_pix_bit(PIX_SHADE[row], cell.x)) return s_lin(0.87, 0.27, 0.51);
    return s_lin(1.0, 0.435, 0.66);
}

static SculptMat sculpt_material(float mat, float3 p, int theme, int shape)
{
    bool primary = mat < 1.5;
    if (theme == 0)
    {
        if (mat < 2.5) return s_mat(s_lin(0.95, 0.92, 0.85), 0.3, 0.6, 0.35, 0.25);
        return s_mat(s_lin(0.1, 0.1, 0.11), 0.55, 0.05, 0.0, 0.1);
    }
    if (theme == 1) return s_mat(s_lin(0.02, 0.05, 0.33), 0.35, 0.5, 0.05, 0.3);
    if (theme == 2)
    {
        if ((primary && shape == 0) || (mat > 2.5 && mat < 3.5 && shape == 1)) return s_mat(s_lin(1.0, 0.40, 0.30), 0.85, 0.08, 0.15, 0.03);
        if (mat < 3.5) return s_mat(s_lin(1.0, 0.80, 0.10), 0.85, 0.08, 0.15, 0.03);
        return s_mat(s_lin(0.09, 0.13, 0.45), 0.9, 0.05, 0.05, 0.02);
    }
    if (theme == 4)
    {
        if (primary && shape == 0) return s_mat(s_lin(0.68, 0.93, 0.80), 0.25, 0.7, 0.3, 0.3);
        if (primary) return s_mat(s_lin(0.97, 0.95, 0.90), 0.3, 0.6, 0.35, 0.25);
        if (mat < 2.5) return s_mat(s_lin(0.52, 0.87, 0.78), 0.25, 0.7, 0.3, 0.3);
        if (mat < 3.5) return s_mat(s_lin(1.0, 0.75, 0.25), 0.25, 0.7, 0.3, 0.3);
        if (mat < 4.5) return s_mat(s_lin(0.62, 0.92, 0.72), 0.3, 0.6, 0.3, 0.35);
        return s_mat(s_lin(0.07, 0.15, 0.33), 0.7, 0.15, 0.05, 0.08);
    }
    return s_mat(s_pixel_colour(p, shape), 0.65, 0.1, 0.12, 0.04);
}

static float3 model_env(float3 d, float rough, float3 l, float3 fill)
{
    float3 col = mix(SCULPT_SCREEN * 0.9, s_lin(0.82, 0.85, 0.92) * 0.55, smoothstep(-0.15, 0.35, d.z));
    float w = rough * 0.3;
    float k = 1.0 - rough * 0.6;
    col += s_lin(1.0, 0.97, 0.92) * 5.0 * k * smoothstep(0.90 - w, 0.97, dot(d, l));
    col += s_lin(0.85, 0.9, 1.0) * 1.6 * k * smoothstep(0.93 - w, 0.98, dot(d, fill));
    return col;
}

static float3 model_tonemap(float3 c)
{
    const float start = 0.76;
    float x = min(c.r, min(c.g, c.b));
    c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
    float peak = max(c.r, max(c.g, c.b));
    if (peak >= start)
    {
        const float d = 1.0 - start;
        float np = 1.0 - d * d / (peak + d - start);
        c *= np / peak;
        float g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
        c = mix(c, float3(np), g);
    }
    return pow(saturate(c), float3(1.0 / 2.2));
}

static float3 model_shade(float3 q, float3 n, float3 rd, float3 L, float fall, float sh, float ao, float mat,
                          float3 l, float3 fill, constant Layer &layer,
                          texture2d<float, access::sample> texSdf,
                          texture2d<float, access::sample> texImg)
{
    int id = sculpt_id(layer);
    SculptMat m;
    float gloss = 1.0;
    if (id > 0)
    {
        float3 p = sculpt_point(q, layer) - float3(n.x, -n.y, n.z) * 0.01;
        m = sculpt_material(mat, p, (id - 1) / 2, (id - 1) % 2);
        if (id == 3 || id == 4)
        {
            gloss = 1.0 - smoothstep(0.97, 0.995, abs(n.z));
        }
    }
    else
    {
        m = s_mat(pow(model_albedo(q.xy, layer, texSdf, texImg), float3(2.2)), 0.45, 0.35, 0.2, 0.3);
        gloss = 1.0 - smoothstep(0.97, 0.995, abs(n.z));
    }
    float3 key = s_lin(1.0, 0.97, 0.93) * 2.1 * fall;
    float ndl = dot(n, L);
    float wrap = 0.5 * m.sss;
    float dif = saturate((ndl + wrap) / (1.0 + wrap)) * mix(sh, 1.0, 0.15 * m.sss);
    float ndh = saturate(dot(n, normalize(L - rd)));
    float shin = exp2(10.0 * (1.0 - m.rough) + 1.0);
    float spe = (pow(ndh, shin) * (shin + 8.0) / 25.0 + 0.15 * pow(ndh, 8.0)) * sh * saturate(ndl * 4.0);
    float fre = pow(1.0 - saturate(dot(n, -rd)), 5.0);
    float3 amb = mix(SCULPT_SCREEN * 0.12, s_lin(0.88, 0.92, 1.0) * 0.22, 0.5 + 0.5 * n.z);
    float3 fl = s_lin(0.85, 0.9, 1.0) * saturate(dot(n, fill)) * 0.12;
    float3 col = m.alb * (key * dif + (amb + fl) * ao * mix(float3(1.0), m.alb, 0.5));
    col += key * spe * m.spec * gloss;
    col += model_env(reflect(rd, n), m.rough, l, fill) * m.refl * (0.04 + 0.96 * fre) * ao * gloss;
    col += s_lin(0.9, 0.95, 1.0) * fre * 0.08 * ao * sh;
    return model_tonemap(col);
}

// ---- Le cristal de Prism Glow ---- (cf. HLSL)

inline float prism_fresnel(float c, float ior)
{
    float f0 = (ior - 1.0) / (ior + 1.0);
    f0 *= f0;
    return f0 + (1.0 - f0) * pow(1.0 - c, 5.0);
}

static float prism_primary(float3 ro, float3 rd, thread int &hc, constant Layer &layer)
{
    hc = -1;
    int shape = prism_shape(layer);
    if (shape < 0)
    {
        return 1e9;
    }
    float t = prism_trace(ro, rd, shape, hc);
    if (hc >= 0 && fmod(PRISM_TRIS[4 * hc].w, 2.0) > 0.5 && ro.z + rd.z * t < 0.0)
    {
        hc = -1;
        return 1e9;
    }
    return t;
}

inline float3 prism_normal(int h, float3 rd)
{
    float3 n = PRISM_TRIS[4 * h + 3].xyz;
    return dot(n, rd) > 0.0 ? -n : n;
}

inline float prism_seg(float3 p, float3 a, float3 b)
{
    float3 pa = p - a, ba = b - a;
    return length(pa - ba * saturate(dot(pa, ba) / dot(ba, ba)));
}

static float prism_edge_px(float3 p, int h, float px)
{
    float4 r0 = PRISM_TRIS[4 * h];
    float3 a = r0.xyz;
    float3 b = a + PRISM_TRIS[4 * h + 1].xyz;
    float3 c = a + PRISM_TRIS[4 * h + 2].xyz;
    int bits = int(r0.w * 0.5);
    float d = 1e9;
    if ((bits & 1) != 0) d = min(d, prism_seg(p, b, c));
    if ((bits & 2) != 0) d = min(d, prism_seg(p, c, a));
    if ((bits & 4) != 0) d = min(d, prism_seg(p, a, b));
    return d / px;
}

static float3 plane_to_world(float3 v, ModelFrame f)
{
    float x = v.x * f.c.z - v.y * f.s.z;
    float y = v.x * f.s.z + v.y * f.c.z;
    float z = -x * f.s.y + v.z * f.c.y;
    return float3(x * f.c.y + v.z * f.s.y, y * f.c.x - z * f.s.x, y * f.s.x + z * f.c.x);
}

static float3 prism_screen(float3 q, float3 d, float3 nz, float hz, float3 tip, float unit, ModelFrame f,
                           constant Layer &layer, texture2d<float, access::sample> texFrame)
{
    float denom = dot(d, nz);
    if (denom > -1e-4)
    {
        return SCULPT_SCREEN * 0.2;
    }
    float3 g = q + d * ((hz - dot(q, nz)) / denom);
    float3 w = plane_to_world(tip + unit * model_to_plane(g, f), f);
    float k = 1.0 - w.z / layer.src.z;
    if (k < 1e-3)
    {
        return SCULPT_SCREEN * 0.2;
    }
    float2 uv = layer.dst.xy + ((w.xy + layer.mb.zw) / k - layer.src.xy) / layer.quad_px * layer.dst.zw;
    if (any(uv < 0.0) || any(uv > 1.0))
    {
        return SCULPT_SCREEN * 0.2;
    }
    return pow(texFrame.sample(samp, uv, level(0.0)).rgb, float3(2.2));
}

static float3 prism_shade(float3 p, float3 n, float3 rd, int h, float px, float3 l, float3 fill, float3 nz,
                          float hz, float3 tip, float unit, ModelFrame f, constant Layer &layer,
                          texture2d<float, access::sample> texFrame)
{
    int shape = prism_shape(layer);
    float4 r3 = PRISM_TRIS[4 * h + 3];
    float3 facet = float3(PRISM_TRIS[4 * h + 1].w, PRISM_TRIS[4 * h + 2].w, r3.w);
    float F = prism_fresnel(saturate(-dot(rd, n)), PRISM_IOR);
    float zb = -model_thick(layer);
    float3 trans = float3(0.0);
    for (int ch = 0; ch < 3; ch++)
    {
        float3 mask = float3(float(ch == 0), float(ch == 1), float(ch == 2));
        float ior = PRISM_IOR + PRISM_DISPERSION * float(ch - 1);
        float3 d = refract(rd, n, 1.0 / ior);
        float3 pos = p;
        float thr = 1.0;
        float acc = 0.0;
        for (int b = 0; b < PRISM_BOUNCES; b++)
        {
            int hh;
            float th = prism_trace(pos, d, shape, hh);
            float tb = d.z < -1e-6 ? (zb - pos.z) / d.z : 1e9;
            if (tb <= th)
            {
                float3 qb = pos + d * tb;
                float3 d2 = refract(d, float3(0.0, 0.0, 1.0), ior);
                if (dot(d2, d2) < 1e-8)
                {
                    pos = qb;
                    d = reflect(d, float3(0.0, 0.0, 1.0));
                    continue;
                }
                acc += thr * dot(prism_screen(qb, d2, nz, hz, tip, unit, f, layer, texFrame), mask);
                thr = 0.0;
                break;
            }
            if (hh < 0)
            {
                break;
            }
            pos += d * th;
            float4 rn = PRISM_TRIS[4 * hh + 3];
            if (fmod(PRISM_TRIS[4 * hh].w, 2.0) > 0.5 && pos.z < 0.0)
            {
                acc += thr * dot(s_lin(0.03, 0.06, 0.37) * 0.35, mask);
                thr = 0.0;
                break;
            }
            float3 dout = refract(d, -rn.xyz, ior);
            if (dot(dout, dout) < 1e-8)
            {
                d = reflect(d, -rn.xyz);
                continue;
            }
            float fi = prism_fresnel(saturate(dot(dout, rn.xyz)), ior);
            acc += thr * (1.0 - fi) * dot(model_env(dout, 0.05, l, fill), mask);
            thr *= fi;
            d = reflect(d, -rn.xyz);
        }
        trans += acc * mask;
    }
    float3 col = F * model_env(reflect(rd, n), 0.05, l, fill) + (1.0 - F) * trans + facet * PRISM_GLOW;
    float fold = 1.0 - smoothstep(0.2, 1.0, prism_edge_px(p, h, px));
    col = mix(col, s_lin(0.96, 0.99, 1.0) * 1.3, PRISM_FOLD * fold * (0.35 + 0.65 * saturate(dot(n, l))));
    return model_tonemap(col);
}

// Les passes de la boucle unique de `cursor_model` (cf. HLSL : un seul appel de `model_eval`).
constant int STAGE_MARCH = 0;
constant int STAGE_NORMAL = 1;
constant int STAGE_AO = 2;
constant int STAGE_SELF = 3;
constant int STAGE_PLANE = 4;
constant int STAGE_EDGE = 5;
constant int STAGE_SHADE = 6;
constant int STAGE_DONE = 7;

constant float2 MODEL_SUBPIXEL[3] = { float2(0.35, 0.2), float2(-0.35, 0.2), float2(0.0, -0.4) };

inline float3 model_tetra(int k)
{
    return 0.5773 * (2.0 * float3(float(((k + 3) >> 1) & 1), float((k >> 1) & 1), float(k & 1)) - 1.0);
}

static float4 cursor_model(float2 local, constant Layer &layer,
                           texture2d<float, access::sample> texSdf,
                           texture2d<float, access::sample> texImg,
                           texture2d<float, access::sample> texFrame)
{
    ModelFrame f;
    f.c = cos(layer.fx.xyz);
    f.s = sin(layer.fx.xyz);
    f.cp = cos(layer.fx.w);
    f.sp = sin(layer.fx.w);
    f.cy = cos(layer.src_prev.w);
    f.sy = sin(layer.src_prev.w);
    float persp = layer.src.z;
    float unit = layer.src.w;
    float3 tip = layer.src_prev.xyz;
    float3 lo = float3(layer.color.rg, -model_thick(layer));
    float3 hi = float3(layer.color.rg + sprite_size(layer), layer.trail_a.z);

    float3 dw = float3(local + layer.src.xy, -persp);
    float dlen = length(dw);
    // Plan translaté de mb.zw dans le repère caméra (caméra réelle ; 0 sous un angle fixe).
    float3 ro = plane_to_model((world_to_plane(float3(-layer.mb.z, -layer.mb.w, persp), f) - tip) / unit, f);
    float3 rd = plane_to_model(world_to_plane(dw / dlen, f), f);
    float3 l = plane_to_model(world_to_plane(MODEL_LIGHT, f), f);
    float3 fill = plane_to_model(world_to_plane(MODEL_FILL, f), f);
    float3 nz = plane_to_model(float3(0.0, 0.0, 1.0), f);
    float hz = -tip.z / unit;
    float stride = sculpt_id(layer) > 0 ? 0.85 : 1.0;
    float3 lamp = float3(layer.color.rg + sprite_size(layer) * 0.5, 0.0) + l * SCULPT_LAMP_DIST;

    float3 ray = rd;
    float2 tb = ray_box(ro, ray, lo - 0.02, hi + 0.02);
    int stage = tb.x < tb.y && tb.y > 0.0 ? STAGE_MARCH : STAGE_DONE;
    bool plane_next = stage == STAGE_DONE;
    bool need_tc = stage == STAGE_MARCH;
    float tc = 1e9;
    int hc = -1;
    int k = 0;
    float t = max(tb.x, 0.0);
    float best = 1e9;
    float t_best = t;
    float d_best = 0.0;
    float mat = 0.0;
    float cov = 0.0;
    float cov_s = 0.0;
    float3 q = float3(0.0);
    float3 n = float3(0.0);
    float3 L = float3(0.0);
    float ao = 1.0;
    float sh = 1.0;
    float2 ts = float2(0.0);
    float res = 1.0;
    float3 g = float3(0.0);
    float inside = 0.0;
    float contact = 0.0;
    float dropped = 0.0;
    int sub = 0;
    int shaded = 0;
    float4 acc = float4(0.0);
    for (int it = 0; it < 500; it++)
    {
        if (need_tc)
        {
            need_tc = false;
            tc = prism_primary(ro, ray, hc, layer);
        }
        if (plane_next)
        {
            plane_next = false;
            stage = cov > 0.0 ? STAGE_SHADE : STAGE_DONE;
            float denom = dot(rd, nz);
            if (cov < 1.0 && denom < -1e-4)
            {
                g = ro + rd * ((hz - dot(ro, nz)) / denom);
                float3 gp = tip + unit * model_to_plane(g, f);
                inside = saturate(min(layer.mb.x - abs(gp.x), layer.mb.y - abs(gp.y)) + 0.5);
                if (inside > 0.0)
                {
                    stage = STAGE_PLANE;
                    k = 0;
                    ts = float2(0.0);
                }
            }
        }
        if (stage == STAGE_SHADE)
        {
            if (cov_s > 0.0)
            {
                float3 c;
                if (mat > PRISM_MAT - 0.5)
                {
                    c = prism_shade(q, n, ray, hc, t_best / dlen, l, fill, nz, hz, tip, unit, f, layer, texFrame);
                }
                else
                {
                    float3 tl = lamp - q;
                    float fall = SCULPT_LAMP_DIST * SCULPT_LAMP_DIST / dot(tl, tl);
                    c = model_shade(q, n, ray, normalize(tl), fall, sh, ao, mat, l, fill, layer, texSdf, texImg);
                }
                acc += float4(c * cov_s, cov_s);
            }
            shaded++;
            stage = STAGE_DONE;
            if (sub > 0)
            {
                float3 dws = float3(local + MODEL_SUBPIXEL[3 - sub] + layer.src.xy, -persp);
                sub--;
                dlen = length(dws);
                ray = plane_to_model(world_to_plane(dws / dlen, f), f);
                tb = ray_box(ro, ray, lo - 0.02, hi + 0.02);
                cov_s = 0.0;
                stage = STAGE_SHADE;
                if (tb.x < tb.y && tb.y > 0.0)
                {
                    stage = STAGE_MARCH;
                    k = 0;
                    t = max(tb.x, 0.0);
                    best = 1e9;
                    t_best = t;
                    need_tc = true;
                }
            }
            continue;
        }
        float3 pos;
        if (stage == STAGE_MARCH)
        {
            pos = ro + ray * t;
        }
        else if (stage == STAGE_NORMAL)
        {
            pos = q + 0.002 * model_tetra(k);
        }
        else if (stage == STAGE_EDGE)
        {
            float3 side = normalize(cross(n, ray));
            float3 e = (k >= 2 ? cross(n, side) : side) * (k % 2 == 1 ? -1.0 : 1.0);
            pos = q + e * 0.5 * t_best / dlen;
        }
        else if (stage == STAGE_AO)
        {
            pos = q + (0.01 + 0.0175 * k) * SCULPT_SCALE * n;
        }
        else if (stage == STAGE_SELF)
        {
            pos = q + n * 0.003 + L * ts.x;
        }
        else if (stage == STAGE_PLANE)
        {
            pos = g + l * ts.x;
        }
        else
        {
            break;
        }
        float2 m = model_eval(pos, stage == STAGE_PLANE, layer, texSdf);
        float d = m.x;
        if (stage == STAGE_MARCH)
        {
            float fp = t / dlen;
            bool hit = d < 0.1 * fp;
            if (hit || d / fp < best)
            {
                best = hit ? 0.0 : d / fp;
                t_best = t;
                d_best = d;
                mat = m.y;
            }
            t += d * stride;
            k++;
            if (!hit && t >= tc)
            {
                hit = true;
                best = 0.0;
                t_best = tc;
                d_best = 0.0;
                mat = PRISM_MAT;
            }
            if (hit || t > tb.y || k == 96)
            {
                cov_s = saturate(1.0 - best);
                if (shaded > 0)
                {
                    stage = STAGE_SHADE;
                    if (cov_s > 0.0)
                    {
                        q = ro + ray * t_best;
                        n = float3(0.0);
                        stage = STAGE_NORMAL;
                        k = 0;
                    }
                }
                else
                {
                    cov = cov_s;
                    if (cov > 0.0)
                    {
                        q = ro + ray * t_best;
                        stage = STAGE_NORMAL;
                        k = 0;
                    }
                    else
                    {
                        plane_next = true;
                    }
                }
                if (stage == STAGE_NORMAL && mat > PRISM_MAT - 0.5)
                {
                    n = prism_normal(hc, ray);
                    k = 0;
                    if (shaded > 0)
                    {
                        stage = STAGE_SHADE;
                    }
                    else
                    {
                        if (prism_edge_px(q, hc, t_best / dlen) < 0.75)
                        {
                            sub = 3;
                        }
                        stage = STAGE_DONE;
                        plane_next = true;
                    }
                }
            }
        }
        else if (stage == STAGE_NORMAL)
        {
            n += model_tetra(k) * d;
            k++;
            if (k == 4)
            {
                n = normalize(n);
                k = 0;
                stage = shaded > 0 ? STAGE_SHADE : STAGE_EDGE;
            }
        }
        else if (stage == STAGE_EDGE)
        {
            if (m.y != mat || abs(d - d_best) > 0.02 * t_best / dlen)
            {
                sub = 3;
            }
            if (k == 0 && mat > 7.5)
            {
                int ps = prism_shape(layer);
                if (ps >= 0)
                {
                    float dout = prism_poly_dist(q.xy, PRISM_OUT_START[ps], PRISM_OUT_COUNT[ps]);
                    if (abs(dout) < 0.75 * t_best / dlen)
                    {
                        sub = 3;
                    }
                }
            }
            k++;
            if (k == 4)
            {
                stage = STAGE_AO;
                k = 0;
                ao = 0.0;
            }
        }
        else if (stage == STAGE_AO)
        {
            ao += ((0.01 + 0.0175 * k) * SCULPT_SCALE - d) * pow(0.85, float(k));
            k++;
            if (k == 5)
            {
                ao = saturate(1.0 - 3.5 * ao / SCULPT_SCALE);
                L = normalize(lamp - q);
                float2 tbs = ray_box(q + n * 0.003, L, lo - MODEL_SHADOW_PAD, hi + MODEL_SHADOW_PAD);
                if (tbs.x < tbs.y && tbs.y > 0.0)
                {
                    stage = STAGE_SELF;
                    k = 0;
                    ts = float2(max(tbs.x, 0.004), tbs.y);
                    res = 1.0;
                }
                else
                {
                    plane_next = true;
                }
            }
        }
        else if (stage == STAGE_SELF)
        {
            res = min(res, MODEL_SOFTNESS * d / ts.x);
            ts.x += clamp(d, 0.01, 0.2);
            k++;
            if (res < 0.002 || ts.x > ts.y || k == 32)
            {
                res = saturate(res);
                sh = res * res * (3.0 - 2.0 * res);
                plane_next = true;
            }
        }
        else if (k == 0)
        {
            contact = 1.0 - smoothstep(0.0, MODEL_CONTACT_RADIUS, d);
            float2 tbp = ray_box(g, l, lo - MODEL_SHADOW_PAD, hi + MODEL_SHADOW_PAD);
            ts = float2(max(tbp.x, 0.004), tbp.y);
            res = 1.0;
            k = 1;
            if (!(tbp.x < tbp.y && tbp.y > 0.0))
            {
                stage = cov > 0.0 ? STAGE_SHADE : STAGE_DONE;
            }
        }
        else
        {
            res = min(res, MODEL_SOFTNESS * d / ts.x);
            ts.x += clamp(d, 0.01, 0.2);
            k++;
            if (res < 0.002 || ts.x > ts.y || k == 33)
            {
                res = saturate(res);
                dropped = 1.0 - res * res * (3.0 - 2.0 * res);
                stage = cov > 0.0 ? STAGE_SHADE : STAGE_DONE;
            }
        }
    }

    float w = 1.0 / max(shaded, 1);
    float shadow = inside * max(dropped * MODEL_SHADOW_ALPHA, contact * MODEL_CONTACT_ALPHA);
    float a = acc.a * w * layer.color.a;
    return float4(acc.rgb * w * layer.color.a, a + (1.0 - a) * shadow * layer.color.a); // prémultiplié, ombre noire
}

// ============ Impact du clic (mode 16) ============
// Port ligne pour ligne de `cursor_impact` (HLSL), dont les commentaires font foi.
static float4 cursor_impact(float2 local, constant Layer &layer)
{
    float3 r = quad_inverse(local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.mb.x);
    float2 pf = layer.dst_prev.xy + r.xy * layer.dst_prev.zw;
    if (r.z < 0.5 || any(pf < 0.0) || any(pf > 1.0))
    {
        return float4(0.0);
    }
    float d = length(r.xy * 2.0 - 1.0);
    float x = abs(d - layer.src.x);
    float aa = layer.radius_px;
    float ring = layer.src.z * (1.0 - smoothstep(layer.src.y - aa, layer.src.y + aa, x));
    float halo = layer.src.w * exp(-x * x / (6.0 * layer.src.y * layer.src.y + aa * aa));
    float spot = layer.mb.z * exp(-d * d / max(layer.mb.y * layer.mb.y, 1e-6));
    float shade = clamp(halo + spot, 0.0, 1.0);
    float a = ring + (1.0 - ring) * shade;
    return float4(layer.color.rgb * ring, a) * layer.color.a; // prémultiplié, ombre noire
}

// ============ Cadre d'APPAREIL modelé (mode 17) ============
// Un portable, un téléphone ou un moniteur, modelés en VRAIE 3D autour du métrage : un corps qui
// a une épaisseur, des arêtes chanfreinées et une lunette, dont la face écran tombe EXACTEMENT
// sur le plan du métrage — le mode 8 continue donc de le dessiner dans l'ouverture, que ce mode
// creuse dans la face avant. Lancé de rayons par pixel dans la MÊME caméra que le plan,
// reconstruite comme au mode 15 (`regions::rotate_point` puis perspective P / (P − z)). Des
// formes neutres que l'on dessine soi-même : aucune marque, aucun logo.
//
// Repère du MODÈLE : unité = l'unité du cadre (`frame_geometry::frame_unit_px`, la même quel que
// soit le ratio du clip), origine au CENTRE du plan, x à droite,
// y vers le bas, z vers la caméra. L'écran occupe ±`layer.mb.xy`, le corps l'entoure de `src_prev` et
// va de z = −`layer.fx.w` à 0 ; ce qui dépasse (socle, pied) sort vers +y et ±z.
// Emplacements du cbuffer — miroir de `frame_geometry::device_frame_cb`, qui en fait foi :
//   src       = (décalage px du rayon, P, unité du modèle en px)
//   layer.radius_px = rayon extérieur du corps, coins HAUTS (unités du modèle)
//   layer.color.r   = l'appareil (1 portable, 2 téléphone, 3 moniteur) ; layer.color.g = 1 si thème sombre ;
//               layer.color.b = rayon extérieur du corps, coins BAS (unités) ; layer.color.a = opacité
//   fx        = (rotation du plan X, Y, Z en rad ; épaisseur du corps)
//   src_prev  = marges du corps (gauche, haut, droite, bas), unités du modèle
//   mb        = (demi-taille de l'écran ; translation du plan dans le repère caméra, px)
//   dst_prev  = (angle du socle du portable depuis le plan, rad ; rayon des coins de l'OUVERTURE,
//               celui du métrage, unités ; recouvrement de la lunette sur le métrage, unités ;
//               pénombre de l'OMBRE en px, 0 pour l'appareil lui-même)
// Les deux rayons du corps sont CONCENTRIQUES à celui de l'ouverture (`concentric_radius`) : la
// lunette garde son épaisseur tout autour de chaque coin. Ils viennent tout faits du cbuffer.
// Constantes : miroir exact de `frame_geometry.rs` (DEV_*), sauf ce qui ne change jamais
// l'encombrement — le micro-chanfrein, l'encoche du socle, les coins de la semelle — et n'existe
// donc que côté shader. Toutes en unités du modèle. L'éclairage est celui du curseur modélisé
// (MODEL_LIGHT/AMBIENT/DIFFUSE), pour que les deux objets d'une même frame soient vus sous la
// même lampe.
//
// Le parti pris matière : ALUMINIUM MAT ET VERRE NOIR, pas de plastique. Un gros arrondi d'arête
// et un reflet large font un objet gonflé ; un produit se lit à ses faces PLATES, à une arête
// nette et à un filet de lumière d'un pixel. D'où : un chanfrein de deux millièmes d'unité — assez
// pour que l'arête ne coupe pas, trop peu pour arrondir la silhouette —, aucun lobe spéculaire
// large, et un filet PEINT le long du contour (un tel chanfrein fait moins de deux pixels à
// l'écran : modelé, il ne s'antialiaserait pas).
constant float DEV_CHAMFER = 0.0021;
// Distance MINIMALE de l'œil qui voit le relief du modèle : celle d'un bras devant un portable.
// Miroir de `frame_geometry::DEV_EYE_MIN`.
constant float DEV_EYE_MIN = 9.6;
// Le plan proche du modèle (`frame_geometry::device_near_plane`) : une fraction de la distance
// de l'œil du modèle, rapprochée du travelling de la caméra réelle, et la bande de fondu. L'objectif
// des présets, 1,6 petit côté (`regions::PERSPECTIVE_FACTOR`), sert de distance de repos.
constant float DEV_NEAR = 0.16;
constant float DEV_NEAR_BAND = 0.1;
constant float DEV_LENS = 1.6;
// Le socle a sa profondeur réelle ; c'est son ANGLE (`device_deck_angle`) qui le rend discret vu
// de face. Il a la largeur de la coque ; tout le reste de ce qui dépasse est fixe, en unités du
// modèle, quelle que soit la forme du métrage encadré.
constant float DEV_DECK_LEN = 1.30;
// Le liseré d'aluminium qui borde la face avant (`DEV_RIM`), le rayon des coins avant de la
// semelle du moniteur (`DEV_FOOT_R`) et l'encoche du socle du portable, au milieu de son arête
// avant (`DEV_SCOOP_*` : demi-largeur, profondeur, hauteur de l'ellipsoïde retiré).
constant float DEV_RIM = 0.0053;
constant float DEV_FOOT_R = 0.0365;
constant float DEV_SCOOP_W = 0.14;
constant float DEV_SCOOP_D = 0.0372;
constant float DEV_SCOOP_H = 0.0112;
constant float DEV_DECK_THICK = 0.0446;
constant float DEV_DECK_THICK_FRONT = 0.0391;
constant float DEV_DECK_GAP = 0.0093;
constant float DEV_NECK_W = 0.255;
constant float DEV_NECK_LEN = 0.177;
constant float DEV_FOOT_W = 0.456;
constant float DEV_FOOT_H = 0.0456;
constant float DEV_STAND_Z = 0.0219;
constant float DEV_FOOT_Z = 0.195;
// Teintes (alpha droit). Deux thèmes, `layer.color.g` = 1 pour le sombre : aluminium argent ou
// graphite, et le verre de la dalle qui va avec. Neutres — c'est ce qui fait un appareil
// « schématique » et non une marque.
constant float3 DEV_SHELL_LIGHT = float3(0.800, 0.806, 0.812);
constant float3 DEV_SHELL_LIGHT_BACK = float3(0.600, 0.610, 0.622);
constant float3 DEV_GLASS_LIGHT = float3(0.031, 0.034, 0.040);
constant float3 DEV_SHELL_GRAPHITE = float3(0.255, 0.263, 0.278);
constant float3 DEV_SHELL_GRAPHITE_BACK = float3(0.153, 0.161, 0.176);
constant float3 DEV_GLASS_GRAPHITE = float3(0.043, 0.047, 0.055);
// Voile directionnel de l'aluminium brossé : doux et étroit, jamais une tache.
constant float DEV_SHEEN = 0.11;

static inline bool dev_dark(constant Layer &layer) { return layer.color.g > 0.5; }
static inline float3 dev_shell(constant Layer &layer) { return dev_dark(layer) ? DEV_SHELL_GRAPHITE : DEV_SHELL_LIGHT; }
static inline float3 dev_shell_back(constant Layer &layer) { return dev_dark(layer) ? DEV_SHELL_GRAPHITE_BACK : DEV_SHELL_LIGHT_BACK; }
static inline float3 dev_glass(constant Layer &layer) { return dev_dark(layer) ? DEV_GLASS_GRAPHITE : DEV_GLASS_LIGHT; }

static inline float2 dev_body_c(constant Layer &layer) { return float2((layer.src_prev.z - layer.src_prev.x) * 0.5, (layer.src_prev.w - layer.src_prev.y) * 0.5); }
static inline float2 dev_body_h(constant Layer &layer) { return layer.mb.xy + float2((layer.src_prev.x + layer.src_prev.z) * 0.5, (layer.src_prev.y + layer.src_prev.w) * 0.5); }
// Le chanfrein, borné par l'épaisseur : garde-fou, jamais atteint aux épaisseurs livrées.
static inline float dev_chamfer(constant Layer &layer) { return min(DEV_CHAMFER, layer.fx.w * 0.3); }
static inline float dev_deck_angle(constant Layer &layer) { return layer.dst_prev.x; }
// L'appareil : 1 = portable, 2 = téléphone, 3 = moniteur (`device_kind_id`).
static inline bool dev_is(constant Layer &layer, float k) { return abs(layer.color.r - k) < 0.5; }

// La hauteur du PLAN PROCHE devant l'écran (unités), pour la caméra RÉELLE en `eye` (repère du
// plan, unités) qui regarde le long de `axis`. Cf. `dev_near_plane` (HLSL), qui fait foi ; miroir
// de `frame_geometry::device_near_plane`.
static inline float dev_near_plane(float3 eye, float3 axis, constant Layer &layer)
{
    float dist = eye.z / max(-axis.z, 1e-3);
    return DEV_NEAR * DEV_EYE_MIN * dist / max(DEV_LENS * 2.0 * min(layer.mb.x, layer.mb.y), 1e-4);
}

// Ce qui reste d'un point `q` du modèle sous le plan proche `h_near` : un fondu, jamais une coupe.
static inline float dev_near_fade(float3 q, float h_near)
{
    return 1.0 - smoothstep(h_near * (1.0 - DEV_NEAR_BAND), h_near, q.z);
}

// Boîte 3D à arêtes chanfreinées.
static float sd_dev_box(float3 p, float3 h, float r)
{
    float3 q = abs(p) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// Le contour du CORPS dans le plan xy, signé (<0 dedans) : la silhouette de la face avant. Le
// filet de lumière et le liseré du navigateur s'y accrochent.
static float sd_dev_outline(float2 p, constant Layer &layer)
{
    // Coins hauts `radius_px`, coins bas `color.b` (cf. HLSL).
    float2 q = p - dev_body_c(layer);
    return sd_round_rect(q, dev_body_h(layer), (q.y < 0.0) ? layer.radius_px : layer.color.b);
}

// Ellipsoïde (borne de distance) : l'encoche du socle.
static float sd_dev_ellipsoid(float3 p, float3 r)
{
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

// La dalle PLEINE du corps : arrondie en xy, mince en z, chanfreinée. Sans le creux de l'écran,
// c'est la silhouette qui porte l'ombre.
static float sd_dev_slab(float3 p, constant Layer &layer)
{
    float t = layer.fx.w;
    float ch = dev_chamfer(layer);
    float2 w = float2(sd_dev_outline(p.xy, layer) + ch, abs(p.z + t * 0.5) - (t * 0.5 - ch));
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - ch;
}

// L'OUVERTURE dans le plan (<0 dedans) : le contour du métrage (rayon `dst_prev.y`) rentré du
// recouvrement `dst_prev.z` comme un décalage — mêmes centres d'arc, rayon diminué d'autant —, si
// bien que la lunette mord le métrage de la même largeur aux coins que le long des bords (cf. HLSL).
static float sd_dev_aperture(float2 p, constant Layer &layer)
{
    float2 ah = layer.mb.xy - layer.dst_prev.z;
    return sd_round_rect(p, ah, clamp(layer.dst_prev.y - layer.dst_prev.z, 0.0, min(ah.x, ah.y)));
}

// Le CORPS : la dalle moins le creux de l'écran, ouvert vers la caméra et fermé au fond — un trou
// débouchant laisserait voir au travers par le côté.
static float sd_dev_body(float3 p, constant Layer &layer)
{
    float hole = max(sd_dev_aperture(p.xy, layer), -p.z - layer.fx.w * 0.55);
    return max(sd_dev_slab(p, layer), -hole);
}

// Le repère du socle du portable : origine à la charnière (bord bas de la coque, à mi-épaisseur),
// y vers l'avant le long du socle, z sa normale. Miroir de `DeviceView::model_points`.
static float3 dev_deck_local(float3 p, constant Layer &layer)
{
    float2 c = dev_body_c(layer);
    float2 h = dev_body_h(layer);
    float3 d = p - float3(0.0, c.y + h.y, -layer.fx.w * 0.5);
    float ca = cos(dev_deck_angle(layer));
    float sa = sin(dev_deck_angle(layer));
    return float3(d.x, d.y * ca + d.z * sa, -d.y * sa + d.z * ca);
}

// Le socle : un COIN, pleine épaisseur à la charnière et aminci vers le bord avant, EXACTEMENT
// aussi large que la coque, et séparé d'elle par un jeu — le trait sombre qui dit deux pièces.
static float sd_dev_deck(float3 p, constant Layer &layer)
{
    float3 q = dev_deck_local(p, layer);
    float y0 = DEV_DECK_GAP;
    float y1 = y0 + DEV_DECK_LEN;
    float tb = DEV_DECK_THICK;
    float slab = sd_dev_box(q - float3(0.0, (y0 + y1) * 0.5, -tb * 0.5),
                            float3(dev_body_h(layer).x, (y1 - y0) * 0.5, tb * 0.5),
                            DEV_CHAMFER * 2.0);
    // Le dessous remonte vers l'avant : c'est lui, et non l'épaisseur, qui fait le profil en coin.
    float k = (DEV_DECK_THICK - DEV_DECK_THICK_FRONT) / DEV_DECK_LEN;
    float under = (-tb + k * (q.y - y0) - q.z) * rsqrt(1.0 + k * k);
    // L'encoche au milieu de l'arête avant (cf. HLSL).
    float scoop = sd_dev_ellipsoid(q - float3(0.0, y1, 0.0), float3(DEV_SCOOP_W, DEV_SCOOP_D, DEV_SCOOP_H));
    return max(max(slab, under), -scoop);
}

// Entrée ANALYTIQUE du rayon dans le coin du socle, 1e9 s'il le manque (cf. HLSL, qui fait foi).
static float dev_deck_hit(float3 ro, float3 rd, constant Layer &layer)
{
    float3 q0 = dev_deck_local(ro, layer);
    float3 qd = dev_deck_local(ro + rd, layer) - q0;
    float hw = dev_body_h(layer).x;
    float y0 = DEV_DECK_GAP;
    float len = DEV_DECK_LEN;
    float tb = DEV_DECK_THICK;
    float2 tt = ray_box(q0, qd, float3(-hw, y0, -tb), float3(hw, y0 + len, 0.0));
    float k = (DEV_DECK_THICK - DEV_DECK_THICK_FRONT) / len;
    float g0 = -tb + k * (q0.y - y0) - q0.z;
    float gd = k * qd.y - qd.z;
    if (abs(gd) > 1e-9)
    {
        float tg = -g0 / gd;
        if (gd > 0.0) { tt.y = min(tt.y, tg); } else { tt.x = max(tt.x, tg); }
    }
    else if (g0 > 0.0)
    {
        return 1e9;
    }
    if (tt.x > tt.y || tt.y <= 0.0)
    {
        return 1e9;
    }
    // Entré par l'encoche, le rayon touche la matière à sa sortie de l'ellipsoïde.
    float t_in = max(tt.x, 0.0);
    float3 o = (q0 - float3(0.0, y0 + len, 0.0)) / float3(DEV_SCOOP_W, DEV_SCOOP_D, DEV_SCOOP_H);
    float3 e = qd / float3(DEV_SCOOP_W, DEV_SCOOP_D, DEV_SCOOP_H);
    float ea = dot(e, e);
    float eb = dot(o, e);
    float disc = eb * eb - ea * (dot(o, o) - 1.0);
    if (disc > 0.0)
    {
        float s = sqrt(disc);
        if (t_in >= (-eb - s) / ea && t_in < (-eb + s) / ea) { t_in = (-eb + s) / ea; }
    }
    return (t_in <= tt.y) ? t_in : 1e9;
}

// Le pied du moniteur : colonne mince contre le dos, puis semelle basse et plate qui part en
// arrière. Pas de palet épais — un pied de moniteur est une tôle.
static float sd_dev_stand(float3 p, constant Layer &layer)
{
    float y0 = dev_body_c(layer).y + dev_body_h(layer).y;
    float zc = -layer.fx.w * 0.5;
    float neck = sd_dev_box(p - float3(0.0, y0 + DEV_NECK_LEN * 0.5 - 0.01, zc - DEV_STAND_Z * 0.5),
                            float3(DEV_NECK_W, DEV_NECK_LEN * 0.5 + 0.01, DEV_STAND_Z * 0.5),
                            DEV_CHAMFER * 2.0);
    // La semelle : une plaque plate, coins arrondis dans son plan (xz), flancs droits.
    float3 f = p - float3(0.0, y0 + DEV_NECK_LEN + DEV_FOOT_H * 0.5, zc - DEV_FOOT_Z * 0.5);
    float2 fd = float2(sd_round_rect(f.xz, float2(DEV_FOOT_W, DEV_FOOT_Z * 0.5), DEV_FOOT_R),
                       abs(f.y) - DEV_FOOT_H * 0.5);
    float foot = min(max(fd.x, fd.y), 0.0) + length(max(fd, 0.0));
    return min(neck, foot);
}

// Ce qui sort du corps : le socle du portable, le pied du moniteur, rien pour les deux autres.
static float sd_dev_extra(float3 p, constant Layer &layer)
{
    if (dev_is(layer, 1.0)) { return sd_dev_deck(p, layer); }
    if (dev_is(layer, 3.0)) { return sd_dev_stand(p, layer); }
    return 1e9;
}

static float sd_device(float3 p, constant Layer &layer)
{
    return min(sd_dev_body(p, layer), sd_dev_extra(p, layer));
}

// Le modèle PLEIN, écran compris : ce que l'ombre voit.
static float sd_dev_solid(float3 p, constant Layer &layer)
{
    return min(sd_dev_slab(p, layer), sd_dev_extra(p, layer));
}

static float3 device_normal(float3 p, constant Layer &layer)
{
    const float e = 0.0006;
    return normalize(float3(1, -1, -1) * sd_device(p + float3(1, -1, -1) * e, layer) +
                     float3(-1, -1, 1) * sd_device(p + float3(-1, -1, 1) * e, layer) +
                     float3(-1, 1, -1) * sd_device(p + float3(-1, 1, -1) * e, layer) +
                     float3(1, 1, 1) * sd_device(p + float3(1, 1, 1) * e, layer));
}

// Couverture d'une SDF 2D adoucie sur un pixel (`aa` = un pixel en unités du modèle).
static inline float dev_cov(float d, float aa)
{
    return saturate(0.5 - d / max(aa, 1e-6));
}

// Filet de lumière d'un pixel, peint juste à l'intérieur d'un contour `d2` (<0 dedans).
static inline float dev_hairline(float d2, float aa)
{
    return dev_cov(abs(d2 + aa) - aa * 0.55, aa);
}

// La matière au point `p`, normale `n` : `.rgb` l'albédo (alpha droit), `.a` = 1 pour le métal
// (qui prend le voile directionnel), 0 pour le verre, qui reste mat.
static float4 device_albedo(float3 p, float3 n, float aa, constant Layer &layer)
{
    float3 metal = dev_shell(layer);
    float3 back = dev_shell_back(layer);
    if (sd_dev_body(p, layer) > sd_dev_extra(p, layer))
    {
        if (!dev_is(layer, 1.0))
        {
            // Le pied du moniteur : de l'aluminium, un dégradé vertical doux.
            float v = saturate((p.y - dev_body_c(layer).y - dev_body_h(layer).y) / (DEV_NECK_LEN + DEV_FOOT_H));
            return float4(mix(metal, back, 0.15 + 0.45 * v), 1.0);
        }
        float3 q = dev_deck_local(p, layer);
        float hw = dev_body_h(layer).x;
        float y0 = DEV_DECK_GAP;
        float len = DEV_DECK_LEN;
        // La tranche AVANT : une barre d'argent qui fonce doucement vers son arête basse.
        if (q.y > y0 + len - DEV_CHAMFER * 3.0)
        {
            float s = saturate(-q.z / DEV_DECK_THICK_FRONT);
            return float4(mix(metal, back, smoothstep(0.35, 1.0, s) * 0.8), 1.0);
        }
        // Le dessous, puis le dessus : clavier et pavé tactile.
        if (q.z < -DEV_DECK_THICK * 0.25) { return float4(back, 1.0); }
        float3 top = metal;
        // Clavier : 0,75 de la largeur du socle, de 0,10 à 0,56 de sa profondeur.
        float key = sd_round_rect(q.xy - float2(0.0, y0 + len * 0.33),
                                  float2(hw * 0.75, len * 0.23), len * 0.02);
        top = mix(top, metal * 0.52, dev_cov(key, aa));
        top = mix(top, metal * 1.06, dev_hairline(key, aa));
        // Pavé tactile, centré dans la moitié avant.
        float pad = sd_round_rect(q.xy - float2(0.0, y0 + len * 0.76),
                                  float2(hw * 0.26, len * 0.14), len * 0.015);
        top = mix(top, metal * 0.88, dev_cov(pad, aa));
        top = mix(top, metal * 1.04, dev_hairline(pad, aa));
        return float4(top, 1.0);
    }
    // Le dos et les flancs : l'aluminium, plus sombre quand il tourne le dos à la caméra.
    float3 shell = mix(back, metal, saturate(n.z * 0.8 + 0.5));
    // Le quart avant du corps seulement (cf. HLSL) : la colonne du moniteur n'est pas du verre.
    float front = (p.z < -layer.fx.w * 0.25) ? 0.0 : smoothstep(0.30, 0.80, n.z);
    if (front <= 0.0) { return float4(shell, 1.0); }

    // Le liseré d'aluminium qui borde la face avant, et le filet de lumière sur son arête.
    float edge = sd_dev_outline(p.xy, layer);
    float band = 1.0 - dev_cov(edge + DEV_RIM, aa);
    float rim = dev_hairline(edge, aa);

    // La face avant : une dalle de verre noir pour les trois appareils.
    float3 c = dev_glass(layer);
    if (dev_is(layer, 2.0))
    {
        // Téléphone : un œil de caméra, rien d'autre — pas de fente de haut-parleur, qui date un
        // téléphone. Au milieu de la lunette du HAUT DU TÉLÉPHONE, pas du métrage : une ouverture
        // paysage est un téléphone COUCHÉ, son haut vers la gauche de l'image. Sa taille est fixe,
        // comme l'épaisseur du corps.
        bool upright = layer.mb.y >= layer.mb.x;
        float2 e = upright ? p.xy : float2(-p.y, p.x);
        float2 hh = upright ? layer.mb.xy : float2(layer.mb.y, layer.mb.x);
        float bez = (upright ? layer.src_prev.y : layer.src_prev.x) - DEV_RIM;
        c = mix(c, float3(0.086, 0.102, 0.133), dev_cov(length(e - float2(0.0, -hh.y - bez * 0.5)) - 0.003, aa));
    }
    else
    {
        // Portable et moniteur : un œil de caméra centré dans la lunette du haut, pas d'encoche.
        float bez = layer.src_prev.y - DEV_RIM;
        c = mix(c, float3(0.120, 0.133, 0.161), dev_cov(length(p.xy - float2(0.0, -layer.mb.y - bez * 0.5)) - 0.2 * bez, aa));
    }
    c = mix(c, metal, band);
    c = mix(c, min(metal * 1.12, 1.0), rim);
    return float4(mix(shell, c, front), max(band, rim));
}

// L'OMBRE portée de l'appareil (même calque, `dst_prev.w` = pénombre en px) : la silhouette que
// la caméra voit VRAIMENT du modèle, socle et pied compris. Cf. `device_shadow` (HLSL), qui fait
// foi : le décalage est déjà dans `src.xy`, on marche le modèle PLEIN, et la plus courte approche
// du rayon, en px, tient lieu de distance au contour, avec la pénombre du mode 2. Ce que le plan
// proche `h_near` efface de l'appareil, il l'efface de son ombre.
static float4 device_shadow(float3 ro, float3 rd, float fpk, float3 lo, float3 hi, float h_near, constant Layer &layer)
{
    float spread = layer.dst_prev.w;
    float m = 2.0 * spread / layer.src.w;
    float2 tb = ray_box(ro, rd, lo - m, hi + m);
    if (tb.x >= tb.y || tb.y <= 0.0)
    {
        return float4(0.0, 0.0, 0.0, 0.0);
    }
    // Dans la silhouette pleine, à coup sûr : le rayon perce la face avant ou le socle.
    if (rd.z < -1e-5 && sd_dev_outline((ro + rd * (-ro.z / rd.z)).xy, layer) < 0.0)
    {
        return float4(0.0, 0.0, 0.0, layer.color.a);
    }
    float t_deck = dev_is(layer, 1.0) ? dev_deck_hit(ro, rd, layer) : 1e9;
    if (t_deck < 1e9)
    {
        return float4(0.0, 0.0, 0.0, layer.color.a * dev_near_fade(ro + rd * t_deck, h_near));
    }
    float t = max(tb.x, 0.0);
    float best = 1e9;
    float t_best = t;
    for (int k = 0; k < 96; k++)
    {
        float d = sd_dev_solid(ro + rd * t, layer);
        float fp = t * fpk;
        if (max(d, 0.0) / fp < best)
        {
            best = max(d, 0.0) / fp;
            t_best = t;
        }
        if (d < 0.08 * fp || t > tb.y)
        {
            break;
        }
        t += max(d, fp);
    }
    float a = layer.color.a * (1.0 - smoothstep(0.0, spread, best)) * dev_near_fade(ro + rd * t_best, h_near);
    return float4(0.0, 0.0, 0.0, a); // noir prémultiplié
}

static float4 device_frame(float2 local, constant Layer &layer)
{
    ModelFrame f;
    f.c = cos(layer.fx.xyz);
    f.s = sin(layer.fx.xyz);
    f.cp = 1.0;
    f.sp = 0.0;
    f.cy = 1.0;
    f.sy = 0.0;
    float persp = layer.src.z;
    float unit = layer.src.w;

    // Le rayon de ce pixel, dans le repère DU PLAN (= celui du modèle, à `unit` près) : caméra en
    // (0, 0, P) du repère caméra, plan translaté de `layer.mb.zw` dans ce même repère.
    float3 dw = float3(local + layer.src.xy, -persp);
    float dlen = length(dw);
    float3 ro = world_to_plane(float3(-layer.mb.z, -layer.mb.w, persp), f) / unit;
    float3 rd = world_to_plane(dw / dlen, f);
    float3 l = world_to_plane(MODEL_LIGHT, f);

    // Le plan proche (`DeviceView::near_plane`) : tiré de la caméra RÉELLE, avant qu'on la recule.
    float h_near = dev_near_plane(ro, world_to_plane(float3(0.0, 0.0, -1.0), f), layer);

    // L'ŒIL DU MODÈLE (`DeviceView::model_eye`, cf. HLSL) : celui du plan, reculé sur sa droite à
    // au moins `DEV_EYE_MIN`, et jamais plus bas que la ligne du centre de l'écran — d'en dessous,
    // le socle montrait sa face inférieure et couvrait le bas du métrage. Chaque rayon passe par le
    // MÊME point du plan que celui de l'objectif. `fpk` = empreinte d'un pixel par unité de
    // distance le long du nouveau rayon (celle du plan, rapportée à sa distance).
    float fpk = 1.0 / dlen;
    if (rd.z < -1e-5)
    {
        float ts = -ro.z / rd.z;
        float3 e = float3(ro.x, min(ro.y, 0.0), ro.z);
        float3 eye = e * max(1.0, DEV_EYE_MIN / max(length(e), 1e-3));
        float3 v = ro + rd * ts - eye;
        float lv = length(v);
        fpk = ts / dlen / lv;
        ro = eye;
        rd = v / lv;
    }

    // La boîte du modèle, corps et débords compris : le socle du portable vient vers la caméra,
    // le pied du moniteur s'en éloigne. Miroir de `DeviceView::model_points`.
    float2 bc = dev_body_c(layer);
    float2 bh = dev_body_h(layer);
    float3 lo = float3(bc - bh, -layer.fx.w);
    float3 hi = float3(bc + bh, 0.0);
    if (dev_is(layer, 1.0))
    {
        // Les quatre coins du profil du socle, de la charnière au bord avant, dessus et dessous.
        float ca = cos(dev_deck_angle(layer));
        float sa = sin(dev_deck_angle(layer));
        float2 hinge = float2(bc.y + bh.y, -layer.fx.w * 0.5);
        float2 qy = float2(DEV_DECK_GAP, DEV_DECK_GAP + DEV_DECK_LEN);
        float2 qz = float2(0.0, -DEV_DECK_THICK);
        for (int j = 0; j < 4; j++)
        {
            float a = qy[j & 1];
            float b = qz[j >> 1];
            float2 yz = hinge + float2(a * ca - b * sa, a * sa + b * ca);
            lo = float3(lo.x, min(lo.yz, yz));
            hi = float3(hi.x, max(hi.yz, yz));
        }
    }
    else if (dev_is(layer, 3.0))
    {
        lo = float3(min(lo.x, -DEV_FOOT_W), lo.y, lo.z - DEV_FOOT_Z);
        hi = float3(max(hi.x, DEV_FOOT_W), hi.y + DEV_NECK_LEN + DEV_FOOT_H, hi.z);
    }

    if (layer.dst_prev.w > 0.0)
    {
        return device_shadow(ro, rd, fpk, lo, hi, h_near, layer);
    }

    // Le plan du métrage occulte tout ce qui est derrière lui DANS l'ouverture ARRONDIE : la
    // marche s'y arrête (cf. HLSL : entre l'arc et le coin carré, c'est de la lunette).
    // Hors de l'ouverture, le même point du plan dit si le rayon perce la FACE AVANT ; le socle a
    // son entrée analytique. La marche ne sert qu'à ce qui les précède et à l'antialiasing.
    float t_max = 1e9;
    float t_solid = 1e9;
    if (rd.z < -1e-5)
    {
        float ts = -ro.z / rd.z;
        float2 qp = ro.xy + rd.xy * ts;
        if (ts > 0.0 && sd_dev_aperture(qp, layer) < 0.0) { t_max = ts; }
        else if (ts > 0.0 && sd_dev_outline(qp, layer) < 0.0) { t_solid = ts; }
    }
    if (dev_is(layer, 1.0)) { t_solid = min(t_solid, dev_deck_hit(ro, rd, layer)); }
    bool solid = t_solid < t_max;

    float2 tb = ray_box(ro, rd, lo - 0.01, hi + 0.01);
    float t1 = min(min(tb.y, t_max), t_solid);
    if (!solid && (tb.x >= t1 || t1 <= 0.0))
    {
        return float4(0.0, 0.0, 0.0, 0.0);
    }

    // Marche, avec la même silhouette antialiasée qu'au mode 15 : un rayon qui frôle le modèle à
    // moins d'un pixel le couvre en partie.
    float t = max(tb.x, 0.0);
    float best = 1e9;
    float t_best = t;
    bool hit = false;
    for (int k = 0; k < 80; k++)
    {
        float d = sd_device(ro + rd * t, layer);
        float fp = t * fpk;
        if (d < 0.08 * fp)
        {
            hit = true;
            t_best = t;
            break;
        }
        if (d / fp < best)
        {
            best = d / fp;
            t_best = t;
        }
        t += max(d, 0.25 * fp);
        if (t > t1)
        {
            break;
        }
    }
    if (!hit && solid)
    {
        hit = true;
        t_best = t_solid;
    }
    float cov = hit ? 1.0 : saturate(1.0 - best);
    if (cov <= 0.0)
    {
        return float4(0.0, 0.0, 0.0, 0.0);
    }
    float3 q = ro + rd * t_best;
    float3 n = device_normal(q, layer);
    float4 mat = device_albedo(q, n, t_best * fpk, layer);
    float diffuse = saturate(dot(n, l));
    // Aucun lobe spéculaire large : c'est lui qui donnait l'air plastique et gonflé. Rien qu'un
    // voile directionnel étroit sur le métal, et le filet de lumière déjà peint dans l'albédo.
    float sheen = DEV_SHEEN * mat.a * pow(diffuse, 4.0);
    float3 rgb = mat.rgb * (MODEL_AMBIENT + MODEL_DIFFUSE * diffuse) + sheen;
    // Au-delà du plan proche, l'appareil s'efface (le socle, quand la caméra en orbite avance).
    float a = cov * layer.color.a * dev_near_fade(q, h_near);
    return float4(rgb * a, a); // prémultiplié
}

fragment float4 ps_main(VSOut i [[stage_in]],
                        constant Layer &layer [[buffer(0)]],
                        texture2d<float, access::sample> texY [[texture(0)]],
                        texture2d<float, access::sample> texUV [[texture(1)]],
                        texture2d<float, access::sample> texImg [[texture(2)]],
                        // Masque de segmentation du sujet webcam. Non lie tant qu'aucun
                        // masque n'existe : Metal rend alors 0, ce qui est sans effet
                        // puisque la branche n'est prise que si layer.fx.z > 0.5.
                        texture2d<float, access::sample> texMask [[texture(3)]],
                        // Champ de distance du sprite de curseur (mode 15 seulement), R16F, cf.
                        // `cursor_sdf.rs`. Le sprite lui-même est en texture(2), comme aux
                        // modes 7 et 13.
                        texture2d<float, access::sample> texSdf [[texture(4)]],
                        // Pyramide de profondeur de champ (`tilted_sample`), lue par le mode 8 et
                        // par le repli du mode 18, qui garde texture(2) pour son rendu isolé.
                        texture2d<float, access::sample> texDof [[texture(5)]])
{
    // mode 18 : l'écran CADRÉ (ombre, cadre, métrage, appareil) flouté comme UN objet rigide
    // (`FrameGeometry::screen_trail`), port 1:1 du HLSL. texImg = son rendu isolé, prémultiplié,
    // à la taille de la sortie. À plat, sa boîte va de `dst_prev` (frame précédente) à `fx`
    // (courante) ; incliné (`mb.z` = 1), les coins du plan vont de `trail_a`/`trail_b` à
    // `fx`/`src_prev`, et le warp du plan (`mb.w`, celui du mode 8) fait l'aller et le retour ;
    // un pixel que le plan prolongé n'atteint pas (aller sans solution) n'a pas de tap.
    // Hors de la sortie rien n'a été rendu : dans l'ouverture arrondie de l'écran (`quad_px`,
    // `radius_px`, 2 px en retrait) on relit le métrage (`src` = la coupe) comme le mode 8 l'a
    // dessiné, avec sa profondeur de champ (`trail_mb` = son `mb`, pyramide en texture(5)) et sa
    // lampe (`color.xy`), nulles à plat ; ailleurs le tap est écarté.
    if (layer.mode > 17.5)
    {
        int taps = int(layer.mb.x);
        float4 acc = float4(0.0);
        float n = 0.0;
        for (int k = 0; k < 16; k++)
        {
            if (k >= taps) break;
            float a = saturate(layer.mb.y) * (1.0 - float(k) / float(taps - 1));
            float2 f;
            float2 q;
            if (layer.mb.z > 0.5)
            {
                float4 ta = mix(layer.fx, layer.trail_a, a);
                float4 tb = mix(layer.src_prev, layer.trail_b, a);
                float3 r = quad_inverse(i.pout, ta.xy, ta.zw, tb.xy, tb.zw, layer.mb.w);
                if (r.z < -0.5) continue;
                f = r.xy;
                q = quad_forward(f, layer.fx.xy, layer.fx.zw,
                                 layer.src_prev.xy, layer.src_prev.zw, layer.mb.w);
            }
            else
            {
                float4 r = mix(layer.fx, layer.dst_prev, a);
                f = (i.pout - r.xy) / r.zw;
                q = layer.fx.xy + f * layer.fx.zw;
            }
            if (all(q >= 0.0) && all(q <= 1.0))
            {
                acc += texImg.sample(samp, q, level(0.0));
                n += 1.0;
            }
            else if (sd_round_rect(f * layer.quad_px - layer.quad_px * 0.5, layer.quad_px * 0.5,
                                   layer.radius_px) < -2.0)
            {
                float z = (f.x - 0.5) * layer.trail_mb.x + (f.y - 0.5) * layer.trail_mb.y;
                float3 rgb = tilted_sample(mix(layer.src.xy, layer.src.zw, f),
                                           layer.trail_mb.w * abs(z - layer.trail_mb.z), texY, texUV, texDof);
                rgb = clamp(rgb * (1.0 + layer.color.x * (f.x - 0.5) + layer.color.y * (f.y - 0.5)), 0.0, 1.0);
                acc += float4(rgb, 1.0);
                n += 1.0;
            }
        }
        return acc / max(n, 1.0);
    }

#ifdef LAYER_MODELS
    // mode 17 : CADRE D'APPAREIL MODELÉ (`device_frame`). Testé en premier, comme le 16.
    if (layer.mode > 16.5)
    {
        return device_frame(i.local, layer);
    }

    // mode 16 : IMPACT DU CLIC (`cursor_impact`). Testé en premier, comme le mode 15.
    if (layer.mode > 15.5)
    {
        return cursor_impact(i.local, layer);
    }

    // mode 15 : CURSEUR MODÉLISÉ (`cursor_model`). Testé en premier : les branches suivantes
    // n'ont pas de borne haute. dst_prev = rect de clip « Clip to canvas », comme au mode 13.
    if (layer.mode > 14.5)
    {
        if (i.pout.x < layer.dst_prev.x || i.pout.x > layer.dst_prev.x + layer.dst_prev.z ||
            i.pout.y < layer.dst_prev.y || i.pout.y > layer.dst_prev.y + layer.dst_prev.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        return cursor_model(i.local, layer, texSdf, texImg, texDof);
    }
#else
    // Les modèles 3D n'existent que dans la variante `LAYER_MODELS` ; un draw qui les enverrait
    // ici ne peint rien plutôt qu'une ombre faite de leurs emplacements.
    if (layer.mode > 14.5)
    {
        return float4(0.0, 0.0, 0.0, 0.0);
    }
#endif

    // mode 14 : CADRE DE FENÊTRE autour de l'écran, dessiné SOUS lui. Cf. commentaires HLSL.
    // Testé avant le mode 13, dont la branche n'a pas de borne haute.
    // fx/src_prev = coins du cadre projeté ; dst_prev = (taille du plan, barre, filet) ;
    // radius_px = rayon extérieur ; color = fond de la barre ; mb = couleur du filet ;
    // src.x = 1 : warp projectif.
    if (layer.mode > 13.5)
    {
        float3 r = quad_inverse(i.local, layer.fx.xy, layer.fx.zw,
                                layer.src_prev.xy, layer.src_prev.zw, layer.src.x);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du cadre projeté
        }
        float2 plane_px = layer.dst_prev.xy;
        float bar = layer.dst_prev.z;
        float line_w = layer.dst_prev.w;
        float2 q = float2(r.x, r.y) * plane_px;
        float2 p = q - plane_px * 0.5;
        // Le MEME rayon aux quatre coins : le metrage est arrondi partout (cf. HLSL).
        float rad = max(layer.radius_px, 0.0);
        float d = sd_round_rect(p, plane_px * 0.5, rad);
        float cov = 1.0 - smoothstep(0.0, 1.5, d);
        float stroke = max(band_cov(-d - line_w * 0.5, line_w * 0.5),
                           band_cov(q.y - (bar - line_w * 0.5), line_w * 0.5));
        float3 rgb = mix(layer.color.rgb, layer.mb.rgb, stroke * layer.mb.a);
        float dr = bar * 0.214;
        float dx = bar * 0.714;
        // Le bloc est repousse du coin d'au moins le rayon PLUS celui d'une pastille et une
        // marge : sans ca, l'arrondi mordait la premiere des que Roundness montait.
        float x0 = max(dx, rad + dr + bar * 0.18);
        rgb = mix(rgb, float3(1.000, 0.373, 0.341), disc_cov(q, float2(x0, bar * 0.5), dr));
        rgb = mix(rgb, float3(0.996, 0.737, 0.180), disc_cov(q, float2(x0 + dx, bar * 0.5), dr));
        rgb = mix(rgb, float3(0.157, 0.784, 0.251), disc_cov(q, float2(x0 + 2.0 * dx, bar * 0.5), dr));
        float a = cov * layer.color.a;
        return float4(rgb * a, a);
    }

    // mode 13 : SPRITE DE CURSEUR posé sur l'écran incliné. Cf. commentaires HLSL.
    // Un mode supérieur doit être testé AVANT cette branche, qui n'a pas de borne haute.
    // mb.x = 1 : warp projectif.
    if (layer.mode > 12.5)
    {
        if (i.pout.x < layer.dst_prev.x || i.pout.x > layer.dst_prev.x + layer.dst_prev.z ||
            i.pout.y < layer.dst_prev.y || i.pout.y > layer.dst_prev.y + layer.dst_prev.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float3 r = quad_inverse(i.local, layer.fx.xy, layer.fx.zw,
                                layer.src_prev.xy, layer.src_prev.zw, layer.mb.x);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float4 s = texImg.sample(samp, clamp(float2(r.x, r.y), 0.0, 1.0));
        float a = s.a * layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 11 : texte en alpha DÉJÀ prémultiplié (CoreText/Direct2D rendent ainsi) — on
    // module juste l'opacité globale.
    //
    // Le commentaire du port disait « ne PAS re-multiplier » et le code faisait exactement
    // ça : `s.rgb * (s.a * color.a)`, soit un alpha appliqué deux fois. Le texte sortait
    // trop sombre sur ses bords adoucis et disparaissait sur les fines.
    if (layer.mode > 10.5 && layer.mode < 11.5)
    {
        return texImg.sample(samp, i.uv) * layer.color.a;
    }

    // mode 12 : ombre du quad projeté. Pénombre douce autour du quad tilté.
    if (layer.mode > 11.5)
    {
        // Le port lisait `spread` dans `fx.x`, recentrait `i.local` sur `quad_px * 0.5`, et
        // remplaçait l'inset de rayon par un simple `+ spread`. Trois écarts : `fx` porte les
        // COINS (pas le spread, qui vit dans `mb.y`), `i.local` est déjà dans le repère de la
        // bbox, et sans l'inset l'ombre n'a aucun coin arrondi. Signature du dernier :
        // `line_cross` était défini et jamais appelé nulle part dans le fichier.
        float2 quad[5] = { layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.fx.xy };
        // Coins arrondis du même rayon que le plan. Une ombre à coins vifs derrière un écran
        // arrondi dépasse en pointe à chaque coin, d'autant plus que le rayon monte.
        float r = max(layer.radius_px, 0.0);
        float2 v[4];
        for (int k = 0; k < 4; k++)
        {
            // TL→TR→BR→BL tourne dans le sens horaire en y-bas, donc (e.y, -e.x) sort du quad.
            // Division par la longueur plutôt que `normalize` : une arête dégénérée donnerait
            // un NaN qui effacerait l'ombre entière.
            float2 ep = quad[k] - quad[(k + 3) & 3];
            float2 ec = quad[k + 1] - quad[k];
            float2 np = float2(ep.y, -ep.x) / max(length(ep), 1e-6);
            float2 nc = float2(ec.y, -ec.x) / max(length(ec), 1e-6);
            v[k] = line_cross(np, dot(quad[(k + 3) & 3], np) - r, nc, dot(quad[k], nc) - r);
        }
        float d = sd_convex_quad(i.local, v[0], v[1], v[2], v[3]) - r;
        // Slot d'un layout en bloc (`dst_prev` = le slot en px locaux, `mb.w` = son rayon ; nul
        // ailleurs) : l'ombre est celle de ce qu'on voit, le plan rogné par le slot (cf. HLSL).
        if (layer.dst_prev.z > layer.dst_prev.x)
        {
            float2 h = (layer.dst_prev.zw - layer.dst_prev.xy) * 0.5;
            d = max(d, sd_round_rect(i.local - layer.dst_prev.xy - h, h, layer.mb.w));
        }
        float spread = max(layer.mb.y, 1e-3);
        float a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(layer.color.rgb * a, a);
    }

    // mode 8 : écran tilté (zoom regions "rotation") ou vu par la caméra réelle. Warp inverse :
    // bilinéaire sous un angle fixe, projectif exact sous la caméra réelle ou un appareil
    // (dst_prev.w = 1) ; la caméra réelle éclaire aussi le plan (color.xy : 1 + color.x·(s − 0.5)
    // + color.y·(t − 0.5)).
    // mb = [gx, gy, z_focus, k] : profondeur du point r du plan = (r.x - 0.5)*gx + (r.y - 0.5)*gy
    // en px, positive vers la caméra ; z_focus = celle du focus du zoom (`TiltedQuad::depth_mb`) ;
    // k = texels source de flou par px d'écart de profondeur (0 = profondeur de champ coupée).
    // texture(5) (texDof) = pyramide demi-résolution de la vidéo, 5 niveaux, mêmes UV que
    // texture(0/1) ; liée explicitement à chaque draw du mode 8. Cf. commentaires HLSL.
    if (layer.mode > 7.5 && layer.mode < 8.5)
    {
        // PAS de test de clip sur `dst_prev` ici — le port en avait copié un depuis le
        // mode 13. En mode 8 `dst_prev.xy` porte `plane_px`, la taille du plan en PIXELS
        // (~1600), comparée à `i.pout` qui vit dans [0,1] : la condition était vraie pour
        // tout pixel et la branche rendait du transparent partout. Le tilt ne dessinait rien.
        float3 r = quad_inverse(i.local, layer.fx.xy, layer.fx.zw,
                                layer.src_prev.xy, layer.src_prev.zw, layer.dst_prev.w);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du quad projeté
        }
        // La coupe source s'applique ICI : `r` est une position DANS le plan (0..1), pas
        // une coordonnée de texture. Le port échantillonnait `r` directement, ignorant le
        // crop et le zoom.
        float2 uv = float2(mix(layer.src.x, layer.src.z, clamp(r.x, 0.0, 1.0)),
                           mix(layer.src.y, layer.src.w, clamp(r.y, 0.0, 1.0)));
        // Coins arrondis DANS LE REPÈRE DU PLAN : le rayon reste constant le long du bord,
        // là où un arrondi calculé dans la bbox s'étirerait avec la perspective.
        // Inconditionnel, rayon 0 compris — `sd_round_rect` dégénère en SDF de rectangle et
        // le feather de 1,5 px subsiste, ce qui fait lire une arête inclinée COMME une arête
        // plutôt que comme une troncature en marches d'escalier.
        // dst_prev.z = 1 : écran sous le chrome de fenêtre, coins HAUTS carrés et rognés par
        // l'arc du cadre (`sd_screen_under_bar`, `color.z` = la remontée, px du plan).
        float2 plane_px = layer.dst_prev.xy;
        float2 p = float2(r.x, r.y) * plane_px - plane_px * 0.5;
        float rad = max(layer.radius_px, 0.0);
        // Une branche et non `?:`, pour ne jamais évaluer les DEUX distances (trois SDF par pixel).
        float d;
        if (layer.dst_prev.z > 0.5)
            d = sd_screen_under_bar(p, plane_px * 0.5, rad, layer.color.z);
        else
            d = sd_round_rect(p, plane_px * 0.5, rad);
        float tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        // Slot d'un layout en bloc (`color.w` = rayon de ses coins, px ; 0 ailleurs, sans effet) :
        // `dst` EST le slot, dont le rect arrondi rogne le plan (`ScreenMask`, cf. HLSL).
        tilt_a *= slot_alpha(i.local, layer.quad_px, layer.color.w);
        // Profondeur de champ : net sous un demi-texel de flou (l'échantillon d'avant, à
        // l'octet), fondu au-delà vers la pyramide au niveau `log2(coc) - 1`, plafonné.
        // `level(lod)` exige `mip_filter::linear` sur `samp` : sans lui, niveau 0 partout.
        float2 rs = clamp(float2(r.x, r.y), 0.0, 1.0);
        float z = (rs.x - 0.5) * layer.mb.x + (rs.y - 0.5) * layer.mb.y;
        float coc = layer.mb.w * abs(z - layer.mb.z);
        float3 rgb = tilted_sample(uv, coc, texY, texUV, texDof);
        // Flou de mouvement, celui du mode 0 : l'UV que CE pixel montrait à la frame précédente,
        // par le même warp inverse sur les coins d'avant (`trail_a`/`trail_b`), puis `taps`
        // échantillons de celui-là à celui-ci, raccourcis de la force. Borné à une frame. Le
        // mouvement se mesure entre les deux points NON bornés (cf. HLSL).
        int taps = int(layer.trail_mb.x);
        if (taps > 1 && layer.trail_mb.y > 0.001)
        {
            float3 rp = quad_inverse(i.local, layer.trail_a.xy, layer.trail_a.zw,
                                     layer.trail_b.xy, layer.trail_b.zw, layer.dst_prev.w);
            float2 duv = (r.xy - rp.xy) * (layer.src.zw - layer.src.xy)
                       * clamp(layer.trail_mb.y, 0.0, 1.0);
            // Sans antécédent sur le plan d'avant, pas de point d'avant : l'échantillon reste net.
            if (rp.z > -0.5 && dot(duv, duv) >= 1e-9)
            {
                float3 acc = float3(0.0);
                for (int k = 0; k < 16; k++)
                {
                    if (k >= taps) break;
                    float t = float(k) / float(taps - 1);
                    acc += tilted_sample(uv - duv * (1.0 - t), coc, texY, texUV, texDof);
                }
                rgb = acc / float(taps);
            }
        }
        if (layer.dst_prev.w > 0.5)
        {
            // La lampe de la caméra réelle : le côté proche un peu plus clair.
            rgb = clamp(rgb * (1.0 + layer.color.x * (rs.x - 0.5) + layer.color.y * (rs.y - 0.5)), 0.0, 1.0);
        }
        // L'alpha est cette couverture, pas `color.a` : les draws du mode 8 laissent `color`
        // à zéro, donc le port rendait de toute façon un plan totalement transparent.
        return float4(rgb * tilt_a, tilt_a);
    }

    // mode 7 : sprite curseur thème (PNG alpha droite). Prémultiplie ici, comme partout
    // ailleurs. `fx` = rect de clip « Clip to canvas » en espace sortie 0..1 [x,y,w,h]
    // (= s_dst quand actif, sinon un rect englobant tout, donc sans effet).
    //
    // Le port avait omis ce test : `plan_cursor` calcule bien le rect et le draw le passe
    // dans `fx`, mais le shader l'ignorait — `cursor.clipToBounds` était inerte sur macOS.
    if (layer.mode > 6.5 && layer.mode < 7.5)
    {
        if (i.pout.x < layer.fx.x || i.pout.x > layer.fx.x + layer.fx.z ||
            i.pout.y < layer.fx.y || i.pout.y > layer.fx.y + layer.fx.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float4 s = texImg.sample(samp, i.uv);
        float a = s.a * layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 6 : wallpaper image RGBA (cover-fit). src = rect uv déjà calculé (crop de
    // recouvrement), i.uv l'interpole. OPAQUE — comme le HLSL.
    //
    // Le port lisait `layer.color.a` ici. `LayerCB::default()` met `color` à zéro, donc
    // l'alpha valait 0 et le fond image était rigoureusement invisible : un fond noir,
    // qu'on lit comme « le compositeur ne dessine pas le wallpaper » plutôt que comme
    // « le wallpaper est dessiné avec alpha 0 ».
    //
    // Fond animé : mêmes emplacements qu'au mode 5 (fx.z temps, fx.w mouvement, mb.x aspect).
    // fx.w = 0 lit l'image telle quelle, à l'octet près.
    if (layer.mode > 5.5 && layer.mode < 6.5)
    {
        float2 uv = i.uv;
        float light = 0.0;
        if (layer.fx.w > 0.5)
        {
            float2 size = layer.src.zw - layer.src.xy;
            float3 m = image_motion((i.uv - layer.src.xy) / size - 0.5, layer.fx.z, layer.fx.w,
                                    layer.mb.x);
            uv = layer.src.xy + (m.xy + 0.5) * size;
            light = m.z;
        }
        float a = quad_round_alpha(i.local, layer.quad_px, layer.radius_px);
        return float4(lighten(texImg.sample(samp, uv).rgb, light) * a, a); // prémultiplié
    }

    // mode 5 : gradient linéaire jusqu'à 4 stops (parité web wallpaper dégradé). Nœuds
    // `rgb + position` dans color, src_prev, dst_prev, src (cf. `ramp4`), fx.xy = direction unitaire (espace sortie, y vers le bas). t est
    // normalisé coin-à-coin (dénominateur = |dx|+|dy|) pour couvrir toute la diagonale.
    //
    // Le port avait remplacé tout ce calcul par une couleur plate : un dégradé s'affichait
    // comme son premier stop, uniformément.
    //
    // Fond animé : fx.z = temps programme (s, replié sur 120), fx.w = mouvement (0 immobile,
    // 1 dérive, 2 aurore, 3 vagues), mb.x = aspect w/h. 0 rend le dégradé d'avant à l'octet.
    if (layer.mode > 4.5 && layer.mode < 5.5)
    {
        float2 dir = layer.fx.xy;
        float slide = 0.0;
        if (layer.fx.w > 0.5 && layer.fx.w < 1.5)
        {
            // Dérive : l'axe balance de ±30° (0.5235988 rad) en 20 s, le dégradé glisse le long
            // de lui de ±20 % en 15 s.
            float da = 0.5235988 * sin(6.2831853 * layer.fx.z / 20.0);
            float sa = sin(da);
            float ca = cos(da);
            dir = float2(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
            slide = 0.2 * sin(6.2831853 * layer.fx.z / 15.0);
        }
        float denom = max(abs(dir.x) + abs(dir.y), 1e-4);
        // Paramétré sur le QUAD dès qu'il en a un (la bulle webcam), sinon sur la sortie. Pour le
        // fond plein cadre les deux coïncident ; pour une bulle dans un coin, `pout` ne montrerait
        // que la tranche du dégradé plein cadre qui passe dessous, jamais la rampe complète que
        // le sélecteur affiche.
        float2 gp = (layer.quad_px.x > 0.0 && layer.quad_px.y > 0.0)
            ? (i.local / layer.quad_px)
            : i.pout;
        float t = clamp(0.5 + dot(gp - 0.5, dir) / denom + slide, 0.0, 1.0);
        float3 g = ramp4(t, layer.color, layer.src_prev, layer.dst_prev, layer.src);
        if (layer.fx.w > 1.5)
        {
            g = gradient_motion(gp, dir, denom, layer.color, layer.src_prev, layer.dst_prev,
                                layer.src, layer.fx.z, layer.fx.w, layer.mb.x);
        }
        float a = quad_round_alpha(i.local, layer.quad_px, layer.radius_px);
        return float4(g * a, a); // prémultiplié
    }

    // mode 4 : curseur dessiné (dot + ring SDF).
    if (layer.mode > 3.5 && layer.mode < 4.5)
    {
        float2 p = i.local - layer.quad_px * 0.5;
        float R = min(layer.quad_px.x, layer.quad_px.y) * 0.5;
        float r = length(p);
        float aa = 1.5;
        float dot_r = R * 0.34;
        float ring_r = R * 0.72;
        float ring_w = R * 0.09;
        float ddot = 1.0 - clamp((r - (dot_r - aa)) / (2.0 * aa), 0.0, 1.0);
        float ring = clamp((r - (ring_r - ring_w - aa)) / aa, 0.0, 1.0)
                   * (1.0 - clamp((r - (ring_r + ring_w)) / aa, 0.0, 1.0));
        float halo = (1.0 - clamp((r - (dot_r + aa)) / 2.5, 0.0, 1.0)) * (1.0 - ddot);
        float a = clamp(ddot + ring, 0.0, 1.0) * layer.color.a;
        float3 rgb = layer.color.rgb * (ddot + ring);
        a = clamp(a + halo * 0.35 * layer.color.a, 0.0, 1.0);
        return float4(rgb * a, a);
    }

    // mode 9 : annotation « figure » — une flèche. Parité EXACTE avec `ArrowSvgs.tsx`, dont
    // chaque direction est un tracé de trois segments à bouts ronds : une hampe et deux
    // barbes. Trois `sd_segment` et un `min` reproduisent la forme telle quelle.
    // fx = hampe, src_prev = barbe 1, dst_prev = barbe 2 ; mb.y = demi-épaisseur px.
    //
    // Le port avait INVENTÉ une forme : un seul segment dérivé de `quad_px`, avec
    // `radius_px` en épaisseur. Ce n'était pas une approximation de la flèche, c'était une
    // autre figure — et elle ignorait la géométrie que `regions::arrow_local_geometry`
    // calcule et uploade.
    if (layer.mode > 8.5 && layer.mode < 9.5)
    {
        float d = sd_segment(i.local, layer.fx.xy, layer.fx.zw);
        d = min(d, sd_segment(i.local, layer.src_prev.xy, layer.src_prev.zw));
        d = min(d, sd_segment(i.local, layer.dst_prev.xy, layer.dst_prev.zw));
        // Couverture sur ~1 px : le trait reste net sans crénelage, et une flèche fine ne
        // disparaît pas quand la demi-épaisseur descend sous le pixel.
        float a = clamp(layer.mb.y - d + 0.5, 0.0, 1.0) * layer.color.a;
        return float4(layer.color.rgb * a, a);
    }

    // mode 10 : annotation « flou » — masque la zone en réutilisant l'image DÉJÀ composée,
    // qui arrive dans `texImg` (recopie mipmappée du render target : on ne peut pas
    // échantillonner la cible sur laquelle on dessine). `i.pout` donne directement l'UV de
    // sortie. fx.x = 0 mosaïque / 1 flou ; fx.y = taille de bloc px ou rayon px ;
    // fx.z = 0 rectangle / 1 ovale ; fx.w = 1 si le masque doit être teinté ;
    // mb.z = 1 si le masque est un quad incliné (coins TL, TR dans dst_prev, BR, BL dans src_prev),
    // mb.w = 1 si son warp est projectif.
    //
    // Le port se contentait de recopier `texImg` : ni forme, ni flou, ni mosaïque, ni teinte.
    if (layer.mode > 9.5 && layer.mode < 10.5)
    {
        float2 n = i.local / max(layer.quad_px, float2(1e-6));
        // Écran incliné : masque warpé comme le contenu qu'il cache. Cf. commentaires HLSL.
        if (layer.mb.z > 0.5)
        {
            float3 w = quad_inverse(i.local, layer.dst_prev.xy, layer.dst_prev.zw,
                                    layer.src_prev.xy, layer.src_prev.zw, layer.mb.w);
            if (w.z < 0.5)
            {
                return float4(0.0, 0.0, 0.0, 0.0);
            }
            n = w.xy;
        }
        float cov = 1.0;
        if (layer.fx.z > 0.5)
        {
            // Ovale inscrit : distance au centre en unités de demi-axes, adoucie sur ~1px. Le
            // fondu tombe HORS de l'ellipse : dedans, le masque reste plein.
            float2 dd = (n - 0.5) * 2.0;
            float r = length(dd);
            float aa = 2.0 / max(min(layer.quad_px.x, layer.quad_px.y), 1.0);
            cov = 1.0 - smoothstep(1.0, 1.0 + aa, r);
        }
        if (cov <= 0.0) return float4(0.0, 0.0, 0.0, 0.0);

        float3 rgb;
        if (layer.fx.x > 0.5)
        {
            // Flou : un niveau de mip de l'image composée. `log2(rayon)` donne le niveau dont
            // un texel couvre à peu près le rayon demandé. Un noyau de quelques taps espacés
            // du rayon ne floute PAS, il superpose des copies décalées — du texte fantôme.
            float lod = log2(max(layer.fx.y, 1.0));
            rgb = texImg.sample(samp, i.pout, level(lod)).rgb;
        }
        else
        {
            // Mosaïque : UV quantifié sur une grille de `fx.y` px, alignée sur le quad pour
            // que les blocs ne rampent pas quand l'annotation bouge.
            float2 px_uv = layer.dst.zw / max(layer.quad_px, float2(1e-6));
            float2 block = max(layer.fx.y, 1.0) * px_uv;
            float2 origin = layer.dst.xy;
            float2 q = origin + (floor((i.pout - origin) / block) + 0.5) * block;
            // Niveau 0 explicite : l'UV quantifié est une marche d'escalier, ses dérivées
            // explosent en bord de bloc et le choix automatique de mip ramollirait justement
            // les arêtes qui font la mosaïque.
            rgb = texImg.sample(samp, q, level(0.0)).rgb;
        }

        if (layer.fx.w > 0.5)
        {
            rgb = mix(rgb, layer.color.rgb, 0.5);
        }
        float a = cov * layer.color.a;
        return float4(rgb * a, a);
    }

    // mode 2 : ombre portée (§7 E4). Pénombre douce dérivée de la SDF du quad source,
    // qui est inséré à l'intérieur du quad d'ombre (élargi de `spread` de chaque côté).
    if (layer.mode > 1.5 && layer.mode < 2.5)
    {
        float spread = layer.fx.x;
        float2 halfsz = layer.quad_px * 0.5 - spread;
        float2 p = i.local - layer.quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, layer.radius_px);
        float a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(layer.color.rgb * a, a);
    }

    float3 rgb;
    // 1 sauf en detourage, ou il porte le masque du sujet. Cf. la branche fx.z plus bas.
    float alpha_mask = 1.0;
    if (layer.mode < 0.5)
    {
        // flou de mouvement par vélocité (§8)
        float2 uv_now = i.uv;
        float2 localp = (i.pout - layer.dst_prev.xy) / layer.dst_prev.zw;
        float2 uv_prev = layer.src_prev.xy + localp * (layer.src_prev.zw - layer.src_prev.xy);
        float2 duv = uv_now - uv_prev;
        float mb_scale = saturate(layer.mb.y);
        float2 duv_blur = duv * mb_scale;
        int taps = int(layer.mb.x);
        if (taps <= 1 || mb_scale <= 0.001 || dot(duv_blur, duv_blur) < 1e-9)
        {
            rgb = sample_yuv(uv_now, texY, texUV);
        }
        else
        {
            float3 acc = float3(0.0);
            for (int k = 0; k < 16; k++)
            {
                if (k >= taps) break;
                float t = float(k) / float(taps - 1);
                acc += sample_yuv(uv_now - duv_blur * (1.0 - t), texY, texUV);
            }
            rgb = acc / float(taps);
        }

        // Effet d'arriere-plan webcam. Miroir exact de la branche HLSL : fx.z porte le mode
        // (1 = detourage, 2 = flou, 3 = fond plat), fx.w l'intensite du flou, fx.xy l'etendue
        // valide de la texture webcam pour ramener uv dans l'espace du masque.
        float effect = layer.fx.z;
        if (effect > 0.5)
        {
            float2 mask_uv = uv_now / max(layer.fx.xy, float2(1e-6));
            float person = saturate(texMask.sample(samp, mask_uv).r);
            if (effect > 2.5)
            {
                rgb = mix(layer.color.rgb, rgb, person);
            }
            else if (effect > 1.5)
            {
                rgb = mix(blur_webcam_bg(uv_now, layer.fx.w, layer.quad_px, i.local, layer.fx.xy, texY, texUV), rgb, person);
            }
            else
            {
                alpha_mask = person;
            }
        }

        // Desk-view cover: the camera is being tilted, so the whole picture is blurred and
        // dimmed (cover.x = strength, cover.y = radius in quad px, cover.z = dim at full cover).
        if (layer.cover.x > 0.001)
        {
            float3 hidden = blur_webcam_radius(uv_now, layer.cover.y, layer.quad_px, i.local, layer.fx.xy,
                                               texY, texUV);
            rgb = mix(rgb, hidden, layer.cover.x) * (1.0 - layer.cover.z * layer.cover.x);
        }
    }
    else
    {
        rgb = layer.color.rgb;
    }

    float alpha = layer.color.a * alpha_mask;
    if (layer.radius_px > 0.0)
    {
        // mb.w = 1 : écran sous le chrome de fenêtre, coins HAUTS carrés et rognés par l'arc du
        // cadre (`sd_screen_under_bar`, `mb.z` = la remontée du contour intérieur, px).
        float2 halfsz = layer.quad_px * 0.5;
        float2 p = i.local - layer.quad_px * 0.5;
        // Une branche et non `?:`, pour ne jamais évaluer les DEUX distances : trois SDF par pixel
        // de l'écran au lieu d'une, 0,6 ms par frame 1080p sur une Radeon 610M (mesuré en WGSL).
        float d;
        if (layer.mb.w > 0.5)
            d = sd_screen_under_bar(p, halfsz, layer.radius_px, layer.mb.z);
        else
            d = sd_round_rect(p, halfsz, layer.radius_px);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d);
    }
    return float4(rgb * alpha, alpha);
}

// =================================================================================
// Fullscreen pass : RGB -> NV12. Mêmes shaders que la passe équivalente HLSL.
// =================================================================================

struct FSOut
{
    float4 pos [[position]];
    float2 uv  [[user(TEXCOORD0)]];
};

vertex FSOut vs_fs(uint vid [[vertex_id]])
{
    FSOut o;
    o.uv = float2((vid << 1) & 2, vid & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

inline float rgb2y(float3 c)  { return (16.0 + 219.0 * (0.2126*c.r + 0.7152*c.g + 0.0722*c.b)) / 255.0; }
inline float2 rgb2uv(float3 c)
{
    float yp = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    float cb = (c.b - yp) / 1.8556;
    float cr = (c.r - yp) / 1.5748;
    return float2(128.0 + 224.0 * cb, 128.0 + 224.0 * cr) / 255.0;
}

fragment float ps_y(FSOut i [[stage_in]],
                    texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    return rgb2y(rgbTex.sample(sampNV, i.uv).rgb);
}

fragment float2 ps_uv(FSOut i [[stage_in]],
                      texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    return rgb2uv(rgbTex.sample(sampNV, i.uv).rgb);
}

// =================================================================================
// Flou gaussien séparable (§7 E3) — shader conservé pour référence, le port actif
// utilise `ps_kawase_down/up` (cf. commit « Kawase » plus loin si on revient).
// =================================================================================

// Une variable de portée programme doit vivre dans `constant` en MSL.
constant int BLUR_R = 24;

fragment float4 ps_blur(FSOut i [[stage_in]],
                        constant Layer &layer [[buffer(0)]],
                        texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float sigma = max(layer.fx.x, 0.001);
    float2 step = layer.fx.y * layer.fx.zw;
    float4 acc = float4(0.0);
    float wsum = 0.0;
    for (int k = -BLUR_R; k <= BLUR_R; k++)
    {
        float w = exp(-0.5 * float(k * k) / (sigma * sigma));
        acc += rgbTex.sample(sampNV, i.uv + float(k) * step) * w;
        wsum += w;
    }
    return acc / wsum;
}

fragment float4 ps_tex(FSOut i [[stage_in]],
                       texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    return rgbTex.sample(sampNV, i.uv);
}

// =================================================================================
// Dual-Kawase (fond flouté rapide).
// =================================================================================

fragment float4 ps_kawase_down(FSOut i [[stage_in]],
                               constant Layer &layer [[buffer(0)]],
                               texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float2 hp = layer.fx.xy * 0.5 * layer.fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.sample(sampNV, uv) * 4.0;
    s += rgbTex.sample(sampNV, uv - hp);
    s += rgbTex.sample(sampNV, uv + hp);
    s += rgbTex.sample(sampNV, uv + float2(hp.x, -hp.y));
    s += rgbTex.sample(sampNV, uv - float2(hp.x, -hp.y));
    return s / 8.0;
}

// Poids 1,2,1,2,1,2,1,2 — somme 12, d'où le `/ 12.0`. Le port avait doublé les deux taps
// purement verticaux : somme 14 divisée par 12, soit +16,7 % de luminosité PAR PASSE et un
// biais vertical. Trois passes UP → un fond flouté 1,59× trop clair et étiré.
fragment float4 ps_kawase_up(FSOut i [[stage_in]],
                             constant Layer &layer [[buffer(0)]],
                             texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float2 hp = layer.fx.xy * 0.5 * layer.fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.sample(sampNV, uv + float2(-hp.x * 2.0, 0.0));
    s += rgbTex.sample(sampNV, uv + float2(-hp.x, hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(0.0, hp.y * 2.0));
    s += rgbTex.sample(sampNV, uv + float2(hp.x, hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(hp.x * 2.0, 0.0));
    s += rgbTex.sample(sampNV, uv + float2(hp.x, -hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(0.0, -hp.y * 2.0));
    s += rgbTex.sample(sampNV, uv + float2(-hp.x, -hp.y)) * 2.0;
    return s / 12.0;
}
