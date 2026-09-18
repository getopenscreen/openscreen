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

#include <metal_stdlib>
using namespace metal;

// =================================================================================
// Constant buffer — symétrique de `cbuffer Layer : register(b0)` côté HLSL.
// =================================================================================
//
// Le moteur côté CPU upload ce buffer via `setVertexBytes` (vertex stage) et
// `setFragmentBytes` (fragment stage) avant chaque draw — la copie est de 128 octets,
// ce qui est sous le seuil d'alignement 4K de Metal pour le mode « immediate ».

struct Layer
{
    float4 dst;       // x,y,w,h dans l'espace sortie 0..1 (origine haut-gauche)
    float4 src;       // u0,v0,u1,v1 dans l'espace source 0..1 ; modes 15 et 17 : décalage px du rayon, P, U
    float2 quad_px;   // taille du quad en pixels (pour les SDF)
    float  radius_px; // rayon des coins arrondis en px (0 = aucun) ; mode 17 : rayon des coins hauts du corps (unités du modèle)
    float  mode;      // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre portée, ..., 15 = curseur 3D, 16 = impact du clic, 17 = appareil modelé
    float4 color;     // couleur pleine / teinte (ombre : rgb + opacité dans a) ; mode 15 : coin du sprite, texel, opacité ; mode 17 : .r = l'appareil (1 portable, 2 téléphone, 3 moniteur), .g = thème sombre, .b = rayon des coins bas du corps, .a = opacité
    float4 fx;        // fx.x = spread ombre (px), fx.y,fx.z libres ; mode 15 : rotation du plan (rad), tangage ; mode 17 : rotation du plan (rad), épaisseur
    float4 src_prev;  // src à la frame précédente (flou de mouvement par vélocité) ; mode 15 : hotspot, lacet ; mode 17 : marges du corps (unités du modèle)
    float4 dst_prev;  // dst à la frame précédente ; modes 13 et 15 : rect de clip ; mode 17 : angle du socle, rayon et recouvrement de l'ouverture, pénombre de l'ombre
    float4 mb;        // mb.x = nombre de taps de motion blur (1 = désactivé) ; modes 15 et 17 : demi-taille du plan, translation
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
//                  4 = texSdf (champ du sprite de curseur, R16F, mode 15)
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
inline float sd_round_rect(float2 p, float2 halfsz, float r)
{
    float2 q = abs(p) - halfsz + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
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
        float t = (abs(k1) < 1e-6) ? 0.0 : -k0 / k1;
        return quad_st_for_root(t, e, f, g, h);
    }
    float disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) return float3(0.0, 0.0, 0.0);
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

