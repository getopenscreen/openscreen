# Effets shader écrits par les agents

Un agent écrit un effet visuel en WGSL. Le compositeur l'applique en une passe sur l'image
composée, en preview comme à l'export. L'effet vit dans le document comme une région de la
timeline : on peut le relire, le régler, le déplacer et le supprimer, que l'on soit l'utilisateur
ou un agent.

Ce document fixe le modèle, le contrat, le DSL, le rendu et l'interface, puis découpe les PR.
Il part du spike Windows (branche `worktree-custom-shader-fx-spike`, commits `9cb30018d` et
`42728e335`).

**Ce que le spike a établi**

- **Coût.** +0,04 ms par frame en 1080p, +0,12 ms en 4K, pour un effet lourd.
- **Export.** 520 ms sans effet, 523 ms avec, pour 180 frames.
- **Preview.** Le rendu tient la cadence de la source, avec ou sans effet.
- **SSOT.** Entre la vue live et le MP4, l'écart reste au niveau du bruit du codec.
- **Boucle d'agent.** À partir du prompt « effet ripple lors du clic », un agent a écrit un
  effet correct en deux itérations, par les seuls outils MCP.

---

## A. Les principes

1. **Le compositeur reste la seule source de pixels.** Un effet est une passe de
   `compose_frame`, que la preview et l'export appellent tous les deux. Il n'existe pas de
   chemin de rendu propre aux effets.
2. **Le document ne stocke que la source.** Le WGSL, son nom, sa description, ses paramètres et
   les valeurs posées. Tout binaire compilé en est dérivé, et n'est jamais écrit dans le projet.
3. **Un effet est une fonction pure** de l'image composée, du temps, du curseur et de ses
   paramètres. Pas d'état d'une frame à l'autre.
4. **Le rendu ne compile jamais.** Le code est compilé à l'écriture, puis à la pose de la scène,
   sur un thread de fond.
5. **Ce que seul le compositeur sait entre dans le contrat.** La place de l'écran, de la webcam
   et du curseur dans la sortie, après zoom, layout et tilt : un effet ne peut pas la recalculer.
   Le prompt du ripple l'a montré, il ne pouvait pas s'écrire sans.
6. **L'agent passe par le DSL.** Il appelle des outils de document. Il n'écrit jamais le JSON du
   projet.
7. **Pour tout le monde.** Aucun réglage, aucune condition ne réserve la fonctionnalité à
   certains utilisateurs.

---

## B. Le modèle de données

### B.1 Deux objets : la définition et la région

- **La définition** (`shaderEffects`) porte le code, son nom, sa description et ses paramètres
  déclarés. Elle dit ce qu'est l'effet.
- **La région** (`shaderEffectRanges`) pose une définition sur la timeline, avec ses valeurs de
  paramètres. Elle dit où l'effet s'applique et comment il est réglé.

La séparation sert trois choses :
- réutiliser un effet à plusieurs endroits sans dupliquer son code ;
- régler une région (`values`) sans réécrire de code ;
- garder léger le snapshot de l'agent, où le code n'apparaît qu'une fois par définition.

### B.2 Le schéma

Deux tableaux de premier rang dans `documentSchemaShape`
(`src/lib/ai-edition/schema/index.ts`), à côté de `zoomRanges` :

```ts
const paramName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

const shaderEffectParamSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("number"), name: paramName, label: z.string().max(40),
		default: z.number(), min: z.number(), max: z.number() }),
	z.object({ type: z.literal("toggle"), name: paramName, label: z.string().max(40),
		default: z.boolean() }),
	z.object({ type: z.literal("color"), name: paramName, label: z.string().max(40),
		default: hexColor }),
	z.object({ type: z.literal("point"), name: paramName, label: z.string().max(40),
		default: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }) }),
]);

export const shaderEffectSchema = z.object({
	id: z.string().min(1),                        // "fx_…"
	name: z.string().min(1).max(60),              // ce que la pilule affiche
	description: z.string().max(500).default(""), // pour l'agent suivant : ce que l'effet fait
	contract: z.number().int().positive(),       // pas un littéral : voir C.5
	code: z.string().min(1).max(65_536),         // plafond technique, pas un budget (C.7)
	params: z.array(shaderEffectParamSchema).max(32).default([]),
	origin: z.enum(["agent", "user"]).default("agent"),
	cost: z.object({ tier, frameReads }).optional(), // estimation du compositeur, en cache
}).superRefine(/* noms uniques, min ≤ default ≤ max */);

export const shaderEffectRangeSchema = endGteStart(z.object({
	id: z.string().min(1),                        // "fxr_…", un par fragment
	startMs: z.number().nonnegative(),            // cache dérivé de l'ancre, comme les zooms
	endMs: z.number().nonnegative(),
	...clipAnchorShape,
	effectId: z.string().min(1),
	values: z.record(z.string(), shaderEffectValueSchema).default({}),
	target: z.enum(["image", "text", "both"]).default("image"),
	lane: z.number().int().min(0).max(7).default(0),
}), "endMs", "startMs");

// documentSchemaShape
shaderEffects: z.array(shaderEffectSchema).optional(),
shaderEffectRanges: z.array(shaderEffectRangeSchema).optional(),
```

- **`values`** ne porte que ce qui diffère du `default` de la définition. Une valeur hors bornes
  est ramenée dans ses bornes à l'écriture (les outils) et à la lecture (la scène), sans erreur.
  Le parse ne le peut pas : les bornes sont dans la définition, pas dans la région.
- **Les `label`** sont écrits par l'agent, dans la langue de l'utilisateur, et affichés tels
  quels. Ils ne passent pas par l'i18n : c'est du contenu, pas de l'interface.
- **Une pilule, ce sont les fragments identiques et contigus** (`regionIdentityKey`), comme pour
  les zooms. Il n'y a pas de clé de groupe : une région coupée par un trim ou une frontière de
  clip reste une seule pilule, et sa progression (`ctx.region`) court sur la pilule entière (B.5).
- **`cost`** est l'estimation du compositeur (C.7), mise en cache quand le code a été vérifié. Elle
  est dérivée, jamais une entrée : un code modifié la recalcule.
- **Une définition que plus aucune région n'utilise est retirée** par l'édition qui a retiré sa
  dernière région (`removeRegion`, `mapAllRegionCollections`). Le document ne garde pas de code
  mort.
- **Les `max` du schéma sont des plafonds techniques, pas des budgets.** Ils protègent le document
  (64 Ko de code, 32 paramètres, 8 lanes) et sont loin au-dessus de tout effet raisonnable. Ce que
  l'agent doit viser, ce sont les paliers de C.7.

### B.3 Ancrée sur le clip, comme les autres régions

Une région d'effet est une région de plus, pas un cas à part. Elle passe par tout le pipeline des
modificateurs ([timeline-model.md](../technical-documentation/architecture/timeline-model.md)),
et suit donc les clips quand on les déplace, les coupe ou les supprime. Le spike la stockait en
ms brutes, sans ancre : elle restait en place pendant que les clips bougeaient.

