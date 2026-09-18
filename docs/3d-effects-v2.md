# 3D effects — v2 : mouvement de caméra et curseur modélisé

Suite de `spec-3d.md` (PR 1 → 5b, toutes ouvertes). Deux demandes :

1. **plusieurs caméras 3D**, dont une où l'orientation suit la **position** du curseur ;
2. un **curseur modélisé** en vraie 3D — hauteur au-dessus du plan, ombre portée, contact au
   clic, orientation vers le point cliqué — d'abord la flèche du thème par défaut, puis tous
   ses états (main, I, redimensionnements…).

Ce document tranche les décisions que la v1 laissait ouvertes et découpe les PR.

---

## A. Le mouvement de caméra

### A.1 Ce qui existe

Un zoom porte **une attitude figée** (`rotationPreset` : `iso`, `left`, `right`), animée par
deux effets qui partagent un unique budget d'angle dynamique (`DYNAMIC_TILT_BUDGET`
= ±1,9° X, ±3,0° Y, 0° Z, `clamp_dynamic_tilt`) :

- **la parallaxe** (`dynamic_tilt`, PR 1) : pilotée par la **vitesse** lissée du curseur ;
- **l'impact du clic** (PR 2b) : piloté par la **position** du clic, `regions::tap`.

`rotated_quad_corners_px(w, h, base, dyn)` projette les coins ; l'échelle de containment est
calculée sur la **base seule** (« échelle gelée »), la part dynamique ne fait que reprojeter.

### A.2 Le modèle : une seule liste « caméra 3D »

**Révisé trois fois après test produit.** La première version séparait l'attitude
(`rotationPreset`) du mouvement (`cameraMotion` : `still`, `sway`, `follow`, `flip`) ; la
deuxième fusionnait tout en un sélecteur avec trois caméras mobiles (`follow-cursor`,
`swing-clicks`, `orbit`) qui faisaient tourner **l'écran** sur un chemin de poses à roulis
permanent (5,5 à 8,5°). Rejetées : « pour chacune, le métrage est de travers ». La troisième,
une caméra pan-tilt-zoom sur un œil fixe, paraissait figée. Il reste **un** champ,
`rotationPreset`, et **un** sélecteur « 3D camera » : les trois angles fixes et **une** caméra
mobile, qui tourne autour de l'écran.

| groupe | valeur | libellé (EN) | ce que ça fait |
|---|---|---|---|
| — | absent | Off | écran droit |
| Angle fixe | `iso` | Angled from above | tourné vers la gauche, plongée marquée |
| Angle fixe | `left` | Turned left | tourné vers la gauche |
| Angle fixe | `right` | Turned right | tourné vers la droite |
| Caméra mobile | `follow-cursor` | Orbits with the cursor | l'écran est immobile, une vraie caméra tourne autour de lui avec le curseur |

`swing-clicks` et `orbit` sont retirés (jamais livrés). La caméra mobile qui reste est l'orbite
ci-dessous, sous l'identifiant `follow-cursor`. Un projet qui les porte encore s'ouvre à plat
(valeur inconnue).

Les trois angles fixes gardent leurs valeurs et leur rendu **à l'octet** (vérifié contre le
commit de base : présets, cadre, flou de confidentialité, profondeur de champ, parallaxe, impact
du clic, flèche modélisée), avec la parallaxe de vitesse et l'impact du clic.

« Turned right » veut dire que la face de l'écran regarde vers la droite : le bord droit
recule. C'est ce que fait `right` [−8, 16, 1] depuis toujours.

### A.3 `follow-cursor` : une caméra en orbite

`crates/compositor/src/camera.rs`. **L'écran ne bouge pas** : c'est le plan z = 0 du monde, en
px de sa boîte. **L'œil tourne autour de lui** sur une sphère et regarde toujours son point visé.

**Pourquoi une orbite.** La version précédente (pan-tilt-zoom : œil fixe, objectif de 12°, la
caméra pivotait sur place) a été jugée « encore plus figée ». Depuis un œil fixe, tourner la caméra
n'est presque qu'un pan à plat : l'angle sous lequel on voit l'écran change à peine. L'orientation
ne se lit que si l'œil se déplace autour de l'écran.

- **Orientation** : `lookAt` à haut fixe, lacet = −azimut, tangage = −élévation. **Roulis nul par
  construction** : l'axe horizontal de l'image reste horizontal dans le monde, et une verticale qui
  passe par le point visé reste verticale. Mesuré au pixel sur le rendu D3D11 : pente interpolée à
  l'axe ≤ 0,013° sur cinq poses, les autres verticales convergeant comme la projection le prévoit
  (écart ≤ 0,03°).
- **Azimut** : ±22° quand le pointeur touche le bord gauche ou droit de l'image source recadrée.
  Pointeur à droite, l'œil passe à droite : le côté droit de l'écran vient vers nous.
- **Élévation** : 4° au repos, ±12° quand le pointeur touche le haut ou le bas. Pointeur en haut,
  la caméra monte et plonge sur le haut de l'écran. L'élévation de repos fait converger les bords
  verticaux : l'écran ne se tient jamais parfaitement droit au milieu de son orbite.
- **Objectif** : celui des angles fixes, distance `P = 1,6 × min(w, h)` (~35° sur le petit côté).
- **Zoom** : moitié travelling, moitié focale (distance divisée par `√zoom`). Un zoom purement
  optique aplatissait la perspective de la vue ; un travelling complet tournait au grand-angle.
- **Cadrage au zoom 1** : le point visé est décalé pour que l'écran soit centré dans sa boîte vu de
  biais (le côté proche grandit, le lointain rétrécit), et la focale est réduite pour qu'il tienne
  dans sa boîte depuis **toute l'enveloppe** de l'orbite. Ce containment ne dépend que du ratio de
  la boîte et du poids : un par région, l'écran ne respire pas. 16:9 : 0,83 (centré) au lieu de 0,77
  (sans centrage) ; au plus près, l'écran passe à 0,7 px du bord de sa boîte. Au repos, il en occupe
  85 % × 83 %.
- **Cadrage au zoom** : le centrage et le containment s'effacent linéairement jusqu'au zoom 2. Au
  delà, le point visé tombe au centre de l'image, grossi exactement du zoom. Le point visé reste dans
  `0,5 ± max(0, 0,5 − 0,55/max(zoom, 1))`, comme avant : au centre au zoom 1.
- **Force 0** = le rendu plat, par le même chemin (mode 0).

**Le cadreur** (`camera::follow`), pure fonction de `t`, sans zone morte : le pointeur, lu dans
l'image source recadrée et borné à l'écran et à la fenêtre du clip, est convolué avec la réponse
impulsionnelle d'un ressort critique, `h(τ) = ω²·τ·e^(−ωτ)`, ω = 5 rad/s, sur 2 s de piste
(120 lectures), avancée de 0,25 s.

