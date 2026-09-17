---
id: quick-start
title: Comment enregistrer son écran avec OpenScreen
sidebar_label: Démarrage rapide
sidebar_position: 3
description: "Enregistrez, coupez et exportez votre premier enregistrement d'écran avec OpenScreen en six étapes, de l'ouverture du HUD à l'export d'un MP4 ou d'un GIF."
keywords:
  - tutoriel enregistrement d'écran
  - démarrage rapide
  - enregistrer son écran
  - couper une vidéo
  - exporter en MP4
---

# Comment enregistrer son écran avec OpenScreen

Ce démarrage rapide vous guide pour enregistrer, couper et exporter votre première vidéo. Consultez d'abord [Installation](./installation.md) si OpenScreen n'est pas encore installé.

## 1. Ouvrir le HUD d'enregistrement {#1-open-the-recording-hud}

Au lancement, OpenScreen affiche une petite pastille flottante (le HUD) ancrée en bas de votre écran. Elle reste au-dessus de tout et n'intercepte pas les clics tant que vous n'interagissez pas avec elle.

## 2. Choisir ce qu'il faut enregistrer {#2-pick-what-to-record}

Cliquez sur le sélecteur de source (icône d'écran) pour ouvrir le choix de la source. Il liste vos **Écrans** et vos **Fenêtres** dans deux onglets : choisissez une vignette et cliquez sur **Partager**.

Sous Linux, le HUD n'a pas de sélecteur de source. Il affiche *Le système vous demandera quoi partager* : quand vous lancez l'enregistrement, la boîte de dialogue de partage de votre bureau demande l'écran ou la fenêtre, avant le compte à rebours et de nouveau à chaque prise.

## 3. Activer l'audio et la webcam (facultatif) {#3-turn-on-audio-and-webcam-optional}

Dans le groupe audio du HUD, activez :
- **Audio système** : capture ce qui est lu sur votre machine.
- **Microphone** : ouvre un vumètre et un sélecteur de périphérique pour vérifier que le bon micro est choisi.
- **Webcam** : ouvre un sélecteur de caméra ; la webcam est enregistrée sur une piste séparée, que vous placerez ensuite dans l'éditeur.

## 4. Enregistrer {#4-record}

Cliquez sur le bouton d'enregistrement. Un compte à rebours 3‑2‑1 apparaît sur votre bureau, puis l'enregistrement démarre. Pendant l'enregistrement, vous pouvez :
- **Mettre en pause / Reprendre**
- **Redémarrer** : abandonner la prise en cours et recommencer
- **Annuler** : abandonner sans sauvegarder

Cliquez sur **Arrêter** quand vous avez terminé.

## 5. Ouvrir le Studio {#5-open-the-studio}

Cliquez sur **Ouvrir le Studio** (ou attendez qu'il s'ouvre automatiquement après l'arrêt) pour charger votre enregistrement dans l'éditeur.

## 6. Couper et exporter {#6-trim-and-export}

- Placez la tête de lecture là où vous voulez couper et appuyez sur `T` (ou sur le bouton ciseaux) : une région de coupe de deux secondes est ajoutée à cet endroit. Faites glisser ses bords pour ajuster ce qui est retiré.
- Cliquez sur **Exporter** dans la barre supérieure, choisissez **MP4** ou **GIF**, sélectionnez une qualité, puis cliquez sur **Exporter**.
- Une fois l'export terminé, cliquez sur **Afficher dans le dossier** pour retrouver votre fichier.

Voilà l'essentiel. Pour tous les outils de montage (zooms, changements de vitesse, annotations, style du curseur, disposition de la webcam), consultez [Montage et timeline](./editing-timeline.md). Pour assembler plusieurs prises en une seule vidéo, consultez [Médiathèque et clips](./media-library.md).

:::note
La barre supérieure bascule l'éditeur entre trois modes : **Médias** (vos clips), **Édition** (tout ce qui précède) et **Enregistrement** (préparer le prochain enregistrement sans quitter l'application).
:::

:::tip
Enregistrez votre travail sous forme de projet (`⌘/Ctrl S`) avant d'exporter si vous voulez reprendre le montage plus tard : les fichiers de projet `.openscreen` gardent chaque couche modifiable, contrairement à la vidéo exportée.
:::