- **`RegionKind`** gagne `"shaderEffect"`. Les sites qui switchent dessus sont listés dans
  [editor-shell.md, « Adding a region kind »](../technical-documentation/architecture/editor-shell.md)
  (ses numéros de ligne sont périmés). Les principaux :
  - **le crochet des éditions de clips :** `mapAllRegionCollections` (`document/timeline.ts`),
    par lequel passent moveClip, duplicateClip, setClipSourceRange, removeClip, replaceTimeline
    et l'insertion ;
  - **les listes codées en dur :** `anchoredRegionsOf`, et `removeRegion`/`EDIT_REGIONS`, dont
    les types rendent un oubli bloquant à la compilation ;
  - **côté agent :** `ModifierKind`, `modifierIds`, `modifierIdsOf` et la recherche d'id de
    `removeModifier` (`agent-tools.ts`) ;
  - **côté éditeur :** `removeRegions` (`useTimeline.ts`), `regionClipboard.ts`, le
    copier-coller et la touche Suppr de `NewEditorShell.tsx`.
- **L'identité des pilules** (`regionIdentityKey`) compte tous les champs sauf la position et la
  provenance. Deux régions contiguës du même effet, aux mêmes `values`, se fondent donc en une
  pilule, comme deux zooms identiques.
- **Les pistes.** Deux régions d'une même `lane` ne se chevauchent pas, avec la règle des autres
  régions (`refuseIfBlocked`). Les lanes s'appliquent dans l'ordre : la lane 0 d'abord, au plus
  près du contenu. C'est ce qui permet un ripple sur toute la vidéo ET un glitch
  sur une coupe.
- **Après une édition de clip** qui fait se chevaucher deux régions d'une même lane, le rendu
  applique les deux, dans l'ordre du tableau, et la piste les montre superposées. Pas de
  réparation automatique : contrairement à l'audio, deux effets superposés ne cassent rien.

### B.4 Persistance

- **Champs additifs et optionnels, sans montée de `schemaVersion`.** C'est la convention de
  `vocabulary` : `.optional()`, et `z.object` qui ignore les clés inconnues. Un document écrit
  avant cette fonctionnalité s'ouvre tel quel, un document sans effet n'en porte aucune trace, et
  tout lecteur prend une liste absente pour vide.
- **Le prix de ce choix.** Une build antérieure qui ouvre puis sauvegarde un projet perd ses
  effets en silence. Voir K, question 1.
- **Pas dans les style presets.** Un preset porte le look du projet, jamais son contenu
  (`stylePresets.ts`), et un effet est posé sur des moments précis du contenu.
- **`openscreen info`** compte les effets avec les zooms et les trims (`documentInfoFields`,
  `projectCommands.ts`).

### B.5 Ce que la scène native reçoit

`buildSceneDescription` projette les régions comme les zooms (`projectRegionsToSource`). Il
ajoute à chaque fragment ce que le compositeur ne peut pas recalculer :

```json
"shaderEffects": [{
  "clipIndex": 0, "startSec": 1.0, "endSec": 5.0,
  "programmeStartSec": 1.0, "programmeEndSec": 5.0,
  "target": "image", "lane": 0,
  "contract": 1, "code": "fn effect(uv: vec2<f32>) -> vec4<f32> { … }",
  "params": [ { "name": "strength", "type": "number" } ],
  "values": { "strength": 1.0 }
}]
```

- **`programmeStart/EndSec`** est l'étendue de la pilule entière en temps programme. Le
  compositeur en tire `ctx.region` sans rien savoir des trims.
- **`values` est déjà normalisé :** une couleur devient 4 floats, un toggle 0 ou 1, un point
  2 floats, et une valeur absente prend son `default`.
- **Le packing dans l'uniform** se fait côté Rust, au même endroit que la struct WGSL générée.
  Le layout n'a qu'une source.
- **Les fragments sous un trim** (`underTrim`) restent dans la scène, comme pour les autres
  régions. Ils se dessinent quand la tête de lecture est posée sur le trim, et l'export ne les
  rencontre jamais.

---

## C. Le contrat WGSL (version 1)

### C.1 Ce que l'agent écrit

Une seule fonction, appelée pour chaque pixel de la sortie :

```wgsl
fn effect(uv: vec2<f32>) -> vec4<f32>
```

`uv` va de (0, 0) en haut à gauche à (1, 1) en bas à droite de la sortie. La fonction rend la
couleur finale du pixel. Le reste du module (bindings, entrées, `@vertex`, `@fragment`) est écrit
par le compositeur et placé APRÈS le code de l'agent : en WGSL, l'ordre des déclarations est
libre, et les erreurs pointent ainsi les lignes que l'agent a écrites.

### C.2 Ce qui est fourni

| Nom | Type | Sens |
|---|---|---|
| `frame(uv)` | `vec4<f32>` | L'image composée en ce point (D.1 dit ce qu'elle contient). Échantillonnage bilinéaire, bords répétés. |
| `ctx.resolution` | `vec2<f32>` | Taille de la sortie, en px. |
| `ctx.aspect` | `f32` | Largeur sur hauteur de la sortie, pour les distances circulaires en uv. |
| `ctx.time` | `f32` | Secondes de programme, continues à travers coupes, clips et vitesses. |
| `ctx.region` | `vec4<f32>` | x : progression de 0 à 1 sur la pilule entière. y : sa durée en s. z : secondes depuis son début. |
| `ctx.cursor` | `vec4<f32>` | xy : la pointe en uv de sortie. z : 1 si elle est à l'écran, même quand le curseur est masqué. |
| `ctx.clicks[i]` | `vec4<f32>` | Les 4 derniers clics des 2 dernières secondes, du plus récent au plus ancien. xy : le point du clic en uv de sortie. z : secondes écoulées depuis. w : 1 si l'entrée est occupée. |
| `ctx.footage` | `vec4<f32>` | Le rect de l'enregistrement en uv de sortie (x, y, w, h), après zoom et layout. Sous un tilt 3D, c'est sa boîte englobante. |
| `ctx.camera` | `vec4<f32>` | Le rect de la webcam en uv de sortie. Taille nulle sans caméra. |
| `ctx.footage_aspect` | `f32` | Largeur sur hauteur de l'enregistrement dans son propre plan, pour les distances circulaires sur lui. |
| `ctx.footage_corners`, `ctx.footage_warp` | | Ce que lisent les deux fonctions suivantes : les coins TL, TR, BR, BL du métrage en uv de sortie, et son warp (1 homographie, 0 bilinéaire). |
| `fx_to_footage(uv)` | `vec2<f32>` | Le point du plan de l'enregistrement sous `uv` : (0, 0) son coin haut-gauche, (1, 1) le bas-droit, prolongé au-delà de ses bords. Loin hors de 0..1 là où aucun point du plan ne tombe. |
| `fx_from_footage(p)` | `vec2<f32>` | L'inverse : où tombe en uv de sortie le point `p` du plan. |
| `params.<nom>` | selon le type | Les paramètres déclarés par l'effet (C.3). |
| `fx_px(n)` | `f32` | `n` pixels d'une sortie 1080p, en fraction de la hauteur. |
| `fx_hash(p)` | `f32` | Hasard déterministe dans [0, 1) pour un `vec2<u32>`, identique sur tous les GPU (PCG). |