- Deux sorties : le pointeur lissé (**orbite**, sur tout l'écran) et le même borné avant lissage à
  la portée du zoom (**point visé**).
- Mesuré : un saut du pointeur est posé à 95 % 0,69 s après lui, sans dépassement, et la caméra
  part avant lui. Coût : ~27 µs par frame en debug, identique à 3 s et à 59 s de région (la caméra elle-même :
  ~22 µs, containment compris) (le cadreur
  d'avant rejouait toute la région : ~5 ms pour une minute).
- Sur la vidéo de revue (8 s, zoom 1 puis 1,8) : azimut de −16° à +15°, élévation de −5° à +14°,
  au plus 1,8° d'azimut et 68 px de déplacement du centre par image à 30 i/s.

Sans piste (curseur masqué : l'export ne la charge pas), la caméra vise le centre, au repos.

**Ce qui suit la caméra** : l'écran (mode 8), son ombre (mode 12), le cadre de fenêtre (mode 14),
le curseur plat (mode 13) et modélisé (mode 15), le flou de confidentialité (mode 10) et la
profondeur de champ. La mise au point suit le **pointeur lissé**, pas le point visé : celui-ci reste
au centre au zoom 1 et bute sur sa portée au zoom, alors que le spectateur regarde le pointeur.
L'ombre de l'écran tombe le long de la lumière de la flèche modélisée (haut-gauche). Une lampe posée
sur la caméra éclaire un peu plus le côté proche : gain 0,2, soit ±4 % d'un bord à l'autre à 22°
d'azimut (`CAMERA_LIGHT_GAIN`, 0,5 donnait ±10 % avec l'œil en orbite).

**Impact du clic** : l'écran reste immobile, c'est **l'œil qui recule** de 4 % de sa distance au
contact, sur la courbe `tap()` de l'impact des angles fixes (mêmes clics, mêmes portes : fenêtre du
clip, clic visible, masque, vitesse, opacité du curseur), puis revient avec un léger rebond. Sur la
vidéo, l'écran perd 2 à 3 % de taille pendant deux images : un tapotement, pas un saut. Le panneau
l'active sous cette caméra, avec sa propre description.

Chaînée à un angle fixe, une région `follow-cursor` ne mélange jamais les deux modèles : la
transition passe par l'écran droit à mi-course. Entre deux régions `follow-cursor`, le cadreur ne
dépend pas de la région : l'orbite continue sans à-coup pendant que le zoom change.

**Rendu exact.** Le warp bilinéaire des angles fixes s'écarte de la projection de cette caméra de
plusieurs centaines de px au pire pixel visible (703 px sur l'enveloppe, 264 px sur la grille
rendue). Les modes 8, 10, 13 et 14 prennent donc un warp
**projectif** exact sous cette caméra : l'homographie des quatre coins (forme de Heckbert) résolue à
l'envers dans le shader, drapeau par mode (`TiltedQuad::warp_flag` : `dst_prev.w` au mode 8, `mb.w`
au 10, `mb.x` au 13, `src.x` au 14). Mesuré sur une grille rendue par D3D11, caméra tournée vers un
coin au zoom 2,2 : 0,07 px d'écart à la projection. `TiltedQuad` porte la caméra complète :
rotation (tangage X, lacet Y), distance `P` et translation de l'image du centre de l'écran
(`offset`). Cette convention décrit n'importe quel œil sans roulis : l'orbite n'a rien changé aux
shaders ni aux emplacements du mode 15.

**Ce qui penche.** La règle des 2° est relâchée pour cette caméra : une arête peut croiser un axe
pendant que l'œil passe, jamais par roulis. Au repos, pointeur au milieu, aucun bord vertical visible
n'est droit (élévation de repos). La pente du contenu au centre de la vue,
`atan(tan(azimut)·sin(élévation))`, atteint 6,35° quand l'œil est dans un coin de l'orbite (pointeur
en haut à droite) : c'est la perspective d'un vrai plan vu de trois quarts, et le prix des grands
angles demandés. Au zoom, la vue garde la fuite du zoom 1 : le texte converge nettement vers le côté
lointain.

### A.3.1 Ce qui clochait avant

- **Les caméras mobiles sur l'écran tournant** (`camera_pose`) : le roulis que la règle des 2°
  imposait pour relier `left` à `right` rendait tout le métrage de travers.
- **La caméra pan-tilt-zoom** : œil fixe et objectif long, elle pivotait sans que l'angle de vue sur
  l'écran change ; avec sa zone morte de 45 %, elle paraissait figée.
- **`flip` clignotait en focus auto** : le seuil était le centre de la coupe zoomée, que le focus
  auto place sur le curseur lissé. Le côté se jouait au bruit flottant : 44 bascules miroir en
  6 s sur une dérive lente (mesuré avant suppression).
- **`follow` ne faisait rien en focus auto** (même cause), et plafonnait au budget dynamique
  (±1,9° / ±3°) en manuel : à peine visible.
- **`still` et `sway` indiscernables** : la parallaxe d'une dérive lente culmine à ~1,2°.
- **Réglage mort sans curseur** : curseur masqué, aucune piste à l'export. Le sélecteur l'écrit
  sous la liste.

### A.4 Ce qui n'est pas livré ici

- **`swing-clicks`** : à refaire sur `camera.rs`, l'orbite en donne la mécanique.
- **`dolly`** (vertigo) : la distance de l'œil par frame, que `TiltedQuad::perspective` sait
  déjà transporter.
- **Flou de mouvement sous la caméra** : le mode 8 n'en a pas. Le lissage borne le mouvement (voir
  les mesures ci-dessus), sans limite de vitesse explicite.
- **Lumière du curseur modélisé** : elle reste fixée à la caméra ; l'œil en orbite la déplace avec
  lui. À fixer au monde avec le propriétaire du mode 15.

### A.5 Portée TS

Le natif porte la preview **et** l'export (`sceneDescription` → `scene.rs`). Le seul autre
consommateur de l'attitude est `getRotation3D` (`types.ts`), lu par
`computeRotation3DContainScale` via `zoomRegionUtils` — la preview CSS (`VirtualPreview.tsx`) ne
porte **aucun** tilt. Pour `follow-cursor`, `getRotation3D` rend la pose de repos de l'orbite
(X = −4° : caméra 4° au-dessus, le bord haut vient vers nous) : le chemin canvas n'a ni la piste ni
la caméra.

---

## B. Le curseur modélisé

### B.1 Ce qui a été retiré

Deux essais précédents ne modélisaient rien, et ont été retirés sans compatibilité (ils n'ont
jamais atteint `main`) :

- `cursor.volume` (« 3D Depth ») empilait des copies du sprite 2D le long de la normale du plan ;
- `cursor.hover` (« Float Height ») décalait le sprite et posait une tache (mode 12) dessous.

Une carte découpée avec de l'épaisseur n'est pas un objet : pas de face éclairée, pas d'ombre
de sa forme, pas de contact. Un préréglage qui porte encore ces clés se lit toujours (les clés
inconnues sont ignorées).

### B.2 Le réglage

**Un seul interrupteur**, `cursor.model3d` (« 3D cursor », **éteint par défaut**) : il remplace
**chaque état** du thème par défaut (les seize de `DEFAULT_CURSOR_SPRITES` : flèche, I, main,
croix, mains ouverte et fermée, redimensionnements, déplacement, interdit, attente…) par son
sprite extrudé. Les autres thèmes gardent leur sprite plat ; l'indice du panneau le dit
(« Default style: every cursor shape turns 3D »). Curseur masqué, l'interrupteur est grisé et
son info-bulle dit pourquoi. Éteint, la frame est celle d'avant **à l'octet** (vérifié à plat et
incliné contre le commit de base).

