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

## C. Découpage en PR

| PR | Titre | Contenu | Dépend de |
|---|---|---|---|
| **6** | `feat(zoom): add the follow-cursor 3D camera` | `rotationPreset` étendu (`follow-cursor`), caméra réelle dans `camera.rs`, warp projectif (modes 8, 10, 13, 14), un seul sélecteur, i18n ×14 | chantier 3D (PR 1, 2b) |
| **7** | `feat(cursor): model the default arrow in 3D` | `cursor.model3d`, mode 15, pose, ombre, retrait de `volume`/`hover` | PR 6 |
| **7b** | `feat(cursor): model every default cursor state in 3D` | champ de distance tiré de chaque sprite (`cursor_sdf.rs`), mode 15 générique, pose selon le hotspot, i18n ×14 | 7 |
| **7c** | `feat(cursor): tap the screen where the click happened` | convergence sur le point cliqué brut, écrasement, impact (mode 16), vidéo de revue | 7b |
| **8** | `feat(zoom): dolly the camera` | distance de fuite par région, dolly-zoom | PR 6 |
| **9** | `feat(cursor): the cursor picks things up` *(plus tard)* | long press : le plan reste pressé pendant un glisser (v1 §PR 2b « Later ») | 7 |

La PR 6 touche surtout la géométrie partagée par les trois backends, testable sans GPU ; ses
shaders n'ajoutent qu'un warp projectif et une lampe, derrière un drapeau que les angles fixes
laissent à 0 (rendu inchangé à l'octet). Le passage à l'orbite n'a touché que `camera.rs`, le
cadreur et l'impact du clic : ni shader ni emplacement du mode 15.

La PR 7 ajoute un mode de shader, donc elle se vérifie sur les trois backends : tests unitaires
Rust de la pose, du contact, de l'ancrage et de la boîte ; rendus D3D11 sur une frame NV12
synthétique ; le même test de rendu dans les modules Linux (lavapipe) et macOS (CI).

**État** : PR 6, 7, 7b et 7c écrites et testées. 8 et 9 restent à faire.