- **Tout ce qui est en uv de sortie** est déjà passé par le zoom, le layout, le cadre et le
  tilt. Ces valeurs viennent de `plan_frame` et `effect_pointer` (`frame_geometry.rs`), que les
  trois backends partagent.
- **Le plan de l'enregistrement** suit le warp que le compositeur dessine : bilinéaire sous un
  angle fixe, homographie sous la caméra réelle (`FootageQuad`, `quad_inverse` des shaders).
  L'effet choisit son repère : l'image de sortie, ou ce plan. Le contrat ne décide pas lequel
  convient à quel effet.
- **Le curseur masqué** (« Afficher le curseur » coupé, l'auto-hide, le `hideCursor` d'un zoom)
  n'est plus dessiné, mais `ctx.cursor` et `ctx.clicks` restent ceux de l'enregistrement : un
  halo suit toujours la souris, une onde part toujours du clic, et un effet peut remplacer le
  curseur par son propre dessin. `ctx.cursor.z` ne vaut 0 que si l'enregistrement a caché la
  pointe ou si elle sort du cadre (un zoom serré) ; les clics d'avant restent.
- **Le point d'un clic** est la pointe à l'instant du clic, au même endroit que l'impact intégré
  (mode 16).
- **Le curseur dessiné** passe par le lissage et peut traîner un instant derrière ce point quand
  la souris arrive pile au moment du clic. Ce cas est rare sur une vraie prise.
- **Le spike exposait un seul clic** (`ctx.click`). Avec quatre, deux clics rapprochés gardent
  chacun leur onde.
- **Rien d'autre n'est lié.** Une variable `@group`/`@binding` dans le code de l'agent est
  refusée, avec sa ligne : aucun backend ne la lierait.

### C.3 Les paramètres sont nommés et typés

Un effet déclare ses paramètres. Le compositeur en génère une struct `FxParams` liée en uniform,
et le code lit `params.radius`, jamais `param(2)`. Un agent qui relit l'effet six mois plus tard
comprend ce qu'il lit, et l'inspecteur sait quel contrôle afficher.

| `type` | WGSL | Dans le document | Contrôle de l'inspecteur |
|---|---|---|---|
| `number` | `f32` | nombre, entre `min` et `max` | curseur |
| `toggle` | `f32` (0 ou 1) | booléen | interrupteur |
| `color` | `vec4<f32>` (RGBA, 0 à 1) | `#rrggbb` ou `#rrggbbaa` | sélecteur de couleur |
| `point` | `vec2<f32>` (uv de sortie) | `{ x, y }` | deux curseurs |

- **Huit paramètres au plus, recommandé.** Au-delà, l'inspecteur devient une liste que personne
  ne règle. Ce n'est pas un refus : le plafond technique est à 32.
- **Les noms** sont des identifiants WGSL en `snake_case`, uniques, hors mots réservés.
- **Le layout uniform est calculé côté Rust** avec les règles d'alignement de WGSL : `f32` sur 4,
  `vec2` sur 8, `vec4` sur 16. Il produit le même ordre et les mêmes trous que la struct générée,
  et un test compare les offsets de naga à ceux du packer.
- **Un paramètre doit se voir.** La description de l'outil exige qu'il change visiblement
  l'effet sur toute sa plage. Un contrôle qui ne fait rien à l'écran est exactement ce que
  l'inspecteur doit éviter.

### C.4 Les règles

- **Pure.** Le résultat ne dépend que de `uv`, de `frame()`, de `ctx` et de `params`. Pas d'état
  d'une frame à l'autre, pas d'horloge, pas de compteur de frames. La preview saute d'une frame à
  l'autre au seek, l'export les rend dans l'ordre, et les deux doivent donner le même pixel.
- **Indépendante de la résolution.** La preview rend plus petit que l'export. Distances en uv ou
  en `fx_px`, jamais en px bruts.
- **Hasard par `fx_hash`.** Le classique `fract(sin(x) * 43758.5453)` donne des valeurs
  différentes d'un GPU à l'autre.
- **Boucles à borne littérale.** Toute boucle s'arrête sur un compteur comparé à un littéral
  (`for (var i = 0; i < 16; i++)`). Une boucle dont la borne n'est pas un littéral est refusée.
  C'est la seule règle ferme du contrat, et ce n'est pas un budget : une boucle qui ne finit pas
  bloque le GPU, le TDR de Windows le réinitialise, et l'app perd son device sans retour (G.2).
  La valeur de la borne, elle, est libre : elle compte dans le palier de coût (C.7).
- **Un plafond de sécurité sur le travail par pixel :** 4 096 itérations, toutes boucles
  imbriquées comprises. L'ordre de grandeur visé est le seuil du TDR (2 s par frame) sur un GPU
  intégré en 1080p ; c'est une estimation, que la PR 1 mesure et ajuste. Un flou de 64 taps en
  fait 64, un raymarching de 64 pas sur 8 objets 512.
- **Alpha.** Pour les cibles `image` et `both`, la valeur rendue remplace le pixel ; les
  encodeurs ignorent l'alpha, et rendre `frame(uv).a` suffit. Pour la cible `text`, `frame()`
  rend le calque des textes en alpha prémultiplié, transparent hors du texte, et l'effet doit
  rendre de l'alpha prémultiplié lui aussi (D.1).

### C.5 Le contrat est versionné

Chaque définition porte `contract: 1`.
- **Le prélude d'une version livrée ne change plus.** Une entrée nouvelle s'ajoute à la fin de
  `FxContext` : le code existant ne la lit pas et compile à l'identique.
- **Un changement de sens crée la version 2,** et le compositeur garde le prélude de la 1.
- **Un document qui porte une version inconnue** (écrit par une build plus récente) garde ses
  régions, sans les appliquer.

### C.6 Exemple

Le ripple du spike, réécrit pour le contrat v1 :

```wgsl
// Une onde part de chaque clic, réfracte l'image et laisse deux ou trois vagues derrière elle.
fn ripple(uv: vec2<f32>, click: vec4<f32>) -> vec2<f32> {
    if (click.w < 0.5 || click.z > params.duration) { return vec2<f32>(0.0); }
    let t = click.z / params.duration;
    let aspect = ctx.resolution.x / ctx.resolution.y;
    let d = (uv - click.xy) * vec2<f32>(aspect, 1.0);
    let r = length(d);
    let x = params.radius * (1.0 - pow(1.0 - t, 3.0)) - r;
    let env = smoothstep(-0.008, 0.0, x) * exp(-max(x, 0.0) / 0.07);
    let wave = sin(x / 0.03 * 6.2831853) * env * (1.0 - t) * (1.0 - t) * params.strength;
    let dir = select(vec2<f32>(0.0), d / r, r > 1e-5);
    return dir * wave * 0.01 / vec2<f32>(aspect, 1.0);
}

fn effect(uv: vec2<f32>) -> vec4<f32> {
    var offset = vec2<f32>(0.0);
    for (var i = 0; i < 4; i++) { offset += ripple(uv, ctx.clicks[i]); }
    return frame(uv - offset);
}
```