Tuyauterie : `CursorVisualSettings.model3d`, clé legacy `cursorModel3d`, préréglages (absent →
éteint), `SceneCursor.model3d` (`serde(default)`), `LiveParams.cursor_model3d`, paramètre live
`cursorModel3d`. Le contrat de scène ne gagne que ce champ optionnel, sans donnée de sprite
neuve : le modèle se tire du sprite que la scène transporte déjà.

### B.3 Le modèle (mode 15)

Un seul mode de shader, identique en HLSL, MSL et WGSL (`cursor_model`), lancé de rayons par
pixel dans la boîte de dessin. **Aucune forme n'est modélisée à la main** : le modèle est la
silhouette du sprite de l'état courant.

- **Forme** : un champ de distance signé tiré de l'alpha du PNG, une fois au chargement
  (`cursor_sdf.rs`) : alpha suréchantillonné ×4 (bilinéaire), seuil 0,5, transformée de
  distance euclidienne exacte (Felzenszwalb), signée, puis floutée sur deux texels fins (le seuil
  laisse un escalier dont les normales striaient les flancs). Texture **R16F** de la taille du
  sprite ×4, distances en unités du modèle : un demi-flottant est exact au millième près autour
  de zéro et filtrable sur les trois backends, là où le R32F ne l'est pas partout. Hors du rect du
  sprite, le shader prend la borne exacte `√(|p − c|² + max(d(c), 0)²)`, `c` = `p` ramené dans le
  rect. Unité = plus grand côté du sprite (= `size_px`), origine au hotspot de la face du dessus.
  Extrudé de 0,19 unité, chanfrein arrondi de 0,045. Normales par gradient du champ.
- **Liaison** : sprite en t2 / `texture(2)` / binding 1 (`texY`), champ en t4 / `texture(4)` /
  binding 2 (`texU`) sur Windows / macOS / Linux. Le cbuffer porte le coin du sprite
  (`color.rg`), son rapport w/h (`radius_px`) et l'écrasement du clic (`color.b`, cf. B.5). Le
  texel du sprite se tire de la taille du champ (`SDF_UPSAMPLE` / plus grand côté) : même valeur
  au bit près que l'ancien emplacement.
- **Matières** : celles du sprite. Le dessus porte son art (alpha droit, comme aux modes 7 et 13) ;
  le chanfrein, les flancs et le dessous lisent l'art à 1,5 texel à l'intérieur de la silhouette,
  le long du gradient du champ : la couleur du bord de CE sprite (filet blanc de la flèche, trait
  noir des mains), jamais la frange mêlée au transparent. Lumière fixée à la **caméra**
  (haut-gauche, devant), ambiante 0,36, diffuse 0,75, reflet sur les arrondis seulement.
- **Ombre** : un rayon qui rate le modèle tombe sur le plan de l'écran. De là, marche vers la
  lumière (pénombre `k·d/t`, k = 6, bornée à 0,45 unité) et ombre de contact (0,12 unité autour
  du modèle). Opacité 0,5 chacune, et seulement à l'intérieur de l'écran.
- **Silhouette antialiasée** sur un pixel ; sortie prémultipliée, ombre noire.

**Pourquoi pas des SDF hors ligne** (tirés des SVG par le générateur de sprites) : l'option
n'était à prendre que si le champ tiré du PNG arrondissait visiblement la flèche par rapport au
polygone analytique d'avant. Comparés côte à côte (flèche taille 8, à plat et iso, en l'air et
posée), les deux ont le même contour à l'œil ; le champ suit même mieux l'art (la queue du
polygone à 10 sommets était trop courte et trop droite). Sur les seize sprites, le signe du champ
coïncide avec l'alpha seuillé (IoU ≥ 0,9997 hors frange) ; sur un disque et un rectangle
synthétiques, l'écart au champ exact reste sous 0,5 texel source dans la bande de 3 texels autour
du bord (0,48 au pire), sous 1 texel au-delà (le flou arrondit les crêtes).

### B.4 La caméra et l'ancrage

La caméra est reconstruite par pixel exactement comme `regions.rs` projette le plan : rotation
dessinée (`TiltedQuad::rot`, base + dynamique), Z puis Y puis X, perspective `P/(P − z)` avec
`P = TiltedQuad::perspective` (`min(w, h) × 1,6` sous un angle fixe), translation du plan dans le
repère caméra (`TiltedQuad::offset`, en `mb.zw`, nulle sous un angle fixe, cf. A.3), échelle de
containment. Un écran droit prend un plan identité : même caméra, même mode.

Deux décisions :

1. **Le hotspot est sur le rayon de vue** du point de contenu visé, à sa hauteur. Il ne glisse
   donc jamais à l'écran quand le modèle monte ou descend : seule l'ombre dit la hauteur.
2. **Ancrage** : sous un angle fixe, la vidéo est dessinée par un warp **bilinéaire** des coins
   projetés, qui s'écarte de la perspective exacte de quelques pixels. Tout le rendu est décalé
   de `point_px(plane_pt) − projection exacte`, pour que le hotspot tombe sur le pixel que
   l'écran montre. Sous la caméra réelle le warp est exact et ce décalage est nul.

### B.5 La pose (fonction pure de `t`)

`cursor_pose`, puis la part « pointeur » du sprite :

- **Hauteur** : 0,35 unité de garde au repos. Chaque clic le pose **au contact** avec la courbe
  `tap()`, celle de l'impact du clic, dont le creux (49,5 ms) est celui de la pression de
  `bounce()`. Gain 1,25 : posé de 27 à 74 ms, donc au moins une image au contact jusqu'à
  21 i/s. Tous les états.
- **Tangage** : queue relevée, pointe vers le bas, 18° au repos, jusqu'à +10° au creux de la
  pression, fois `clickBounce / 2,5`.
- **Lacet** : vers la vitesse horizontale lissée (`follow_at`, différence centrée sur ±100 ms),
  et vers la cible d'un clic dans les 300 ms qui le précèdent. Borné en douceur à ±25°
  (`tanh`), nul au repos, continu en `t`.
- **Part « pointeur »** (`pointing_factor`), tirée du seul hotspot, sans table par état :
  distance du hotspot au centre du sprite rapportée au demi-côté (norme max), `smoothstep` de
  0,3 à 0,75. Tangage et lacet en sont multipliés. Flèche (0,83), main qui pointe, aide,
  démarrage, flèche haute : 1, la pose de la flèche. I, croix, redimensionnements, déplacement,
  interdit, attente, poing fermé : 0, ni tangage ni lacet (tourner une flèche de
  redimensionnement en change le sens ; basculer une forme autour de son centre en enfoncerait
  la moitié dans le plan). Main ouverte (hotspot au haut de la paume) : 0,86.
- **Point le plus bas** : le hotspot est posé à `garde + lift`, où
  `lift = épaisseur·cos(tangage) − y_haut·sin(tangage)` et `y_haut` = haut de la silhouette (tiré
  du champ) relatif au hotspot. Le point le plus bas du modèle posé est donc à la garde au
  repos, au plan au contact, jamais dessous. Mesuré sur huit états, à plat et iso : 0 pour les
  états centrés (face du dessous au sol), +1,6 à +1,8 % d'unité pour les pointeurs (le chanfrein
  arrondit le coin qui touche), sous le seuil testé de 2 %.
