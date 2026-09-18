// Compositeur — un draw par calque (quad). NV12->RGB maison (E1), coins arrondis SDF (E2).
// Tout écrit depuis les maths (§7), rien repris de l'ancien paradigme.

cbuffer Layer : register(b0)
{
    float4 dst;       // x,y,w,h dans l'espace sortie 0..1 (origine haut-gauche)
    float4 src;       // u0,v0,u1,v1 dans l'espace source 0..1 ; modes 15 et 17 : décalage px du rayon, P, U
    float2 quad_px;   // taille du quad en pixels (pour les SDF)
    float  radius_px; // rayon des coins arrondis en px (0 = aucun) ; mode 17 : rayon des coins hauts du corps (unités du modèle)
    float  mode;      // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre portée, 4 = curseur, 15 = curseur 3D, 16 = impact du clic, 17 = appareil modelé
    float4 color;     // couleur pleine / teinte (ombre : rgb + opacité dans a) ; mode 15 : coin du sprite, écrasement, opacité ; mode 17 : .r = l'appareil (1 portable, 2 téléphone, 3 moniteur), .g = thème sombre, .b = rayon des coins bas du corps, .a = opacité
    float4 fx;        // fx.x = spread ombre (px), fx.y,fx.z libres ; mode 15 : rotation du plan (rad), tangage ; mode 17 : rotation du plan (rad), épaisseur
    float4 src_prev;  // src à la frame précédente (flou de mouvement par vélocité) ; mode 15 : hotspot, lacet ; mode 17 : marges du corps (unités du modèle)
    float4 dst_prev;  // dst à la frame précédente ; modes 13 et 15 : rect de clip ; mode 17 : angle du socle, rayon et recouvrement de l'ouverture, pénombre de l'ombre
    float4 mb;        // mb.x = nombre de taps de motion blur (1 = désactivé) ; modes 15 et 17 : demi-taille du plan, translation
};
// Mode 15 (curseur modélisé) : le détail des emplacements est dans `frame_geometry.rs`, en tête
// de la section « Curseur modélisé » (`cursor_model_cb`). Mode 17 (appareil modelé) : en tête de
// « Appareils modelés » (`device_frame_cb`), et résumé au-dessus de `device_frame` ci-dessous.

struct VSOut
{
    float4 pos   : SV_Position;
    float2 uv    : TEXCOORD0; // coords d'échantillonnage source
    float2 local : TEXCOORD1; // coords pixel dans le quad (pour SDF)
    float2 pout  : TEXCOORD2; // position 0..1 sortie (pour la vélocité par pixel)
};