Avec `params` : `strength` (number, 0 à 2, 1), `radius` (number, 0,05 à 0,5, 0,2), `duration`
(number, 0,3 à 2 s, 0,9).

### C.7 Le coût : des paliers indicatifs, pas des limites

Le coût d'un effet est estimé depuis son code, sans le faire tourner. Il ne dépend donc pas de la
machine : le même code reçoit le même palier partout, et un effet haut de gamme n'est jamais
refusé parce que la machine qui l'écrit est modeste.

- **L'estimation se fait sur l'IR de naga.** Elle compte les lectures de `frame()` par pixel,
  multipliées par la borne des boucles qui les contiennent ; les fonctions appelées sont
  dépliées. Les lectures de texture dominent le coût mesuré dans le spike : c'est la bande
  passante qui paie.
- **Les paliers**, en lectures par pixel :

| Palier | Lectures | Exemples | Recommandation |
|---|---|---|---|
| Léger | ≤ 8 | vignette, étalonnage, ripple à 4 clics | Partout, y compris sur toute la vidéo. |
| Moyen | ≤ 32 | aberration chromatique échantillonnée, petit flou, glitch | Sur des régions de quelques dizaines de secondes. |
| Lourd | ≤ 128 | gros flou, bokeh | Sur des régions courtes : une transition, un moment fort. |
| Très lourd | au-delà | raymarching, simulations | Quelques secondes. L'export reste juste, mais plus lent ; la preview peut ralentir sur un petit GPU. |

- **Mesuré sur la RTX 4070 Ti** (`shader_fx_tier_calibration`) : environ 4 µs par lecture en
  1080p et 17 µs en 4K, au-dessus d'un fixe de 0,03 ms. Un effet léger coûte au plus 0,06 ms par
  frame en 1080p, un moyen 0,14 ms, un lourd 0,54 ms, 512 lectures 2,1 ms. Le détail est dans
  [rendering-performance.md](../technical-documentation/engineering/rendering-performance.md).
- **Mesuré sur lavapipe** (le repli CPU de Linux, 16 threads) : environ 1,4 ms par lecture en
  1080p, 350 fois la RTX. Un effet léger y ajoute jusqu'à 11 ms à une frame qui en coûte 7,5 ;
  un lourd, 234 ms. L'ordre des paliers tient, mais sans GPU même un effet léger double le
  temps d'export.
- **Mesuré sur un Apple M1** (GPU intégré, Metal, même banc) : environ 0,12 ms par lecture en
  1080p et 0,5 ms en 4K, au-dessus d'un fixe de 0,3 ms. Un effet léger coûte au plus 1,3 ms par
  frame en 1080p, un moyen 4,3 ms, un lourd 16 ms, 512 lectures 49 ms : trente fois la RTX. Les
  lectures y dominent aussi : sans les `sin`/`cos` du banc, 128 lectures coûtent encore 10,5 ms.
- **Le Radeon 610M** des mesures Linux reste à mesurer. La description de l'outil donnera les
  paliers en ms sur la RTX et sur le M1, pour que l'agent raisonne en temps et non en lectures.
- **Plusieurs effets au même instant s'additionnent.** Le retour d'un outil donne le palier de
  l'effet, et le palier cumulé du moment le plus chargé de sa région.
- **Rien n'est refusé au coût.** Le palier et sa recommandation reviennent à l'agent (E.3), qui
  décide, et ils restent lisibles dans le snapshot (E.2).

---

## D. Le rendu

### D.1 Où la passe s'insère

`compose_frame` dessine, dans l'ordre :
1. le fond ;
2. le métrage et le cadre ;
3. les flous de confidentialité ;
4. le curseur ;
5. la webcam ;
6. les annotations et les sous-titres.

Une région choisit sa cible (`target`). Sans demande explicite, c'est `image`.

- **`image`** : l'image sans les textes. La passe s'insère avant les annotations et les
  sous-titres. Un effet déforme l'écran, la webcam, le curseur et le fond, jamais le texte que
  l'utilisateur a posé pour être lu.
- **`text`** : les textes seuls (annotations et sous-titres). Les textes sont dessinés dans un
  calque transparent à part, l'effet s'y applique, puis le calque est composé par-dessus l'image
  (« over » prémultiplié). L'image dessous reste intacte. Le calque n'existe que si une région
  `text` couvre la frame.
- **`both`** : l'image finale, textes compris, par exemple pour un fondu au noir qui doit couvrir
  les sous-titres. La passe vient après tout.

Les flous de confidentialité restent sûrs. L'effet ne voit que des pixels déjà floutés et ne peut
rien y retrouver : il n'existe aucun chemin vers l'image d'avant le flou.

### D.2 Plusieurs effets à la fois

- **L'ordre.** Les régions actives à la frame s'appliquent par lane croissante, puis dans
  l'ordre du tableau.
- **Le coût.** Chacune fait une copie du RT dans `ann_copy` et une passe plein cadre.
- **Les cibles s'enchaînent dans l'ordre du dessin :** les effets `image`, puis les textes et
  leurs effets `text`, puis les effets `both`. Un effet ne voit que ce qui est dessiné avant lui.

### D.3 Les chemins de rendu

- **Un seul `compose_frame`.** La preview (`live.rs`), l'export MP4 et l'export GIF
  (`walk_composited_timeline`, `timeline_walk.rs`) l'appellent tous. Les effets apparaissent
  donc partout, sans code propre à chaque chemin.
- **Une passe par frame de sortie.** `compose_frame_mb` n'a aucun appelant, et le flou de
  mouvement est calculé par calque (`mb_taps`).

### D.4 La compilation : une fois, hors du rendu

Il y a deux compilations, à deux moments :

1. **À l'écriture.** Quand un outil pose ou change un code (`addEffect`,
   `setEffectDefinition`), le processus principal appelle `checkShaderEffect(code, params)` de l'addon.
   - **La compilation est réelle,** pour le backend de la machine, en plus de la validation
     naga. « Accepté » veut donc dire « se dessinera ».
   - **Elle tourne sur le pool de libuv** (une `AsyncTask`) : la compilation Metal d'un code neuf
     prend 120 ms, et jusqu'à 375 ms pour la première du processus. `runDocumentTool` attend la
     réponse, puis la passe à l'exécuteur des outils, qui reste synchrone.
   - **Le coût est estimé** depuis le code (C.7), sans rendu ni mesure sur la machine.
   - **L'erreur revient à l'agent** avec la ligne et la colonne de SON code.
2. **À la pose de la scène** (`Compositor::set_scene`). Chaque code nouveau part compiler sur un
   thread de fond.
   - **La preview** saute l'effet le temps de la compilation, puis recompose la frame en pause
     (`shader_fx_landed`). Environ 10 ms avec FXC ; avec Metal, 120 ms pour une source neuve et
     jusqu'à 375 ms pour la première du processus (H.3).
   - **L'export** attend le binaire, et ne rend jamais une frame sans son effet. C'est le mode
     par défaut du compositeur : seule la vue live le coupe.