- **Pas de rebond d'échelle** en 3D : le contact le remplace.
- **Écrasement** : sur la même courbe `tap()`, l'épaisseur descend à 70 % au creux, puis le
  rebond l'épaissit un instant (104,8 % à 165 ms). Fois `clickBounce / 2,5`, jamais sous 55 %
  (deux chanfreins et un peu de flanc). Le dessus descend, le point le plus bas reste posé, le
  hotspot reste sur son pixel. L'empreinte, elle, ne change pas : un étalement de 5 % défaisait
  l'égalité « curseur centré posé = son sprite » de B.3.

### B.5.1 Le contact tombe sur le pixel cliqué

**Ce qui clochait.** L'application passe au compositeur la piste **lissée** (`smoothed`, le
ressort du réglage « smoothing ») ; les clics gardent leurs instants bruts, mais la piste lissée
traîne derrière la souris. Le modèle se posait donc à côté de la cible. Mesuré par
`the_modelled_tip_touches_the_raw_click_pixel` (scène dorée 1170×658, recadrée, zoom 2), écart
entre la pointe au contact et le pixel du clic brut :

| geste | lissage 0 | 0,25 | 0,5 | 1 |
|---|---|---|---|---|
| arrêt de 150 ms autour du clic, arrivée à 0,5 écran/s | 0 px | 6 à 8 px | 58 à 71 px | 105 à 127 px |
| idem, arrivée à 2 écrans/s | 0 px | 22 à 27 px | 137 à 166 px | 208 à 251 px |
| clic au vol (la souris repart aussitôt), 0,5 écran/s | 75 à 91 px | 59 à 72 px | 153 à 185 px | 209 à 252 px |

S'y ajoutait la traînée de flou, étalée de 2 à 16 copies pendant le contact.

**Correction** (`CursorTrack::pinned_at`, fonction pure de `t`). La piste garde la position
brute de chaque clic (`click_points`, conservée par `smoothed`). Le curseur modélisé est posé sur
`at(t)` tiré vers ce point : poids en smoothstep sur les 250 ms qui précèdent le clic, 1 pendant
les 100 ms qui suivent (le contact, 27 à 74 ms, plus une image à 24 i/s), retour en smoothstep
sur 250 ms. Continue et de pente continue ; hors de ces fenêtres, `at(t)` à l'identique. La
traînée lit la même position, donc se replie sur la tête pendant le contact. Le lacet vise aussi
le point brut.

Après : 0,0001 px au pire, sur les cinq caméras (plat, `iso`, `left`, `right` avec impact du
plan, `follow-cursor`), quatre lissages, deux vitesses, avec et sans arrêt, flèche et main. Sur
le rendu D3D11 d'une maquette dont les cibles portent une pastille rouge
(`tests/cursor_tap_render.rs`, lissage 0,5) : la pointe est à 0,13 à 0,35 px du centre mesuré de
la pastille, à plat, en `iso` et sous la caméra réelle, et la couvre.

Le sprite plat garde `at(t)` : son rendu reste celui d'avant à l'octet.

### B.5.2 L'impact du clic (mode 16)

Sous le curseur modélisé, chaque clic laisse une trace **sur** l'écran, centrée sur le point
cliqué brut :

- **tache de pression** : un disque sombre gaussien (rayon 0,3 du carré, opacité 0,3), qui
  apparaît au creux et s'éteint en ~180 ms ;
