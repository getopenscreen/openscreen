---
id: editing-timeline
title: Montage et timeline
sidebar_position: 6
description: "Monter dans la timeline d'OpenScreen : régions de zoom, coupe et vitesse, segments Caméra plein écran, annotations, style du curseur, inspecteur flottant."
keywords:
  - éditeur vidéo avec timeline
  - zoom sur une vidéo
  - accélérer une vidéo
  - annotations vidéo
  - lissage du curseur
  - montage multipiste
---

# Montage et timeline

L'éditeur a trois modes, que l'on change avec le sélecteur segmenté de la barre supérieure :

| Mode | À quoi il sert |
|---|---|
| **Médias** | Les clips de votre projet : importer, rechercher, consulter les transcriptions, glisser sur la timeline. Voir [Médiathèque et clips](./media-library.md). |
| **Édition** | L'aperçu, l'inspecteur flottant et la timeline complète. C'est là que le projet se monte réellement. |
| **Enregistrement** | La préparation d'un nouvel enregistrement : micro, caméra, audio système, curseur. Voir [Enregistrement](./recording.md#recording-from-the-editor-rec-mode). |

Tout ce qui suit décrit le mode **Édition** : un aperçu redimensionnable en haut, une timeline en dessous. Faites glisser la poignée qui les sépare pour rééquilibrer le partage.

## Inspecteur flottant {#floating-inspector}

Une barre d'icônes flottante se superpose à l'aperçu. Elle donne accès à cinq onglets :