Le cache est en mémoire, par compositeur.
- **La clé** est le hash de (contrat, layout des paramètres, code).
- **L'éviction** est LRU au-delà de 64 entrées : un agent qui itère en crée une par version.
- **Pas de cache disque en v1.** 10 ms par effet ne le justifient pas, et Metal comme Mesa gardent
  déjà leur propre cache de shaders : sur le M1, une source déjà vue se recompile en 0,4 ms dans le
  même processus, en 3 ms dans un autre. L'app ne passe d'ailleurs aujourd'hui aucun dossier
  inscriptible au natif : il faudrait une variable d'environnement sur le modèle de
  `OPENSCREEN_FONTS_DIR`.

### D.5 Par plateforme

Une seule source WGSL, traduite par naga au moment de compiler.

| | Windows | macOS | Linux |
|---|---|---|---|
| Traduction | naga vers HLSL SM 5.0 | naga vers MSL | aucune : WGSL tel quel |
| Compilation | `D3DCompile` (FXC) vers DXBC, puis `CreateVertexShader`/`CreatePixelShader` | `new_library_with_source`, puis `make_pipeline(…, Blend::Replace)` | `create_shader_module`, puis `create_render_pipeline` |
| Thread de fond | naga et FXC (fait) | naga, bibliothèque et pipeline, sous `autoreleasepool` (fait) | module et pipeline (fait) |
| Copie du RT | `CopySubresourceRegion` vers `ann_copy` (fait) | blit vers `ann_copy` dans le command buffer de la frame (fait) | `copy_texture_to_texture` vers le niveau 0 d'`ann_copy` (fait) |
| Insertion | fin de `compose_frame` (fait) | fin de `compose_frame`, avant `submit` (fait) | `image` entre la passe caméra et l'ann-pass, `text` et `both` après (fait) |
| Uniforms | `Map(WRITE_DISCARD)` (fait) | `set_fragment_bytes` (fait) | `create_buffer_init(UNIFORM)` par passe (fait) |

**macOS en détail**
- **Activer `msl-out`.** Le dépôt l'obtient aujourd'hui par unification des features de wgpu ; le
  déclarer explicitement sous `cfg(target_os = "macos")`.
- **Pas d'objet sampler.** Les shaders Metal du dépôt utilisent des `constexpr sampler` :
  passer le sampler en `inline_samplers` de naga (`BindSamplerTarget::Inline`).
- **Lier les bindings explicitement.** Remplir `per_entry_point_map` pour `fx_fs` : texture,
  sampler, buffer. Sinon `fake_missing_bindings` émet `[[user(fake0)]]`, qui n'est pas du MSL
  valide.
- **Lire les noms de fonctions** dans `TranslationInfo.entry_point_names`.
- **Le thread de fond.** `Device`, `Library` et `RenderPipelineState` de metal-rs sont `Send` et
  `Sync`, et `live.rs` déplace déjà un `Gpu` vers un thread de préchargement.
- **Pas de garde de boucle.** naga borne sinon chaque boucle par une lecture `volatile` à chaque
  tour (`force_loop_bounding`). La validation a déjà prouvé que toute boucle finit (C.4) : la garde
  coûtait 7 à 10 % de la passe sur le M1.
- **Le calque des textes.** `draw_annotations` ouvre sa propre passe : elle prend désormais sa
  cible, le RT ou le calque. Le calque est effacé dans une passe à part, puisque
  `draw_annotations` n'en ouvre aucune quand rien n'est visible, puis posé sur le RT par
  `pipeline_fs_tex` (« over » prémultiplié).
- **La passe charge sa cible** au lieu de l'ignorer : un effet peut faire `discard`, et le pixel
  doit alors rester celui de la composition.

**Linux en détail**
- **Un bind group layout explicite,** jamais `layout: None`. Sinon un effet qui n'appelle pas
  `frame()`, ou ne lit pas `ctx`, perd ces bindings, et le bind group échoue à la validation.
- **Le thread de fond.** `wgpu::Device` est `Send`, `Sync` et `Clone` : le pipeline peut se
  construire hors du thread de rendu.
- **Valider avant wgpu.** Aucun `on_uncaptured_error` n'est posé, donc une erreur de validation
  wgpu fait paniquer. La pré-validation (`shader_fx::analyze`) en protège : naga 24, celui de
  wgpu 24, et le refus de tout binding que le prélude ne déclare pas. Si wgpu panique malgré tout,
  seul le thread de compilation meurt, et l'effet ne se dessine pas (D.6).
- **« Accepté » sous Linux.** `check_for_agent` traduit l'effet en SPIR-V par naga, comme wgpu le
  fera. La compilation par le pilote Vulkan n'a lieu qu'à `set_scene`, faute de device dans
  l'outil.
- **Le calque des textes** est une texture RGBA8 transparente, posée sur le RT par la passe qui
  recopie déjà `accum` (`pipeline_copy`, « over » prémultiplié).

**naga reste en 24.** À partir de la 25, sa sortie HLSL déclare les samplers dans un tas D3D12
(`register(s0, space0)`), que FXC refuse en `ps_5_0` (erreur X3721). Le test
`a_valid_effect_becomes_hlsl_that_d3d11_accepts` garde cette frontière : il doit passer avant tout
bump de naga ou de wgpu.

### D.6 Un effet qui ne compile pas au rendu

Ce cas arrive avec un document écrit ailleurs, une version de contrat inconnue ou un
compilateur qui diffère d'une machine à l'autre.
- **La région ne se dessine pas,** et la frame reste celle de la composition.
- **L'erreur est écrite une fois** dans le journal natif (`[shader-fx]`) et remonte à
  l'inspecteur (F.2).
- **L'export ne s'arrête pas.** Un effet manquant vaut mieux qu'un export perdu, et l'agent ou
  l'utilisateur a déjà vu l'erreur à l'écriture.

---

## E. Le DSL : ce que l'agent appelle et relit

Les effets passent par les outils de document, comme le reste : `TOOL_ARG_SCHEMAS`,
`TOOL_DESCRIPTIONS`, `executeAgentTool`. Le serveur MCP les sert sans rien de plus, et l'agent
intégré les reçoit par le même tableau.

### E.1 Les outils

| Outil | Arguments | Effet |
|---|---|---|
| `addEffect` | `startSec`, `endSec` (secondes de règle), `effect` **ou** `effectId`, `values?`, `target?`, `lane?` | Pose une région. Avec `effect` (`name`, `description`, `code`, `params?`), crée d'abord la définition. Avec `effectId`, réutilise une définition du projet. |
| `setEffect` | `effectRegionId`, `startSec?`, `endSec?`, `values?`, `target?`, `lane?` | Change une région. Seuls les champs passés changent. |
| `setEffectDefinition` | `effectId`, `name?`, `description?`, `code?`, `params?` | Change une définition, donc toutes les régions qui l'utilisent. Un code neuf est compilé avant d'être accepté. Les `values` d'un paramètre retiré tombent, un paramètre nouveau prend son `default`. |
| `getEffect` | `effectId` | Lecture : la définition entière, code compris. |
| `removeModifier` | `id` | Retire une région d'effet, comme un zoom. |