- **anneau** : un trait blanc net (demi-épaisseur 5 % du carré, qui s'amincit de moitié) bordé
  d'un halo sombre doux (opacité 0,3), qui part de 12 % du carré et s'arrête à 80 % en
  décélérant (cubique), et s'éteint en `(1 − u)²`. Le blanc se lit sur un contenu coloré ou
  sombre, le halo sur un fond blanc.

**Temps** : il part du creux de la pression (49,5 ms après le clic, l'instant du contact de
`tap()`, `bounce()` et de l'impact du plan) et dure 400 ms. À 30 i/s, la première image du
contact (33 ms) montre le curseur posé, la suivante (67 ms) l'anneau naissant.
**Taille** : le carré a un demi-côté de 0,7 taille de curseur (l'anneau finit donc à 0,56
taille, ~40 px pour un curseur de taille 4 en 720p). **Réglage** : `clickBounce / 2,5`
multiplie les opacités (plafond 1) et règle la taille (`0,75 + 0,25 × force`) ; 0 = rien.
Seulement quand `model3d` est allumé (un curseur sans modèle n'a pas de contact).

**Rendu** : un carré du plan centré sur le point, dont les coins passent par la projection du
contenu (`TiltedQuad::point_px`), comme le sprite du mode 13 ; le shader inverse le warp
(bilinéaire sous un angle fixe, projectif sous la caméra réelle) et dessine un disque dans le
carré. L'anneau est donc posé sur le plan : ellipse sous `iso`, perspective exacte sous
`follow-cursor`. Rien n'est dessiné hors de l'écran. Rust porte la courbe dans le temps
(`impact_at`) ; les trois shaders ne dessinent que la forme de l'instant (`cursor_impact`).
Dessiné sous le curseur et sa traînée ; le backend logiciel le garde. Emplacements du cbuffer :
en tête de la section « Impact du clic » de `frame_geometry.rs`.

Vérifié : centre du carré sur le pixel du clic à 0,05 px près (plat, `iso`, `follow-cursor`) ;
sur le rendu D3D11 et lavapipe, l'écart dû à l'anneau culmine au même rayon au-dessus et à gauche
de la pastille ; plus rien après sa fenêtre.

### B.6 Boîte, traînée, coût

- **Boîte de dessin** : les huit coins de la boîte du modèle (le rect du sprite sur toute
  l'épaisseur), et leur projection au sol le long de la lumière, élargie de la pénombre
  (`min(t/k, 0,45) / lz`) et du contact. Un miroir CPU du shader, champ compris, vérifie
  qu'aucun pixel du modèle ni d'ombre n'en sort, pour huit états et quatre plans.
- **Traînée** : des copies du modèle sur GPU. Le backend logiciel ne dessine que la tête
  (`CursorPlan::for_backend`) : sur WARP la traînée de la flèche analytique coûtait déjà +68 à
  +98 ms.
- **Coût** (1080p, RTX 4070 Ti, meilleur de cinq passes de 100 frames, readback compris) :
  curseur net (taille 3 ou 10, flèche ou I) dans le bruit, à ±0,15 ms du sprite ; taille 10 avec
  16 copies, +0,22 à +0,38 ms/frame, contre +0,66 à +1,1 ms pour la flèche analytique mesurée
  dans les mêmes conditions. Une lecture de texture coûte moins que les dix arêtes du polygone.
- **Mémoire** : un champ par sprite chargé, sans éviction ; les seize sprites du thème pèsent
  ~2,6 Mo de R16F.
- **`LayerCB`** reste à 128 octets ; l'emploi des emplacements aux modes 15 et 16 est documenté
  en tête des sections « Curseur modélisé » et « Impact du clic » de `frame_geometry.rs` et dans
  les trois structs de shader.
- **Traînée au contact** : elle lit la position convergée (B.5.1), donc se replie sur une seule
  copie pendant le contact.

### B.7 Limites

- Seul le thème par défaut est modélisé ; les thèmes sweezy (art de 128 px, bords non
  détourés) restent plats.
- Un pointeur basculé montre le flanc de sa queue, de la couleur de son bord : la main qui
  pointe gagne un liseré noir au bas de la paume. C'est la 3D, pas un défaut.
- Un dessus plat (curseur centré) reçoit 0,88 de la lumière : son blanc sort gris clair (226),
  là où le dessus penché de la flèche sort blanc. Mêmes constantes d'éclairage qu'avant.
- Le repli math de Windows (mode 4, sans sprite) reste plat.
- L'ombre s'arrête au bord du rect de l'écran, pas à ses coins arrondis.
- Le MSL n'est compilé et exécuté que par la CI macOS.
- Le sprite plat et l'impact du plan (`regions::click_impact`, qui lit `at(t_c)` sur la piste
  lissée) ne convergent pas sur le point brut : leur rendu reste celui d'avant à l'octet. Sous un
  lissage fort, le rebond du sprite plat tombe donc à côté de la cible.
- L'impact du mode 16 ne passe pas par les portes de celui du plan (vitesse ≥ 2×, flou de
  confidentialité visible, fenêtre du clip).

---

## C. Le cadre autour de l'enregistrement

### C.1 Les réglages

Deux réglages de projet, à côté du fond d'écran :

| réglage | valeurs | rendu |
|---|---|---|
| `effects.frame` | `none` | rien, et la frame est celle d'avant le réglage, à l'octet |
| | `window` | chrome de fenêtre **plat**, dans le plan de l'écran (mode 14) |
| | `laptop`, `phone`, `monitor` | appareils **modelés en vraie 3D** (mode 17) |
| `effects.frameTheme` | `light`, `dark` | argent / chrome clair, ou graphite / chrome sombre — pour **tous** les cadres |

`monitor` s'appelle **Screen** dans le panneau : la valeur nomme l'objet, le libellé nomme ce
qu'un utilisateur appelle son écran de bureau. Le navigateur a été retiré : il faisait doublon
avec le chrome de fenêtre.

**Aucune restriction.** Chaque cadre est toujours proposé, quelle que soit la forme du projet.
C'est le cadre qui s'adapte au métrage — jamais l'inverse : un téléphone autour d'un clip paysage
est un téléphone COUCHÉ, avec son œil de caméra sur le bord qui est devenu son haut.

**Roundness sous un cadre.** Le slider parcourt 0 → le plafond du cadre choisi (C.5) et se lit
en **%** de cette course, avec l'infobulle « La course s'adapte au cadre » (`roundnessFrameHelp`,
15 langues). La valeur stockée reste en px ; le natif en relit la position (`roundnessFrac` ×
petit côté de la sortie ÷ `ROUNDNESS_SLIDER_MAX_PX` = 64, miroir de `paramUnits.ts`). Sans cadre,
le slider reste en px et le rendu est celui d'avant, à l'octet.

**Migration.** `window-light` et `window-dark` étaient un réglage qui faisait deux métiers. Ils se
lisent encore, et se dédoublent en `window` + le thème qu'ils nommaient : côté app
(`readRecordingFrame`, `src/lib/projectDefaults.ts`), côté préréglages de style, et côté scène
(`SceneFrame::resolved` / `::theme_override`). Aucune passe de migration ne réécrit le document :
un projet écrit par une version antérieure s'ouvre avec le cadre ET le thème qu'il avait, et une
valeur qu'aucune de ces deux familles ne connaît se lit « aucun cadre » des deux côtés.

### C.2 Le métrage ne bouge pas

**Le métrage a la même boîte et la même coupe avec et sans cadre**, quel qu'il soit. Son rayon, lui,
suit la course de Roundness propre au cadre (C.5).
Le cadre pousse vers l'EXTÉRIEUR : dans le padding, et au-delà du canevas s'il le faut, où la sortie
le coupe. Il n'y a plus de `fit_in_window_frame` ni de `fit_in_device_frame` : rétrécir l'image
pour loger un objet décoratif, c'était l'inverse de ce qu'on veut. Tout ce qui s'ancre sur `s_dst`
— ombre de l'écran, masques de confidentialité, annotations, curseurs — n'a donc rien à rattraper,
et l'overlay de l'éditeur pose ses poignées sur `layout.screenRect` tel quel (le portage TS
`fitInWindowFrame` a disparu avec lui).

Épinglé par `the_footage_box_is_the_same_under_every_frame` (chaque cadre × plat, iso, orbite ×
zoom 1 et 2, au bit près) et `a_framed_privacy_mask_covers_what_the_overlay_shows`.

### C.2 bis L'unité du cadre

**Une seule longueur par boîte, la même sur x, y et z** : tout ce qu'un cadre dessine s'y mesure —
barre et filet de la fenêtre, lunettes, liseré, épaisseurs, rayons, socle et pied.

```
u = max(s_w / r_w, s_h / r_h) · min(r_w, r_h)      (frame_unit_px)
```

Le petit côté de la sortie, à l'échelle de la part de la sortie que la boîte occupe dans sa
dimension la plus remplie. Un clip est contenu dans la zone paddée et la touche dans une dimension,
quel que soit son ratio : `u` vaut le petit côté de cette zone pour un clip 16:9, 9:16, 1:1, 4:3 ou
21:9, et **le même cadre a les mêmes bordures en px autour de chacun** — seule l'ouverture change
de forme. `u` suit le padding et grandit avec le zoom, comme la boîte.

Avant, les lunettes étaient en largeurs de la boîte et la fenêtre en petit côté : autour d'un clip
portrait dans une sortie 16:9, la lunette du portable tombait au tiers de celle d'un clip paysage.
Le modèle du mode 17 a désormais `u` pour unité (`DeviceView::unit` = `u` × containment).

Épinglé par `a_frame_is_the_same_on_every_clip_ratio` (géométrie : bordures, rayons, épaisseur au
centième de px sur cinq ratios) et `a_frame_looks_the_same_on_every_clip_ratio` (rendu : bordures
et rayon mesurés sur l'image, à 0,1 px près).

### C.3 Les formes

Modelées en **vraie 3D**, pas une image plate gauchie sur le plan : la caméra tourne vraiment
autour d'elles. La **face écran tombe exactement sur le plan du métrage** — le mode 8 continue d'y
dessiner l'image, dans l'ouverture que le mode 17 creuse dans la face avant. Formes neutres
dessinées par nous : aucune marque, aucun logo, **aucune encoche d'écran** (la signature d'une
marque) ; un œil de caméra minuscule en est l'équivalent neutre.

Vus de face, elles se règlent sur deux produits de référence : un portable aluminium à lunette
fine, et un moniteur à lunette fine sur colonne plate. Proportions en **unités du cadre** (C.2 bis ;
`frame_geometry.rs`, miroir `DEV_*` des trois shaders). Les valeurs d'avant, en largeurs d'un écran
16:9, ont été multipliées par 16/9 : au ratio de référence, rien ne bouge.

| | lunette G/H/D/B (verre noir + liseré 0,0053) | coins extérieurs | épaisseur | ce qui dépasse |
|---|---|---|---|---|
| `window` | filet 0,0012 × 3, barre 0,04 | concentriques (C.5) | — (plat) | — |
| `laptop` | 0,0356 / 0,0356 / 0,0356 / 0,0409 | coque fixe 0,046 / 0,0074, ouverture au slider (C.5) | 0,0284 | socle 1,30 de profondeur, 0,0446 → 0,0391 d'épaisseur |
| `phone` | 0,014 × 4 | concentriques (C.5) | 0,05 | — |
| `monitor` | 0,0178 × 4 | coque fixe 0,0109, ouverture au slider (C.5) | 0,0284 | colonne 0,51 × 0,177, semelle 0,91 × 0,0456 |

- **Lunettes fines et uniformes**, sans menton : 2 % de la largeur d'un écran 16:9 en verre noir pour
  le portable (un rien de plus en bas, où l'écran rejoint la charnière), 1 % pour le moniteur, un
  anneau de 1,4 % de `u` pour le téléphone. Autour, un **liseré d'aluminium** de 0,0053 (`DEV_RIM`,
  quelques pixels) qui suit le contour du corps. Aucun détail sauf un œil de caméra centré dans la
  lunette du haut ; plus de fente de haut-parleur.
- **Le même corps sous tous les ratios** : un téléphone qui encadre un clip paysage est un téléphone
  COUCHÉ, de la même épaisseur ; un moniteur pivoté garde son pied.
- **Le socle a la largeur de la coque**, qui suit l'ouverture ; sa profondeur, son épaisseur, et tout
  le pied du moniteur sont fixes en `u`.
- **Le portable** : le socle a sa **profondeur réelle** (1,30 u, un 14 pouces : 221 mm pour 312 mm
  autour d'un écran 16:9), une arête avant qui fonce doucement vers le bas, et une **encoche** peu
  profonde au milieu de cette arête, celle qui sert à ouvrir l'écran. Clavier et pavé tactile,
  creusés d'un ton dans l'aluminium, n'apparaissent que quand la caméra tourne.
- **Le moniteur** : une colonne LARGE et plate, à flancs droits, qui descend de derrière l'écran, puis
  une semelle mince aux coins avant arrondis. Aluminium, un dégradé vertical doux.

#### Le socle, par l'ORIENTATION

Vu de face, le socle d'un portable n'est qu'une barre d'argent sous l'écran : sa tranche avant. On
ne le raccourcit pas pour l'obtenir, on l'**oriente** : la charnière s'ouvre juste assez pour que le
PLAN du socle passe à `DEV_DECK_EYE_CLEARANCE` (0,01) sous l'œil de la caméra droite. Le socle est
alors vu par la tranche, et le modèle est **rigide** : le même angle montre le clavier dès que la
caméra tourne.

Dérivation (`device_deck_angle`, en `u`) : l'œil est en `(0, 0, P)` dans le repère du plan, la
charnière en `(0, h, −e/2)` avec `h = demi-hauteur de l'écran + lunette basse` et `e` l'épaisseur du
corps. Le plan du socle contient l'axe x et la charnière ; il passe par `(0, c, P)` quand
l'ouverture écran–socle vaut

```
ouverture = atan((P + e/2) / (h − c))
```

et l'angle depuis le plan de l'écran en est le supplément. Avec `P = DEV_EYE_MIN` (C.6), cela donne
**86,9° en 16:9**, et le même angle sur un clip portrait dans la même sortie (84,5° dans une sortie
portrait). La borne est `[60°, 135°]`, pas `[90°, 135°]` : un œil à hauteur du centre de l'écran ne
voit un socle par la tranche que si celui-ci remonte vers lui, donc sous 90° à toute distance finie.
Un plancher à 90° montrerait le clavier, sur ~13 % de la hauteur de l'écran, au lieu de la barre.
Épinglé par `the_laptop_deck_is_seen_edge_on_from_the_flat_camera` : la barre fait 40,8 px
(0,047 u) sous un écran paysage, 40,4 px sous un écran portrait.

### C.4 La matière

**Aluminium mat et verre noir, pas de plastique.** Un gros arrondi d'arête et un reflet large font
un objet gonflé ; un produit se lit à ses faces PLATES, à une arête nette et à un filet de lumière
d'un pixel.

- **Micro-chanfrein de 0,0012 unité** : assez pour que l'arête ne coupe pas, trop peu pour arrondir
  la silhouette.
- **Le liseré et le filet de lumière sont PEINTS**, pas modelés : un chanfrein d'un millième fait
  moins d'un pixel à l'écran et ne s'antialiaserait pas.
- **Aucun lobe spéculaire large.** Rien qu'un voile directionnel étroit sur le métal
  (`DEV_SHEEN` = 0,11, `pow(diffuse, 4)`) ; le verre reste mat.
- Deux thèmes, les mêmes formes : argent (0,800) / dos 0,600 / verre 0,031, ou graphite (0,255) /
  dos 0,153 / verre 0,043. Le shader les lit dans `color.g`.

### C.5 Les coins : une course par cadre, qui se voit

**Sous un cadre, Roundness parcourt 0 → le plafond de CE cadre** (`frame_roundness_cap`, en `u`) :
chaque position du slider est belle pour chaque cadre et chaque ratio, et un rendu laid n'est plus
atteignable. Sans cadre, rien ne change (le slider en px de sortie, à l'octet).

| cadre | plafond du métrage | réglé sur |
|---|---|---|
| `window` | 0,035 u (30 px à u = 864) | le contour reste sous la hauteur de la barre (0,04 u) : l'arc ne quitte jamais le chrome, les pastilles s'en écartent ; les coins HAUTS du métrage restent carrés sous la barre, rien de ce qu'ils montrent n'est rogné |
| `laptop`, `monitor` | 0,04 u (35 px) | l'intérieur de la lunette seulement, du coin vif à un coin d'écran franchement arrondi ; la coque garde ses rayons (ci-dessous) |
| `phone` | 0,08 u (69 px) | les grands coins d'un téléphone moderne, 14 % de sa largeur debout dans une sortie 16:9 |

**UNE fonction de coin pour le métrage** : `screen_corner_radius_px` — le rayon demandé, borné à la
moitié du petit côté du métrage. Tout ce qui trace ce coin la lit : le métrage (modes 0 et 8),
l'**ouverture** de chaque appareil (mode 17, `dst_prev.y`), les coins bas de la fenêtre.

Les premiers plafonds (0,013 u pour la fenêtre, 0,0056 u pour le portable et le moniteur) rendaient
la course invisible : de 0 à 100 %, le coin ne bougeait presque pas.

**Le corps** : pour la **fenêtre** et le **téléphone**, `concentric_radius(r, b_x, b_y) = r + (b_x + b_y) / 2`. Les deux
arcs ont le même centre, et la bordure garde son épaisseur tout autour du coin. Quand les deux
bordures diffèrent (le bas du portable, 0,0409 contre 0,0356, liseré compris des deux côtés),
leur moyenne : les centres se décalent alors perpendiculairement à la diagonale, et l'épaisseur y
vaut la moyenne des deux bordures à 0,15 px près.

- **Portable et moniteur : seule l'ouverture suit le slider.** Leur coque garde ses rayons
  industriels (`device_shell_radius`, en `u`) : portable 0,046 en haut et 0,0074 en bas (2,5 % et
  0,4 % de la largeur du capot), moniteur 0,0109 (0,6 %). La coque d'un produit ne change pas de
  forme parce que son écran arrondit ses coins ; la lunette s'épaissit donc au coin quand le
  slider monte, comme sur les produits de référence.
- **L'ouverture est le contour du métrage rentré du recouvrement** (C.6) comme un décalage : mêmes
  centres, rayon `r − recouvrement`. Sous le même rayon, elle mordait le métrage d'un demi-pixel de
  plus sur la diagonale. Et le corps est concentrique à CE bord visible : quand le métrage
  s'arrondit moins que le recouvrement (Roundness 0), l'ouverture a un coin vif rentré d'un pixel
  et quart, et le corps s'arrondit autour de ce coin (`device_frame_cb`).
- **La fenêtre** : l'arrondi du haut se fait **une seule fois, par le cadre**. Les coins HAUTS du
  métrage sont carrés, à ras de la barre, et le plafond (0,035 u) tient toujours dans la barre moins
  le filet : l'arc du cadre ne descend jamais sous elle. Les coins BAS suivent la course,
  concentriques au cadre (rayon du métrage + filet, un seul rayon au mode 14). Modes 0 et 8 :
  `sd_screen_under_bar`, drapeau et remontée dans `mb.w`/`mb.z` (mode 0) ou `dst_prev.z`/`color.z`
  (mode 8).
- **La lunette gagne partout hors de l'ouverture** : dessinée APRÈS le métrage, opaque jusqu'au bord
  de l'ouverture, et la marche s'arrête au plan du métrage dans l'ouverture ARRONDIE — pas dans son
  rect, sinon les coins laissaient voir le métrage ou le fond entre l'arc et le coin carré.

Épinglé par `roundness_spans_each_frames_own_range` (0, la moitié, le plafond et rien au-delà ; le
corps concentrique à chaque position pour la fenêtre et le téléphone, la coque fixe pour le
portable et le moniteur ; des plafonds qui se voient), `the_aperture_and_the_footage_share_one_corner`,
`only_the_inside_of_the_laptop_and_screen_bezel_follows_roundness` (silhouette identique au pixel
entre Roundness 0 et maximal, coins de l'écran visiblement changés),
`the_window_rounds_the_top_once_and_the_bottom_with_the_slider`,
`the_title_bar_dots_survive_the_maximum_roundness`, et en pixels par
`the_border_keeps_its_thickness_around_every_corner` : fenêtre, téléphone ×
Roundness 0, par défaut, maximal × plat, iso × clair, sombre, la bordure mesurée le long de la
diagonale à 45° de chaque coin vaut celle des deux bords voisins à **1 px de sortie** près (la
tolérance du test ; mesuré : 0,6 px au plus, au Roundness 0 où le coin vif laisse l'antialiasing
épaissir la diagonale, et 0,2 px ailleurs). Sous iso, les épaisseurs se
mesurent dans le plan, la tolérance en px de sortie. `the_bezel_fills_the_corners_at_maximum_roundness`
reste vrai.

### C.6 Coutures, ombre et caméra du modèle

- **Aucune couture.** Le métrage s'estompe AU-DELÀ de son bord sur 1,5 px ; la lunette est opaque
  jusqu'au bord de l'ouverture et s'estompe EN DEÇÀ. L'ouverture est donc rentrée de
  **`DEV_OVERLAP_PX` = 1,25 px** dans le métrage, sous le même rayon : la lunette couvre la frange
  du métrage et fait son propre fondu sur de l'image opaque. En PIXELS (`dst_prev.z` converti en
  unités) : exprimé en unités, le recouvrement fondait sous la somme des deux fondus sur un petit
  écran. La fenêtre, elle, est dessinée SOUS le métrage : sa couture est déjà pleine.
  `no_seam_lets_the_wallpaper_through` sonde chaque bord et chaque coin sur fond vert, chaque cadre
  × Roundness 0 et maximal × plat, iso, orbite × 1080p et 4K.
- **L'ombre d'un appareil a sa silhouette 3D.** Un quad plat étiré dans le plan de l'écran pendait
  sous le portable comme une dalle grise. `device_shadow_cb` redessine le calque du mode 17 en mode
  OMBRE (`dst_prev.w` = pénombre) : chaque pixel lance le rayon du pixel décalé de l'ombre, marche
  le modèle PLEIN (écran compris), et la plus courte approche du rayon, en pixels, tient lieu de
  distance au contour — pleine au contour, nulle à la pénombre, comme le mode 2. Même décalage,
  même pénombre, même opacité que l'ombre de l'écran (`SCREEN_SHADOW_*`, slider Shadow). La fenêtre
  garde son ombre de quad (`shadow_caster`), exacte pour un rect arrondi plat.
  `the_device_shadow_follows_the_silhouette` : aucun pixel assombri au-delà de silhouette +
  décalage + pénombre, une ombre juste sous le socle et le pied.
- **L'œil du modèle.** Le plan garde l'objectif des présets (1,6 petit côté) : c'est lui qui fait
  lire l'inclinaison du métrage. Mais un socle de profondeur réelle vient alors à quelques dixièmes
  de l'œil, sa tranche avant se projette sur toute la largeur de l'image, et sous `iso` le clavier
  devient plus grand que l'écran. Le RELIEF du modèle est donc vu d'un œil reculé sur la MÊME
  droite, à au moins **`DEV_EYE_MIN` = 9,6 u** : chaque rayon passe par le même point du plan que
  celui de l'objectif, si bien que la face écran reste au pixel près sur le métrage (0,0002 px
  d'écart mesuré), et seul ce qui sort du plan change de perspective. 9,6 est réglé sur le portable
  de référence : sa tranche avant, à 1,3 u devant l'écran, y paraît ~15 % plus large que le
  couvercle (9,6 / 8,3).
- **Jamais d'en dessous** (`DeviceView::model_eye`). Cet œil ne descend jamais sous la ligne du centre
  de l'écran (`y ≤ 0` dans le repère du plan). Le socle est réglé pour être vu par la tranche depuis
  la caméra droite, son plan passe juste sous l'œil : un œil plus bas le voyait par-dessous, et sa
  face inférieure remontait sur le bas de l'écran. C'était le cas de la caméra en orbite dès que le
  pointeur passait dans le bas de l'image, et au zoom sur le bas, où elle vise sous le centre, l'œil
  du relief (reculé sur la droite qui passe par le centre de l'écran) plongeait de 35° et le socle
  couvrait tout le métrage, son arête avant énorme au premier plan. Borné ainsi, aucun point du
  socle ne se projette sur l'écran, sous aucun angle ni aucun zoom. Au repos et sous les angles
  fixes, qui regardent tous d'en haut, rien ne change.
- **Le plan proche** (`device_near_plane`). Quand la caméra en orbite avance pour zoomer, le socle —
  qu'une vraie caméra dépasserait — s'efface par son bord avant, en fondu : ce qui se tient plus loin
  que `DEV_NEAR · DEV_EYE_MIN · g` devant l'écran disparaît sur `DEV_NEAR_BAND` = 10 % de cette
  hauteur, jamais une coupe franche qui montrerait sa section. `g` est le travelling de la caméra
  RÉELLE : sa distance au point qu'elle vise, sur celle de l'objectif des présets (1 à plat, ≥ 1
  sous un angle fixe, `zoom^−0,5` sous l'orbite). `DEV_NEAR` = 0,16 : au repos, 1,54 u, au-delà du
  bord avant du socle (1,30 u) — rien ne change ; dès le zoom 1,25, le bord avant s'efface ; au zoom
  5, la moitié avant. La caméra réelle elle-même ne peut pas porter ce plan : au repos, son œil est
  déjà DANS la profondeur du socle sur un clip large (1,22 u devant un 21:9). C'est donc l'œil du
  modèle qui avance du même travelling qu'elle. L'ombre s'efface avec l'appareil.
  `the_near_plane_spares_the_rest_and_comes_in_with_the_orbit_camera` (au repos, sous les angles
  fixes à tous les zooms, sous l'orbite au zoom 1 : rien ; au zoom 1,5 : le bord avant),
  `the_laptop_deck_never_covers_the_screen` (géométrie : cinq ratios × zooms 1 à 5 × sept positions
  du pointeur, le socle reste à 18,8 px au moins sous le bord bas de l'écran) et
  `the_laptop_deck_never_covers_the_zoom_focus` (rendu : au zoom 5 et aux angles extrêmes de
  l'orbite, le centre de l'image est du métrage, pixel par pixel).

### C.7 Le mode 17

Un seul mode de shader, identique en HLSL, MSL et WGSL (`device_frame`), lancé de rayons par pixel
dans la boîte de dessin.

- **Repère du MODÈLE** : unité = l'unité du cadre `u` (C.2 bis), origine au centre du plan, x à
  droite, y vers le bas, z vers la caméra ; le corps occupe z de −épaisseur à 0.
- **Le corps** est une dalle arrondie en xy (coins hauts et bas distincts), mince en z, chanfreinée,
  MOINS le creux de l'écran, ouvert vers la caméra et fermé au fond.
- **Surfaces analytiques.** Hors de l'ouverture, le point où le rayon traverse le plan dit s'il perce
  la FACE AVANT ; le socle a son entrée analytique (`dev_deck_hit`, encoche comprise). Vu par la
  tranche, un socle est frôlé par des rayons qui restent à quelques pixels de lui sur toute sa
  profondeur : la marche y avançait à pas d'un quart de pixel et s'épuisait, et la lunette du bas
  laissait voir le fond sur une dizaine de pixels. La marche (80 pas) ne sert plus qu'à ce qui
  précède ces surfaces — arêtes, flancs, pied — et à l'antialiasing du contour.
- **Éclairage** : celui du curseur modélisé (`MODEL_LIGHT` / `AMBIENT` / `DIFFUSE`), la même lampe
  pour les deux objets d'une frame.
- **Emplacements du cbuffer** : en tête de `device_frame_cb` (`frame_geometry.rs`), qui fait foi.
  `radius_px` / `color.b` = rayons des coins hauts / bas, concentriques, calculés côté Rust ;
  `dst_prev` = (angle du socle, rayon de l'ouverture, recouvrement, pénombre de l'ombre). Le plan
  proche n'a pas d'emplacement : les shaders le tirent de `src.z / src.w` et de `mb.xy`. `LayerCB`
  reste à 128 octets.

### C.8 Limites

- Le **MSL n'est compilé et exécuté que par la CI macOS**, comme le mode 15.
- **La charnière s'ouvre sous 90°** (84,5° à 86,9°) : c'est la condition pour voir le socle par la
  tranche depuis un œil à hauteur d'écran (C.3).
- **L'œil du modèle n'est pas celui du plan** : sous un angle fixe, le relief de l'appareil converge
  un peu moins que les bords de l'image. C'est ce qui garde un socle réel lisible ; le prix est
  invisible tant que le relief reste petit devant l'écran.
- Le socle ne reçoit pas l'ombre calculée de l'écran, et la jonction colonne–semelle du moniteur
  garde un filet de lumière d'un pixel (le pli des deux faces).
- Un cadre peut sortir du canevas : c'est le prix d'un métrage qui ne rétrécit jamais.
- `u` rend un cadre identique d'un ratio de CLIP à l'autre, dans une même sortie. D'une sortie à
  l'autre il suit son petit côté, comme l'ombre et le slider : un téléphone debout dans une sortie
  9:16 a des lunettes plus fines, relativement à sa largeur, que dans une sortie 16:9.
- Au Roundness 0, le coin du métrage est vif : sur la diagonale, l'antialiasing y épaissit la
  lunette de 0,6 px au plus.
- Sous la caméra en orbite, le relief n'est jamais vu d'en dessous : un pointeur dans le bas de
  l'image ne montre plus le dessous du socle, du pied ou du téléphone.

---

## D. Découpage en PR

| PR | Titre | Contenu | Dépend de |
|---|---|---|---|
| **6** | `feat(zoom): add the follow-cursor 3D camera` | `rotationPreset` étendu (`follow-cursor`), caméra réelle dans `camera.rs`, warp projectif (modes 8, 10, 13, 14), un seul sélecteur, i18n ×14 | chantier 3D (PR 1, 2b) |
| **7** | `feat(cursor): model the default arrow in 3D` | `cursor.model3d`, mode 15, pose, ombre, retrait de `volume`/`hover` | PR 6 |
| **7b** | `feat(cursor): model every default cursor state in 3D` | champ de distance tiré de chaque sprite (`cursor_sdf.rs`), mode 15 générique, pose selon le hotspot, i18n ×14 | 7 |
| **7c** | `feat(cursor): tap the screen where the click happened` | convergence sur le point cliqué brut, écrasement, impact (mode 16), vidéo de revue | 7b |
| **7d** | `feat(frames): frame the recording with a 3D device` | §C : `frame` = none/window/laptop/phone/screen, thème clair-sombre, mode 17, warp projectif sous un appareil, i18n ×14 | 7c |
| **7e** | `fix(frames): keep the footage, model the devices after real products` | §C.2–C.6 : métrage constant, une seule fonction de coin, fenêtre arrondie une fois, socle par l'orientation, œil du modèle, coutures en pixels, ombre à la silhouette, proportions de référence | 7d |
| **7f** | `fix(frames): keep every border's thickness, in one frame unit` | §C.1, C.2 bis, C.5, C.6 : unité du cadre, course de Roundness par cadre, bordures concentriques, œil du relief jamais sous l'écran, plan proche du socle, i18n ×15 | 7e |
| **8** | `feat(zoom): dolly the camera` | distance de fuite par région, dolly-zoom | PR 6 |
| **9** | `feat(cursor): the cursor picks things up` *(plus tard)* | long press : le plan reste pressé pendant un glisser (v1 §PR 2b « Later ») | 7 |

La PR 6 touche surtout la géométrie partagée par les trois backends, testable sans GPU ; ses
shaders n'ajoutent qu'un warp projectif et une lampe, derrière un drapeau que les angles fixes
laissent à 0 (rendu inchangé à l'octet). Le passage à l'orbite n'a touché que `camera.rs`, le
cadreur et l'impact du clic : ni shader ni emplacement du mode 15.

La PR 7 ajoute un mode de shader, donc elle se vérifie sur les trois backends : tests unitaires
Rust de la pose, du contact, de l'ancrage et de la boîte ; rendus D3D11 sur une frame NV12
synthétique ; le même test de rendu dans les modules Linux (lavapipe) et macOS (CI).

La PR 7d ajoute le mode 17, donc elle se vérifie de la même façon : tests unitaires Rust de la
face écran, de la boîte et du réglage ; rendus D3D11 sur une frame NV12 synthétique
(`tests/device_frame_render.rs`) ; le même test de rendu dans les modules Linux (lavapipe) et
macOS (CI).

**État** : PR 6, 7, 7b, 7c, 7d, 7e et 7f écrites et testées. 8 et 9 restent à faire.