VSOut vs_main(uint vid : SV_VertexID)
{
    float2 c = float2(vid & 1, (vid >> 1) & 1); // strip: (0,0)(1,0)(0,1)(1,1)
    float2 p = dst.xy + c * dst.zw;             // 0..1 sortie
    float2 ndc = float2(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    VSOut o;
    o.pos = float4(ndc, 0.0, 1.0);
    o.uv = src.xy + c * (src.zw - src.xy);
    o.local = c * quad_px;
    o.pout = p;
    return o;
}

Texture2D<float>  texY  : register(t0);
Texture2D<float2> texUV : register(t1);
Texture2D<float4> texImg : register(t2); // wallpaper image RGBA (fond, mode 6) ; mode 8 : pyramide de flou
// Masque de segmentation du sujet, 0 = fond, 1 = sujet. Produit par `segmentation.rs` a la
// resolution du modele (256x144) ; l'upscale vers la resolution webcam est fait par le sampler
// lineaire, ce qui est exactement le filtrage qu'on veut sur un masque.
Texture2D<float> texMask : register(t3);
// Champ de distance signé du sprite de curseur (mode 15 seulement), R16F, cf. `cursor_sdf.rs`.
// Le sprite lui-même est en t2 (texImg), comme aux modes 7 et 13.
Texture2D<float> texSdf : register(t4);
SamplerState samp : register(s0);

// Plafond de la profondeur de champ du mode 8, en niveau de la pyramide demi-résolution (1.5 =
// ~5.7 texels source). Validé à l'œil sur du texte : cf. `tests/tilted_depth_of_field.rs`.
#define DOF_MAX_LOD 1.5

// BT.709 limited -> RGB (§7 E1), matrice en dur, range mesuré en S1.
float3 yuv709_limited(float y, float2 cbcr)
{
    float Yf = (y * 255.0 - 16.0) / 219.0;
    float Cb = (cbcr.x * 255.0 - 128.0) / 224.0;
    float Cr = (cbcr.y * 255.0 - 128.0) / 224.0;
    float3 rgb;
    rgb.r = Yf + 1.5748 * Cr;
    rgb.g = Yf - 0.1873 * Cb - 0.4681 * Cr;
    rgb.b = Yf + 1.8556 * Cb;
    return saturate(rgb);
}

float3 sample_yuv(float2 uv)
{
    float y = texY.Sample(samp, uv);
    float2 cbcr = texUV.Sample(samp, uv);
    return yuv709_limited(y, cbcr);
}

// SDF segment à bouts ronds — la primitive des flèches d'annotation, dont les tracés SVG sont
// trois segments `stroke-linecap="round"` (cf. ArrowSvgs.tsx).
float sd_segment(float2 p, float2 a, float2 b)
{
    float2 pa = p - a;
    float2 ba = b - a;
    float h = saturate(dot(pa, ba) / max(dot(ba, ba), 1e-6));
    return length(pa - ba * h);
}

// SDF rectangle à coins arrondis (§7 E2) : <0 dedans.
float sd_round_rect(float2 p, float2 halfsz, float r)
{
    float2 q = abs(p) - halfsz + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// L'écran sous le chrome de FENÊTRE (modes 0 et 8) : coins HAUTS carrés, à ras de la barre de
// titre, coins bas arrondis de `r`. L'arrondi du haut se fait une seule fois, par le cadre :
// quand `r` dépasse la barre, l'arc du cadre descend sous elle et rogne les coins hauts de
// l'écran. On le reproduit ici au contour INTÉRIEUR du filet — un rect arrondi de `r` qui monte
// de `lift` (la barre moins le filet) au-dessus de l'écran. Tant que `r <= lift`, son arc reste
// au-dessus de l'écran et ne rogne rien.
float sd_screen_under_bar(float2 p, float2 halfsz, float r, float lift)
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
float quad_round_alpha(float2 local, float2 quad_px, float radius_px)
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
float2 line_cross(float2 n1, float d1, float2 n2, float d2)
{
    float det = n1.x * n2.y - n1.y * n2.x;
    if (abs(det) < 1e-6) return float2(0.0, 0.0); // arêtes parallèles : quad dégénéré
    return float2(d1 * n2.y - d2 * n1.y, d2 * n1.x - d1 * n2.x) / det;
}

// Distance signée EXACTE à un quadrilatère convexe (<0 dedans). Le max des demi-plans suffit près
// des arêtes mais donne un coin en pointe ; ici on veut aussi la distance juste au coin, puisque
// c'est elle qui devient l'arrondi une fois le rayon retranché.
float sd_convex_quad(float2 p, float2 v0, float2 v1, float2 v2, float2 v3)
{
    float2 v[5] = { v0, v1, v2, v3, v0 };
    float inside = -1e9;
    float border = 1e9;
    [unroll] for (int k = 0; k < 4; k++)
    {
        float2 a = v[k];
        float2 e = v[k + 1] - a;
        float2 n = float2(e.y, -e.x) / max(length(e), 1e-6);
        inside = max(inside, dot(p - a, n));
        border = min(border, sd_segment(p, a, v[k + 1]));
    }
    return (inside < 0.0) ? -border : border;
}

// (s, t, ok) du warp inverse du mode 8 pour une racine `t` donnée : `ok` = 1 quand le couple
// tombe dans le quad projeté (même marge 0.02 qu'ailleurs). Les deux racines doivent être
// essayées — trancher sur `t` seul retient parfois celle dont le `s` sort du quad, et le pixel
// est alors déclaré dehors alors que l'autre racine le plaçait dedans.
float3 quad_st_for_root(float t, float2 e, float2 f, float2 g, float2 h)
{
    float denomX = e.x + g.x * t;
    float denomY = e.y + g.y * t;
    float s = (abs(denomX) > abs(denomY)) ? (h.x - f.x * t) / denomX : (h.y - f.y * t) / denomY;
    float ok = (s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02) ? 1.0 : 0.0;
    return float3(s, t, ok);
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 : le warp bilinéaire INVERSE, partagé
// par le mode 8 (écran incliné) et le mode 13 (curseur posé sur ce même écran). Les deux doivent
// résoudre exactement la même équation, sinon le curseur glisse par rapport au contenu — d'où
// une seule implémentation plutôt que deux copies.
float3 quad_inverse_bilinear(float2 P, float2 c00, float2 c10, float2 c11, float2 c01)
{
    float2 e = c10 - c00;
    float2 f = c01 - c00;
    float2 g = c00 - c10 - c01 + c11;
    float2 h = P - c00;
    float k2 = g.x * f.y - g.y * f.x;
    float k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    float k0 = h.x * e.y - h.y * e.x;
    // Seuil RELATIF. Les présets « left »/« right » sont une rotation Y pure : le quad
    // projeté est un trapèze symétrique dont `f` et `g` sont tous deux verticaux, donc
    // k2 = 0 EXACTEMENT — au bruit d'arrondi près, et ce bruit vaut quelques centièmes sur
    // des produits en 10^6. Un seuil absolu de 0.001 le manquait : l'équation passait dans la
    // branche quadratique avec k2 ≈ 0, où `(-k1 + sqrt(k1²)) / 2k2` ne renvoie que du bruit —
    // soustraire deux nombres presque égaux, puis diviser par presque rien. La quasi-totalité
    // du quad était rejetée, ce qui se voyait comme un écran incliné tranché net.
    if (abs(k2) < 1e-5 * abs(k1))
    {
        float t = (abs(k1) < 1e-6) ? 0.0 : -k0 / k1;
        return quad_st_for_root(t, e, f, g, h);
    }
    float disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) return float3(0.0, 0.0, 0.0);
    // Forme stable : `q` n'oppose jamais deux quantités voisines, et les deux racines
    // s'en déduisent exactement. `sign()` est évité parce qu'il vaut 0 en 0, ce qui
    // annulerait `q` là où la formule reste parfaitement définie.
    float q = -0.5 * (k1 + (k1 >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
    float3 r0 = quad_st_for_root(q / k2, e, f, g, h);
    float3 r1 = quad_st_for_root(abs(q) > 0.0 ? k0 / q : q / k2, e, f, g, h);
    return (r0.z > 0.5) ? r0 : r1;
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 par l'homographie EXACTE du carré unité
// sur le quad (forme de Heckbert, coordonnées relatives à c00), résolue à l'envers par Cramer.
// C'est la projection d'un plan par une vraie caméra (`camera.rs`) : le warp bilinéaire s'en écarte
// de plusieurs dizaines de px au centre d'un écran vu de biais. Miroir de `regions::square_to_quad`.
float3 quad_inverse_projective(float2 P, float2 c00, float2 c10, float2 c11, float2 c01)
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
    // x·(g s + h t + 1) = a s + b t, idem en y : un système 2×2 linéaire en (s, t).
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

// Le warp inverse d'un calque posé sur le plan : projectif sous la caméra réelle (`projective` =
// 1, cf. `TiltedQuad::warp_flag`), bilinéaire sous un angle fixe, inchangé.
float3 quad_inverse(float2 P, float2 c00, float2 c10, float2 c11, float2 c01, float projective)
{
    if (projective > 0.5)
    {
        return quad_inverse_projective(P, c00, c10, c11, c01);
    }
    return quad_inverse_bilinear(P, c00, c10, c11, c01);
}

// Hash 2D -> [0,1) sans sin() : le hash `frac(sin(x) * 43758)` dépend de la précision du GPU,
// celui-ci (Hoskins, « hash12 ») ne fait que des produits de petites valeurs.
float hash12(float2 p)
{
    float3 p3 = frac(float3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.x + p3.y) * p3.z);
}

// Bruit de valeur lissé (hermite), sans texture.
float value_noise(float2 q)
{
    float2 i = floor(q);
    float2 f = frac(q);
    float2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + float2(1.0, 0.0));
    float c = hash12(i + float2(0.0, 1.0));
    float d = hash12(i + float2(1.0, 1.0));
    return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
}

// Mouvements 2 (aurore) et 3 (vagues) du mode 5, dans les deux couleurs des stops seulement.
// `gp` 0..1 sur le quad, `dir`/`denom` ceux du dégradé, `time` = temps programme replié sur
// 120 s (toutes les périodes ci-dessous le divisent), `aspect` = w/h de la sortie. Périodes
// longues et contraste bas : le fond ne doit jamais prendre l'attention.
float3 gradient_motion(float2 gp, float2 dir, float denom, float3 c0, float3 c1, float time,
                       float motion, float aspect)
{
    const float TAU = 6.2831853;
    float u = dot(gp - 0.5, dir) / denom; // position le long de l'axe, -0.5..0.5
    if (motion < 2.5)
    {
        // Aurore : rampe perturbée par un bruit lent (dont l'origine tourne en 120 s), puis
        // trois nappes gaussiennes sur des Lissajous de 20 à 40 s. Coordonnées corrigées de
        // l'aspect pour que les nappes restent rondes.
        float2 p = float2((gp.x - 0.5) * aspect, gp.y - 0.5);
        float ph = TAU * time / 120.0;
        float n = value_noise(p * 2.5 + 1.5 * float2(cos(ph), sin(ph)));
        float3 g = lerp(c0, c1, saturate(0.5 + u + 0.3 * (n - 0.5)));
        float2 b0 = float2(0.35 * aspect * sin(TAU * time / 20.0), 0.25 * sin(TAU * time / 30.0 + 1.0));
        float2 b1 = float2(0.30 * aspect * sin(TAU * time / 24.0 + 2.0), 0.22 * cos(TAU * time / 40.0));
        float2 b2 = float2(0.25 * aspect * cos(TAU * time / 30.0 + 4.0), 0.28 * sin(TAU * time / 24.0 + 3.0));
        g = lerp(g, c1, 0.45 * exp(-dot(p - b0, p - b0) / 0.08));
        g = lerp(g, c0, 0.45 * exp(-dot(p - b1, p - b1) / 0.06));
        g = lerp(g, c1, 0.35 * exp(-dot(p - b2, p - b2) / 0.05));
        return g;
    }
    // Vagues : trois bandes sinus perpendiculaires à l'axe, qui avancent d'une bande en 12 s,
    // légèrement ondulées le long des bandes (20 s). Elles décalent la rampe, rien d'autre.
    float v = dot(gp - 0.5, float2(-dir.y, dir.x)) / denom;
    float w = sin(TAU * (3.0 * u + 0.04 * sin(TAU * (1.5 * v + time / 20.0)) - time / 12.0));
    return lerp(c0, c1, saturate(0.5 + u + 0.07 * w));
}

// Couverture d'une pastille (disque) adoucie sur ~1.5 px, pour la barre de titre du mode 14.
float disc_cov(float2 p, float2 c, float r)
{
    return 1.0 - smoothstep(r - 0.75, r + 0.75, length(p - c));
}

// Couverture d'un trait centré sur `x = 0`, de demi-épaisseur `half_w`, sur ~1 px. Un trait plus
// fin qu'un pixel s'estompe au lieu de disparaître (même forme que la flèche du mode 9).
float band_cov(float x, float half_w)
{
    return saturate(half_w + 0.5 - abs(x));
}

// Fond flouté pour le mode "blur" de la webcam.
// Disque de Vogel (spirale à angle d'or) à 21 échantillons avec pondération gaussienne et
// rotation par pixel via Interleaved Gradient Noise (IGN) pour un bokeh photographique doux, isotrope et rapide.
static const float3 VOGEL_TAPS[21] = {
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

float3 blur_webcam_bg(float2 uv, float intensity, float2 qpx, float2 local_px)
{
    float max_r_px = max(intensity, 0.0) * 22.0 + 1.5;
    float2 step = max_r_px / max(qpx, 1.0);
    // Interleaved Gradient Noise pour rotation aléatoire par pixel
    float noise = frac(52.9829189 * frac(0.06711056 * local_px.x + 0.00583715 * local_px.y));
    float angle = noise * 6.2831853;
    float s, c;
    sincos(angle, s, c);
    float3 sum = 0.0;
    float total = 0.0;
    [unroll] for (int k = 0; k < 21; k++)
    {
        float2 p = VOGEL_TAPS[k].xy;
        float w = VOGEL_TAPS[k].z;
        float2 rot_p = float2(p.x * c - p.y * s, p.x * s + p.y * c);
        sum += sample_yuv(saturate(uv + rot_p * step)) * w;
        total += w;
    }
    return sum / max(total, 1e-4);
}

// ============ Curseur MODÉLISÉ (mode 15) ============
// Le sprite de l'état courant en objet 3D : sa silhouette (champ de distance signé tiré de son
// alpha par `cursor_sdf.rs`), extrudée avec un chanfrein, lancé de rayons par pixel. Le dessus
// porte l'art du sprite ; le chanfrein et les flancs, la couleur de son bord. Ce qui touche le
// modèle est éclairé ; ce qui le rate tombe sur le plan de l'écran, où l'on mesure l'ombre portée
// (marche vers la lumière, pénombre douce) et l'ombre de contact. La caméra est reconstruite à
// l'identique de `regions::rotate_point` + perspective P / (P - z) ; la pose, la caméra et la
// boîte de dessin viennent de `frame_geometry::cursor_model_cb`, qui documente les emplacements
// du cbuffer.
//
// Repère du MODÈLE : unité = plus grand côté du sprite, origine au hotspot de la face du dessus,
// x à droite, y vers le bas, z vers la caméra ; le modèle occupe z de -MODEL_THICK à 0. Le rect
// du sprite y commence en `color.rg` et mesure `sprite_size()` (rapport w/h dans `radius_px`).
// Textures : t2 (texImg) = le sprite, RGBA en alpha droit ; t4 (texSdf) = son champ, R16F, en
// unités du modèle, négatif dedans, sur le même rect.
// Constantes : miroir exact de `frame_geometry.rs` (MODEL_*).
static const float MODEL_THICK = 0.19;

// Taille du sprite, repère du modèle : son plus grand côté vaut 1, `radius_px` porte w/h.
float2 sprite_size()
{
    return float2(min(radius_px, 1.0), min(1.0 / radius_px, 1.0));
}

// Un texel du sprite, en unités du modèle : le champ est le sprite suréchantillonné ×4
// (`cursor_sdf::SDF_UPSAMPLE`) et le plus grand côté du sprite vaut 1.
static const float CURSOR_SDF_UPSAMPLE = 4.0;
float sprite_texel()
{
    uint w, h;
    texSdf.GetDimensions(w, h);
    return CURSOR_SDF_UPSAMPLE / (float)max(w, h);
}

// Épaisseur du modèle, écrasé au clic de `color.b` (`CursorPose::squash`).
float model_thick()
{
    return MODEL_THICK * color.b;
}
static const float MODEL_BEVEL = 0.045;
// Direction VERS la lumière, repère caméra : haut-gauche, devant.
static const float3 MODEL_LIGHT = float3(-0.4194, -0.5792, 0.6990);
static const float MODEL_AMBIENT = 0.36;
static const float MODEL_DIFFUSE = 0.75;
static const float MODEL_SPECULAR = 0.45;
// Profondeur (texels du sprite) à laquelle on lit la couleur du bord : assez loin de la frange
// antialiasée, assez près pour rester dans le filet de l'art (~4 texels).
static const float MODEL_RIM_INSET = 1.5;
// Ombre portée : dureté de la pénombre (plus grand = plus net), portée maximale (la marche vers
// la lumière s'arrête à la boîte du modèle élargie d'autant) et opacité ; ombre de contact :
// portée (unités) et opacité. La boîte de dessin en dépend : miroir des constantes
// `MODEL_SOFTNESS`, `MODEL_SHADOW_PAD` et `MODEL_CONTACT_RADIUS` de `frame_geometry.rs`.
static const float MODEL_SOFTNESS = 6.0;
static const float MODEL_SHADOW_PAD = 0.45;
static const float MODEL_SHADOW_ALPHA = 0.5;
static const float MODEL_CONTACT_RADIUS = 0.12;
static const float MODEL_CONTACT_ALPHA = 0.5;

// Distance signée à la silhouette (plan xy du modèle). Dans le rect du sprite, le champ ; hors de
// lui, une borne inférieure exacte le long de la normale au rect : le sprite tient dans son rect,
// qui est convexe, donc |p - s|² >= |p - c|² + |c - s|² pour tout point s du sprite (c = p ramené
// dans le rect). Échantillonné au niveau 0 : la marche est une boucle à sortie anticipée.
float sd_sprite2(float2 p)
{
    float2 c = clamp(p, color.rg, color.rg + sprite_size());
    float d = texSdf.SampleLevel(samp, (c - color.rg) / sprite_size(), 0.0);
    float2 o = p - c;
    float out2 = dot(o, o);
    float e = max(d, 0.0);
    return out2 > 0.0 ? sqrt(out2 + e * e) : d;
}

// Distance signée au modèle : le contour rentré du chanfrein, épaisseur rentrée du chanfrein, puis
// regonflé : les arêtes du dessus et du dessous sont arrondies de MODEL_BEVEL.
float sd_model(float3 p)
{
    float half_t = model_thick() * 0.5;
    float2 w = float2(sd_sprite2(p.xy) + MODEL_BEVEL, abs(p.z + half_t) - (half_t - MODEL_BEVEL));
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - MODEL_BEVEL;
}

// Normale par le gradient du champ (tétraèdre, quatre évaluations).
float3 model_normal(float3 p)
{
    const float e = 0.002;
    return normalize(float3(1, -1, -1) * sd_model(p + float3(1, -1, -1) * e) +
                     float3(-1, -1, 1) * sd_model(p + float3(-1, -1, 1) * e) +
                     float3(-1, 1, -1) * sd_model(p + float3(-1, 1, -1) * e) +
                     float3(1, 1, 1) * sd_model(p + float3(1, 1, 1) * e));
}

// Entrée/sortie d'un rayon dans une boîte alignée (x = entrée, y = sortie ; x >= y : raté).
float2 ray_box(float3 o, float3 d, float3 lo, float3 hi)
{
    float3 inv = 1.0 / (abs(d) > 1e-6 ? d : 1e-6);
    float3 t0 = (lo - o) * inv;
    float3 t1 = (hi - o) * inv;
    float3 tn = min(t0, t1);
    float3 tf = max(t0, t1);
    return float2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

// Cosinus/sinus de la pose : rotation du plan (X, Y, Z), tangage et lacet du modèle.
struct ModelFrame
{
    float3 c;
    float3 s;
    float cp;
    float sp;
    float cy;
    float sy;
};

// Repère caméra -> repère du plan : la transposée de `regions::rotate_point` (X, Y, puis Z).
float3 world_to_plane(float3 v, ModelFrame f)
{
    float y = v.y * f.c.x + v.z * f.s.x;
    float z = -v.y * f.s.x + v.z * f.c.x;
    float x = v.x * f.c.y - z * f.s.y;
    z = v.x * f.s.y + z * f.c.y;
    return float3(x * f.c.z + y * f.s.z, -x * f.s.z + y * f.c.z, z);
}

// Repère du modèle -> repère du plan (sans échelle ni translation) : tangage autour de x, puis
// lacet autour de z (`ModelView::model_to_plane`).
float3 model_to_plane(float3 v, ModelFrame f)
{
    float y = v.y * f.cp - v.z * f.sp;
    float z = v.y * f.sp + v.z * f.cp;
    return float3(v.x * f.cy - y * f.sy, v.x * f.sy + y * f.cy, z);
}

// L'inverse du précédent.
float3 plane_to_model(float3 v, ModelFrame f)
{
    float x = v.x * f.cy + v.y * f.sy;
    float y = -v.x * f.sy + v.y * f.cy;
    return float3(x, y * f.cp + v.z * f.sp, -y * f.sp + v.z * f.cp);
}

// Pénombre vers la lumière depuis `o` (1 = éclairé, 0 = dans l'ombre). Marche bornée à la boîte
// du modèle élargie de la portée de la pénombre, pas bornés, sortie dès que l'ombre est pleine.
float model_soft_shadow(float3 o, float3 l, float3 lo, float3 hi)
{
    float2 tb = ray_box(o, l, lo - MODEL_SHADOW_PAD, hi + MODEL_SHADOW_PAD);
    if (tb.x >= tb.y || tb.y <= 0.0)
    {
        return 1.0;
    }
    float res = 1.0;
    float t = max(tb.x, 0.004);
    [loop] for (int k = 0; k < 32; k++)
    {
        float d = sd_model(o + l * t);
        res = min(res, MODEL_SOFTNESS * d / t);
        if (res < 0.002 || t > tb.y)
        {
            break;
        }
        t += clamp(d, 0.01, 0.2);
    }
    res = saturate(res);
    return res * res * (3.0 - 2.0 * res);
}

// Couleur de la matière au point `p` du plan xy (alpha droit) : l'art du sprite, lu au plus à
// MODEL_RIM_INSET texels du bord vers l'intérieur. Le dessus garde donc son art, et le chanfrein,
// les flancs et le dessous prennent la couleur du bord de CE sprite (le filet blanc de la flèche,
// le trait noir des mains), jamais la frange mêlée au transparent.
float3 model_albedo(float2 p)
{
    float texel = sprite_texel();
    float e = 0.25 * texel;
    float2 g = float2(sd_sprite2(p + float2(e, 0.0)) - sd_sprite2(p - float2(e, 0.0)),
                      sd_sprite2(p + float2(0.0, e)) - sd_sprite2(p - float2(0.0, e)));
    float2 q = p - g / max(length(g), 1e-6) * max(sd_sprite2(p) + MODEL_RIM_INSET * texel, 0.0);
    return texImg.SampleLevel(samp, (q - color.rg) / sprite_size(), 0.0).rgb;
}

// Couleur (alpha droit) d'un point de la surface vu le long de `rd`.
float3 model_shade(float3 q, float3 rd, float3 l)
{
    float3 n = model_normal(q);
    float3 albedo = model_albedo(q.xy);
    float diffuse = saturate(dot(n, l));
    // Reflet sur les arrondis seulement : une face plane l'allumerait d'un bloc (la lumière est
    // directionnelle), et le dessus sombre d'un sprite virerait au gris à chaque clic.
    float gloss = 1.0 - smoothstep(0.97, 0.995, abs(n.z));
    float spec = gloss * pow(saturate(dot(n, normalize(l - rd))), 110.0);
    return albedo * (MODEL_AMBIENT + MODEL_DIFFUSE * diffuse) + MODEL_SPECULAR * spec;
}

float4 cursor_model(float2 local)
{
    ModelFrame f;
    f.c = cos(fx.xyz);
    f.s = sin(fx.xyz);
    f.cp = cos(fx.w);
    f.sp = sin(fx.w);
    f.cy = cos(src_prev.w);
    f.sy = sin(src_prev.w);
    float persp = src.z;
    float unit = src.w;
    float3 tip = src_prev.xyz;
    // La boîte du modèle : le rect du sprite, sur toute l'épaisseur.
    float3 lo = float3(color.rg, -model_thick());
    float3 hi = float3(color.rg + sprite_size(), 0.0);

    // Le rayon de ce pixel : de la caméra (0, 0, P) à travers le pixel sur le plan image z = 0.
    // Le plan est translaté de mb.zw dans le repère caméra (caméra réelle, 0 sous un angle fixe).
    float3 dw = float3(local + src.xy, -persp);
    float dlen = length(dw);
    float3 ro = plane_to_model((world_to_plane(float3(-mb.z, -mb.w, persp), f) - tip) / unit, f);
    float3 rd = plane_to_model(world_to_plane(dw / dlen, f), f);
    float3 l = plane_to_model(world_to_plane(MODEL_LIGHT, f), f);
    // Le plan de l'écran dans le repère du modèle : dot(p, nz) = hz.
    float3 nz = plane_to_model(float3(0.0, 0.0, 1.0), f);
    float hz = -tip.z / unit;

    // Le modèle. Silhouette antialiasée : un rayon qui la frôle à moins d'un pixel la couvre en
    // partie (`best`, la plus petite distance rencontrée, en pixels).
    float cov = 0.0;
    float3 rgb = 0.0;
    float2 tb = ray_box(ro, rd, lo - 0.02, hi + 0.02);
    if (tb.x < tb.y && tb.y > 0.0)
    {
        float t = max(tb.x, 0.0);
        float best = 1e9;
        float t_best = t;
        bool hit = false;
        [loop] for (int k = 0; k < 64; k++)
        {
            float d = sd_model(ro + rd * t);
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
        cov = hit ? 1.0 : saturate(1.0 - best);
        if (cov > 0.0)
        {
            rgb = model_shade(ro + rd * t_best, rd, l);
        }
    }

    // Le plan, là où le modèle ne couvre pas tout le pixel : ombre portée et ombre de contact,
    // seulement à l'intérieur de l'écran (`mb.xy` = sa demi-taille, px du plan).
    float shadow = 0.0;
    float denom = dot(rd, nz);
    if (cov < 1.0 && denom < -1e-4)
    {
        float3 g = ro + rd * ((hz - dot(ro, nz)) / denom);
        float3 gp = tip + unit * model_to_plane(g, f);
        float inside = saturate(min(mb.x - abs(gp.x), mb.y - abs(gp.y)) + 0.5);
        if (inside > 0.0)
        {
            float dropped = 1.0 - model_soft_shadow(g, l, lo, hi);
            float contact = 1.0 - smoothstep(0.0, MODEL_CONTACT_RADIUS, sd_model(g));
            shadow = inside * max(dropped * MODEL_SHADOW_ALPHA, contact * MODEL_CONTACT_ALPHA);
        }
    }

    float a = cov * color.a;
    return float4(rgb * a, a + (1.0 - a) * shadow * color.a); // prémultiplié, ombre noire
}

// ============ Impact du clic (mode 16) ============
// Sous le curseur modélisé : une tache de pression et un anneau posés SUR l'écran, centrés sur le
// point cliqué. Même warp que le mode 13 (fx/src_prev = coins, mb.x = 1 : projectif) ; le carré
// (s, t) porte un disque, d = 0 au point cliqué et 1 sur le cercle inscrit. src = anneau (rayon,
// demi-épaisseur, opacité, opacité du halo sombre) ; mb.yz = tache (rayon, opacité) ; dst_prev =
// le carré en fractions du plan, pour ne rien dessiner hors de l'écran ; radius_px = largeur de
// l'antialiasing ; color = teinte de l'anneau et opacité. Emplacements : `cursor_impact_cb`.
float4 cursor_impact(float2 local)
{
    float3 r = quad_inverse(local, fx.xy, fx.zw, src_prev.xy, src_prev.zw, mb.x);
    float2 pf = dst_prev.xy + r.xy * dst_prev.zw;
    if (r.z < 0.5 || any(pf < 0.0) || any(pf > 1.0))
    {
        return float4(0.0, 0.0, 0.0, 0.0);
    }
    float d = length(r.xy * 2.0 - 1.0);
    float x = abs(d - src.x);
    float ring = src.z * (1.0 - smoothstep(src.y - radius_px, src.y + radius_px, x));
    float halo = src.w * exp(-x * x / (6.0 * src.y * src.y + radius_px * radius_px));
    float spot = mb.z * exp(-d * d / max(mb.y * mb.y, 1e-6));
    float shade = saturate(halo + spot);
    float a = ring + (1.0 - ring) * shade;
    return float4(color.rgb * ring, a) * color.a; // prémultiplié, ombre noire
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
// y vers le bas, z vers la caméra. L'écran occupe ±`mb.xy`, le corps l'entoure de `src_prev` et
// va de z = −`fx.w` à 0 ; ce qui dépasse (socle, pied) sort vers +y et ±z.
// Emplacements du cbuffer — miroir de `frame_geometry::device_frame_cb`, qui en fait foi :
//   src       = (décalage px du rayon, P, unité du modèle en px)
//   radius_px = rayon extérieur du corps, coins HAUTS (unités du modèle)
//   color.r   = l'appareil (1 portable, 2 téléphone, 3 moniteur) ; color.g = 1 si thème sombre ;
//               color.b = rayon extérieur du corps, coins BAS (unités) ; color.a = opacité
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
static const float DEV_CHAMFER = 0.0021;
// Distance MINIMALE de l'œil qui voit le relief du modèle : celle d'un bras devant un portable.
// Miroir de `frame_geometry::DEV_EYE_MIN`.
static const float DEV_EYE_MIN = 9.6;
// Le plan proche du modèle (`frame_geometry::device_near_plane`) : une fraction de la distance
// de l'œil du modèle, rapprochée du travelling de la caméra réelle, et la bande de fondu. L'objectif
// des présets, 1,6 petit côté (`regions::PERSPECTIVE_FACTOR`), sert de distance de repos.
static const float DEV_NEAR = 0.16;
static const float DEV_NEAR_BAND = 0.1;
static const float DEV_LENS = 1.6;
// Le socle a sa profondeur réelle ; c'est son ANGLE (`device_deck_angle`) qui le rend discret vu
// de face. Il a la largeur de la coque ; tout le reste de ce qui dépasse est fixe, en unités du
// modèle, quelle que soit la forme du métrage encadré.
static const float DEV_DECK_LEN = 1.30;
// Le liseré d'aluminium qui borde la face avant (`DEV_RIM`), le rayon des coins avant de la
// semelle du moniteur (`DEV_FOOT_R`) et l'encoche du socle du portable, au milieu de son arête
// avant (`DEV_SCOOP_*` : demi-largeur, profondeur, hauteur de l'ellipsoïde retiré).
static const float DEV_RIM = 0.0053;
static const float DEV_FOOT_R = 0.0365;
static const float DEV_SCOOP_W = 0.14;
static const float DEV_SCOOP_D = 0.0372;
static const float DEV_SCOOP_H = 0.0112;
static const float DEV_DECK_THICK = 0.0446;
static const float DEV_DECK_THICK_FRONT = 0.0391;
static const float DEV_DECK_GAP = 0.0093;
static const float DEV_NECK_W = 0.255;
static const float DEV_NECK_LEN = 0.177;
static const float DEV_FOOT_W = 0.456;
static const float DEV_FOOT_H = 0.0456;
static const float DEV_STAND_Z = 0.0219;
static const float DEV_FOOT_Z = 0.195;
// Teintes (alpha droit). Deux thèmes, `color.g` = 1 pour le sombre : aluminium argent ou
// graphite, et le verre de la dalle qui va avec. Neutres — c'est ce qui fait un appareil
// « schématique » et non une marque.
static const float3 DEV_SHELL_LIGHT = float3(0.800, 0.806, 0.812);
static const float3 DEV_SHELL_LIGHT_BACK = float3(0.600, 0.610, 0.622);
static const float3 DEV_GLASS_LIGHT = float3(0.031, 0.034, 0.040);
static const float3 DEV_SHELL_GRAPHITE = float3(0.255, 0.263, 0.278);
static const float3 DEV_SHELL_GRAPHITE_BACK = float3(0.153, 0.161, 0.176);
static const float3 DEV_GLASS_GRAPHITE = float3(0.043, 0.047, 0.055);
// Voile directionnel de l'aluminium brossé : doux et étroit, jamais une tache.
static const float DEV_SHEEN = 0.11;

bool dev_dark() { return color.g > 0.5; }
float3 dev_shell() { return dev_dark() ? DEV_SHELL_GRAPHITE : DEV_SHELL_LIGHT; }
float3 dev_shell_back() { return dev_dark() ? DEV_SHELL_GRAPHITE_BACK : DEV_SHELL_LIGHT_BACK; }
float3 dev_glass() { return dev_dark() ? DEV_GLASS_GRAPHITE : DEV_GLASS_LIGHT; }

float2 dev_body_c() { return float2((src_prev.z - src_prev.x) * 0.5, (src_prev.w - src_prev.y) * 0.5); }
float2 dev_body_h() { return mb.xy + float2((src_prev.x + src_prev.z) * 0.5, (src_prev.y + src_prev.w) * 0.5); }
// Le chanfrein, borné par l'épaisseur : garde-fou, jamais atteint aux épaisseurs livrées.
float dev_chamfer() { return min(DEV_CHAMFER, fx.w * 0.3); }
float dev_deck_angle() { return dst_prev.x; }
// L'appareil : 1 = portable, 2 = téléphone, 3 = moniteur (`device_kind_id`).
bool dev_is(float k) { return abs(color.r - k) < 0.5; }

// La hauteur du PLAN PROCHE devant l'écran (unités), pour la caméra RÉELLE en `eye` (repère du
// plan, unités) qui regarde le long de `axis` : la distance au point qu'elle vise, rapportée à
// celle de l'objectif des présets, rapproche d'autant l'œil du modèle et son plan proche. Miroir
// de `frame_geometry::device_near_plane` : 1,54 u au repos, au-delà du socle (1,30 u) ; sous la
// caméra en orbite, `zoom^−0,5` de moins.
float dev_near_plane(float3 eye, float3 axis)
{
    float dist = eye.z / max(-axis.z, 1e-3);
    return DEV_NEAR * DEV_EYE_MIN * dist / max(DEV_LENS * 2.0 * min(mb.x, mb.y), 1e-4);
}

// Ce qui reste d'un point `q` du modèle sous le plan proche `h_near` : 1 en deçà, 0 au-delà, un fondu
// sur `DEV_NEAR_BAND` de sa hauteur — jamais une coupe franche qui montrerait une section.
float dev_near_fade(float3 q, float h_near)
{
    return 1.0 - smoothstep(h_near * (1.0 - DEV_NEAR_BAND), h_near, q.z);
}

// Boîte 3D à arêtes chanfreinées.
float sd_dev_box(float3 p, float3 h, float r)
{
    float3 q = abs(p) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// Le contour du CORPS dans le plan xy, signé (<0 dedans) : la silhouette de la face avant. Le
// filet de lumière et le liseré du navigateur s'y accrochent.
float sd_dev_outline(float2 p)
{
    // Coins hauts `radius_px`, coins bas `color.b` : le couvercle du portable est arrondi en haut
    // et presque carré à la charnière.
    float2 q = p - dev_body_c();
    return sd_round_rect(q, dev_body_h(), (q.y < 0.0) ? radius_px : color.b);
}

// Ellipsoïde (borne de distance) : l'encoche du socle.
float sd_dev_ellipsoid(float3 p, float3 r)
{
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

// La dalle PLEINE du corps : arrondie en xy, mince en z, chanfreinée. Sans le creux de l'écran,
// c'est la silhouette qui porte l'ombre.
float sd_dev_slab(float3 p)
{
    float t = fx.w;
    float ch = dev_chamfer();
    float2 w = float2(sd_dev_outline(p.xy) + ch, abs(p.z + t * 0.5) - (t * 0.5 - ch));
    return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - ch;
}

// L'OUVERTURE dans le plan (<0 dedans) : le contour du métrage (rayon `dst_prev.y`, la même
// fonction de coin que lui, `screen_corner_radius_px`) rentré du recouvrement `dst_prev.z`. Rentré
// comme un décalage, pas comme un rect : les arcs gardent leur centre et perdent le recouvrement
// de rayon, si bien que la lunette mord le métrage de la même largeur aux coins que le long des
// bords — sous le même rayon, elle le mordait d'un demi-pixel de plus sur la diagonale. Elle reste
// DANS le métrage sur tout son contour : la lunette gagne partout hors d'elle.
float sd_dev_aperture(float2 p)
{
    float2 ah = mb.xy - dst_prev.z;
    return sd_round_rect(p, ah, clamp(dst_prev.y - dst_prev.z, 0.0, min(ah.x, ah.y)));
}

// Le CORPS : la dalle moins le creux de l'écran, ouvert vers la caméra et fermé au fond — un trou
// débouchant laisserait voir au travers par le côté.
float sd_dev_body(float3 p)
{
    float hole = max(sd_dev_aperture(p.xy), -p.z - fx.w * 0.55);
    return max(sd_dev_slab(p), -hole);
}

// Le repère du socle du portable : origine à la charnière (bord bas de la coque, à mi-épaisseur),
// y vers l'avant le long du socle, z sa normale. Miroir de `DeviceView::model_points`.
float3 dev_deck_local(float3 p)
{
    float2 c = dev_body_c();
    float2 h = dev_body_h();
    float3 d = p - float3(0.0, c.y + h.y, -fx.w * 0.5);
    float ca = cos(dev_deck_angle());
    float sa = sin(dev_deck_angle());
    return float3(d.x, d.y * ca + d.z * sa, -d.y * sa + d.z * ca);
}

// Le socle : un COIN, pleine épaisseur à la charnière et aminci vers le bord avant, EXACTEMENT
// aussi large que la coque, et séparé d'elle par un jeu — le trait sombre qui dit deux pièces.
float sd_dev_deck(float3 p)
{
    float3 q = dev_deck_local(p);
    float y0 = DEV_DECK_GAP;
    float y1 = y0 + DEV_DECK_LEN;
    float tb = DEV_DECK_THICK;
    float slab = sd_dev_box(q - float3(0.0, (y0 + y1) * 0.5, -tb * 0.5),
                            float3(dev_body_h().x, (y1 - y0) * 0.5, tb * 0.5),
                            DEV_CHAMFER * 2.0);
    // Le dessous remonte vers l'avant : c'est lui, et non l'épaisseur, qui fait le profil en coin.
    float k = (DEV_DECK_THICK - DEV_DECK_THICK_FRONT) / DEV_DECK_LEN;
    float under = (-tb + k * (q.y - y0) - q.z) * rsqrt(1.0 + k * k);
    // L'encoche au milieu de l'arête avant, pour ouvrir l'écran du pouce : un creux peu profond,
    // qui se lit de face comme un léger fléchissement du haut de la barre.
    float scoop = sd_dev_ellipsoid(q - float3(0.0, y1, 0.0), float3(DEV_SCOOP_W, DEV_SCOOP_D, DEV_SCOOP_H));
    return max(max(slab, under), -scoop);
}

// Entrée ANALYTIQUE du rayon dans le coin du socle (chanfrein ignoré, un millième d'unité), 1e9
// s'il le manque. Vu par la tranche, le socle est frôlé par des rayons qui restent à quelques
// pixels de lui sur toute sa profondeur : la marche y avance à pas d'un quart de pixel et
// s'épuise avant de l'atteindre — ou d'atteindre la lunette juste derrière, qui s'effaçait.
float dev_deck_hit(float3 ro, float3 rd)
{
    float3 q0 = dev_deck_local(ro);
    float3 qd = dev_deck_local(ro + rd) - q0;
    float hw = dev_body_h().x;
    float y0 = DEV_DECK_GAP;
    float len = DEV_DECK_LEN;
    float tb = DEV_DECK_THICK;
    float2 tt = ray_box(q0, qd, float3(-hw, y0, -tb), float3(hw, y0 + len, 0.0));
    // Le dessous, qui remonte vers l'avant (`sd_dev_deck`) : dedans tant que g <= 0.
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
    // Entré par l'encoche (un ellipsoïde retiré), le rayon touche la matière à sa SORTIE de
    // l'ellipsoïde, s'il est encore dans le coin.
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
float sd_dev_stand(float3 p)
{
    float y0 = dev_body_c().y + dev_body_h().y;
    float zc = -fx.w * 0.5;
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
float sd_dev_extra(float3 p)
{
    if (dev_is(1.0)) { return sd_dev_deck(p); }
    if (dev_is(3.0)) { return sd_dev_stand(p); }
    return 1e9;
}

float sd_device(float3 p)
{
    return min(sd_dev_body(p), sd_dev_extra(p));
}

// Le modèle PLEIN, écran compris : ce que l'ombre voit.
float sd_dev_solid(float3 p)
{
    return min(sd_dev_slab(p), sd_dev_extra(p));
}

float3 device_normal(float3 p)
{
    const float e = 0.0006;
    return normalize(float3(1, -1, -1) * sd_device(p + float3(1, -1, -1) * e) +
                     float3(-1, -1, 1) * sd_device(p + float3(-1, -1, 1) * e) +
                     float3(-1, 1, -1) * sd_device(p + float3(-1, 1, -1) * e) +
                     float3(1, 1, 1) * sd_device(p + float3(1, 1, 1) * e));
}

// Couverture d'une SDF 2D adoucie sur un pixel (`aa` = un pixel en unités du modèle).
float dev_cov(float d, float aa)
{
    return saturate(0.5 - d / max(aa, 1e-6));
}

// Filet de lumière d'un pixel, peint juste à l'intérieur d'un contour `d2` (<0 dedans).
float dev_hairline(float d2, float aa)
{
    return dev_cov(abs(d2 + aa) - aa * 0.55, aa);
}

// La matière au point `p`, normale `n` : `.rgb` l'albédo (alpha droit), `.a` = 1 pour le métal
// (qui prend le voile directionnel), 0 pour le verre, qui reste mat.
float4 device_albedo(float3 p, float3 n, float aa)
{
    float3 metal = dev_shell();
    float3 back = dev_shell_back();
    if (sd_dev_body(p) > sd_dev_extra(p))
    {
        if (!dev_is(1.0))
        {
            // Le pied du moniteur : de l'aluminium, un dégradé vertical doux, rien d'imprimé.
            float v = saturate((p.y - dev_body_c().y - dev_body_h().y) / (DEV_NECK_LEN + DEV_FOOT_H));
            return float4(lerp(metal, back, 0.15 + 0.45 * v), 1.0);
        }
        float3 q = dev_deck_local(p);
        float hw = dev_body_h().x;
        float y0 = DEV_DECK_GAP;
        float len = DEV_DECK_LEN;
        // La tranche AVANT : tout ce que la caméra droite voit du socle, une barre d'argent qui
        // fonce doucement vers son arête basse.
        if (q.y > y0 + len - DEV_CHAMFER * 3.0)
        {
            float s = saturate(-q.z / DEV_DECK_THICK_FRONT);
            return float4(lerp(metal, back, smoothstep(0.35, 1.0, s) * 0.8), 1.0);
        }
        // Le dessous.
        if (q.z < -DEV_DECK_THICK * 0.25) { return float4(back, 1.0); }
        // Le dessus : clavier et pavé tactile, creusés d'un ton dans l'aluminium, avec le même
        // filet de lumière que les arêtes — c'est lui qui dit « fraisé » et non « peint ». Vus
        // seulement quand la caméra tourne : de face, le socle est vu par la tranche.
        float3 top = metal;
        // Clavier : 0,75 de la largeur du socle, de 0,10 à 0,56 de sa profondeur.
        float key = sd_round_rect(q.xy - float2(0.0, y0 + len * 0.33),
                                  float2(hw * 0.75, len * 0.23), len * 0.02);
        top = lerp(top, metal * 0.52, dev_cov(key, aa));
        top = lerp(top, metal * 1.06, dev_hairline(key, aa));
        // Pavé tactile, centré dans la moitié avant.
        float pad = sd_round_rect(q.xy - float2(0.0, y0 + len * 0.76),
                                  float2(hw * 0.26, len * 0.14), len * 0.015);
        top = lerp(top, metal * 0.88, dev_cov(pad, aa));
        top = lerp(top, metal * 1.04, dev_hairline(pad, aa));
        return float4(top, 1.0);
    }
    // Le dos et les flancs : l'aluminium, plus sombre quand il tourne le dos à la caméra.
    float3 shell = lerp(back, metal, saturate(n.z * 0.8 + 0.5));
    // La face avant est en z = 0 ; le quart avant du corps suffit à la reconnaître. À mi-épaisseur,
    // la face avant de la colonne du moniteur, qui sort du corps en z = −épaisseur/2, se prenait
    // pour du verre et pointillait la jonction en noir.
    float front = (p.z < -fx.w * 0.25) ? 0.0 : smoothstep(0.30, 0.80, n.z);
    if (front <= 0.0) { return float4(shell, 1.0); }

    // Le liseré d'aluminium qui borde la face avant, et le filet de lumière d'un pixel sur son
    // arête : le verre noir s'arrête à `DEV_RIM` du contour.
    float edge = sd_dev_outline(p.xy);
    float band = 1.0 - dev_cov(edge + DEV_RIM, aa);
    float rim = dev_hairline(edge, aa);

    // La face avant : une dalle de verre noir pour les trois appareils.
    float3 c = dev_glass();
    if (dev_is(2.0))
    {
        // Téléphone : un œil de caméra, rien d'autre — pas de fente de haut-parleur, qui date un
        // téléphone. Au milieu de la lunette du HAUT DU TÉLÉPHONE, pas du métrage : une ouverture
        // paysage est un téléphone COUCHÉ, son haut vers la gauche de l'image. Sa taille est fixe,
        // comme l'épaisseur du corps.
        bool upright = mb.y >= mb.x;
        float2 e = upright ? p.xy : float2(-p.y, p.x);
        float2 hh = upright ? mb.xy : float2(mb.y, mb.x);
        float bez = (upright ? src_prev.y : src_prev.x) - DEV_RIM;
        c = lerp(c, float3(0.086, 0.102, 0.133), dev_cov(length(e - float2(0.0, -hh.y - bez * 0.5)) - 0.003, aa));
    }
    else
    {
        // Portable et moniteur : un œil de caméra centré dans la lunette du haut, seul détail du
        // cadre. Pas d'encoche : c'est la signature d'une marque, l'œil en est l'équivalent neutre.
        float bez = src_prev.y - DEV_RIM;
        c = lerp(c, float3(0.120, 0.133, 0.161), dev_cov(length(p.xy - float2(0.0, -mb.y - bez * 0.5)) - 0.2 * bez, aa));
    }
    c = lerp(c, metal, band);
    c = lerp(c, min(metal * 1.12, 1.0), rim);
    return float4(lerp(shell, c, front), max(band, rim));
}

// L'OMBRE portée de l'appareil (même calque, `dst_prev.w` = pénombre en px) : la silhouette que
// la caméra voit VRAIMENT du modèle, socle et pied compris, là où un quad plat étiré dans le plan
// de l'écran se lisait comme une dalle grise sous le portable. Le décalage de l'ombre est déjà
// dans `src.xy` (`device_shadow_cb`) : le rayon de ce pixel est celui du pixel décalé. On marche
// le modèle PLEIN, écran compris et sans l'arrêt au plan du métrage, et la plus courte approche
// du rayon, en px (distance / empreinte du pixel à cette profondeur), tient lieu de distance au
// contour — nulle dans la silhouette. Même pénombre que le mode 2 : pleine au contour, nulle à
// `spread` px, donc rien au-delà de silhouette + décalage + pénombre. Ce que le plan proche `h_near`
// efface de l'appareil, il l'efface de son ombre.
float4 device_shadow(float3 ro, float3 rd, float fpk, float3 lo, float3 hi, float h_near)
{
    float spread = dst_prev.w;
    // La pénombre en unités, avec de la marge pour ce qui est derrière le plan (le pied), dont
    // les pixels sont plus grands.
    float m = 2.0 * spread / src.w;
    float2 tb = ray_box(ro, rd, lo - m, hi + m);
    if (tb.x >= tb.y || tb.y <= 0.0)
    {
        return float4(0.0, 0.0, 0.0, 0.0);
    }
    // Dans la silhouette pleine, à coup sûr : le rayon perce la face avant ou le socle.
    if (rd.z < -1e-5 && sd_dev_outline((ro + rd * (-ro.z / rd.z)).xy) < 0.0)
    {
        return float4(0.0, 0.0, 0.0, color.a);
    }
    float t_deck = dev_is(1.0) ? dev_deck_hit(ro, rd) : 1e9;
    if (t_deck < 1e9)
    {
        return float4(0.0, 0.0, 0.0, color.a * dev_near_fade(ro + rd * t_deck, h_near));
    }
    float t = max(tb.x, 0.0);
    float best = 1e9;
    float t_best = t;
    [loop] for (int k = 0; k < 96; k++)
    {
        float d = sd_dev_solid(ro + rd * t);
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
    float a = color.a * (1.0 - smoothstep(0.0, spread, best)) * dev_near_fade(ro + rd * t_best, h_near);
    return float4(0.0, 0.0, 0.0, a); // noir prémultiplié
}

float4 device_frame(float2 local)
{
    ModelFrame f;
    f.c = cos(fx.xyz);
    f.s = sin(fx.xyz);
    f.cp = 1.0;
    f.sp = 0.0;
    f.cy = 1.0;
    f.sy = 0.0;
    float persp = src.z;
    float unit = src.w;

    // Le rayon de ce pixel, dans le repère DU PLAN (= celui du modèle, à `unit` près) : caméra en
    // (0, 0, P) du repère caméra, plan translaté de `mb.zw` dans ce même repère.
    float3 dw = float3(local + src.xy, -persp);
    float dlen = length(dw);
    float3 ro = world_to_plane(float3(-mb.z, -mb.w, persp), f) / unit;
    float3 rd = world_to_plane(dw / dlen, f);
    float3 l = world_to_plane(MODEL_LIGHT, f);

    // Le plan proche (`DeviceView::near_plane`) : tiré de la caméra RÉELLE, avant qu'on la recule.
    float h_near = dev_near_plane(ro, world_to_plane(float3(0.0, 0.0, -1.0), f));

    // L'ŒIL DU MODÈLE (`DeviceView::model_eye`). Le plan garde l'objectif des présets — c'est lui
    // qui fait lire l'inclinaison du métrage —, mais cet œil est à 1,6 petit côté du plan : un
    // socle de profondeur réelle (1,3) viendrait à quelques dixièmes de lui, et se projetterait en
    // une dalle plus large que l'image. Le relief du modèle est donc vu d'un œil RECULÉ sur la même
    // droite, à au moins `DEV_EYE_MIN` — la distance d'un bras —, et jamais plus bas que la ligne du
    // centre de l'écran : d'en dessous, le socle, vu par la tranche depuis la caméra droite, montrait
    // sa face inférieure et couvrait le bas du métrage. Chaque rayon passe par le MÊME point du plan
    // que celui de l'objectif : la face écran reste exactement sur le métrage, seul ce qui sort du
    // plan change de perspective. `fpk` = empreinte d'un pixel par unité de distance le long du
    // nouveau rayon (celle du plan, rapportée à sa distance).
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
    float2 bc = dev_body_c();
    float2 bh = dev_body_h();
    float3 lo = float3(bc - bh, -fx.w);
    float3 hi = float3(bc + bh, 0.0);
    if (dev_is(1.0))
    {
        // Les quatre coins du profil du socle, de la charnière au bord avant, dessus et dessous.
        float ca = cos(dev_deck_angle());
        float sa = sin(dev_deck_angle());
        float2 hinge = float2(bc.y + bh.y, -fx.w * 0.5);
        float2 qy = float2(DEV_DECK_GAP, DEV_DECK_GAP + DEV_DECK_LEN);
        float2 qz = float2(0.0, -DEV_DECK_THICK);
        [unroll] for (int j = 0; j < 4; j++)
        {
            float a = qy[j & 1];
            float b = qz[j >> 1];
            float2 yz = hinge + float2(a * ca - b * sa, a * sa + b * ca);
            lo = float3(lo.x, min(lo.yz, yz));
            hi = float3(hi.x, max(hi.yz, yz));
        }
    }
    else if (dev_is(3.0))
    {
        lo = float3(min(lo.x, -DEV_FOOT_W), lo.y, lo.z - DEV_FOOT_Z);
        hi = float3(max(hi.x, DEV_FOOT_W), hi.y + DEV_NECK_LEN + DEV_FOOT_H, hi.z);
    }

    if (dst_prev.w > 0.0)
    {
        return device_shadow(ro, rd, fpk, lo, hi, h_near);
    }

    // Le plan du métrage occulte tout ce qui est derrière lui DANS l'ouverture : la marche s'y
    // arrête. C'est ce qui laisse le mode 8 dessiner le métrage dans le cadre, et ce qui empêche
    // de voir au travers de l'appareil par son ouverture. L'ouverture ARRONDIE, pas son rect :
    // entre l'arc et le coin carré c'est de la lunette, et un rayon arrêté au plan y laissait voir
    // le métrage — ou le fond — dans les coins à Roundness élevé.
    //
    // Hors de l'ouverture, le même point du plan dit si le rayon perce la FACE AVANT ; et le socle
    // a son entrée analytique (`dev_deck_hit`). Ces deux surfaces-là sont connues sans marcher :
    // la marche ne sert qu'à ce qui les précède (arêtes, flancs, pied) et à l'antialiasing du
    // contour. Sans elles, un rayon qui frôle un socle vu par la tranche s'épuisait en pas d'un
    // quart de pixel, et la lunette du bas laissait voir le fond sur une dizaine de pixels.
    float t_max = 1e9;
    float t_solid = 1e9;
    if (rd.z < -1e-5)
    {
        float ts = -ro.z / rd.z;
        float2 qp = ro.xy + rd.xy * ts;
        if (ts > 0.0 && sd_dev_aperture(qp) < 0.0) { t_max = ts; }
        else if (ts > 0.0 && sd_dev_outline(qp) < 0.0) { t_solid = ts; }
    }
    if (dev_is(1.0)) { t_solid = min(t_solid, dev_deck_hit(ro, rd)); }
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
    [loop] for (int k = 0; k < 80; k++)
    {
        float d = sd_device(ro + rd * t);
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
    float3 n = device_normal(q);
    float4 mat = device_albedo(q, n, t_best * fpk);
    float diffuse = saturate(dot(n, l));
    // Aucun lobe spéculaire large : c'est lui qui donnait l'air plastique et gonflé. Rien qu'un
    // voile directionnel étroit sur le métal, et le filet de lumière déjà peint dans l'albédo.
    float sheen = DEV_SHEEN * mat.a * pow(diffuse, 4.0);
    float3 rgb = mat.rgb * (MODEL_AMBIENT + MODEL_DIFFUSE * diffuse) + sheen;
    // Au-delà du plan proche, l'appareil s'efface (le socle, quand la caméra en orbite avance).
    float a = cov * color.a * dev_near_fade(q, h_near);
    return float4(rgb * a, a); // prémultiplié
}

float4 ps_main(VSOut i) : SV_Target
{
    // mode 17 : CADRE D'APPAREIL MODELÉ (cf. `device_frame`). Testé en premier, comme le 16.
    if (mode > 16.5)
    {
        return device_frame(i.local);
    }

    // mode 16 : IMPACT DU CLIC (cf. `cursor_impact`). Testé en premier, comme le mode 15.
    if (mode > 15.5)
    {
        return cursor_impact(i.local);
    }

    // mode 15 : CURSEUR MODÉLISÉ (cf. `cursor_model`). Testé en premier : les branches suivantes
    // n'ont pas de borne haute. dst_prev = rect de clip « Clip to canvas », comme au mode 13.
    if (mode > 14.5)
    {
        if (i.pout.x < dst_prev.x || i.pout.x > dst_prev.x + dst_prev.z ||
            i.pout.y < dst_prev.y || i.pout.y > dst_prev.y + dst_prev.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        return cursor_model(i.local);
    }

    // mode 14 : CADRE DE FENÊTRE autour de l'écran (barre de titre, trois pastilles, filet),
    // dessiné SOUS lui. Testé avant le mode 13, dont la branche n'a pas de borne haute.
    // Même warp que le mode 8 — le cadre est le quad de l'écran prolongé, il penche donc avec
    // lui ; à plat, le quad est un rect et le warp l'identité exacte.
    // fx.xy/fx.zw = coins TL/TR, src_prev.xy/.zw = BR/BL (px locaux) ; dst_prev.xy = taille du
    // cadre dans son plan, dst_prev.z = hauteur de la barre, dst_prev.w = épaisseur du filet
    // (px du plan) ; radius_px = rayon du corps, LES QUATRE COINS (`plan_frame`, « Le rayon des
    // coins ») ; color = fond de la barre, mb = couleur du filet (alpha droit) ; src.x = 1 : warp
    // projectif.
    if (mode > 13.5)
    {
        float3 r = quad_inverse(i.local, fx.xy, fx.zw, src_prev.xy, src_prev.zw, src.x);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du cadre projeté
        }
        float2 plane_px = dst_prev.xy;
        float bar = dst_prev.z;
        float line_w = dst_prev.w;
        float2 q = float2(r.x, r.y) * plane_px; // px du plan depuis le coin haut-gauche
        float2 p = q - plane_px * 0.5;
        // Le MÊME rayon aux quatre coins. Les coins hauts plafonnaient à la hauteur de la barre,
        // parce que le métrage, lui, avait ses coins hauts carrés : deux contours qui ne se
        // suivaient pas, et un haut de fenêtre qui se lisait comme un défaut de tracé. Le métrage
        // est maintenant arrondi partout, donc le cadre peut l'être aussi.
        float rad = max(radius_px, 0.0);
        float d = sd_round_rect(p, plane_px * 0.5, rad);
        float cov = 1.0 - smoothstep(0.0, 1.5, d);
        // Filet intérieur le long du contour, et séparation entre la barre et le contenu.
        float stroke = max(band_cov(-d - line_w * 0.5, line_w * 0.5),
                           band_cov(q.y - (bar - line_w * 0.5), line_w * 0.5));
        float3 rgb = lerp(color.rgb, mb.rgb, stroke * mb.a);
        // Pastilles : proportions d'une barre de 28 px (rayon 6, pas de 20), centrées en hauteur
        // dans la barre. Leur bloc est repoussé du coin d'au moins le rayon PLUS leur propre
        // rayon et une marge : sans ça, l'arrondi mordait la première dès que Roundness montait.
        // Une borne large (l'arc est toujours en deçà du rayon) plutôt qu'une résolution exacte.
        float dr = bar * 0.214;
        float dx = bar * 0.714;
        float x0 = max(dx, rad + dr + bar * 0.18);
        rgb = lerp(rgb, float3(1.000, 0.373, 0.341), disc_cov(q, float2(x0, bar * 0.5), dr));
        rgb = lerp(rgb, float3(0.996, 0.737, 0.180), disc_cov(q, float2(x0 + dx, bar * 0.5), dr));
        rgb = lerp(rgb, float3(0.157, 0.784, 0.251), disc_cov(q, float2(x0 + 2.0 * dx, bar * 0.5), dr));
        float a = cov * color.a;
        return float4(rgb * a, a); // prémultiplié
    }

    // mode 13 : SPRITE DE CURSEUR posé sur l'écran incliné. Même warp que le mode 8, mais
    // échantillonnant la texture du curseur en alpha DROIT (comme le mode 7) au lieu de la
    // vidéo NV12. Le curseur remplace un pointeur qui faisait partie de l'image capturée : il
    // doit donc subir la même inclinaison qu'elle, sinon il se lit comme un autocollant plat
    // collé par-dessus la scène. Corriger sa seule position ne suffisait pas.
    // fx.xy/fx.zw = coins TL/TR (px locaux) ; src_prev.xy/.zw = BR/BL ; dst_prev = rect de clip
    // « Clip to canvas » en espace sortie ; mb.x = 1 : warp projectif.
    // Un mode supérieur doit être testé AVANT cette branche, qui n'a pas de borne haute.
    if (mode > 12.5)
    {
        if (i.pout.x < dst_prev.x || i.pout.x > dst_prev.x + dst_prev.z ||
            i.pout.y < dst_prev.y || i.pout.y > dst_prev.y + dst_prev.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float3 r = quad_inverse(i.local, fx.xy, fx.zw, src_prev.xy, src_prev.zw, mb.x);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du sprite projeté
        }
        float4 s = texImg.Sample(samp, saturate(float2(r.x, r.y)));
        float a = s.a * color.a;
        return float4(s.rgb * a, a);
    }

    // mode 8 : écran tilté en 3D (zoom regions "rotation" : iso/left/right) ou vu par la caméra
    // réelle (`follow-cursor`). `dst`/`quad_px` couvrent la BOUNDING BOX des 4 coins projetés
    // (`frame_geometry::tilted_screen_cb`) ; ce shader retrouve où tombe chaque pixel DANS le quad
    // (warp inverse : bilinéaire sous un angle fixe, projectif exact sous la caméra réelle,
    // dst_prev.w = 1) et échantillonne la vidéo à l'UV correspondant, sinon transparent.
    // fx.xy/fx.zw = coins TL/TR (px locaux, 0..quad_px) ; src_prev.xy/.zw = coins BR/BL.
    // color.xy (caméra réelle) : éclairage 1 + color.x·(s − 0.5) + color.y·(t − 0.5).
    // mb = [gx, gy, z_focus, k] : profondeur du point r du plan = (r.x - 0.5)*gx + (r.y - 0.5)*gy
    // en px, positive vers la caméra ; z_focus = celle du focus du zoom (`TiltedQuad::depth_mb`) ;
    // k = texels source de flou par px d'écart de profondeur (0 = profondeur de champ coupée).
    // t2 (texImg) = pyramide demi-résolution de la vidéo, 5 niveaux, mêmes UV que t0/t1 ; liée
    // explicitement à chaque draw du mode 8 (`draw_video` ne lie que t0/t1).
    // mode 11 : texte d'annotation, rastérisé par Direct2D (voir text.rs). D2D écrit sur une
    // surface DXGI en alpha PRÉMULTIPLIÉ, donc contrairement au mode 7 (sprite curseur, alpha
    // droit) il ne faut SURTOUT pas re-multiplier ici : les bords adoucis des glyphes
    // deviendraient deux fois trop transparents et le texte paraîtrait délavé.
    // `color.a` reste l'opacité globale (fondu d'animation).
    //
    // mode 12 : ombre du quad PROJETÉ. Même pénombre que le mode 2, mais portée par le
    // quadrilatère incliné au lieu d'un rect droit — une ombre droite derrière un écran penché ne
    // se lit pas comme son ombre, mais comme une seconde surface posée derrière. Les coins
    // arrivent dans la même convention que le mode 8 (fx = TL/TR, src_prev = BR/BL, px locaux) ;
    // mb.y = étalement de la pénombre en px.
    if (mode > 11.5)
    {
        float2 quad[5] = { fx.xy, fx.zw, src_prev.xy, src_prev.zw, fx.xy };
        // Coins arrondis du même rayon que le plan (`radius_px`). Une ombre à coins vifs derrière
        // un écran aux coins arrondis dépasse en pointe à chaque coin — visible, et d'autant plus
        // que le rayon monte. On rentre donc chaque arête de `r`, et retrancher `r` à la distance
        // du quadrilatère ainsi obtenu redonne un arrondi exactement tangent aux deux arêtes.
        float r = max(radius_px, 0.0);
        float2 v[4];
        [unroll] for (int k = 0; k < 4; k++)
        {
            // TL→TR→BR→BL tourne dans le sens horaire en y-bas, donc (e.y, -e.x) sort du quad.
            // Division par la longueur plutôt que `normalize` : une arête dégénérée donnerait un
            // NaN qui effacerait l'ombre entière.
            float2 ep = quad[k] - quad[(k + 3) & 3];       // arête précédente
            float2 ec = quad[k + 1] - quad[k];             // arête courante
            float2 np = float2(ep.y, -ep.x) / max(length(ep), 1e-6);
            float2 nc = float2(ec.y, -ec.x) / max(length(ec), 1e-6);
            // Chaque arête rentrée de r : n·x = n·a - r. Leur intersection est le coin rentré.
            v[k] = line_cross(np, dot(quad[(k + 3) & 3], np) - r, nc, dot(quad[k], nc) - r);
        }
        float d = sd_convex_quad(i.local, v[0], v[1], v[2], v[3]) - r;
        float spread = max(mb.y, 1e-3);
        float a = color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(color.rgb * a, a);
    }

    if (mode > 10.5)
    {
        float4 s = texImg.Sample(samp, i.uv);
        return s * color.a;
    }

    // mode 10 : annotation « flou » — masque la zone en réutilisant l'image DÉJÀ composée, qui
    // arrive dans `texImg` (recopie du render target : on ne peut pas échantillonner la cible sur
    // laquelle on dessine). `i.pout` donne directement l'UV de sortie, donc aucun mapping à
    // refaire. fx.x = 0 mosaïque / 1 flou ; fx.y = taille de bloc px (mosaïque) ou rayon px
    // (flou) ; fx.z = 0 rectangle / 1 ovale ; fx.w = 1 si le masque doit être teinté ;
    // mb.z = 1 si le masque est un quad incliné (coins TL, TR dans dst_prev, BR, BL dans src_prev),
    // mb.w = 1 si son warp est projectif.
    if (mode > 9.5)
    {
        // Masque de forme, en coords locales normalisées du quad.
        float2 n = i.local / max(quad_px, 1e-6);
        // Écran incliné (mb.z = 1) : le masque est le quad dst_prev = TL, TR / src_prev = BR, BL,
        // warpé comme le contenu qu'il cache (`FrameGeometry::privacy_mask`), par le même inverse
        // que le mode 8. Bord net, marge de 2 % comprise : un fondu rendrait le masque en partie
        // transparent SUR la zone à cacher.
        if (mb.z > 0.5)
        {
            float3 w = quad_inverse(i.local, dst_prev.xy, dst_prev.zw, src_prev.xy, src_prev.zw, mb.w);
            if (w.z < 0.5)
            {
                return float4(0.0, 0.0, 0.0, 0.0);
            }
            n = w.xy;
        }
        float cov = 1.0;
        if (fx.z > 0.5)
        {
            // Ovale inscrit : distance au centre en unités de demi-axes, adoucie sur ~1px. Le
            // fondu tombe HORS de l'ellipse : dedans, le masque reste plein.
            float2 d = (n - 0.5) * 2.0;
            float r = length(d);
            float aa = 2.0 / max(min(quad_px.x, quad_px.y), 1.0);
            cov = 1.0 - smoothstep(1.0, 1.0 + aa, r);
        }
        if (cov <= 0.0) return float4(0.0, 0.0, 0.0, 0.0);

        float3 rgb;
        if (fx.x > 0.5)
        {
            // Flou : on échantillonne un niveau de mip de l'image composée. `log2(rayon)` donne
            // le niveau dont un texel couvre à peu près le rayon demandé, et le filtrage
            // trilinéaire lisse la transition entre deux niveaux quand le rayon varie.
            //
            // Un noyau de quelques taps espacés du rayon ne floute PAS : il superpose autant de
            // copies décalées, ce qui se voit comme du texte fantôme. Atteindre un vrai lissage
            // par taps demanderait un tap par pixel de rayon ; la pyramide de mips donne le même
            // résultat à coût constant, et c'est le GPU qui l'a construite.
            float lod = log2(max(fx.y, 1.0));
            rgb = texImg.SampleLevel(samp, i.pout, lod).rgb;
        }
        else
        {
            // Mosaïque : on quantifie l'UV sur une grille de `fx.y` px, alignée sur le quad pour
            // que les blocs ne rampent pas quand l'annotation bouge.
            float2 px_uv = dst.zw / max(quad_px, 1e-6);
            float2 block = max(fx.y, 1.0) * px_uv;
            float2 origin = dst.xy;
            float2 q = origin + (floor((i.pout - origin) / block) + 0.5) * block;
            // `SampleLevel(..., 0)` et non `Sample` : l'UV quantifié est une marche d'escalier,
            // donc ses dérivées explosent en bord de bloc et le choix automatique de mip
            // ramollirait justement les arêtes qui font la mosaïque.
            rgb = texImg.SampleLevel(samp, q, 0.0).rgb;
        }

        if (fx.w > 0.5)
        {
            // Teinte blanc/noir : la couleur choisie, mêlée à moitié, garde la forme lisible sans
            // effacer complètement ce qu'il y a dessous.
            rgb = lerp(rgb, color.rgb, 0.5);
        }
        float a = cov * color.a;
        return float4(rgb * a, a); // prémultiplié
    }

    // mode 9 : annotation « figure » — une flèche. Parité EXACTE avec `ArrowSvgs.tsx`, dont
    // chaque direction est un tracé de trois segments à bouts ronds dans un viewBox 0..100 :
    // une hampe et deux barbes. Trois `sd_segment` et un `min` reproduisent donc la forme telle
    // quelle, pas une approximation. Les extrémités arrivent déjà converties en px locaux du
    // quad (échelle uniforme centrée, comme le `preserveAspectRatio` par défaut du SVG).
    // fx = hampe (a.xy, b.xy), src_prev = barbe 1, dst_prev = barbe 2 ; mb.y = demi-épaisseur px.
    if (mode > 8.5)
    {
        float d = sd_segment(i.local, fx.xy, fx.zw);
        d = min(d, sd_segment(i.local, src_prev.xy, src_prev.zw));
        d = min(d, sd_segment(i.local, dst_prev.xy, dst_prev.zw));
        // Couverture sur ~1 px : le trait reste net sans crénelage, et une flèche fine ne
        // disparaît pas quand la demi-épaisseur descend sous le pixel.
        float a = saturate(mb.y - d + 0.5) * color.a;
        return float4(color.rgb * a, a); // prémultiplié, comme tous les autres modes
    }

    if (mode > 7.5)
    {
        float3 r = quad_inverse(i.local, fx.xy, fx.zw, src_prev.xy, src_prev.zw, dst_prev.w);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du quad projeté
        }
        float2 uv = float2(lerp(src.x, src.z, saturate(r.x)), lerp(src.y, src.w, saturate(r.y)));
        // Coins arrondis DANS LE REPÈRE DU PLAN (`dst_prev.xy` = sa taille avant projection) :
        // le rayon reste constant le long du bord, alors qu'un arrondi calculé dans la bbox
        // s'étirerait avec la perspective. Sans cet arrondi, un écran penché a des arêtes de
        // couteau qui coupent le contenu en pleine phrase, et ça se lit comme une troncature
        // plutôt que comme une inclinaison.
        //
        // Inconditionnel, rayon 0 COMPRIS : `sd_round_rect` dégénère alors en SDF de rectangle et
        // le feather de 1.5 px subsiste, ce qui est précisément ce qui fait lire une arête inclinée
        // comme une arête. Sous l'ancienne garde `radius_px > 0`, un slider Roundness à 0 laissait
        // la couverture du plan au seul test binaire `r.z < 0.5` ci-dessus : des marches d'escalier
        // en escalier franc, soit la troncature même que cette branche existe pour éviter (d'où le
        // symptôme « le tilt 3D est tronqué, mais pas au-dessus d'un certain arrondi »). L'ombre du
        // mode 12 applique déjà son `max(radius_px, 0.0)` sans garde, pour la même raison.
        // dst_prev.z = 1 : écran sous le chrome de fenêtre, coins HAUTS carrés et rognés par
        // l'arc du cadre (`sd_screen_under_bar`, `color.z` = la remontée, px du plan).
        float2 plane_px = dst_prev.xy;
        float2 p = float2(r.x, r.y) * plane_px - plane_px * 0.5;
        float rad = max(radius_px, 0.0);
        float d = (dst_prev.z > 0.5) ? sd_screen_under_bar(p, plane_px * 0.5, rad, color.z)
                                     : sd_round_rect(p, plane_px * 0.5, rad);
        float tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        // Profondeur de champ : cercle de confusion en texels source, nul au focus du zoom.
        // Sous un demi-texel, l'échantillon net d'avant, à l'octet : le texte net ne passe
        // jamais par le RGBA de la pyramide, et `k = 0` (réglage coupé) ne quitte jamais cette
        // voie. Au-delà, fondu vers la pyramide demi-résolution (t2) au niveau `log2(coc) - 1`
        // (son niveau 0 est déjà une moyenne 2x2), plafonné à DOF_MAX_LOD : au niveau 2, un
        // bloc 4x4 soude les jambages d'un « m » en 1080p.
        float3 rgb = sample_yuv(uv);
        float2 rs = saturate(float2(r.x, r.y));
        float z = (rs.x - 0.5) * mb.x + (rs.y - 0.5) * mb.y;
        float coc = mb.w * abs(z - mb.z);
        if (coc > 0.5)
        {
            float lod = clamp(log2(coc) - 1.0, 0.0, DOF_MAX_LOD);
            float3 far_rgb = texImg.SampleLevel(samp, uv, lod).rgb;
            rgb = lerp(rgb, far_rgb, saturate((coc - 0.5) / 1.5));
        }
        if (dst_prev.w > 0.5)
        {
            // La lampe de la caméra réelle : le côté proche un peu plus clair.
            rgb = saturate(rgb * (1.0 + color.x * (rs.x - 0.5) + color.y * (rs.y - 0.5)));
        }
        return float4(rgb * tilt_a, tilt_a); // prémultiplié, comme les autres modes
    }

    // mode 7 : sprite curseur thème (PNG alpha droite, arrow.png etc.). Prémultiplie ici
    // (le blend state attend du prémultiplié partout ailleurs). fx = rect de clip "Clip to
    // canvas" en espace sortie 0..1 [x,y,w,h] (= s_dst quand actif, sinon un rect englobant
    // tout -> aucun effet).
    if (mode > 6.5)
    {
        if (i.pout.x < fx.x || i.pout.x > fx.x + fx.z || i.pout.y < fx.y || i.pout.y > fx.y + fx.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float4 s = texImg.Sample(samp, i.uv);
        float a = s.a * color.a; // color.a = opacité globale (fade éventuel)
        return float4(s.rgb * a, a);
    }

    // mode 6 : wallpaper image RGBA (cover-fit). src = rect uv déjà calculé (crop de
    // recouvrement), i.uv l'interpole. Opaque.
    if (mode > 5.5)
    {
        float a = quad_round_alpha(i.local, quad_px, radius_px);
        return float4(texImg.Sample(samp, i.uv).rgb * a, a); // prémultiplié
    }

    // mode 5 : gradient linéaire 2 stops (parité web wallpaper dégradé). color = stop0,
    // src.xyz = stop1, fx.xy = direction unitaire (espace sortie, y vers le bas). t est
    // normalisé coin-à-coin (dénominateur = |dx|+|dy|) pour couvrir toute la diagonale.
    // Fond animé : fx.z = temps programme (s, replié sur 120), fx.w = mouvement (0 immobile,
    // 1 dérive, 2 aurore, 3 vagues), mb.x = aspect w/h. 0 rend le dégradé d'avant à l'octet.
    if (mode > 4.5)
    {
        float2 dir = fx.xy;
        if (fx.w > 0.5 && fx.w < 1.5)
        {
            // Dérive : l'axe respire de ±15° (0.2617994 rad) en 20 s.
            float da = 0.2617994 * sin(6.2831853 * fx.z / 20.0);
            float sa = sin(da);
            float ca = cos(da);
            dir = float2(dir.x * ca - dir.y * sa, dir.x * sa + dir.y * ca);
        }
        float denom = max(abs(dir.x) + abs(dir.y), 1e-4);
        // Paramétré sur le QUAD dès qu'il en a un (la bulle webcam), sinon sur la sortie. Pour le
        // fond plein cadre les deux coïncident ; pour une bulle dans un coin, `pout` ne montrerait
        // que la tranche du dégradé plein cadre qui passe dessous, jamais la rampe complète que
        // le sélecteur affiche.
        float2 gp = (quad_px.x > 0.0 && quad_px.y > 0.0) ? (i.local / quad_px) : i.pout;
        float t = saturate(0.5 + dot(gp - 0.5, dir) / denom);
        float3 g = lerp(color.rgb, src.xyz, t);
        if (fx.w > 1.5)
        {
            g = gradient_motion(gp, dir, denom, color.rgb, src.xyz, fx.z, fx.w, mb.x);
        }
        float a = quad_round_alpha(i.local, quad_px, radius_px);
        return float4(g * a, a); // prémultiplié
    }

    // mode 4 : curseur custom (dot + ring, dessiné depuis les maths). color = teinte.
    // fx = rect de clip "Clip to canvas" (mêmes conventions que le mode 7 ci-dessus).
    if (mode > 3.5)
    {
        if (i.pout.x < fx.x || i.pout.x > fx.x + fx.z || i.pout.y < fx.y || i.pout.y > fx.y + fx.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float2 p = i.local - quad_px * 0.5;
        float r = length(p);
        float R = quad_px.x * 0.5;
        float aa = 1.5;
        float dot_r = R * 0.34;
        float ring_r = R * 0.72;
        float ring_w = R * 0.09;
        float dot = 1.0 - smoothstep(dot_r - aa, dot_r + aa, r);
        float ring = smoothstep(ring_r - ring_w - aa, ring_r - ring_w, r)
                   * (1.0 - smoothstep(ring_r + ring_w, ring_r + ring_w + aa, r));
        // liseré sombre fin sous le dot pour le contraste sur fond clair
        float halo = (1.0 - smoothstep(dot_r + aa, dot_r + aa + 2.5, r)) * (1.0 - dot);
        float a = saturate(dot + ring) * color.a;
        float3 rgb = color.rgb * (dot + ring) + float3(0, 0, 0) * halo;
        a = saturate(a + halo * 0.35 * color.a);
        return float4(rgb * a, a);
    }

    // mode 2 : ombre portée (§7 E4). Pénombre douce dérivée de la SDF du quad source,
    // qui est inséré à l'intérieur du quad d'ombre (élargi de `spread` de chaque côté).
    if (mode > 1.5)
    {
        // `quad_px`/`spread` sont en px de SORTIE : le render target porte la géométrie de
        // sortie, donc aucune pré-déformation n'est nécessaire. (Historiquement le canvas
        // était figé en 16:9 et étiré en fin de pipeline, d'où un facteur anisotrope transporté
        // dans `mb.yz` que ce shader devait annuler — le halo ressortait elliptique sans lui.)
        float spread = fx.x;
        float2 halfsz = quad_px * 0.5 - spread;
        float2 p = i.local - quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, radius_px);
        float a = color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(color.rgb * a, a);
    }

    float3 rgb;
    // 1 sauf en mode detourage, ou il porte le masque du sujet (cf. la branche fx.z ci-dessous).
    float alpha_mask = 1.0;
    if (mode < 0.5)
    {
        // flou de mouvement par vélocité (§8) : pour CE pixel sortie, uv à la frame
        // précédente = même pixel remappé par (dst_prev, src_prev). On floute le long
        // de uv_prev->uv_now (capture translation ET zoom). Early-out si immobile.
        float2 uv_now = i.uv;
        float2 localp = (i.pout - dst_prev.xy) / dst_prev.zw;
        float2 uv_prev = src_prev.xy + localp * (src_prev.zw - src_prev.xy);
        float2 duv = uv_now - uv_prev;
        float mb_scale = saturate(mb.y);
        float2 duv_blur = duv * mb_scale;
        int taps = (int) mb.x;
        if (taps <= 1 || mb_scale <= 0.001 || dot(duv_blur, duv_blur) < 1e-9)
        {
            rgb = sample_yuv(uv_now);
        }
        else
        {
            float3 acc = 0.0;
            [loop] for (int k = 0; k < 16; k++)
            {
                if (k >= taps) break;
                float t = (float) k / (float) (taps - 1);
                acc += sample_yuv(uv_now - duv_blur * (1.0 - t));
            }
            rgb = acc / (float) taps;
        }

        // Effet d'arriere-plan webcam. fx.z : 1 = detourage, 2 = flou, 3 = fond personnalise.
        // `color` porte la couleur de fond du mode 3, fx.w l'intensite du flou du mode 2.
        // fx.xy porte l'etendue VALIDE de la texture webcam (wcw/wtw, wch/wth) : le masque a
        // ete produit sur la frame ENTIERE, pas sur le sous-rect dessine, pour que le modele
        // ne se fasse pas amputer le sujet par un crop utilisateur. Il faut donc ramener uv,
        // qui vit dans l'espace source, dans cet espace-la.
        // Le masque est absent (texture 1x1 noire) tant que la segmentation n'a pas produit sa
        // premiere frame : `person` vaut alors 0 et le mode 1 rendrait la webcam invisible, donc
        // c'est l'appelant qui ne met fx.z a autre chose que 0 qu'une fois un masque disponible.
        float effect = fx.z;
        if (effect > 0.5)
        {
            float2 mask_uv = uv_now / max(fx.xy, 1e-6);
            float person = saturate(texMask.Sample(samp, mask_uv));
            if (effect > 2.5)
            {
                rgb = lerp(color.rgb, rgb, person);
            }
            else if (effect > 1.5)
            {
                rgb = lerp(blur_webcam_bg(uv_now, fx.w, quad_px, i.local), rgb, person);
            }
            else
            {
                alpha_mask = person;
            }
        }
    }
    else
    {
        rgb = color.rgb;
    }

    float alpha = color.a * alpha_mask;
    if (radius_px > 0.0)
    {
        // `quad_px` est en px de SORTIE (le render target porte la géométrie de sortie) et
        // `radius_px` est un rayon réel en px de sortie : la SDF isotrope les compare dans le
        // même espace, le coin est donc rond par construction. (Avant, le canvas figé en 16:9
        // était étiré en fin de pipeline et il fallait pré-déformer par `mb.yz` pour que le
        // cercle ne ressorte pas elliptique.)
        // mb.w = 1 : écran sous le chrome de fenêtre, coins HAUTS carrés et rognés par l'arc du
        // cadre (`sd_screen_under_bar`, `mb.z` = la remontée du contour intérieur, px).
        float2 halfsz = quad_px * 0.5;
        float2 p = i.local - quad_px * 0.5;
        float d = (mb.w > 0.5) ? sd_screen_under_bar(p, halfsz, radius_px, mb.z)
                               : sd_round_rect(p, halfsz, radius_px);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d); // ~1.5px feather (§7 fwidth-like)
    }
    return float4(rgb * alpha, alpha); // prémultiplié
}

// ============ RGB -> NV12 (§5) : deux passes vers les plans d'une texture NV12 ============
// VS plein écran (triangle unique) qui expose l'UV.
struct FSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
FSOut vs_fs(uint vid : SV_VertexID)
{
    FSOut o;
    o.uv = float2((vid << 1) & 2, vid & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

Texture2D<float4> rgbTex : register(t0);
SamplerState sampNV : register(s0);

// BT.709 limited, RGB(0..1) -> Y' et Cb,Cr (inverse de yuv709_limited).
float rgb2y(float3 c)  { return (16.0  + 219.0 * (0.2126*c.r + 0.7152*c.g + 0.0722*c.b)) / 255.0; }
float2 rgb2uv(float3 c)
{
    float yp = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    float cb = (c.b - yp) / 1.8556;
    float cr = (c.r - yp) / 1.5748;
    return (128.0 + 224.0 * float2(cb, cr)) / 255.0;
}

float ps_y(FSOut i) : SV_Target   // plan Y (R8), pleine résolution
{
    return rgb2y(rgbTex.Sample(sampNV, i.uv).rgb);
}
float2 ps_uv(FSOut i) : SV_Target // plan UV (R8G8), demi-résolution (bilinéaire moyenne)
{
    return rgb2uv(rgbTex.Sample(sampNV, i.uv).rgb);
}

// ============ Flou gaussien séparable (§7 E3) ============
// fx.x = sigma (px), fx.y = pas de texel (1/dim), fx.zw = direction (1,0)|(0,1).
#define BLUR_R 24
float4 ps_blur(FSOut i) : SV_Target
{
    float sigma = max(fx.x, 0.001);
    float2 step = fx.y * fx.zw;
    float4 acc = 0.0;
    float wsum = 0.0;
    [unroll]
    for (int k = -BLUR_R; k <= BLUR_R; k++)
    {
        float w = exp(-0.5 * (k * k) / (sigma * sigma));
        acc += rgbTex.Sample(sampNV, i.uv + k * step) * w;
        wsum += w;
    }
    return acc / wsum;
}
// simple copie/échantillonnage d'une texture RGBA (pour redessiner le fond flouté)
float4 ps_tex(FSOut i) : SV_Target { return rgbTex.Sample(sampNV, i.uv); }

// ============ Dual-Kawase (fond flouté rapide) ============
// fx.xy = texel de la texture SOURCE (1/w, 1/h), fx.z = offset. 5 taps (down) / 8 taps (up),
// bilinéaires, à résolution décroissante -> bien moins de samples qu'un gaussien large.
float4 ps_kawase_down(FSOut i) : SV_Target
{
    float2 hp = fx.xy * 0.5 * fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.Sample(sampNV, uv) * 4.0;
    s += rgbTex.Sample(sampNV, uv - hp);
    s += rgbTex.Sample(sampNV, uv + hp);
    s += rgbTex.Sample(sampNV, uv + float2(hp.x, -hp.y));
    s += rgbTex.Sample(sampNV, uv - float2(hp.x, -hp.y));
    return s / 8.0;
}
float4 ps_kawase_up(FSOut i) : SV_Target
{
    float2 hp = fx.xy * 0.5 * fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.Sample(sampNV, uv + float2(-hp.x * 2.0, 0.0));
    s += rgbTex.Sample(sampNV, uv + float2(-hp.x, hp.y)) * 2.0;
    s += rgbTex.Sample(sampNV, uv + float2(0.0, hp.y * 2.0));
    s += rgbTex.Sample(sampNV, uv + float2(hp.x, hp.y)) * 2.0;
    s += rgbTex.Sample(sampNV, uv + float2(hp.x * 2.0, 0.0));
    s += rgbTex.Sample(sampNV, uv + float2(hp.x, -hp.y)) * 2.0;
    s += rgbTex.Sample(sampNV, uv + float2(0.0, -hp.y * 2.0));
    s += rgbTex.Sample(sampNV, uv + float2(-hp.x, -hp.y)) * 2.0;
    return s / 12.0;
}