| Onglet | Ce qu'il contrôle |
|---|---|
| **Composition** | Une section d'arrière-plan (image, couleur unie ou dégradé derrière votre enregistrement ; importez votre propre image ou choisissez parmi les préréglages), puis le flou d'arrière-plan, l'ombre, le flou de mouvement, l'arrondi des coins et la marge. Sa ligne **Format** définit la forme de sortie pour l'aperçu et l'export : les formes propres à vos clips sous **Original**, plus 16:9, 9:16, 1:1, 4:3, 4:5, 16:10 et 10:16. |
| **Disposition caméra** | La composition de la webcam : incrustation d'image, empilement vertical, double cadre ou sans webcam. Effet miroir, « réduire au zoom », forme de la caméra (rectangle/cercle/carré/arrondi) et taille. Faites glisser la bulle de la webcam directement sur le canevas pour la déplacer. |
| **Audio** | Le niveau de sortie, appliqué de la même façon dans l'aperçu et à l'export. |
| **Curseur** | Utile uniquement pour les enregistrements faits en mode curseur éditable, sous Windows, macOS ou Linux. Afficher/masquer, rogner au canevas, une bande de thèmes de curseur, et des glissières pour la taille, le lissage, le flou de mouvement et le rebond au clic. |
| **Transcription** | La transcription agrégée de tous les clips, modifiable : voir [Montage par la transcription](./captions.md#transcript-editing). Son bouton **Sous-titres** active les sous-titres, les met en forme et les traduit : voir [Sous-titres et transcription](./captions.md#captions). |

Le bouton **crayon** de la même barre ouvre la fenêtre **Modifier le clip** pour le clip sélectionné : un rectangle de recadrage déplaçable avec des champs numériques X/Y/L/H et des préréglages de proportions, plus les points d'entrée et de sortie du clip. Le recadrage se règle clip par clip, pas pour tout le projet.

Sélectionner une région sur la timeline (un bloc de zoom, de coupe, d'annotation, de vitesse ou Caméra plein écran) remplace le contenu de l'onglet par un inspecteur propre à cette région, décrit plus bas avec chaque type de région.

## Barre d'outils de la timeline {#timeline-toolbar}

- **Amélioration auto** (icône baguette) : un menu qui propose deux traitements à lancer ponctuellement :
  - **Zooms automatiques** : lit le mouvement enregistré du curseur et place des régions de zoom aux moments où le curseur s'attarde. Pas de réseau, pas de modèle. [Zoom automatique](/features/auto-zoom/) explique comment ces moments sont choisis.
  - **Coupes intelligentes** (avec la mention *Avec l'IA*) : confie plutôt la tâche à l'agent IA, qui a besoin d'un [fournisseur connecté](./ai-editing.md).
- **Vitesse** (`S`) : ajoute une région de changement de vitesse à la tête de lecture.
- **Commentaire** (`A`) : ajoute une annotation à la tête de lecture.
- **Couper** (`T`) : place une coupe de deux secondes (une « région de coupe ») à la tête de lecture. Faites glisser ses bords pour la redimensionner, comme toute autre région.
- **Ajouter un zoom** (`Z`) : place une région de zoom animée à la tête de lecture.
- **Mise au point automatique** (viseur) : un interrupteur ; activé, chaque région de zoom suit le curseur et le réglage de mise au point propre à chaque zoom se verrouille.
- **Caméra plein écran** (`C`) : ajoute un segment où la webcam occupe tout le cadre.

Faites glisser les bords d'une région pour la redimensionner, ou le bloc lui-même pour la déplacer. Les régions s'aimantent à la tête de lecture, aux bords des autres régions, ainsi qu'au début et à la fin de la timeline. `Ctrl/Cmd + C` / `Ctrl/Cmd + V` copie les attributs d'une région sélectionnée sur une autre région du même type.

`Shift` + molette fait défiler la timeline ; `Ctrl`/`Cmd` + molette zoome et dézoome. Ces deux gestes sont rappelés sous la barre de transport.

### Régions de zoom {#zoom-regions}

Cliquez sur un bloc de zoom pour ouvrir son inspecteur :
- Six préréglages de profondeur : 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **Rotation 3D** : Aucune, Iso, Gauche ou Droite.
- **Mode focus** : Manuel (faites glisser le repère de focus dans l'aperçu) ou Auto (suit le curseur enregistré). Verrouillé sur Auto quand l'interrupteur Mise au point automatique de la barre d'outils est activé.
- **Position du focus** : pourcentage X/Y numérique en mode manuel.

Les régions de zoom placées par **Amélioration auto → Zooms automatiques** ouvrent le même inspecteur. Le fonctionnement de ce traitement, et sa comparaison avec les zooms automatiques d'autres enregistreurs, sont décrits dans [Zoom automatique](/features/auto-zoom/).

### Régions de coupe {#trim-regions}

Un passage coupé est retiré de la lecture et de l'export. L'inspecteur se résume à une action **Supprimer** : appuyez sur `Del` ou utilisez le bouton de l'inspecteur. Les mêmes coupes peuvent aussi se faire depuis le texte, dans la [transcription](./captions.md#transcript-editing).

### Régions de vitesse {#speed-regions}

Une liste déroulante de préréglages (de 0.25× à 5×, plus 1× pour revenir à la normale) et un champ numérique libre qui accepte toute valeur jusqu'à 100×. Dans les deux cas, l'export restitue la vitesse réelle.

### Régions Caméra plein écran {#full-camera-regions}

Un passage où la webcam remplit le cadre au lieu de rester dans l'emplacement que lui donne sa disposition : utile pour une introduction face caméra au milieu d'un enregistrement d'écran. N'a de sens que si l'enregistrement contient une piste webcam.

### Annotations {#annotations}

Quatre types, que l'on change avec la liste déroulante **Type** de l'inspecteur. Changer de type conserve la plage et le cadre de la région : une erreur de choix coûte un clic, pas un nouveau tracé.

- **Texte** : contenu, taille, couleur de fond avec interrupteur, couleur du texte et animation d'apparition (Aucune / Fondu / Monter / Apparition / Glisser à gauche / Machine à écrire / Pulsation).
- **Image** : importez un JPG, PNG, GIF ou WebP.
- **Flèche** : huit directions, épaisseur du trait (1–20) et couleur.
- **Flou** : un masque de confidentialité. Gaussien ou Mosaïque, rectangle ou ovale, avec une intensité (ou une taille de blocs pour la mosaïque). Faites-le glisser et redimensionnez-le sur l'aperçu comme toute autre annotation.

:::note
Il n'est plus possible de dessiner des formes de flou à main levée. Celles qui existent s'affichent encore, mais sous la forme de leur boîte englobante : elles couvrent volontairement trop, plutôt que de laisser visible dans l'export quelque chose que vous aviez marqué comme privé. L'inspecteur le signale quand il en rencontre une.
:::

## Style du curseur {#cursor-styling}

Si votre enregistrement contient des données de curseur éditables (capture native en mode curseur éditable, sous Windows, macOS ou Linux ; [Mode du curseur](./recording.md#cursor-mode) détaille ce que chaque plateforme enregistre), l'onglet Curseur vous permet de choisir parmi une bibliothèque de thèmes de curseur et de régler la taille, le lissage, le flou de mouvement et le rebond au clic indépendamment de la capture brute. Le tracé sous-jacent du curseur est lissé de façon déterministe : ce que vous voyez dans l'aperçu correspond à l'export final.

## Raccourcis clavier {#keyboard-shortcuts}

L'icône d'engrenage de la barre supérieure ouvre la fenêtre des raccourcis, où ceux qui sont configurables peuvent être réaffectés.

| Action | Par défaut |
|---|---|
| Ajouter un zoom | `Z` |
| Ajouter une coupe | `T` |
| Ajouter une vitesse | `S` |
| Ajouter une annotation | `A` |
| Ajouter une caméra en plein écran | `C` |
| Ajouter un audio | `M` |
| Enregistrer une voix off | `V` |
| Supprimer la sélection | `Ctrl/Cmd + D` |
| Lecture / Pause | `Space` |
| Copier les attributs de la région | `Ctrl/Cmd + C` |
| Coller les attributs de la région | `Ctrl/Cmd + V` |
| Ouvrir l'application (fonctionne depuis n'importe quelle application) | `Ctrl/Cmd + Shift + O` |

Fixes (non réaffectables) :

| Action | Raccourci |
|---|---|
| Annuler | `Ctrl/Cmd + Z` |
| Rétablir | `Ctrl/Cmd + Shift + Z` (ou `+ Y`) |
| Supprimer la sélection (alt) | `Del` / `⌫` |
| Parcourir les annotations en avant / en arrière | `Tab` / `Shift + Tab` |
| Image précédente / suivante | `←` / `→` |
| Panoramique de la timeline | `Shift + Scroll` |
| Zoom de la timeline | `Ctrl + Scroll` |

## Enregistrer votre travail {#saving-your-work}

Les modifications sont stockées dans un fichier de projet `.openscreen`, distinct de toute vidéo exportée et entièrement modifiable :

- **Enregistrer le projet** (`Ctrl/Cmd + S`) : enregistre dans le fichier existant, ou demande un emplacement la première fois.
- **Charger un projet** (`Ctrl/Cmd + O`) : ouvre un fichier `.openscreen` existant.
- **Nouveau projet** (`Ctrl/Cmd + N`) : vide le projet en cours.

La barre supérieure affiche un indicateur **Enregistré** / **Non enregistré**, et fermer avec des modifications non enregistrées vous propose d'enregistrer, d'ignorer les modifications ou d'annuler.

Quand vous êtes prêt, passez à [Export](./export.md).