- **Un seul `add`.** Écrire puis poser un effet est le cas courant : un appel, pas deux.
  `effectId` sert à réutiliser.
- **Pas de `removeEffect`.** La définition part avec sa dernière région (B.2).
- **Les noms suivent le DSL :** `add*`, puis `set*` qui ne touche que les champs passés, puis
  `removeModifier` pour retirer. Pas de neutralisation (force à 0, durée nulle) à la place d'un
  retrait.
- **Le placement suit les autres régions :** `anchorForAgent` / `landingOf`. Le modèle est
  `addCameraFullscreen`. Une étendue qui ne couvre aucun clip est refusée (`coversNoClip`), et
  une région qui en heurterait une autre de la même lane aussi (`refuseIfBlocked`).

### E.2 Ce que l'agent relit

`getCurrentDocument` ajoute deux listes, sans le code, qui coûterait cher en tokens à chaque
lecture :

```json
"effects": [
  { "id": "fxr_…", "effectId": "fx_…", "name": "Ripple au clic",
    "startSec": 0, "endSec": 6, "target": "image", "lane": 0, "values": { "strength": 1 } }
],
"effectDefinitions": [
  { "effectId": "fx_…", "name": "Ripple au clic",
    "description": "Une onde part de chaque clic et réfracte l'image.",
    "contract": 1, "lines": 22, "regions": 1,
    "cost": { "tier": "light", "frameReads": 4 },
    "params": [ { "name": "strength", "type": "number", "label": "Force",
                  "default": 1, "min": 0, "max": 2 } ] }
]
```

- **Les pilules sont coalescées** comme les autres régions (`coalesceForAgent`) : un id par
  pilule, celui de son premier fragment.
- **Le code se lit par `getEffect`,** quand l'agent veut le modifier.
- **`description` est écrite par l'agent** et lue par l'agent suivant. La description de l'outil
  l'exige : ce que l'effet fait, en une phrase, pas comment il le fait.
- **`cost`** est l'estimation mise en cache dans la définition. `null` signifie que rien n'a pu
  vérifier le code quand il a été écrit.
- **`timeBaseNote`** nomme les effets parmi les régions en secondes de règle.

### E.3 Les retours

- **Accepté :** l'id, l'étendue posée (`landingReport`, comme les autres régions : fragments,
  bornes rognées), et le coût : le palier de l'effet, le palier cumulé du moment le plus chargé,
  et la recommandation du palier quand la région la dépasse. Par exemple : « lourd sur 45 s :
  pour une région longue, vise moyen ».
- **Refusé à la compilation :** l'enveloppe `{ error }`, avec l'erreur de naga ou du compilateur
  du backend, lignes et colonnes de SON code. Le document ne change pas.
- **Refusé pour une boucle sans borne littérale,** ou au-delà du plafond de sécurité de C.4,
  avec la ligne de la boucle. C'est le seul refus qui ne vient pas du compilateur.
- **Sans validateur branché** (un harnais de test), le code est stocké et `validated: false` le
  dit.

### E.4 Voir le résultat sans exporter

Avant, `getFrames` (`media-tools.ts`) ne montrait que le dernier export : vérifier un effet
coûtait un export complet. Sur un projet de dix minutes, la boucle de l'agent devenait trop
lente.

**`getFrames` rend désormais depuis le document quand l'export manque ou est périmé** (PR 5).
- **Avec un export à jour,** l'outil lit toujours ce fichier.
- **Sinon,** le processus principal construit les clips et la scène comme l'export
  (`buildNativeClipList`, `buildSceneDescription`). Il passe les secondes de règle en indices de
  frame, sur la grille à 60 i/s de `exportVideo`, et demande ces frames à l'addon
  (`renderFrames`).
- **L'addon rend par la marche de l'export,** `timeline_walk::render_frames` : mêmes clips, mêmes
  vitesses, même frame source à chaque instant. Les frames non demandées ne sont ni décodées ni
  composées.
- **Un saut de plus de 2 s repart d'une image clé** (`catch_up`). `seek_to` rend la première
  frame à ou après le point visé ; on recule donc ce point jusqu'à tomber avant l'instant voulu,
  puis on avance comme l'export : la frame montrée est la dernière dont le pts le précède.
- **Le compositeur attend la compilation des effets,** comme celui de l'export.
- **Les images sont des JPEG** de 1 280 px de large au plus, comme les frames d'un export.
- **Prouvé au pixel** par `tests/render_frames_match_export.rs` : une frame rendue seule est
  identique, octet pour octet, à la même frame de la marche complète. La source est une mire dont
  chaque frame change, sur une grille à 24 i/s qui tombe entre ses frames. Un seek droit sur
  l'instant visé échoue à ce test.
- **Ce n'est pas la vue live** que le spike pilotait (`presentTime`, `readFrame`) : elle saute un
  effet qui compile encore, et il faut la sonder en boucle.

### E.5 Ce que l'agent lit avant d'écrire

- **`TOOL_DESCRIPTIONS.addEffect`** porte le contrat court : la signature, les entrées de C.2,
  les règles de C.4, les paliers de C.7 en ms, les trois cibles et le défaut `image`, l'exigence
  d'un paramètre visible, et la vérification avec `getFrames`.
- **La ressource MCP `openscreen://effects/contract`** porte le contrat complet et deux
  exemples : le ripple au clic et une vignette qui respire.
  - **Ce serait la première ressource du serveur,** qui n'en a aucune aujourd'hui.
  - **Pourquoi une ressource :** le contrat est trop long pour une description d'outil, et il
    évolue avec `contract`.
- **Le prompt de base** (`BASE_SYSTEM_PROMPT`) gagne deux choses :
  - une ligne dans la carte des intentions : un effet visuel que les réglages n'offrent pas se
    fait avec `addEffect` ;
  - les effets dans la ligne des bases de temps.
- **Le skill `openscreen-demo`** gagne une entrée « effets » à son étape 6.

### E.6 L'agent intégré

Il a les mêmes outils et le même validateur que le serveur MCP : `handlers.ts` passe
`checkShaderEffect: (code, params) => loudnessService.checkShaderEffect(code, params)` à
`runChat`, qui le transmet par `ChatRunEnv` et `InvokeArgs` jusqu'à `buildTools`.

### E.7 Le banc (workbench)

Un scénario, `effect-ripple-on-click`, sur une mire avec trois clics :

- **Attendu :** un `addEffect` dont le code lit `ctx.clicks`, une région qui couvre chaque clic et
  la demi-seconde qui suit, et la cible `image`, puisque rien ne demande les textes.
- **Pas exigé :** lire la piste du curseur. Le compositeur donne déjà les clics placés sur la
  sortie, c'est tout l'intérêt du contrat (C.2).

`documentInvariants` valide les deux nouvelles listes : chaque région pointe une définition
existante, et ses `values` sont dans les bornes. Hors ligne, rien ne compile le code : le résultat
dit `validated: false`, et les checks lisent le code comme du texte.

---

## F. L'interface

### F.1 Une piste « Effets » dans la timeline

