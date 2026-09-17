---
id: product-demo-video
title: Comment faire une vidéo de démo produit
sidebar_label: Vidéo de démo produit
description: "Faire une vidéo de démo produit avec OpenScreen : script, enregistrement à 60 fps, webcam, zooms automatiques, coupes, flou, sous-titres et export."
keywords:
  - vidéo de démo produit
  - enregistrer une démo de logiciel
  - vidéo de démo avec zoom et sous-titres
  - tutoriel enregistrement d'écran
  - prompteur
---

# Comment faire une vidéo de démo produit

Pour faire une vidéo de démo produit, écrivez un court script, enregistrez le produit à un rythme régulier, puis montez : coupez les temps morts, zoomez sur l'essentiel, masquez les données privées, ajoutez des sous-titres et exportez au format qu'exige votre canal de diffusion. Ce guide détaille chaque étape dans OpenScreen, un enregistreur d'écran et éditeur gratuit, sous licence MIT, pour Windows, macOS et Linux, où l'enregistrement, le montage, la transcription et l'export s'exécutent sur votre machine. OpenScreen produit un fichier vidéo. Il n'héberge pas la vidéo et ne crée pas de parcours cliquable ; si vous avez besoin de l'un ou de l'autre, voir [Quand OpenScreen n'est pas le bon outil](#when-openscreen-is-not-the-right-tool).

## Avant de commencer {#before-you-start}

- Installez OpenScreen depuis la [page de téléchargement](/download/). La page [Installation](../installation.md) couvre chaque plateforme.
- Décidez où la vidéo sera regardée. C'est ce qui détermine le format : 16:9 pour un site web ou une page de documentation, 9:16 pour un fil vertical, 1:1 pour un emplacement carré.
- Préparez le produit : un compte de démo, des données d'exemple, les notifications désactivées.

## 1. Écrire le script dans la fenêtre Notes {#1-write-the-script-in-the-notes-window}

Sous Windows et macOS, cliquez sur **Ouvrir les notes** dans le HUD. Cela ouvre une fenêtre de texte enrichi, enregistrée localement d'une session à l'autre. Écrivez-y le script, une action par ligne. Le HUD sous Linux n'a pas de bouton Notes.

La fenêtre Notes sert aussi de prompteur. **Démarrer le défilement automatique** fait défiler le texte à une vitesse réglable de 10 à 100. La taille de police va de 14 à 48 px, et **Miroir horizontal** retourne le texte.

:::caution
Sous Windows, OpenScreen exclut le HUD et la fenêtre Notes de la capture. Sous macOS, il ne peut pas le garantir : gardez la fenêtre Notes sur un écran que vous n'enregistrez pas. Sous macOS et Linux, utilisez **Masquer le HUD** si le HUD se trouve sur l'écran enregistré.
:::

## 2. Enregistrer l'écran ou une fenêtre {#2-record-the-screen-or-a-window}

1. Sous Windows et macOS, ouvrez le sélecteur de source et choisissez un écran sous **Écrans** ou une seule fenêtre sous **Fenêtres**. Sous Linux, il n'y a pas de sélecteur dans l'application : le portail du système demande la source à chaque prise. OpenScreen ne capture pas de zone de l'écran : enregistrez la fenêtre ou l'écran, puis recadrez le clip dans l'éditeur.
2. Activez le micro et vérifiez son vumètre. Activez l'audio système si le produit émet du son, et la webcam si vous voulez apparaître à l'écran.
3. Gardez le mode curseur éditable, celui par défaut : le pointeur est enregistré sous forme de données, et vous pourrez donc en changer le style plus tard. Les clics sont enregistrés sous Windows. Sous macOS, ils exigent l'autorisation Accessibilité. Sous Linux, votre utilisateur doit faire partie du groupe `input`, et le tapotement pour cliquer des pavés tactiles n'est pas capturé ([détails](../installation.md#mouse-clicks-on-wayland)).
4. Lancez l'enregistrement. Un compte à rebours 3-2-1 s'affiche d'abord ; il ne peut pas être désactivé.

OpenScreen vise 60 fps à la capture, jusqu'à 3840×2160 sous Windows et macOS. Sous Linux, la taille est celle que fournit le compositeur. Pendant l'enregistrement, vous pouvez mettre en pause, recommencer la prise, l'annuler ou l'arrêter.

**Calez votre rythme sur les zooms.** Amenez le pointeur sur l'élément que vous allez expliquer, puis immobilisez-le. Les zooms automatiques de l'étape 4 cherchent ces pauses : un pointeur immobile pendant une durée allant d'environ une demi-seconde à 2,6 secondes. Un pointeur qui reste immobile plus longtemps n'obtient pas de zoom.

**Longues démos sous Linux.** Linux écrit un MP4 classique qui n'est finalisé qu'à l'arrêt : un plantage en pleine prise laisse donc un fichier illisible. Enregistrez plutôt plusieurs prises plus courtes ; l'étape 5 montre comment les assembler.

Consultez [Enregistrement d'écran](../recording.md) pour toutes les commandes du HUD.

## 3. Choisir la disposition de la webcam et l'arrière-plan {#3-choose-the-webcam-layout-and-background}

La webcam est enregistrée dans son propre fichier : son placement est donc une décision de montage, modifiable à tout moment. Ouvrez l'onglet **Disposition caméra** dans l'inspecteur de l'éditeur :

- **Incrustation d'image**, **Empilement vertical**, **Double cadre** ou **Sans webcam**.
- Pour toutes les dispositions : miroir, et recadrage de l'image de la caméra.
- Pour **Incrustation d'image** uniquement : **Forme de la caméra** (Rect., Cercle, Carré ou Arrondi), une taille de 10 à 50 % (25 % par défaut), et **Réduire au zoom**, activé par défaut, qui réduit la caméra pendant un zoom pour qu'elle ne cache pas le détail. Faites glisser la caméra sur le canevas pour la déplacer.
- **Arrière-plan de la caméra** : Original, Flouté, Détouré ou Personnalisé. Détouré retire l'arrière-plan sans fond vert, grâce à un modèle de segmentation qui tourne sur votre CPU. Cette section n'apparaît que si le moteur de segmentation se charge sur votre machine.

Pour une introduction ou une conclusion, appuyez sur `C` pour ajouter un segment **Caméra plein écran** : la caméra remplit tout le cadre pendant ce passage.

L'onglet **Composition** met en forme le cadre. Sa section d'arrière-plan propose 18 fonds d'écran intégrés, une couleur unie, un dégradé ou votre propre image, ainsi qu'un flou d'arrière-plan. En dessous se trouvent l'ombre, l'arrondi, la marge et le flou de mouvement.

## 4. Ajouter des zooms automatiques {#4-add-automatic-zooms}

Dans la barre d'outils de la timeline, ouvrez **Amélioration auto** et choisissez **Zooms automatiques**. OpenScreen lit le mouvement enregistré du curseur et place des régions de zoom sur ces pauses, sans réseau ni modèle. S'il ne place rien, il vous le signale. Les causes habituelles sont un enregistrement sans données de curseur, aucune pause sur cette plage, ou des zooms existants qui couvrent déjà ces moments.

Vérifiez-les ensuite. Cliquez sur un zoom pour régler son niveau (de 1.25× à 5×), son mode de focus (Auto suit le curseur, Manuel garde un point fixe) et une éventuelle rotation 3D. Appuyez sur `Z` pour ajouter un zoom à la main, et sur `Ctrl/Cmd+D` pour supprimer un zoom dont vous ne voulez pas.

Pour en savoir plus sur le placement des zooms : [Zoom automatique](/features/auto-zoom/).

## 5. Couper depuis la transcription et accélérer les temps morts {#5-cut-from-the-transcript-and-speed-up-dead-time}

**Transcrivez d'abord.** Ouvrez l'onglet **Transcription**. S'il n'y a pas encore de transcription, cliquez sur **Transcrire maintenant**. La transcription tourne en local avec Whisper. La première transcription télécharge son modèle une seule fois, environ 264 Mo.

**Coupez par le texte.** Dans la transcription, sélectionnez des mots et appuyez sur `Delete` : ce passage est retiré de la lecture et de l'export. Les silences apparaissent dans le texte sous forme de repères : cliquez sur l'un d'eux pour le couper, et cliquez de nouveau pour le rétablir. Survolez un mot coupé pour le rétablir. Vous pouvez aussi appuyer sur `T` pour ajouter une région de coupe sur la timeline.

**Accélérez ce que vous ne pouvez pas couper**, comme les chargements de page ou la saisie. Appuyez sur `S` pour ajouter une région de vitesse, choisissez un préréglage de 0.25× à 5×, ou saisissez une valeur de 0.1× à 100×. L'audio est étiré dans le temps en conséquence.

**Assemblez plusieurs prises.** Passez en mode **Médias**, utilisez **Importer un média** si une prise n'est pas encore listée, puis faites glisser sa carte sur la rangée de clips. Si vous la déposez sur un clip existant, OpenScreen propose **Ajouter avant**, **Ajouter après** ou **Diviser ici et insérer**. Voir [Médiathèque et clips](../media-library.md).

Si vous avez connecté votre propre fournisseur de LLM, **Amélioration auto → Coupes intelligentes** confie les coupes à l'agent IA. C'est facultatif, et désactivé tant que vous n'avez pas ajouté de clé ([Montage par IA](../ai-editing.md)). L'historique d'annulation conserve les 50 dernières étapes, modifications de l'agent comprises.

## 6. Flouter les données privées, annoter, ajouter du son {#6-blur-private-data-annotate-add-sound}

Appuyez sur `A` pour ajouter une annotation, puis choisissez son **Type** :

- **Flou** : Gaussien ou Mosaïque, rectangle ou ovale. Placez-le sur les adresses e-mail, les clés API ou les noms de clients, étirez sa région sur toutes les images qui les montrent, puis parcourez la vidéo pour vérifier.
- **Texte** : avec une animation facultative (Fondu, Monter, Apparition, Glisser à gauche, Machine à écrire ou Pulsation).
- **Flèche** : huit directions, épaisseur du trait et couleur réglables.
- **Image** : un JPG, PNG, GIF ou WebP, par exemple un logo.

Pour le son, appuyez sur `V` pour enregistrer une voix off sur la timeline, ou sur `M` pour importer de la musique (mp3, wav, m4a, aac, flac, ogg, opus). Chaque piste a son propre gain, ses fondus, sa lecture en boucle et son mode muet.

L'onglet **Curseur** permet de changer le style du pointeur enregistré à l'étape 2. Tous les outils sont décrits dans [Montage et timeline](../editing-timeline.md).

## 7. Incruster les sous-titres {#7-burn-in-captions}

Dans l'onglet **Transcription**, cliquez sur **Sous-titres** et activez **Afficher les sous-titres**. Ils sont dessinés en direct à partir de la transcription : les coupes de l'étape 5 s'y reportent donc sans étape supplémentaire. Réglez la police, la taille, le gras, la couleur, le bandeau de fond, la position, et de 1 à 12 mots par ligne. Vérifiez le placement dans l'aperçu après tout changement de format.

Whisper détecte la langue parlée, mais vous pouvez aussi forcer l'une des 100 langues avec **Régénérer en** dans le mode Médias. Pour publier dans une autre langue, utilisez **Traduire** vers l'une des 15 langues cibles, puis sélectionnez cette langue sous **Affichage** avant d'exporter. La traduction passe par votre propre fournisseur de LLM : elle nécessite donc une clé.

Les sous-titres sont incrustés dans la vidéo. OpenScreen n'écrit pas de fichier `.srt` ni `.vtt` : un lecteur ne peut donc pas les désactiver. Détails : [Sous-titres et transcription](../captions.md), et [fonctionnement des sous-titres](/features/captions/).

## 8. Exporter {#8-export}

**Choisissez le format.** Le réglage **Format** de l'onglet **Composition** propose 16:9 (par défaut), 9:16, 1:1, 4:3, 4:5, 16:10, 10:16, ou la forme d'origine de vos clips.

**Exportez.** Cliquez sur **Exporter** dans la barre supérieure :

- **MP4** : 720p, 1080p ou Source ; 24, 30 ou 60 fps ; H.264 ou H.265. La fenêtre présente H.264 comme l'option **Meilleure compatibilité**. Le débit vidéo n'est pas réglable : environ 8 Mbit/s en 1080p.
- **GIF** : 15, 20, 25 ou 30 fps ; taille Medium, Large ou Original ; boucle activée ou désactivée. Les GIF utilisent 256 couleurs, sans tramage : ils conviennent aux clips courts d'interfaces en aplats.

Il n'y a pas de filigrane. Pour obtenir un autre format, changez de format et exportez de nouveau.

**Conservez le projet.** Enregistrez-le avec `Ctrl/Cmd+S` sous forme de fichier `.openscreen` : vous pourrez ainsi remplacer un clip et exporter de nouveau quand l'interface change. Le projet référence vos médias au lieu de les intégrer ; `openscreen pack` rassemble le tout dans un seul dossier portable ([CLI](/docs/cli/)). Plus de détails dans [Export](../export.md).

## Publier le fichier {#publish-the-file}

OpenScreen n'héberge pas votre vidéo, ne crée pas de liens de partage et ne compte pas les vues. Mettez le fichier exporté en ligne là où votre public le regarde.

## Quand OpenScreen n'est pas le bon outil {#when-openscreen-is-not-the-right-tool}

- **Vous voulez un lien hébergé avec des statistiques de visionnage ou des commentaires.** Un enregistreur hébergé convient mieux. Loom, par exemple, partage chaque enregistrement sous forme de lien sur loom.com, et sa page de tarifs indique des statistiques de visionnage et des commentaires vidéo dans toutes les formules (en septembre 2026). Voir [OpenScreen comme alternative à Loom](/alternatives/loom/) pour le cas, plus restreint, où OpenScreen convient.
- **Vous voulez une démo interactive** que le spectateur parcourt en cliquant. OpenScreen n'exporte que de la vidéo et des GIF.
- **Votre lecteur vidéo a besoin d'un fichier de sous-titres séparé.** OpenScreen ne fait qu'incruster les sous-titres.
- **Vous enregistrez sur un téléphone ou une tablette.** OpenScreen est une application de bureau pour Windows, macOS 13 ou ultérieur, et Linux.

## Sources {#sources}

- OpenScreen : le [code source de la version v1.11.0](https://github.com/getopenscreen/openscreen/tree/v1.11.0).
- Loom : [loom.com](https://www.loom.com) et [loom.com/pricing](https://www.loom.com/pricing), consultés en septembre 2026.

Loom est une marque de son propriétaire. OpenScreen n'est pas affilié à Loom.