// Warp inverse d'un calque posé sur le plan : projectif sous la caméra réelle (`projective` = 1),
// bilinéaire sous un angle fixe, inchangé.
inline float3 quad_inverse(float2 P, float2 c00, float2 c10, float2 c11, float2 c01, float projective)
{
    if (projective > 0.5)
    {
        return quad_inverse_projective(P, c00, c10, c11, c01);
    }
    return quad_inverse_bilinear(P, c00, c10, c11, c01);
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

inline float3 blur_webcam_bg(float2 uv, float intensity, float2 qpx, float2 local_px,
                             texture2d<float, access::sample> texY,
                             texture2d<float, access::sample> texUV)
{
    float max_r_px = max(intensity, 0.0) * 22.0 + 1.5;
    float2 step = max_r_px / max(qpx, float2(1.0));
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
        sum += sample_yuv(saturate(uv + rot_p * step), texY, texUV) * w;
        total += w;
    }
    return sum / max(total, 1e-4);
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

// Mouvements 2 (aurore) et 3 (vagues) du mode 5. Miroir ligne pour ligne de
// `gradient_motion` côté HLSL (commentaires complets là-bas).
inline float3 gradient_motion(float2 gp, float2 dir, float denom, float3 c0, float3 c1,
                              float time, float motion, float aspect)
{
    const float TAU = 6.2831853;
    float u = dot(gp - 0.5, dir) / denom; // position le long de l'axe, -0.5..0.5
    if (motion < 2.5)
    {
        // Aurore : rampe perturbée par un bruit lent, puis trois nappes gaussiennes.
        float2 p = float2((gp.x - 0.5) * aspect, gp.y - 0.5);
        float ph = TAU * time / 120.0;
        float n = value_noise(p * 2.5 + 1.5 * float2(cos(ph), sin(ph)));
        float3 g = mix(c0, c1, clamp(0.5 + u + 0.3 * (n - 0.5), 0.0, 1.0));
        float2 b0 = float2(0.35 * aspect * sin(TAU * time / 20.0), 0.25 * sin(TAU * time / 30.0 + 1.0));
        float2 b1 = float2(0.30 * aspect * sin(TAU * time / 24.0 + 2.0), 0.22 * cos(TAU * time / 40.0));
        float2 b2 = float2(0.25 * aspect * cos(TAU * time / 30.0 + 4.0), 0.28 * sin(TAU * time / 24.0 + 3.0));
        g = mix(g, c1, 0.45 * exp(-dot(p - b0, p - b0) / 0.08));
        g = mix(g, c0, 0.45 * exp(-dot(p - b1, p - b1) / 0.06));
        g = mix(g, c1, 0.35 * exp(-dot(p - b2, p - b2) / 0.05));
        return g;
    }
    // Vagues : trois bandes sinus perpendiculaires à l'axe (12 s), ondulées (20 s).
    float v = dot(gp - 0.5, float2(-dir.y, dir.x)) / denom;
    float w = sin(TAU * (3.0 * u + 0.04 * sin(TAU * (1.5 * v + time / 20.0)) - time / 12.0));
    return mix(c0, c1, clamp(0.5 + u + 0.07 * w, 0.0, 1.0));
}

// ============ Curseur MODÉLISÉ (mode 15) ============
// Port ligne pour ligne de `cursor_model` (HLSL), dont les commentaires font foi ; seules
// différences : `layer` et les textures arrivent en paramètres (le sprite en texture(2), son
// champ R16F en texture(4)), `saturate` s'écrit `clamp`, `lerp` s'écrit `mix`, `SampleLevel`
// s'écrit `sample(…, level(0.0))`.
// Constantes : miroir exact de `frame_geometry.rs` (MODEL_*).
constant float MODEL_THICK = 0.19;
constant float MODEL_BEVEL = 0.045;
constant float3 MODEL_LIGHT = float3(-0.4194, -0.5792, 0.6990);
constant float MODEL_AMBIENT = 0.36;
constant float MODEL_DIFFUSE = 0.75;
constant float MODEL_SPECULAR = 0.45;
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

// Épaisseur du modèle, écrasé au clic de `color.b`.
inline float model_thick(constant Layer &layer)
{
    return MODEL_THICK * layer.color.b;
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

static float sd_model(float3 p, constant Layer &layer, texture2d<float, access::sample> texSdf)
{
    float half_t = model_thick(layer) * 0.5;
    float2 w = float2(sd_sprite2(p.xy, layer, texSdf) + MODEL_BEVEL,
                      abs(p.z + half_t) - (half_t - MODEL_BEVEL));
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - MODEL_BEVEL;
}

static float3 model_normal(float3 p, constant Layer &layer, texture2d<float, access::sample> texSdf)
{
    const float e = 0.002;
    const float3 ka = float3(1.0, -1.0, -1.0);
    const float3 kb = float3(-1.0, -1.0, 1.0);
    const float3 kc = float3(-1.0, 1.0, -1.0);
    const float3 kd = float3(1.0, 1.0, 1.0);
    return normalize(ka * sd_model(p + ka * e, layer, texSdf) + kb * sd_model(p + kb * e, layer, texSdf) +
                     kc * sd_model(p + kc * e, layer, texSdf) + kd * sd_model(p + kd * e, layer, texSdf));
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

static float model_soft_shadow(float3 o, float3 l, float3 lo, float3 hi, constant Layer &layer,
                               texture2d<float, access::sample> texSdf)
{
    float2 tb = ray_box(o, l, lo - MODEL_SHADOW_PAD, hi + MODEL_SHADOW_PAD);
    if (tb.x >= tb.y || tb.y <= 0.0)
    {
        return 1.0;
    }
    float res = 1.0;
    float t = max(tb.x, 0.004);
    for (int k = 0; k < 32; k++)
    {
        float d = sd_model(o + l * t, layer, texSdf);
        res = min(res, MODEL_SOFTNESS * d / t);
        if (res < 0.002 || t > tb.y)
        {
            break;
        }
        t += clamp(d, 0.01, 0.2);
    }
    res = clamp(res, 0.0, 1.0);
    return res * res * (3.0 - 2.0 * res);
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

static float3 model_shade(float3 q, float3 rd, float3 l, constant Layer &layer,
                          texture2d<float, access::sample> texSdf,
                          texture2d<float, access::sample> texImg)
{
    float3 n = model_normal(q, layer, texSdf);
    float3 albedo = model_albedo(q.xy, layer, texSdf, texImg);
    float diffuse = clamp(dot(n, l), 0.0, 1.0);
    float gloss = 1.0 - smoothstep(0.97, 0.995, abs(n.z));
    float spec = gloss * pow(clamp(dot(n, normalize(l - rd)), 0.0, 1.0), 110.0);
    return albedo * (MODEL_AMBIENT + MODEL_DIFFUSE * diffuse) + MODEL_SPECULAR * spec;
}

static float4 cursor_model(float2 local, constant Layer &layer,
                           texture2d<float, access::sample> texSdf,
                           texture2d<float, access::sample> texImg)
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
    float3 hi = float3(layer.color.rg + sprite_size(layer), 0.0);

    float3 dw = float3(local + layer.src.xy, -persp);
    float dlen = length(dw);
    // Plan translaté de mb.zw dans le repère caméra (caméra réelle ; 0 sous un angle fixe).
    float3 ro = plane_to_model((world_to_plane(float3(-layer.mb.z, -layer.mb.w, persp), f) - tip) / unit, f);
    float3 rd = plane_to_model(world_to_plane(dw / dlen, f), f);
    float3 l = plane_to_model(world_to_plane(MODEL_LIGHT, f), f);
    float3 nz = plane_to_model(float3(0.0, 0.0, 1.0), f);
    float hz = -tip.z / unit;

    float cov = 0.0;
    float3 rgb = float3(0.0);
    float2 tb = ray_box(ro, rd, lo - 0.02, hi + 0.02);
    if (tb.x < tb.y && tb.y > 0.0)
    {
        float t = max(tb.x, 0.0);
        float best = 1e9;
        float t_best = t;
        bool hit = false;
        for (int k = 0; k < 64; k++)
        {
            float d = sd_model(ro + rd * t, layer, texSdf);
            float fp = t / dlen;
            if (d < 0.1 * fp)
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
            t += d;
            if (t > tb.y)
            {
                break;
            }
        }
        cov = hit ? 1.0 : clamp(1.0 - best, 0.0, 1.0);
        if (cov > 0.0)
        {
            rgb = model_shade(ro + rd * t_best, rd, l, layer, texSdf, texImg);
        }
    }

    float shadow = 0.0;
    float denom = dot(rd, nz);
    if (cov < 1.0 && denom < -1e-4)
    {
        float3 g = ro + rd * ((hz - dot(ro, nz)) / denom);
        float3 gp = tip + unit * model_to_plane(g, f);
        float inside = clamp(min(layer.mb.x - abs(gp.x), layer.mb.y - abs(gp.y)) + 0.5, 0.0, 1.0);
        if (inside > 0.0)
        {
            float dropped = 1.0 - model_soft_shadow(g, l, lo, hi, layer, texSdf);
            float contact = 1.0 - smoothstep(0.0, MODEL_CONTACT_RADIUS, sd_model(g, layer, texSdf));
            shadow = inside * max(dropped * MODEL_SHADOW_ALPHA, contact * MODEL_CONTACT_ALPHA);
        }
    }

    float a = cov * layer.color.a;
    return float4(rgb * a, a + (1.0 - a) * shadow * layer.color.a); // prémultiplié, ombre noire
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
                        texture2d<float, access::sample> texSdf [[texture(4)]])
{
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
        return cursor_model(i.local, layer, texSdf, texImg);
    }

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
        float spread = max(layer.mb.y, 1e-3);
        float a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(layer.color.rgb * a, a);
    }

    // mode 8 : écran tilté (zoom regions "rotation") ou vu par la caméra réelle. Warp inverse :
    // bilinéaire sous un angle fixe, projectif exact sous la caméra réelle (dst_prev.w = 1), qui
    // éclaire aussi le plan (color.xy : 1 + color.x·(s − 0.5) + color.y·(t − 0.5)).
    // mb = [gx, gy, z_focus, k] : profondeur du point r du plan = (r.x - 0.5)*gx + (r.y - 0.5)*gy
    // en px, positive vers la caméra ; z_focus = celle du focus du zoom (`TiltedQuad::depth_mb`) ;
    // k = texels source de flou par px d'écart de profondeur (0 = profondeur de champ coupée).
    // texture(2) (texImg) = pyramide demi-résolution de la vidéo, 5 niveaux, mêmes UV que
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
        float d = (layer.dst_prev.z > 0.5) ? sd_screen_under_bar(p, plane_px * 0.5, rad, layer.color.z)
                                           : sd_round_rect(p, plane_px * 0.5, rad);
        float tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        // Profondeur de champ : net sous un demi-texel de flou (l'échantillon d'avant, à
        // l'octet), fondu au-delà vers la pyramide au niveau `log2(coc) - 1`, plafonné.
        // `level(lod)` exige `mip_filter::linear` sur `samp` : sans lui, niveau 0 partout.
        float3 rgb = sample_yuv(uv, texY, texUV);
        float2 rs = clamp(float2(r.x, r.y), 0.0, 1.0);
        float z = (rs.x - 0.5) * layer.mb.x + (rs.y - 0.5) * layer.mb.y;
        float coc = layer.mb.w * abs(z - layer.mb.z);
        if (coc > 0.5)
        {
            float lod = clamp(log2(coc) - 1.0, 0.0, DOF_MAX_LOD);
            float3 far_rgb = texImg.sample(samp, uv, level(lod)).rgb;
            rgb = mix(rgb, far_rgb, clamp((coc - 0.5) / 1.5, 0.0, 1.0));
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
    if (layer.mode > 5.5 && layer.mode < 6.5)
    {
        float a = quad_round_alpha(i.local, layer.quad_px, layer.radius_px);
        return float4(texImg.sample(samp, i.uv).rgb * a, a); // prémultiplié
    }

    // mode 5 : gradient linéaire 2 stops (parité web wallpaper dégradé). color = stop0,
    // src.xyz = stop1, fx.xy = direction unitaire (espace sortie, y vers le bas). t est
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
        if (layer.fx.w > 0.5 && layer.fx.w < 1.5)
        {
            // Dérive : l'axe respire de ±15° (0.2617994 rad) en 20 s.
            float da = 0.2617994 * sin(6.2831853 * layer.fx.z / 20.0);
            float sa = sin(da);
            float ca = cos(da);
            dir = float2(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
        }
        float denom = max(abs(dir.x) + abs(dir.y), 1e-4);
        // Paramétré sur le QUAD dès qu'il en a un (la bulle webcam), sinon sur la sortie. Pour le
        // fond plein cadre les deux coïncident ; pour une bulle dans un coin, `pout` ne montrerait
        // que la tranche du dégradé plein cadre qui passe dessous, jamais la rampe complète que
        // le sélecteur affiche.
        float2 gp = (layer.quad_px.x > 0.0 && layer.quad_px.y > 0.0)
            ? (i.local / layer.quad_px)
            : i.pout;
        float t = clamp(0.5 + dot(gp - 0.5, dir) / denom, 0.0, 1.0);
        float3 g = mix(layer.color.rgb, layer.src.xyz, t);
        if (layer.fx.w > 1.5)
        {
            g = gradient_motion(gp, dir, denom, layer.color.rgb, layer.src.xyz, layer.fx.z,
                                layer.fx.w, layer.mb.x);
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
                rgb = mix(blur_webcam_bg(uv_now, layer.fx.w, layer.quad_px, i.local, texY, texUV), rgb, person);
            }
            else
            {
                alpha_mask = person;
            }
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
        float d = (layer.mb.w > 0.5) ? sd_screen_under_bar(p, halfsz, layer.radius_px, layer.mb.z)
                                     : sd_round_rect(p, halfsz, layer.radius_px);
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