- **Où.** Une rangée par lane utilisée, plus une rangée vide pour en ouvrir une nouvelle. Elles se placent sous la piste Full Camera, dans l'ordre des lanes de `V4Timeline.tsx`.
- **La pilule** porte le nom de la définition. La glisser, l'étirer, la sélectionner et la
  supprimer se font comme pour un zoom (`selectPill`, `startPillDrag`, `removeRegions`).
- **L'annulation** passe par l'historique habituel (`saveDocument({ history: true })`). Une
  édition d'agent reste un seul pas d'annulation par tour (`agentDocumentApply.ts`).
- **Pas de bouton « ajouter un effet » en v1.** Un effet naît d'un agent : le chat intégré ou un
  client MCP. Un bouton qui ouvrirait un panneau vide n'aurait rien à proposer. La bibliothèque
  d'effets (J) lui donnera un contenu.
- **Le copier-coller** (`regionClipboard`) copie la région avec sa définition. Collée dans un
  autre projet, la définition y est recréée.
- **Le site** (`website/scripts/gen-recreation.mjs`) recopie `LANE_ORDER` à la main. La nouvelle
  piste n'y casse rien, et la recréation ne la montrera pas tant qu'on ne l'y ajoute pas.

### F.2 L'inspecteur

`SelectionPane` (`FloatingInspector.tsx`) gagne une branche `shaderEffect`. Elle contient, dans
l'ordre :

- **le nom de l'effet,** sans phrase d'explication sous les contrôles ;
- **un contrôle par paramètre déclaré,** généré depuis `params` (curseur, interrupteur, couleur
  ou point), qui écrit `values` sur la région ;
- **la cible :** « Image », « Textes » ou « Les deux » (`target`) ;
- **le palier de coût,** en un mot (léger, moyen, lourd, très lourd), sans phrase ;
- **le code,** replié par défaut, en lecture seule, avec un bouton copier ; l'édition du code
  passe par l'agent en v1 ;
- **supprimer,** comme pour les autres régions.

**Un effet qui ne compile pas** affiche l'erreur du compilateur dans l'inspecteur. C'est
l'exception admise aux phrases sous les réglages : sans elle, la pilule existerait sans rien
faire, et ce serait une vraie surprise.

### F.3 Textes de l'interface

Les libellés fixes vont dans `timeline.json` (`labels.shaderEffect`) et dans `editor.json`
(`inspector.effectCode`, `inspector.effectLayer`…), pour les 15 locales.
`localeParity.test.ts` et `npm run i18n:check` vérifient leur parité. Les noms et libellés
écrits par l'agent n'y passent pas.

---

## G. SSOT, déterminisme, sécurité

### G.1 Ce qui garantit preview = export

- **Un seul chemin de pixels.** La preview et l'export appellent le même `compose_frame`, avec la
  même scène : `buildSceneDescription` sert aux deux.
- **Une seule horloge.** `ctx.time` est le temps programme, et `ctx.region` vient de l'étendue
  de la pilule en temps programme. Aucun des deux ne lit le compteur de frames.
- **Un effet pur.** C'est le contrat C.4. La validation fait respecter ce qui se vérifie
  statiquement (boucles, taille), et la description de l'outil donne le reste à l'agent comme
  règle d'écriture.
- **Jamais de placeholder à l'export.** Le mode bloquant est le défaut du compositeur.
- **À résolution égale.** La preview rend plus petit que l'export. Un effet qui suit C.4 donne la
  même image, mais pas les mêmes pixels, puisqu'il n'y en a pas le même nombre. C'est déjà vrai
  de tout le reste du rendu.

**Mesure du spike.** Écart entre la frame de la vue live et celle du MP4 exporté, décodé en
BT.709 : 2,2 à 2,6 / 255, dans la région d'effet comme hors d'elle. C'est le bruit du codec.

### G.2 Un GPU qui ne répond plus

Le seul vrai risque d'un code écrit par un agent est une boucle qui ne finit pas. Le TDR de
Windows réinitialise alors le GPU, et l'app perd son device. Rien ne gère ce cas dans le dépôt :
le thread de rendu s'arrête sur son erreur (`fatal`, `live.rs`) et ne redémarre pas.

La protection est statique, posée à la validation : la borne littérale de toute boucle et le
plafond de 4 096 itérations par pixel (C.4). Ce n'est pas un budget de coût, qui n'existe qu'en
paliers indicatifs (C.7). Récupérer un device perdu est un chantier à part : il concerne toute
l'app, pas les effets.

### G.3 Un projet partagé

Un projet porte le code de ses effets. Ouvrir le projet de quelqu'un d'autre compile donc du code
qu'on n'a pas écrit.
- **Ce code ne tourne que sur le GPU,** sans accès aux fichiers, au réseau ni à la mémoire du
  processus.
- **Les garde-fous de G.2 s'appliquent aussi à l'ouverture.** Un effet refusé reste dans le
  document, et sa région ne se dessine pas.

---

## H. Performance

### H.1 Pas de budget ferme

- **Une région inactive ne coûte rien.** La passe n'existe que si une région couvre la frame.
- **Le coût d'un effet se lit en paliers** (C.7), estimés depuis le code et identiques sur toutes
  les machines. L'agent les connaît et suit leurs recommandations ; rien n'est refusé au coût.
- **Une cible `text`** ajoute un calque transparent et sa composition, seulement aux frames
  qu'elle couvre.

### H.2 Mesuré par le spike (RTX 4070 Ti, D3D11)

| Mesure | Résultat |
|---|---|
| Compilation (naga + FXC) d'un effet de 60 lignes | 10 ms, sur un thread de fond |
| Passe d'un effet lourd, 1080p | +0,04 ms par frame |
| Passe d'un effet lourd, 4K | +0,12 ms par frame |
| Export de 180 frames en 1752×1080 : sans effet, avec effet, avec effet lourd | 520, 523 et 521 ms |
| Preview en lecture, source à 30 i/s | 30 i/s avec et sans effet |

Mesuré à la passe Linux (lavapipe sous WSL, 16 threads) : effet prêt en 18 ms après `set_scene`,
module et pipeline compris ; les paliers en C.7.

À mesurer à l'implémentation :
- le Radeon 610M des mesures Linux.

### H.3 Mesuré sur macOS (Apple M1, Metal)

| Mesure | Résultat |
|---|---|
| Compilation (naga + Metal + pipeline) d'une source neuve, le ripple de C.6 | 120 ms en médiane, 160 à 375 ms pour la première du processus, sur le thread de fond |
| Recompilation d'une source que Metal a déjà vue | 0,4 ms dans le même processus, 3 ms dans un autre |
| `addEffect` accepté, compilation réelle comprise (CLI `mcp`) | 152 ms ; refusé à la ligne de l'agent en 6 ms |
| Passe d'un effet de 1 lecture, 1080p et 4K | +0,41 ms et +1,2 ms par frame |
| Passe d'un effet de 128 lectures, 1080p et 4K | +16 ms et +63 ms par frame |
| Export de 180 frames en 1752×1080 : sans effet, ripple, effet lourd du spike | 2 469, 2 428 et 2 375 ms : dans le bruit, l'export est limité par l'encodeur |
| Preview en lecture, source à 30 i/s | 29,7 i/s avec et sans effet |
| Vue live contre MP4 (BT.709), image entière | 3,1 / 255 avec effet, 3,0 sans |
| Vue live contre MP4, sur les pixels où l'effet agit | 13 à 16 / 255 avec effet, 14 à 16 sans effet sur les mêmes pixels : le bruit du codec sur des bords nets |

La compilation, dix fois plus lente qu'avec FXC, reste hors du rendu. Elle tourne aussi à
l'écriture (`checkShaderEffect`), d'où le pool de libuv plutôt que le thread principal (D.4).

Le détail est dans
[rendering-performance.md](../technical-documentation/engineering/rendering-performance.md).

---

## I. Les tests

| Niveau | Ce qu'il couvre |
|---|---|
| Rust, `shader_fx.rs` | Prélude et struct générée ; packer de paramètres contre les offsets de naga ; borne littérale et plafond d'itérations ; estimation du coût et paliers (boucles imbriquées, fonctions dépliées) ; erreurs aux lignes de l'agent ; sélection des régions (lane, ordre, `underTrim`) ; `ctx.region` sur une pilule coupée. |
| Rust, par backend | Une passe repeint la frame dans sa région et nulle part ailleurs ; les trois cibles (`text` laisse l'image intacte, `image` laisse les textes intacts) ; preview non bloquante puis `shader_fx_landed` ; effet cassé = frame intacte. Windows (fait), macOS (fait, sur le runner CI, avec en plus une vraie annotation entre une cible `image` et une cible `text`), Linux sur lavapipe. |
| Rust, `frame_geometry.rs` | `ctx.clicks`, `ctx.footage`, `ctx.camera` en uv de sortie, sous zoom et sous tilt. |
| TS, schéma | Parse, bornes des `values`, définition orpheline retirée, document ancien inchangé. |
| TS, timeline | La région suit `moveClip`, `removeClip`, `replaceTimeline` et les trims (`timelineMap.test.ts`, `timeline.test.ts`). |
| TS, outils | `addEffect` avec `effect` puis avec `effectId` ; `setEffect` ; `setEffectDefinition` ; `getEffect` ; `removeModifier` ; les refus (compilation, boucle sans borne, chevauchement, aucun clip) ; le palier et sa recommandation dans le retour ; le snapshot. |
| TS, scène | Projection, `programmeStart/EndSec` d'une pilule coupée, normalisation des `values`. |
| Banc | Les deux scénarios de E.7. |
| Bout en bout | La boucle du spike par la CLI `mcp` : prompt, `addEffect`, `getFrames`, puis comparaison de la vue live avec l'export. Une ligne dans le [journal e2e](../technical-documentation/testing/manual-e2e-checklist.md). |

---

## J. Hors de la v1

- **Effets par calque** (l'écran seul, la webcam seule). La passe agit sur l'image composée.
- **Effets temporels** (traînées, persistance). Ils prendraient les frames précédentes comme
  entrées explicites, jamais un état gardé ; ce n'est pas fait.
- **Transitions entre deux clips.** Elles demandent deux images en entrée.
- **L'édition du code dans l'interface.** En v1, le code se lit, se copie, et s'écrit par
  l'agent.
- **La bibliothèque d'effets** partagée entre projets, avec un bouton « ajouter » qui la propose.
- **Une poignée sur la preview** pour les paramètres `point`.
- **Le cache disque** des binaires compilés.
- **La récupération d'un device GPU perdu,** un chantier qui concerne toute l'app.

---

## K. Décisions (14/10/2026)

1. **Champs additifs, sans montée de `schemaVersion`.** Comme `audioTracks`. Une build antérieure
   qui sauvegarde le projet perd ses effets : c'est accepté.
2. **Pas de budget ferme, des paliers indicatifs** (C.7). Ils sont estimés depuis le code, donc
   indépendants de la machine. L'agent les connaît, avec leurs recommandations. Un budget lié à
   la machine aurait refusé des effets haut de gamme sur une machine modeste, alors que l'export,
   lui, les rend très bien.
3. **Pas de limites fermes non plus.** Paramètres, code et lanes ont des recommandations, et des
   plafonds techniques loin au-dessus (B.2). Seule reste ferme la borne littérale des boucles,
   avec son plafond de 4 096 itérations par pixel : une protection contre le blocage du GPU, pas
   une limite de créativité.
4. **Pas de bouton « ajouter un effet » en v1.** Les effets naissent des agents.
5. **Trois cibles : `image`, `text`, `both`.** Sans demande explicite, l'effet vise `image`, sous
   les textes.

## L. Découpage en PR

Le spike n'est pas fusionné tel quel : les PR 1 et 2 reprennent son code, et il est stocké
ailleurs (`legacyEditor`, sans ancre).

1. **Contrat v1 et passe Windows (Rust).**
   - `shader_fx.rs` : struct `FxParams` générée et packer ; `ctx.region`, `ctx.clicks`,
     `ctx.footage`, `ctx.camera`, `fx_px`, `fx_hash` ; borne littérale des boucles et plafond
     d'itérations ; estimation du coût et paliers, calibrés en ms sur le GPU intégré de
     référence.
   - `check_shader_effect` compile pour le backend et rend le palier.
   - `scene.rs` lit la nouvelle forme ; la passe Windows gère les trois cibles (calque de textes
     à part pour `text`), `lane` et l'éviction LRU.
2. **Modèle de données et DSL (TS).**
   - Schéma (B.2) et `RegionKind` dans tout le pipeline (B.3) ;
   - outils (E.1), snapshot (E.2), projection de scène (B.5) ;
   - validateur branché sur l'agent intégré (E.6) ;
   - descriptions, prompt de base, ressource MCP du contrat, skill, `openscreen info`, banc.
3. **Passe macOS.** naga `msl-out`, samplers inline, bindings explicites, thread de fond, tests
   sur le runner CI.
4. **Passe Linux.** WGSL direct, bind group layout explicite, thread de fond, test lavapipe.
5. **`getFrames` depuis le document.** Rendu de frames sans export quand celui-ci manque ou est
   périmé (E.4).
6. **Interface.** Piste et lanes, inspecteur, copier-coller, i18n.

La PR 2 dépend de la 1. Les PR 3, 4 et 5 dépendent de la 1 et peuvent avancer en parallèle. La
PR 6 dépend de la 2.

Chaque PR met à jour la documentation qu'elle rend fausse, dans le même changement :
- `native-compositor.md` ;
- `document-model.md` et `timeline-model.md` ;
- `editor-shell.md`, dont la checklist « Adding a region kind » a ses numéros de ligne à
  rafraîchir ;
- `ai-agent.md`, dont le tableau d'outils annonce encore « 26 tools » ;
- `mcp-server.md` ;
- une ligne de [decisions.md](../technical-documentation/architecture/decisions.md) : WGSL et
  naga 24, compilation hors du rendu, effet pur ;
- et, à la PR 6, une page de `website/docs/`.
